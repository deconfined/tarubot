/**
 * Independent byte model for the reviewed controller recipe. It runs in the trusted parent,
 * before a build: an image, assembler response, current directory hash or child echo cannot
 * choose its own expectation. Timestamps/history are non-execution metadata; every path,
 * byte, mode, owner, link and extended attribute is committed. Native engine/kernel behavior
 * remains an explicit prerequisite, rather than something a version string can prove.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { types } from "node:util";
import { gunzipSync, inflateRawSync } from "node:zlib";
import importedPins from "../ops/host-controller/pins.json" with { type: "json" };

const failure = "host-controller-closure-failed";
const limit = 512 * 1024 * 1024;
const nativeSet = Uint8Array.prototype.set;
const nativeLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)?.get;
// JSON imports are shared module values. Keep our catalogue separate from callers and
// freeze every nested value before any public derivation can use it.
function freezeCatalogue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeCatalogue(child);
    Object.freeze(value);
  }
  return value;
}
const pins = freezeCatalogue(JSON.parse(JSON.stringify(importedPins)) as typeof importedPins);
// Updated only with reviewed static source pins; an earlier importer cannot mutate the
// shared JSON module and make that mutated catalogue become our native expectation.
const reviewedCatalogueSha256 = "f332d33f6a6cbf3bcd96fd608f26eee3ee73c15ed12fac684e0f777e76cc296c";
/** Immutable reviewed DATA only; this catalogue never creates an image or process capability. */
export function reviewedControllerCatalogue(): typeof importedPins {
  requireValue(controllerDigest(Buffer.from(JSON.stringify(pins))) === reviewedCatalogueSha256);
  return pins;
}
export const controllerDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(controllerBytes(bytes)).digest("hex");
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error(failure);
}
/** Intrinsic copies do not execute a byteLength/iterator/toJSON override. */
export function controllerBytes(value: unknown, maximum = limit): Buffer {
  requireValue(
    types.isUint8Array(value) &&
      typeof nativeLength === "function" &&
      typeof nativeBuffer === "function",
  );
  requireValue(!types.isSharedArrayBuffer(Reflect.apply(nativeBuffer, value, [])));
  const length: unknown = Reflect.apply(nativeLength, value, []);
  requireValue(typeof length === "number" && length >= 0 && length <= maximum);
  const copy = new Uint8Array(length);
  Reflect.apply(nativeSet, copy, [value]);
  return Buffer.from(copy.buffer);
}
/** Duplicate keys are rejected before ordinary JSON parsing can erase their contradiction. */
export function controllerJson(bytes: Uint8Array, maximum = 2 * 1024 * 1024): unknown {
  try {
    return parseJson(bytes, maximum);
  } catch {
    throw new Error(failure);
  }
}
function parseJson(bytes: Uint8Array, maximum: number): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    controllerBytes(bytes, maximum),
  );
  let at = 0,
    nodes = 0;
  const space = () => {
    while (/^[ \t\r\n]$/u.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    requireValue(text[start] === '"');
    for (;;) {
      requireValue(at < text.length);
      const char = text[at++];
      if (char === "\\") {
        requireValue(at < text.length);
        at++;
      } else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
      else requireValue(char !== undefined && char.charCodeAt(0) >= 32);
    }
  };
  const value = (depth: number): unknown => {
    space();
    requireValue(++nodes <= 100_000 && depth <= 32);
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      space();
      const output: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return output;
      }
      for (;;) {
        space();
        const key = string();
        requireValue(!Object.hasOwn(output, key));
        space();
        requireValue(text[at++] === ":");
        Object.defineProperty(output, key, { enumerable: true, value: value(depth + 1) });
        space();
        const next = text[at++];
        if (next === "}") return output;
        requireValue(next === ",");
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      const output: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return output;
      }
      for (;;) {
        output.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === "]") return output;
        requireValue(next === ",");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      text.slice(at),
    );
    requireValue(match);
    at += match[0].length;
    const output: unknown = JSON.parse(match[0]);
    requireValue(typeof output !== "number" || Number.isFinite(output));
    return output;
  };
  try {
    const output = value(0);
    space();
    requireValue(at === text.length);
    return output;
  } catch {
    throw new Error(failure);
  }
}
export interface ControllerFile {
  kind: "file" | "directory" | "symlink" | "hardlink";
  mode: number;
  uid: number;
  gid: number;
  bytes: Buffer;
  target: string;
  xattrs: Record<string, string>;
}
export type ControllerTree = Map<string, ControllerFile>;
function canonical(path: string, root = false): string {
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/u, "");
  requireValue(!path.startsWith("/") && !path.includes("\0") && !path.includes("\\"));
  if (path === "." || path === "") {
    requireValue(root);
    return "";
  }
  requireValue(
    path.length <= 4096 &&
      posix.normalize(path) === path &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
  return path;
}
const empty = (): Buffer => Buffer.alloc(0);
function tarNumber(bytes: Buffer): number {
  requireValue((bytes[0] ?? 0) < 128);
  const text = bytes.toString("ascii").replace(/\0.*$/u, "").trim();
  requireValue(text === "" || /^[0-7]+$/u.test(text));
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  requireValue(Number.isSafeInteger(value) && value >= 0);
  return value;
}
function tarText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)),
  );
}
function pax(bytes: Buffer): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(32, offset);
    requireValue(end > offset);
    const digits = bytes.subarray(offset, end).toString("ascii");
    requireValue(/^[1-9][0-9]*$/u.test(digits));
    const size = Number(digits);
    requireValue(size <= 65_536 && offset + size <= bytes.length);
    const record = bytes.subarray(end + 1, offset + size);
    requireValue(record[record.length - 1] === 10);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(0, -1));
    const equal = text.indexOf("=");
    requireValue(equal > 0);
    const key = text.slice(0, equal);
    requireValue(!Object.hasOwn(output, key));
    output[key] = text.slice(equal + 1);
    offset += size;
  }
  return output;
}
function remove(tree: ControllerTree, path: string): void {
  // This reviewed archive profile refuses inode edits that would otherwise require a
  // complete overlayfs inode model. An alias must never follow replacement path bytes.
  for (const [name, file] of tree) {
    if (file.kind !== "hardlink" || name === path || name.startsWith(`${path}/`)) continue;
    requireValue(file.target !== path && !file.target.startsWith(`${path}/`));
  }
  for (const name of tree.keys())
    if (name === path || name.startsWith(`${path}/`)) tree.delete(name);
}
/** Parse, never unpack into the parent filesystem. Layer links cannot redirect later writes. */
export function applyControllerLayer(tree: ControllerTree, input: Uint8Array): void {
  try {
    applyLayer(tree, input, 64 * 1024 * 1024);
  } catch {
    throw new Error(failure);
  }
}
/** Outer Docker-save members may be whole uncompressed layers, unlike rootfs files. */
function applyLayer(
  tree: ControllerTree,
  input: Uint8Array,
  memberLimit: number,
  outer = false,
): void {
  const bytes = controllerBytes(input);
  let offset = 0,
    count = 0,
    ended = false;
  requireValue(bytes.length >= 1024 && bytes.length % 512 === 0);
  let extra: Record<string, string> = Object.create(null),
    longName = "",
    longLink = "";
  const seen = new Set<string>();
  const additions: [string, ControllerFile][] = [];
  const whiteouts: { path: string; opaque: boolean }[] = [];
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      requireValue(
        offset + 512 <= bytes.length && bytes.subarray(offset).every((byte) => byte === 0),
      );
      ended = true;
      break;
    }
    requireValue(++count <= 100_000);
    const magic = tarText(header.subarray(257, 263));
    requireValue(magic === "ustar" || magic === "ustar ");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    requireValue(sum === tarNumber(header.subarray(148, 156)));
    const size = tarNumber(header.subarray(124, 136));
    requireValue(size <= memberLimit && offset + size <= bytes.length);
    const content = bytes.subarray(offset, offset + size);
    const next = offset + Math.ceil(size / 512) * 512;
    requireValue(
      next <= bytes.length && bytes.subarray(offset + size, next).every((byte) => byte === 0),
    );
    offset = next;
    const type = tarText(header.subarray(156, 157)) || "0";
    if (type === "x") {
      requireValue(Object.keys(extra).length === 0);
      extra = pax(content);
      continue;
    }
    if (type === "L" || type === "K") {
      if (type === "L") {
        requireValue(!longName);
        longName = tarText(content);
      } else {
        requireValue(!longLink);
        longLink = tarText(content);
      }
      continue;
    }
    requireValue(["0", "1", "2", "5"].includes(type));
    const prefix = tarText(header.subarray(345, 500));
    const original = tarText(header.subarray(0, 100));
    const path = canonical(
      extra.path ?? (longName || (prefix ? `${prefix}/${original}` : original)),
      true,
    );
    const target = extra.linkpath ?? (longLink || tarText(header.subarray(157, 257)));
    requireValue(!seen.has(path));
    seen.add(path);
    const xattrs: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(extra)) {
      if (key.startsWith("SCHILY.xattr.")) xattrs[key.slice(13)] = value;
      else
        requireValue(
          [
            "path",
            "linkpath",
            "size",
            "uid",
            "gid",
            "mtime",
            "atime",
            "ctime",
            "LIBARCHIVE.creationtime",
          ].includes(key),
        );
    }
    const numeric = (key: "uid" | "gid", field: Buffer): number => {
      const text = extra[key];
      if (text === undefined) return tarNumber(field);
      requireValue(/^[0-9]+$/u.test(text) && Number.isSafeInteger(Number(text)));
      return Number(text);
    };
    requireValue(
      extra.size === undefined ||
        (/^(?:0|[1-9][0-9]*)$/u.test(extra.size) && Number(extra.size) === size),
    );
    const base = posix.basename(path);
    if (base.startsWith(".wh.")) {
      requireValue(!outer);
      requireValue(type === "0" && size === 0);
      const parent = posix.dirname(path) === "." ? "" : posix.dirname(path);
      requireValue(base === ".wh..wh..opq" || base.length > 4);
      const removed = parent ? `${parent}/${base.slice(4)}` : base.slice(4);
      if (base !== ".wh..wh..opq") requireValue(canonical(removed) === removed);
      whiteouts.push({
        path: base === ".wh..wh..opq" ? parent : removed,
        opaque: base === ".wh..wh..opq",
      });
    } else {
      const kind =
        type === "0" ? "file" : type === "5" ? "directory" : type === "2" ? "symlink" : "hardlink";
      requireValue(kind === "file" || size === 0);
      additions.push([
        path,
        {
          kind,
          mode: tarNumber(header.subarray(100, 108)),
          uid: numeric("uid", header.subarray(108, 116)),
          gid: numeric("gid", header.subarray(116, 124)),
          bytes: kind === "file" ? Buffer.from(content) : empty(),
          target: kind === "hardlink" ? canonical(target) : target,
          xattrs,
        },
      ]);
    }
    extra = Object.create(null);
    longName = "";
    longLink = "";
  }
  requireValue(
    ended && offset <= bytes.length && Object.keys(extra).length === 0 && !longName && !longLink,
  );
  // OCI whiteouts affect only lower-layer resources, regardless of tar member ordering.
  const lower = new Map(tree);
  for (const item of whiteouts) {
    if (!item.opaque) remove(lower, item.path);
    else
      for (const name of [...lower.keys()]) {
        if ((item.path === "" && name !== "") || name.startsWith(`${item.path}/`))
          remove(lower, name);
      }
  }
  const added = new Map(additions);
  for (const [path] of additions) {
    for (
      let parent = posix.dirname(path);
      parent !== "." && parent !== "";
      parent = posix.dirname(parent)
    ) {
      const ancestor = added.get(parent);
      requireValue(!ancestor || ancestor.kind === "directory");
    }
  }
  for (const [path, file] of additions) {
    for (
      let parent = posix.dirname(path);
      parent !== "." && parent !== "";
      parent = posix.dirname(parent)
    ) {
      const entry = lower.get(parent);
      requireValue(!entry || entry.kind === "directory");
    }
    if (file.kind === "hardlink") {
      const target = lower.get(file.target);
      requireValue(
        target?.kind === "file" &&
          file.target !== path &&
          target.mode === file.mode &&
          target.uid === file.uid &&
          target.gid === file.gid &&
          JSON.stringify(Object.entries(target.xattrs).sort()) ===
            JSON.stringify(Object.entries(file.xattrs).sort()),
      );
    }
    if (file.kind !== "directory" || lower.get(path)?.kind !== "directory") remove(lower, path);
    lower.set(path, file);
  }
  tree.clear();
  for (const [path, file] of lower) tree.set(path, file);
}
function resolvedFile(
  tree: ControllerTree,
  path: string,
  visited = new Set<string>(),
): ControllerFile {
  requireValue(!visited.has(path));
  visited.add(path);
  const file = tree.get(path);
  requireValue(file);
  return file.kind === "hardlink" ? resolvedFile(tree, file.target, visited) : file;
}
export function controllerTreeCommitment(tree: ControllerTree): string {
  const output = [...tree]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, entry]) => {
      const content = resolvedFile(tree, path);
      requireValue(entry.kind !== "hardlink" || content.kind === "file");
      return [
        path,
        entry.kind,
        entry.mode,
        entry.uid,
        entry.gid,
        content.kind === "file" ? controllerDigest(content.bytes) : "",
        entry.target,
        Object.entries(entry.xattrs).sort(([a], [b]) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        ),
      ];
    });
  return controllerDigest(Buffer.from(JSON.stringify(output)));
}
const crcTable = Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
/** Hash-verified wheel extraction has no installation hooks, executable wrappers or resolver. */
export function controllerWheel(input: Uint8Array): Map<string, Buffer> {
  try {
    const bytes = controllerBytes(input, 32 * 1024 * 1024);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
      if (
        bytes.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
      ) {
        end = i;
        break;
      }
    requireValue(
      end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    );
    const count = bytes.readUInt16LE(end + 10),
      start = bytes.readUInt32LE(end + 16);
    requireValue(
      count > 0 &&
        count <= 4096 &&
        count === bytes.readUInt16LE(end + 8) &&
        start + bytes.readUInt32LE(end + 12) === end,
    );
    const output = new Map<string, Buffer>(),
      seen = new Set<string>();
    const ranges: [number, number][] = [];
    let at = start,
      total = 0;
    for (let i = 0; i < count; i++) {
      requireValue(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50);
      const flags = bytes.readUInt16LE(at + 8),
        method = bytes.readUInt16LE(at + 10);
      const compressed = bytes.readUInt32LE(at + 20),
        size = bytes.readUInt32LE(at + 24);
      const nameLength = bytes.readUInt16LE(at + 28),
        extra = bytes.readUInt16LE(at + 30),
        comment = bytes.readUInt16LE(at + 32);
      requireValue(at + 46 + nameLength + extra + comment <= end);
      const raw = bytes.subarray(at + 46, at + 46 + nameLength);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(raw),
        isDirectory = name.endsWith("/");
      const path = isDirectory ? name.slice(0, -1) : name;
      const mode = bytes.readUInt32LE(at + 38) >>> 16,
        fileType = mode & 0xf000;
      total += size;
      requireValue(
        raw.equals(Buffer.from(name)) &&
          /^[A-Za-z0-9_./+-]+$/u.test(name) &&
          canonical(path) === path &&
          !seen.has(path) &&
          !/(?:^|\/)(?:__pycache__|sitecustomize\.py|usercustomize\.py)(?:\/|$)|\.(?:pth|pyc|pyo)$|\.data\//u.test(
            name,
          ) &&
          (fileType === 0 || fileType === (isDirectory ? 0x4000 : 0x8000)) &&
          flags === 0 &&
          [0, 8].includes(method) &&
          (!isDirectory || size === 0) &&
          size <= 32 * 1024 * 1024 &&
          total <= 64 * 1024 * 1024,
      );
      seen.add(path);
      const local = bytes.readUInt32LE(at + 42);
      requireValue(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50);
      requireValue(
        bytes.readUInt16LE(local + 6) === flags &&
          bytes.readUInt16LE(local + 8) === method &&
          bytes.readUInt32LE(local + 14) === bytes.readUInt32LE(at + 16) &&
          bytes.readUInt32LE(local + 18) === compressed &&
          bytes.readUInt32LE(local + 22) === size,
      );
      const localName = bytes.readUInt16LE(local + 26),
        localExtra = bytes.readUInt16LE(local + 28);
      requireValue(
        localName === nameLength && bytes.subarray(local + 30, local + 30 + localName).equals(raw),
      );
      const dataStart = local + 30 + localName + localExtra,
        dataEnd = dataStart + compressed;
      requireValue(dataEnd <= start && !ranges.some(([a, b]) => local < b && dataEnd > a));
      ranges.push([local, dataEnd]);
      const content =
        method === 0
          ? Buffer.from(bytes.subarray(dataStart, dataEnd))
          : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
              maxOutputLength: 32 * 1024 * 1024,
            });
      requireValue(content.length === size && crc32(content) === bytes.readUInt32LE(at + 16));
      // Wheel directories carry no installed bytes. The literal assembler creates only
      // the parents of regular members; RECORD authenticates those regular members.
      if (!isDirectory) output.set(name, content);
      at += 46 + nameLength + extra + comment;
    }
    requireValue(at === end);
    const records = [...output.keys()].filter((name) => name.endsWith(".dist-info/RECORD"));
    requireValue(records.length === 1);
    const record = records[0];
    requireValue(record);
    const rawRecord = output.get(record);
    requireValue(rawRecord);
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(rawRecord)
      .replace(/\r\n/gu, "\n");
    requireValue(text.endsWith("\n") && !text.includes("\r"));
    const checked = new Set<string>();
    for (const line of text.slice(0, -1).split("\n")) {
      const parts = line.split(",");
      requireValue(parts.length === 3);
      const [name, checksum, length] = parts;
      requireValue(name && !checked.has(name));
      checked.add(name);
      const content = output.get(name);
      requireValue(content);
      if (name === record) requireValue(checksum === "" && length === "");
      else
        requireValue(
          checksum === `sha256=${createHash("sha256").update(content).digest("base64url")}` &&
            length === String(content.length),
        );
    }
    requireValue(checked.size === output.size);
    return output;
  } catch {
    throw new Error(failure);
  }
}
export interface ControllerPublicBytes {
  manifest: Uint8Array;
  config: Uint8Array;
  layers: readonly Uint8Array[];
  wheels: Readonly<Record<string, Uint8Array>>;
}
export interface ControllerRecipeBytes {
  Containerfile: Uint8Array;
  "assemble.py": Uint8Array;
  "launcher.py": Uint8Array;
  "pins.json": Uint8Array;
  "tarubot_guarded.py": Uint8Array;
  "_tarubot_frames.py": Uint8Array;
}
export interface ControllerClosure {
  rootfs_sha256: string;
  recipe_sha256: string;
  execution_config: Record<string, unknown>;
  tree: ControllerTree;
}
function directory(tree: ControllerTree, path: string): void {
  const parent = posix.dirname(path);
  if (parent !== "." && !tree.has(parent)) directory(tree, parent);
  const prior = tree.get(path);
  requireValue(!prior || prior.kind === "directory");
  if (!prior)
    tree.set(path, {
      kind: "directory",
      mode: 0o755,
      uid: 0,
      gid: 0,
      bytes: empty(),
      target: "",
      xattrs: {},
    });
}
function regular(tree: ControllerTree, path: string, bytes: Buffer, mode = 0o644): void {
  directory(tree, posix.dirname(path));
  requireValue(!tree.has(path));
  tree.set(path, { kind: "file", mode, uid: 0, gid: 0, bytes, target: "", xattrs: {} });
}
/** All expected edits below mirror the literal assembler; they never inspect built output. */
export function deriveControllerClosure(
  input: ControllerPublicBytes,
  source: ControllerRecipeBytes,
): ControllerClosure {
  try {
    reviewedControllerCatalogue();
    const manifestBytes = controllerBytes(input.manifest, 2 * 1024 * 1024),
      configBytes = controllerBytes(input.config, 2 * 1024 * 1024);
    requireValue(
      controllerDigest(manifestBytes) === pins.base.manifest_sha256 &&
        controllerDigest(configBytes) === pins.base.config_sha256,
    );
    const manifest = controllerJson(manifestBytes) as {
      config: { digest: string };
      layers: { digest: string }[];
    };
    const config = controllerJson(configBytes) as {
      architecture: string;
      os: string;
      rootfs: { diff_ids: string[] };
      config: { Env: string[] };
    };
    requireValue(
      config.architecture === "amd64" &&
        config.os === "linux" &&
        manifest.config.digest === `sha256:${pins.base.config_sha256}` &&
        input.layers.length === pins.base.layers.length &&
        manifest.layers.length === pins.base.layers.length,
    );
    const tree: ControllerTree = new Map();
    for (const [index, layerPin] of pins.base.layers.entries()) {
      const part = input.layers[index];
      requireValue(part);
      const compressed = controllerBytes(part);
      requireValue(controllerDigest(compressed) === layerPin.sha256);
      const tar = gunzipSync(compressed, { maxOutputLength: limit });
      requireValue(
        controllerDigest(tar) === layerPin.diff_id &&
          config.rootfs.diff_ids[index] === `sha256:${layerPin.diff_id}` &&
          manifest.layers[index]?.digest === `sha256:${layerPin.sha256}`,
      );
      applyControllerLayer(tree, tar);
    }
    const expectedNames = [
      "Containerfile",
      "assemble.py",
      "launcher.py",
      "pins.json",
      "tarubot_guarded.py",
      "_tarubot_frames.py",
    ] as const;
    requireValue(Object.keys(source).sort().join("\0") === [...expectedNames].sort().join("\0"));
    const sourceEntries: [string, string][] = [];
    for (const name of expectedNames) {
      const bytes = controllerBytes(source[name], 2 * 1024 * 1024);
      if (name === "pins.json")
        requireValue(JSON.stringify(controllerJson(bytes)) === JSON.stringify(pins));
      else requireValue(controllerDigest(bytes) === (pins.sources as Record<string, string>)[name]);
      sourceEntries.push([name, controllerDigest(bytes)]);
    }
    remove(tree, "usr/local/lib/python3.12/site-packages");
    remove(tree, "usr/local/lib/python3.12/ensurepip");
    for (const name of [...tree.keys()]) {
      if (
        name.split("/").includes("__pycache__") ||
        /\.(?:pyc|pyo)$/u.test(name) ||
        /^usr\/local\/bin\/pip/u.test(name)
      )
        remove(tree, name);
    }
    requireValue(
      Object.keys(input.wheels).sort().join("\0") ===
        pins.wheels
          .map((wheel) => wheel.filename)
          .sort()
          .join("\0"),
    );
    for (const wheel of pins.wheels) {
      const value = input.wheels[wheel.filename];
      requireValue(value);
      const bytes = controllerBytes(value, 32 * 1024 * 1024);
      requireValue(bytes.length === wheel.size && controllerDigest(bytes) === wheel.sha256);
      for (const [path, content] of controllerWheel(bytes))
        regular(tree, `opt/tarubot/python/${path}`, content);
    }
    for (const name of [
      "launcher.py",
      "pins.json",
      "tarubot_guarded.py",
      "_tarubot_frames.py",
    ] as const)
      regular(
        tree,
        `opt/tarubot/${name.endsWith("guarded.py") || name.startsWith("_tarubot") ? "connection_plugins" : "controller"}/${name}`,
        controllerBytes(source[name]),
      );
    // Generated bytes and metadata are fixed by the reviewed recipe, never copied from an image.
    regular(tree, "opt/tarubot/controller/ansible.cfg", Buffer.from("[defaults]\n"), 0o444);
    const env = [...config.config.Env];
    const execution_config = {
      Env: env,
      Entrypoint: [...pins.runtime.entrypoint],
      Cmd: [],
      User: pins.runtime.user,
      WorkingDir: pins.runtime.workdir,
      Volumes: null,
      ExposedPorts: null,
      Healthcheck: null,
      OnBuild: null,
      Shell: null,
      StopSignal: "SIGTERM",
      // BuildKit dispatchCmd sets this legacy field for the literal CMD [] recipe.
      // It is a fixed expected constant, not a flag adopted from built output.
      ArgsEscaped: true,
    };
    return {
      rootfs_sha256: controllerTreeCommitment(tree),
      recipe_sha256: controllerDigest(Buffer.from(JSON.stringify(sourceEntries))),
      execution_config,
      tree,
    };
  } catch {
    throw new Error(failure);
  }
}
interface SavedSelection {
  config: string;
  layers: string[];
  nativeImageIds: string[];
  profile: "oci-content" | "legacy-config";
  compression?: ("gzip" | "none")[];
}
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const output = value as Record<string, unknown>;
  requireValue(
    required.every((key) => Object.hasOwn(output, key)) &&
      Object.keys(output).every((key) => required.includes(key) || optional.includes(key)),
  );
  return output;
}
const ociIndex = "application/vnd.oci.image.index.v1+json";
const dockerIndex = "application/vnd.docker.distribution.manifest.list.v2+json";
const ociManifest = "application/vnd.oci.image.manifest.v1+json";
const dockerManifest = "application/vnd.docker.distribution.manifest.v2+json";
/** OCI content identity is a closed hashed graph, never a tag or synthetic layout hash. */
function savedSelection(archive: ControllerTree): SavedSelection {
  const file = (path: string): Buffer => {
    const item = archive.get(canonical(path));
    requireValue(item?.kind === "file");
    return item.bytes;
  };
  let legacy: { config: string; layers: string[] } | undefined;
  if (archive.has("manifest.json")) {
    const rows = controllerJson(file("manifest.json"));
    requireValue(Array.isArray(rows) && rows.length === 1);
    const row = record(rows[0], ["Config", "Layers"], ["RepoTags"]);
    requireValue(
      typeof row.Config === "string" &&
        Array.isArray(row.Layers) &&
        row.Layers.length > 0 &&
        row.Layers.length <= 64 &&
        row.Layers.every((path) => typeof path === "string"),
    );
    legacy = {
      config: canonical(row.Config),
      layers: (row.Layers as string[]).map((path) => canonical(path)),
    };
  }
  if (!archive.has("oci-layout") && !archive.has("index.json")) {
    requireValue(legacy);
    return {
      ...legacy,
      nativeImageIds: [`sha256:${controllerDigest(file(legacy.config))}`],
      profile: "legacy-config",
    };
  }
  requireValue(archive.has("oci-layout") && archive.has("index.json"));
  const layout = record(controllerJson(file("oci-layout")), ["imageLayoutVersion"]);
  requireValue(layout.imageLayoutVersion === "1.0.0");
  const root = record(
    controllerJson(file("index.json")),
    ["schemaVersion", "manifests"],
    ["mediaType", "annotations"],
  );
  requireValue(
    root.schemaVersion === 2 &&
      (root.mediaType === undefined || root.mediaType === ociIndex) &&
      Array.isArray(root.manifests) &&
      root.manifests.length === 1,
  );
  const used = new Set<string>(),
    ids: string[] = [],
    visiting = new Set<string>();
  const descriptor = (
    raw: unknown,
    mediaTypes: readonly string[],
  ): { path: string; bytes: Buffer; mediaType: string } => {
    const item = record(raw, ["digest", "size", "mediaType"], ["platform", "annotations"]);
    requireValue(
      typeof item.digest === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(item.digest) &&
        typeof item.size === "number" &&
        Number.isSafeInteger(item.size) &&
        item.size > 0 &&
        item.size <= limit &&
        typeof item.mediaType === "string" &&
        mediaTypes.includes(item.mediaType),
    );
    if (item.platform !== undefined) {
      const platform = record(item.platform, ["architecture", "os"]);
      requireValue(platform.architecture === "amd64" && platform.os === "linux");
    }
    if (item.annotations !== undefined) {
      const annotations = item.annotations;
      requireValue(
        annotations !== null &&
          typeof annotations === "object" &&
          !Array.isArray(annotations) &&
          Object.values(annotations).every((value) => typeof value === "string"),
      );
    }
    const path = `blobs/sha256/${item.digest.slice(7)}`,
      bytes = file(path);
    requireValue(bytes.length === item.size && controllerDigest(bytes) === item.digest.slice(7));
    used.add(path);
    return { path, bytes, mediaType: item.mediaType };
  };
  const walk = (
    raw: unknown,
    depth: number,
  ): { config: string; layers: string[]; compression: ("gzip" | "none")[] } => {
    requireValue(depth <= 4);
    const node = descriptor(raw, [ociIndex, dockerIndex, ociManifest, dockerManifest]);
    requireValue(!visiting.has(node.path));
    visiting.add(node.path);
    ids.push(`sha256:${node.path.slice("blobs/sha256/".length)}`);
    if (node.mediaType === ociIndex || node.mediaType === dockerIndex) {
      const index = record(
        controllerJson(node.bytes),
        ["schemaVersion", "mediaType", "manifests"],
        ["annotations"],
      );
      requireValue(
        index.schemaVersion === 2 &&
          index.mediaType === node.mediaType &&
          Array.isArray(index.manifests) &&
          index.manifests.length === 1,
      );
      return walk(index.manifests[0], depth + 1);
    }
    const manifest = record(
      controllerJson(node.bytes),
      ["schemaVersion", "mediaType", "config", "layers"],
      ["annotations"],
    );
    requireValue(
      manifest.schemaVersion === 2 &&
        manifest.mediaType === node.mediaType &&
        Array.isArray(manifest.layers) &&
        manifest.layers.length > 0 &&
        manifest.layers.length <= 64,
    );
    const config = descriptor(manifest.config, [
      "application/vnd.oci.image.config.v1+json",
      "application/vnd.docker.container.image.v1+json",
    ]);
    const layerDescriptors = manifest.layers.map((raw) =>
      descriptor(raw, [
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.docker.image.rootfs.diff.tar",
        "application/vnd.docker.image.rootfs.diff.tar.gzip",
      ]),
    );
    const layers = layerDescriptors.map((item) => item.path);
    const compression = layerDescriptors.map((item) =>
      item.mediaType.endsWith("gzip") ? ("gzip" as const) : ("none" as const),
    );
    requireValue(new Set(layers).size === layers.length);
    return { config: config.path, layers, compression };
  };
  const selected = walk(root.manifests[0], 0);
  requireValue(
    !legacy ||
      (legacy.config === selected.config &&
        JSON.stringify(legacy.layers) === JSON.stringify(selected.layers)),
  );
  // Extra runtime/artifact blobs cannot turn a one-image save into a hidden graph or alias.
  for (const [path, item] of archive) {
    if (item.kind === "directory") requireValue(["", "blobs", "blobs/sha256"].includes(path));
    else
      requireValue(
        item.kind === "file" &&
          (["oci-layout", "index.json", "manifest.json"].includes(path) || used.has(path)),
      );
  }
  return { ...selected, nativeImageIds: ids, profile: "oci-content" };
}
/** Verify a native-engine save archive against the previously derived expectation. */
export function verifyControllerImage(
  input: Uint8Array,
  expected: ControllerClosure,
): {
  config_sha256: string;
  rootfs_sha256: string;
  native_image_ids: readonly string[];
  profile: "oci-content" | "legacy-config";
} {
  try {
    reviewedControllerCatalogue();
    const archive: ControllerTree = new Map();
    applyLayer(archive, input, limit, true);
    const selected = savedSelection(archive);
    const configFile = archive.get(selected.config);
    requireValue(configFile?.kind === "file");
    const config = controllerJson(configFile.bytes) as {
      architecture: string;
      os: string;
      config: Record<string, unknown>;
      rootfs: { type: string; diff_ids: string[] };
    };
    requireValue(
      config.architecture === "amd64" &&
        config.os === "linux" &&
        config.rootfs.type === "layers" &&
        config.rootfs.diff_ids.length === selected.layers.length,
    );
    requireValue(expected.execution_config.ArgsEscaped === true);
    for (const [key, value] of Object.entries(expected.execution_config)) {
      if (key === "Cmd" && Array.isArray(value) && value.length === 0) {
        requireValue(
          JSON.stringify(expected.execution_config.Entrypoint) ===
            JSON.stringify(pins.runtime.entrypoint),
        );
        const cmd = config.config.Cmd;
        requireValue(cmd === undefined || cmd === null || (Array.isArray(cmd) && cmd.length === 0));
      } else requireValue(JSON.stringify(config.config[key] ?? null) === JSON.stringify(value));
    }
    requireValue(
      !Object.keys(config.config).some(
        (key) =>
          !Object.hasOwn(expected.execution_config, key) &&
          ![
            "Hostname",
            "Domainname",
            "AttachStdin",
            "AttachStdout",
            "AttachStderr",
            "Tty",
            "OpenStdin",
            "StdinOnce",
            "Labels",
            "ArgsEscaped",
          ].includes(key),
      ),
    );
    // Docker save formats can omit their zero defaults. A supplied value must have
    // the reviewed type and value, rather than becoming an unchecked execution flag.
    for (const name of ["Hostname", "Domainname"])
      requireValue(!Object.hasOwn(config.config, name) || config.config[name] === "");
    for (const name of [
      "AttachStdin",
      "AttachStdout",
      "AttachStderr",
      "Tty",
      "OpenStdin",
      "StdinOnce",
    ])
      requireValue(!Object.hasOwn(config.config, name) || config.config[name] === false);
    const labels = config.config.Labels;
    requireValue(
      labels === undefined ||
        labels === null ||
        (typeof labels === "object" && !Array.isArray(labels) && Object.keys(labels).length === 0),
    );
    const tree: ControllerTree = new Map();
    for (const [index, path] of selected.layers.entries()) {
      const layer = archive.get(canonical(path));
      requireValue(layer?.kind === "file");
      let bytes = layer.bytes;
      const compressed = bytes[0] === 31 && bytes[1] === 139;
      requireValue(
        selected.compression === undefined ||
          (selected.compression[index] === "gzip") === compressed,
      );
      if (compressed) bytes = gunzipSync(bytes, { maxOutputLength: limit });
      requireValue(`sha256:${controllerDigest(bytes)}` === config.rootfs.diff_ids[index]);
      applyControllerLayer(tree, bytes);
    }
    const rootfs_sha256 = controllerTreeCommitment(tree);
    requireValue(rootfs_sha256 === expected.rootfs_sha256);
    return {
      config_sha256: controllerDigest(configFile.bytes),
      rootfs_sha256,
      native_image_ids: Object.freeze([...selected.nativeImageIds]),
      profile: selected.profile,
    };
  } catch {
    throw new Error(failure);
  }
}
