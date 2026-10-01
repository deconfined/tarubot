/** Invented archives exercise byte-model semantics; they never create a native image cap. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  applyControllerLayer,
  controllerBytes,
  controllerDigest,
  controllerJson,
  controllerTreeCommitment,
  controllerWheel,
  deriveControllerClosure,
  reviewedControllerCatalogue,
  verifyControllerImage,
  type ControllerClosure,
  type ControllerRecipeBytes,
  type ControllerTree,
} from "../../scripts/host-controller-closure.js";

interface Member {
  path: string;
  data?: Uint8Array;
  type?: string;
  target?: string;
  mode?: number;
  uid?: number;
  gid?: number;
}
const octal = (header: Buffer, offset: number, length: number, value: number) =>
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
function tar(members: Member[]): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512),
      data = Buffer.from(member.data ?? []);
    header.write(member.path, 0, 100);
    octal(header, 100, 8, member.mode ?? 0o644);
    octal(header, 108, 8, member.uid ?? 0);
    octal(header, 116, 8, member.gid ?? 0);
    octal(header, 124, 12, data.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(member.type ?? "0", 156, 1);
    header.write(member.target ?? "", 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
const data = (text: string): Buffer => Buffer.from(text);
function pax(fields: [string, string][]): Buffer {
  return Buffer.concat(
    fields.map(([key, value]) => {
      const payload = `${key}=${value}\n`;
      let length = Buffer.byteLength(payload) + 2;
      for (;;) {
        const next = Buffer.byteLength(payload) + String(length).length + 1;
        if (next === length) return data(`${length} ${payload}`);
        length = next;
      }
    }),
  );
}
function tree(members: Member[]): ControllerTree {
  const result: ControllerTree = new Map();
  applyControllerLayer(result, tar(members));
  return result;
}
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
interface ZipMember {
  name: string;
  data: Buffer;
  mode?: number;
}
function zip(members: ZipMember[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const item of members) {
    const name = data(item.name),
      checksum = crc(item.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(item.data.length, 18);
    header.writeUInt32LE(item.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(item.data.length, 20);
    entry.writeUInt32LE(item.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, item.data);
    central.push(entry, name);
    offset += header.length + name.length + item.data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function wheel(entries: ZipMember[], newline = "\n"): Buffer {
  const record = "invented-1.dist-info/RECORD";
  const rows = entries
    .filter((item) => !item.name.endsWith("/"))
    .map(
      (item) =>
        `${item.name},sha256=${createHash("sha256").update(item.data).digest("base64url")},${item.data.length}${newline}`,
    )
    .join("");
  const text = `${rows}${record},,${newline}`;
  return zip([...entries, { name: record, data: data(text) }]);
}
const execution = {
  Env: ["PATH=/usr/local/bin:/usr/bin"],
  Entrypoint: [
    "/usr/local/bin/python3.12",
    "-I",
    "-S",
    "-B",
    "/opt/tarubot/controller/launcher.py",
  ],
  Cmd: [],
  User: "10000:10000",
  WorkingDir: "/",
  Volumes: null,
  ExposedPorts: null,
  Healthcheck: null,
  OnBuild: null,
  Shell: null,
  StopSignal: "SIGTERM",
  ArgsEscaped: true,
};
function image(
  members: Member[],
  change: (config: Record<string, unknown>) => void = () => {},
): { archive: Buffer; expected: ControllerClosure } {
  const layer = tar(members),
    root = tree(members);
  const config: Record<string, unknown> = {
    architecture: "amd64",
    os: "linux",
    config: { ...execution },
    rootfs: { type: "layers", diff_ids: [`sha256:${controllerDigest(layer)}`] },
  };
  change(config);
  return {
    archive: tar([
      {
        path: "manifest.json",
        data: data(JSON.stringify([{ Config: "config.json", Layers: ["layer.tar"] }])),
      },
      { path: "config.json", data: data(JSON.stringify(config)) },
      { path: "layer.tar", data: layer },
    ]),
    expected: {
      rootfs_sha256: controllerTreeCommitment(root),
      recipe_sha256: "a".repeat(64),
      execution_config: execution,
      tree: root,
    },
  };
}
interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { architecture: string; os: string };
}
/** The fixture builds actual content-addressed graph bytes, never a native artifact origin. */
function ociImage(
  options: {
    indexes?: number;
    manifest?: (value: Record<string, unknown>) => void;
    root?: (value: Record<string, unknown>) => void;
    blobs?: (value: Map<string, Buffer>) => void;
    legacy?: (value: Record<string, unknown>) => void;
  } = {},
): {
  archive: Buffer;
  expected: ControllerClosure;
  ids: string[];
  wrapper: string;
  config: string;
} {
  const members = [{ path: "owned", data: data("safe") }];
  const expected = image(members).expected;
  const bytes = new Map<string, Buffer>(),
    ids: string[] = [];
  const blob = (body: Buffer, mediaType: string): Descriptor => {
    const hash = controllerDigest(body);
    bytes.set(`blobs/sha256/${hash}`, body);
    return { digest: `sha256:${hash}`, size: body.length, mediaType };
  };
  const rawLayer = tar(members),
    layer = blob(gzipSync(rawLayer), "application/vnd.oci.image.layer.v1.tar+gzip");
  const config = blob(
    data(
      JSON.stringify({
        architecture: "amd64",
        os: "linux",
        config: execution,
        rootfs: { type: "layers", diff_ids: [`sha256:${controllerDigest(rawLayer)}`] },
      }),
    ),
    "application/vnd.oci.image.config.v1+json",
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config,
    layers: [layer],
  };
  options.manifest?.(manifest);
  let selected = blob(data(JSON.stringify(manifest)), "application/vnd.oci.image.manifest.v1+json");
  ids.push(selected.digest);
  selected.platform = { architecture: "amd64", os: "linux" };
  for (let i = 0; i < (options.indexes ?? 0); i++) {
    selected = blob(
      data(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [selected],
        }),
      ),
      "application/vnd.oci.image.index.v1+json",
    );
    ids.unshift(selected.digest);
  }
  const root: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [selected],
  };
  options.root?.(root);
  options.blobs?.(bytes);
  const compatibility: Record<string, unknown> = {
    Config: `blobs/sha256/${config.digest.slice(7)}`,
    Layers: [`blobs/sha256/${layer.digest.slice(7)}`],
    RepoTags: null,
  };
  options.legacy?.(compatibility);
  const wrapper = data(JSON.stringify(root));
  return {
    archive: tar([
      { path: "blobs", type: "5" },
      { path: "blobs/sha256", type: "5" },
      ...[...bytes].map(([path, body]) => ({ path, data: body })),
      { path: "oci-layout", data: data('{"imageLayoutVersion":"1.0.0"}') },
      { path: "index.json", data: wrapper },
      { path: "manifest.json", data: data(JSON.stringify([compatibility])) },
    ]),
    expected,
    ids,
    wrapper: controllerDigest(wrapper),
    config: config.digest.slice(7),
  };
}

describe("independent controller archive semantics", () => {
  test("the reviewed catalogue is immutable data with no caller pin adoption", () => {
    const catalogue = reviewedControllerCatalogue();
    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(Object.isFrozen(catalogue.sources)).toBe(true);
    expect(Object.isFrozen(catalogue.base.layers[0])).toBe(true);
    expect(Object.isFrozen(catalogue.runtime.entrypoint)).toBe(true);
    expect(() => {
      catalogue.runtime.user = "0:0";
    }).toThrow();
    expect(reviewedControllerCatalogue().runtime.user).toBe("10000:10000");
  });
  test("intrinsic byte snapshots refuse shared memory and ignore shadowed iterator/length", () => {
    let offers = 0;
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, "byteLength", {
      get() {
        offers++;
        return 0;
      },
    });
    Object.defineProperty(bytes, Symbol.iterator, {
      value() {
        offers++;
        throw Error("private");
      },
    });
    expect([...controllerBytes(bytes)]).toEqual([1, 2, 3]);
    expect(offers).toBe(0);
    expect(() => controllerBytes(new Uint8Array(new SharedArrayBuffer(8)))).toThrow();
  });

  test("bounded JSON rejects duplicates, invalid UTF-8, nonfinite numbers and non-JSON spacing", () => {
    expect(controllerJson(data('{"a":[true,null,1]}'))).toEqual({ a: [true, null, 1] });
    for (const input of [
      data('{"a":1,"\\u0061":2}'),
      Buffer.from([255]),
      data("1e999"),
      data("\u00a0{}"),
      data("\ufeff{}"),
    ])
      expect(() => controllerJson(input)).toThrow("host-controller-closure-failed");
  });

  test("whiteouts remove lower entries and retain same-layer additions in either order", () => {
    for (const reversed of [false, true]) {
      const result = tree([
        { path: "old.py", data: data("old") },
        { path: "unexpected.py", data: data("lower") },
      ]);
      const layer: Member[] = [
        { path: "unexpected.py", data: data("new") },
        { path: ".wh.unexpected.py" },
        { path: ".wh.old.py" },
      ];
      applyControllerLayer(result, tar(reversed ? layer.reverse() : layer));
      expect(result.get("unexpected.py")?.bytes.toString()).toBe("new");
      expect(result.has("old.py")).toBe(false);
      expect(result.size).toBe(1);
    }
  });

  test("opaque whiteouts remove only lower descendants", () => {
    const result = tree([
      { path: "owned", type: "5" },
      { path: "owned/old", data: data("old") },
    ]);
    applyControllerLayer(
      result,
      tar([{ path: "owned/new", data: data("new") }, { path: "owned/.wh..wh..opq" }]),
    );
    expect(result.has("owned/old")).toBe(false);
    expect(result.get("owned/new")?.bytes.toString()).toBe("new");
    expect(result.get("owned")?.kind).toBe("directory");
    for (const path of [".wh..", ".wh...", "owned/.wh..."])
      expect(() => applyControllerLayer(result, tar([{ path }]))).toThrow();
  });

  test("retained hardlinks cannot follow a replacement or removed target", () => {
    const result = tree([
      { path: "a", data: data("original") },
      { path: "b", type: "1", target: "a" },
    ]);
    const original = controllerTreeCommitment(result);
    for (const layer of [[{ path: "a", data: data("replacement") }], [{ path: ".wh.a" }]]) {
      expect(() => applyControllerLayer(result, tar(layer))).toThrow();
      expect(controllerTreeCommitment(result)).toBe(original);
    }
    expect(() =>
      tree([
        { path: "a", data: data("original") },
        { path: "b", type: "1", target: "a", mode: 0o755 },
      ]),
    ).toThrow();
  });

  test("PAX path/owner/xattrs and link targets remain part of the complete commitment", () => {
    const result = tree([
      {
        path: "PaxHeader",
        type: "x",
        data: pax([
          ["path", "owned/file"],
          ["uid", "10000"],
          ["SCHILY.xattr.user.invented", "value"],
        ]),
      },
      { path: "placeholder", data: data("bytes") },
    ]);
    expect(result.get("owned/file")?.uid).toBe(10000);
    expect(result.get("owned/file")?.xattrs).toEqual({ "user.invented": "value" });
    const plain = tree([{ path: "owned/file", data: data("bytes"), uid: 10000 }]);
    expect(controllerTreeCommitment(result)).not.toBe(controllerTreeCommitment(plain));
    expect(() =>
      tree([
        {
          path: "PaxHeader",
          type: "x",
          data: pax([
            ["path", "a"],
            ["path", "b"],
          ]),
        },
        { path: "placeholder" },
      ]),
    ).toThrow();
  });

  test("traversal, duplicate members, late ancestor changes and incomplete tar trailers refuse atomically", () => {
    for (const members of [
      [{ path: "../escape" }],
      [{ path: "a" }, { path: "a" }],
      [{ path: "a/b" }, { path: "a", type: "2", target: "elsewhere" }],
      [{ path: "device", type: "3" }],
    ])
      expect(() => tree(members)).toThrow();
    const result = tree([{ path: "retained", data: data("safe") }]),
      before = controllerTreeCommitment(result);
    expect(() => applyControllerLayer(result, tar([{ path: "new" }]).subarray(0, 512))).toThrow();
    expect(controllerTreeCommitment(result)).toBe(before);
  });

  test("regular wheel members authenticate through RECORD while valid empty directories install no bytes", () => {
    for (const newline of ["\n", "\r\n"]) {
      const result = controllerWheel(
        wheel(
          [
            { name: "package/", data: Buffer.alloc(0), mode: 0o40755 },
            { name: "package/module.py", data: data("answer = 42\n") },
          ],
          newline,
        ),
      );
      expect([...result.keys()]).toEqual(["package/module.py", "invented-1.dist-info/RECORD"]);
      expect(result.get("package/module.py")?.toString()).toBe("answer = 42\n");
    }
  });

  test("wheel local/central divergence, forbidden import overrides and checksum substitutions refuse", () => {
    const valid = wheel([{ name: "package/module.py", data: data("answer = 42\n") }]);
    const changedLocal = Buffer.from(valid);
    changedLocal.writeUInt32LE(0, 14);
    expect(() => controllerWheel(changedLocal)).toThrow();
    for (const item of [
      { name: "../escape", data: data("bad") },
      { name: "package.pth", data: data("bad") },
      { name: "sitecustomize.py", data: data("bad") },
      { name: "link", data: data("target"), mode: 0o120777 },
    ])
      expect(() => controllerWheel(wheel([item]))).toThrow();
    const changedRecord = Buffer.from(valid),
      position = changedRecord.indexOf(data("sha256="));
    changedRecord[position + 7] = 65;
    expect(() => controllerWheel(changedRecord)).toThrow();
  });

  test("saved-image verification compares independent rootfs and closed execution configuration", () => {
    const good = image([{ path: "owned", data: data("safe") }]);
    expect(verifyControllerImage(good.archive, good.expected).rootfs_sha256).toBe(
      good.expected.rootfs_sha256,
    );
    const extra = image([
      { path: "owned", data: data("safe") },
      { path: "unexpected", data: data("code") },
    ]);
    expect(() => verifyControllerImage(extra.archive, good.expected)).toThrow();
    for (const changed of [
      "User",
      "Entrypoint",
      "Env",
      "Volumes",
      "OnBuild",
      "Hostname",
      "Domainname",
      "Tty",
      "OpenStdin",
      "ArgsEscaped",
      "AttachStdin",
      "Labels",
    ]) {
      const bad = image([{ path: "owned", data: data("safe") }], (value) => {
        (value.config as Record<string, unknown>)[changed] = "unexpected";
      });
      expect(() => verifyControllerImage(bad.archive, good.expected)).toThrow();
    }
    for (const flag of ["Tty", "OpenStdin"]) {
      const bad = image([{ path: "owned", data: data("safe") }], (value) => {
        (value.config as Record<string, unknown>)[flag] = true;
      });
      expect(() => verifyControllerImage(bad.archive, good.expected)).toThrow();
    }
    for (const value of [false, "true", null]) {
      const bad = image([{ path: "owned", data: data("safe") }], (config) => {
        (config.config as Record<string, unknown>).ArgsEscaped = value;
      });
      expect(() => verifyControllerImage(bad.archive, good.expected)).toThrow();
    }
    for (const value of [undefined, null, []]) {
      const allowed = image([{ path: "owned", data: data("safe") }], (config) => {
        if (value === undefined) delete (config.config as Record<string, unknown>).Cmd;
        else (config.config as Record<string, unknown>).Cmd = value;
      });
      expect(verifyControllerImage(allowed.archive, good.expected).rootfs_sha256).toBe(
        good.expected.rootfs_sha256,
      );
    }
    const command = image([{ path: "owned", data: data("safe") }], (config) => {
      (config.config as Record<string, unknown>).Cmd = ["unexpected"];
    });
    expect(() => verifyControllerImage(command.archive, good.expected)).toThrow();
    const mode = image([{ path: "owned", data: data("safe"), mode: 0o755 }]);
    expect(() => verifyControllerImage(mode.archive, good.expected)).toThrow();
  });
  test("read-only generated startup config bytes and permissions remain committed", () => {
    const path = "opt/tarubot/controller/ansible.cfg";
    const good = image([{ path, data: data("[defaults]\n"), mode: 0o444 }]);
    expect(verifyControllerImage(good.archive, good.expected).rootfs_sha256).toBe(
      good.expected.rootfs_sha256,
    );
    for (const changed of [
      { path, data: data("[defaults]\n"), mode: 0o644 },
      { path, data: data("[defaults]\ncallback_plugins=/unexpected\n"), mode: 0o444 },
    ]) {
      const bad = image([changed]);
      expect(() => verifyControllerImage(bad.archive, good.expected)).toThrow();
    }
  });

  test("unpinned public material cannot choose an expected rootfs", () => {
    expect(() =>
      deriveControllerClosure(
        { manifest: data("{}"), config: data("{}"), layers: [], wheels: {} },
        {} as ControllerRecipeBytes,
      ),
    ).toThrow("host-controller-closure-failed");
  });
  test("saved OCI IDs come only from the complete authenticated selected content graph", () => {
    for (const indexes of [0, 2]) {
      const fixture = ociImage({ indexes });
      const verified = verifyControllerImage(fixture.archive, fixture.expected);
      expect(verified.profile).toBe("oci-content");
      expect(verified.native_image_ids).toEqual(fixture.ids);
      expect(verified.native_image_ids.includes(`sha256:${fixture.config}`)).toBe(false);
      expect(verified.native_image_ids.includes(`sha256:${fixture.wrapper}`)).toBe(false);
      expect(verified.rootfs_sha256).toBe(fixture.expected.rootfs_sha256);
    }
    const legacy = image([{ path: "owned", data: data("safe") }]);
    const verified = verifyControllerImage(legacy.archive, legacy.expected);
    expect(verified.profile).toBe("legacy-config");
    expect(verified.native_image_ids).toEqual([`sha256:${verified.config_sha256}`]);
  });
  test("OCI descriptors refuse altered hashes, sizes, types and compression contracts", () => {
    for (const change of [
      (item: Descriptor) => {
        item.digest = `sha256:${"f".repeat(64)}`;
      },
      (item: Descriptor) => {
        item.size++;
      },
      (item: Descriptor) => {
        item.mediaType = "application/vnd.oci.image.layer.v1.tar";
      },
      (item: Descriptor) => {
        item.mediaType = "unknown";
      },
    ]) {
      const fixture = ociImage({
        manifest(value) {
          change((value.layers as Descriptor[])[0] as Descriptor);
        },
      });
      expect(() => verifyControllerImage(fixture.archive, fixture.expected)).toThrow(
        "host-controller-closure-failed",
      );
    }
    const changed = ociImage({
      blobs(values) {
        const entry = values.values().next().value as Buffer;
        entry[0] = 0;
      },
    });
    expect(() => verifyControllerImage(changed.archive, changed.expected)).toThrow();
  });
  test("OCI graph ambiguity, platform contradictions, attestation branches and excessive depth refuse", () => {
    const changes = [
      (root: Record<string, unknown>) => {
        (root.manifests as Descriptor[]).push((root.manifests as Descriptor[])[0] as Descriptor);
      },
      (root: Record<string, unknown>) => {
        ((root.manifests as Descriptor[])[0] as Descriptor).platform = {
          architecture: "arm64",
          os: "linux",
        };
      },
      (root: Record<string, unknown>) => {
        ((root.manifests as Descriptor[])[0] as Descriptor).platform = {
          architecture: "unknown",
          os: "unknown",
        };
      },
    ];
    for (const root of changes) {
      const fixture = ociImage({ root });
      expect(() => verifyControllerImage(fixture.archive, fixture.expected)).toThrow();
    }
    const deep = ociImage({ indexes: 5 });
    expect(() => verifyControllerImage(deep.archive, deep.expected)).toThrow();
    const extra = ociImage({
      blobs(values) {
        const body = data("{}");
        values.set(`blobs/sha256/${controllerDigest(body)}`, body);
      },
    });
    expect(() => verifyControllerImage(extra.archive, extra.expected)).toThrow();
  });
  test("legacy compatibility metadata cannot contradict the authenticated OCI selection", () => {
    const fixture = ociImage({
      legacy(value) {
        value.Config = "another-config.json";
      },
    });
    expect(() => verifyControllerImage(fixture.archive, fixture.expected)).toThrow();
  });
});
