/** Scoped native storage tests use invented bytes/credentials and local presigning, never S3 HTTP. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createControlStorage,
  type ControlStorageConfig,
  type ControlStorageScope,
} from "../../scripts/control-storage.js";

const generation = "11111111-1111-4111-8111-111111111111";
function configuration(scope: ControlStorageScope = "infra"): ControlStorageConfig {
  return {
    scope,
    bucket: "invented-bucket",
    endpoint: "https://region.example.org",
    region: "us-east-1",
    credentials: {
      accessKeyId: "invented_access",
      secretAccessKey: "invented-secret",
      sessionToken: null,
    },
  };
}
function fake() {
  let options: Bun.S3Options = {};
  const calls: Array<{ method: string; key: string; options?: Bun.S3Options }> = [];
  const writes: Uint8Array[] = [];
  let readError: unknown = null;
  let partialReadError: unknown = null;
  let writeError: unknown = null;
  let presignError: unknown = null;
  let bytes: Uint8Array[] = [Uint8Array.from([1]), Uint8Array.from([2, 3])];
  let changeUrl: (url: URL) => void = () => {};
  let openStream = false;
  let cancelled = 0;
  let beforeWrite: () => Promise<void> = async () => {};
  const client = {
    presign(key: string) {
      calls.push({ method: "presign", key });
      if (presignError !== null) throw presignError;
      const url = new URL(`${options.endpoint}/${key}`);
      url.searchParams.set("X-Amz-Date", "20260930T000000Z");
      url.searchParams.set(
        "X-Amz-Credential",
        `${options.accessKeyId}/20260930/${options.region}/s3/aws4_request`,
      );
      if (options.sessionToken) url.searchParams.set("X-Amz-Security-Token", options.sessionToken);
      changeUrl(url);
      return url.toString();
    },
    file(key: string, fileOptions: Bun.S3Options) {
      calls.push({ method: "read", key, options: structuredClone(fileOptions) });
      return {
        stream() {
          if (partialReadError !== null) {
            let part = 0;
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                if (part++ === 0) controller.enqueue(Uint8Array.from([1]));
                else controller.error(partialReadError);
              },
            });
          }
          return new ReadableStream<Uint8Array>({
            start(controller) {
              if (readError !== null) controller.error(readError);
              else {
                for (const chunk of bytes) controller.enqueue(chunk);
                if (!openStream) controller.close();
              }
            },
            cancel() {
              cancelled++;
            },
          });
        },
      };
    },
    async write(key: string, value: Uint8Array, writeOptions: Bun.S3Options) {
      calls.push({ method: "write", key, options: structuredClone(writeOptions) });
      await beforeWrite();
      writes.push(Uint8Array.from(value));
      if (writeError !== null) throw writeError;
      return value.length;
    },
  };
  const factory = (received: Bun.S3Options) => {
    options = structuredClone(received);
    return client as unknown as Bun.S3Client;
  };
  return {
    calls,
    writes,
    factory,
    options: () => options,
    cancelled: () => cancelled,
    error: (value: unknown) => {
      readError = value;
    },
    partialError: (value: unknown) => {
      partialReadError = value;
    },
    writeError: (value: unknown) => {
      writeError = value;
    },
    presignError: (value: unknown) => {
      presignError = value;
    },
    bytes: (value: Uint8Array[], open = false) => {
      bytes = value;
      openStream = open;
    },
    changeUrl: (edit: (url: URL) => void) => {
      changeUrl = edit;
    },
    beforeWrite: (callback: () => Promise<void>) => {
      beforeWrite = callback;
    },
  };
}

/** Synchronous native-shaped seams expose each offer without opening a connection. */
function nativeOffers() {
  let options: Bun.S3Options = {};
  let hook: (phase: string) => void = () => {};
  const offers: string[] = [];
  let part = 0;
  const reader = {
    get read() {
      hook("read-getter");
      return async () => {
        offers.push("read");
        hook("read");
        return part++ === 0 ? { done: false, value: Uint8Array.from([7]) } : { done: true };
      };
    },
    cancel: async () => {
      hook("cancel");
    },
    releaseLock: () => {
      hook("release");
    },
  };
  const stream = {
    get getReader() {
      hook("getReader-getter");
      return () => {
        offers.push("getReader");
        return reader;
      };
    },
  };
  const file = {
    get stream() {
      hook("stream-getter");
      return () => {
        offers.push("stream");
        return stream;
      };
    },
  };
  const client = {
    presign(key: string) {
      hook("presign");
      const url = new URL(`${options.endpoint}/${key}`);
      url.searchParams.set("X-Amz-Date", "20260930T000000Z");
      url.searchParams.set(
        "X-Amz-Credential",
        `${options.accessKeyId}/20260930/${options.region}/s3/aws4_request`,
      );
      return url.toString();
    },
    file() {
      offers.push("file");
      hook("file");
      return file;
    },
    get write() {
      hook("write-getter");
      return async () => {
        offers.push("write");
        return 1;
      };
    },
  };
  const store = createControlStorage(configuration(), {
    createClient(received) {
      options = received;
      return client as unknown as Bun.S3Client;
    },
  });
  return {
    store,
    offers,
    setHook(value: typeof hook) {
      hook = value;
    },
  };
}

describe("scoped native control storage", () => {
  test("cross-realm rejected refusals stay private and arbitrary thenable getters are never invoked", () => {
    const storagePath = new URL("../../scripts/control-storage.ts", import.meta.url).pathname;
    const consumerPath = new URL("../../scripts/control-consumer.ts", import.meta.url).pathname;
    const ownerPath = new URL("../../scripts/control-owner-boundary.ts", import.meta.url).pathname;
    const program = `
      import { runInNewContext } from "node:vm";
      import { createControlStorage } from ${JSON.stringify(storagePath)};
      import { ControlConsumerGuard } from ${JSON.stringify(consumerPath)};
      import { GitHubControlOwnerBoundary } from ${JSON.stringify(ownerPath)};
      let options, offers = 0, unhandled = 0, thenGetters = 0, refused = 0;
      process.on("unhandledRejection", () => { unhandled++; });
      const store = createControlStorage(${JSON.stringify(configuration())}, {
        createClient(value) {
          options = value;
          return {
            presign(key) {
              const url = new URL(options.endpoint + "/" + key);
              url.searchParams.set("X-Amz-Date", "20260930T000000Z");
              url.searchParams.set("X-Amz-Credential", options.accessKeyId + "/20260930/" + options.region + "/s3/aws4_request");
              return url.toString();
            },
            file() { offers++; throw Error("unexpected-offer"); },
            write: async () => { offers++; throw Error("unexpected-offer"); },
          };
        },
      });
      const scope = { target: "infra", backend: "a".repeat(64), namespace: store.namespace };
      const owner = new GitHubControlOwnerBoundary({
        ...scope, passphrase: "invented control passphrase with sufficient entropy",
        owner_id: 123456, repository_id: 234567, environment_id: 1010,
        token: "invented_owner_read_token_12345",
      }, {
        store: { read: store.read.bind(store), write: async () => {}, readVersion: async () => null },
        get: async () => { offers++; throw Error("unexpected-offer"); }, now: () => 1800000000000,
      });
      const guard = new ControlConsumerGuard(scope, { store, owner, now: () => 1800000000000 });
      for (const foreign of [true, false]) {
        for (const layer of ["read", "write", "consumer", "owner"]) {
          const value = foreign ? runInNewContext('Promise.reject(Error("invented-private-rejection"))')
            : Object.defineProperty({}, "then", { get() { thenGetters++; throw Error("private-then-getter"); } });
          const callback = () => value;
          try {
            if (layer === "read") await store.read("current", callback);
            else if (layer === "write") await store.write("current", Uint8Array.from([1]), callback);
            else if (layer === "consumer") await guard.check(undefined, callback);
            else await owner.readOwnerAnchor(scope, callback);
          } catch(error) {
            const expected = layer === "read" ? "control-storage-read-failed" : layer === "write"
              ? "control-storage-write-failed" : layer === "consumer" ? "control-consumer-guard-failed" : "invalid-control-owner-boundary";
            if (error.message === expected) refused++;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      console.log(JSON.stringify({ refused, offers, unhandled, thenGetters }));
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exit: child.exitCode, diagnostic: Buffer.from(child.stderr).toString() }).toEqual({
      exit: 0,
      diagnostic: "",
    });
    expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
      refused: 8,
      offers: 0,
      unhandled: 0,
      thenGetters: 0,
    });
  });
  test("original read refusal blocks each late routing/getter offer and never captures write", async () => {
    const cases = [
      ["presign", []],
      ["file", ["file"]],
      ["stream-getter", ["file"]],
      ["getReader-getter", ["file", "stream"]],
      ["read-getter", ["file", "stream", "getReader"]],
      ["read", ["file", "stream", "getReader", "read"]],
      ["release", ["file", "stream", "getReader", "read", "read"]],
    ] as const;
    for (const [phase, expected] of cases) {
      const f = nativeOffers();
      let live = true,
        writeGetters = 0;
      f.setHook((at) => {
        if (at === phase) live = false;
        if (at === "write-getter") writeGetters++;
      });
      await expect(
        f.store.read("current", () => {
          if (!live) throw new Error("private-expired");
        }),
      ).rejects.toThrow("control-storage-read-failed");
      expect(f.offers).toEqual([...expected]);
      expect(writeGetters).toBe(0);
    }
    const valid = nativeOffers();
    valid.setHook((phase) => {
      if (phase === "write-getter") throw new Error("read exposed mutation");
    });
    expect(await valid.store.read("current", () => {})).toEqual(Uint8Array.from([7]));
  });
  test("swallowed nested getter denials permanently fence the owning native read", async () => {
    for (const phase of ["presign", "stream-getter", "getReader-getter", "read-getter"]) {
      const f = nativeOffers();
      f.setHook((at) => {
        if (at === phase) void f.store.read("wrong-private-key").catch(() => {});
      });
      await expect(f.store.read("current", () => {})).rejects.toThrow(
        "control-storage-read-failed",
      );
      expect(f.offers).not.toContain("read");
    }
  });
  test("write getter expiry and swallowed reentry refuse the actual SDK mutation", async () => {
    for (const nested of [false, true]) {
      const f = nativeOffers();
      let live = true;
      f.setHook((phase) => {
        if (phase !== "write-getter") return;
        if (nested) void f.store.write("wrong-private-key", Uint8Array.from([1])).catch(() => {});
        else live = false;
      });
      await expect(
        f.store.write("current", Uint8Array.from([1]), () => {
          if (!live) throw new Error("private-expired");
        }),
      ).rejects.toThrow("control-storage-write-failed");
      expect(f.offers).toEqual([]);
    }
  });
  test("read callbacks can only refuse, and expired or accessor absence never returns null", async () => {
    for (const value of [
      true,
      false,
      {},
      Promise.resolve(),
      Promise.reject(new Error("private-refusal")),
    ]) {
      const f = nativeOffers();
      await expect(f.store.read("current", (() => value) as () => void)).rejects.toThrow(
        "control-storage-read-failed",
      );
      expect(f.offers).toEqual([]);
    }
    const inherited = fake();
    const inheritedError = new Error("private-absence");
    Object.setPrototypeOf(
      inheritedError,
      Object.assign(Object.create(Error.prototype), { code: "NoSuchKey" }),
    );
    inherited.error(inheritedError);
    await expect(
      createControlStorage(configuration(), { createClient: inherited.factory }).read("current"),
    ).rejects.toThrow("control-storage-read-failed");
    const accessor = fake();
    const error = new Error("private-absence");
    let getterCalls = 0;
    Object.defineProperty(error, "code", {
      get() {
        getterCalls++;
        return "NoSuchKey";
      },
    });
    accessor.error(error);
    await expect(
      createControlStorage(configuration(), { createClient: accessor.factory }).read("current"),
    ).rejects.toThrow("control-storage-read-failed");
    expect(getterCalls).toBe(0);
    const late = fake();
    let live = true;
    late.error(
      new Proxy(Object.assign(new Error("private-absence"), { code: "NoSuchKey" }), {
        getOwnPropertyDescriptor(value, name) {
          live = false;
          return Reflect.getOwnPropertyDescriptor(value, name);
        },
      }),
    );
    await expect(
      createControlStorage(configuration(), { createClient: late.factory }).read("current", () => {
        if (!live) throw new Error("private-expired");
      }),
    ).rejects.toThrow("control-storage-read-failed");
  });
  test("cleanup reentry cannot turn an uncertain read into authenticated absence", async () => {
    for (const phase of ["cancel", "release"]) {
      const f = nativeOffers();
      f.setHook((at) => {
        if (at === "read") throw Object.assign(new Error("private-absence"), { code: "NoSuchKey" });
        if (at === phase) void f.store.read("wrong-private-key").catch(() => {});
      });
      await expect(f.store.read("current", () => {})).rejects.toThrow(
        "control-storage-read-failed",
      );
      expect(f.offers).toEqual(["file", "stream", "getReader", "read"]);
    }
  });
  test("captured denial fence runs after routing preparation immediately before the SDK mutation", async () => {
    const f = fake();
    const store = createControlStorage(configuration(), { createClient: f.factory });
    const bytes = Uint8Array.from([1, 2]);
    let clock = 10;
    const deny = () => {
      if (clock >= 20) throw new Error("invented private expired proof");
    };
    f.changeUrl(() => {
      clock = 20;
      bytes[0] = 9;
    });
    await expect(store.write("current", bytes, deny)).rejects.toThrow(
      "control-storage-write-failed",
    );
    expect(f.calls.filter((call) => call.method === "write")).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    clock = 19;
    f.changeUrl(() => {
      bytes[0] = 8;
    });
    await store.write("current", bytes, deny);
    expect(f.writes).toEqual([Uint8Array.from([9, 2])]);
    const count = f.calls.length;
    await expect(store.write("current", bytes, true as unknown as () => void)).rejects.toThrow(
      "invalid-control-storage",
    );
    expect(f.calls).toHaveLength(count);
    await expect(store.write("current", bytes, async () => {})).rejects.toThrow(
      "control-storage-write-failed",
    );
    expect(f.calls.filter((call) => call.method === "write")).toHaveLength(1);
  });
  test("constructor configuration is snapshotted before accessor side effects can substitute authority", () => {
    const f = fake();
    const config = configuration();
    const credentials = structuredClone(config.credentials);
    Object.defineProperty(config, "credentials", {
      enumerable: true,
      get: () => {
        config.scope = "trust-production";
        config.endpoint = "https://other.example.org";
        return credentials;
      },
    });
    const store = createControlStorage(config, { createClient: f.factory });
    expect(config.scope).toBe("trust-production");
    expect(store.scope).toBe("infra");
    expect(store.namespace).toBe("tarubot/control/v1/infra/");
    expect(f.options().endpoint).toBe("https://invented-bucket.region.example.org");
    const broken = configuration();
    Object.defineProperty(broken, "credentials", {
      enumerable: true,
      get: () => {
        throw new Error("invented-private-accessor-diagnostic");
      },
    });
    expect(() => createControlStorage(broken, { createClient: fake().factory })).toThrow(
      "invalid-control-storage",
    );
  });
  test("diagnostics expose only public metadata and external properties cannot replace routing or credentials", async () => {
    const f = fake();
    const config = configuration();
    config.credentials.sessionToken = "invented-private-session-marker";
    const store = createControlStorage(config, { createClient: f.factory });
    expect(Object.keys(store).sort()).toEqual(["binding", "namespace", "scope"]);
    for (const diagnostic of [JSON.stringify(store), Bun.inspect(store)])
      for (const privateValue of Object.values(config.credentials))
        if (privateValue !== null) expect(diagnostic).not.toContain(privateValue);
    // Public freezing and runtime-private fields prevent recovering or replacing mutable internals.
    for (const field of ["client", "config", "endpoint", "allowed", "key", "assertClient"])
      expect(Reflect.get(store, field)).toBeUndefined();
    for (const [field, value] of [
      ["client", { write: () => "invented bypass" }],
      ["config", { ...config, scope: "trust-production" }],
      ["endpoint", "https://other.example.org"],
      ["allowed", /.*/u],
      ["key", () => "tarubot/infra.tfstate"],
      ["assertClient", () => {}],
      ["namespace", "tarubot/control/v1/trust-production/"],
      ["scope", "trust-production"],
    ] as const)
      expect(Reflect.set(store, field, value)).toBe(false);
    config.endpoint = "https://other.example.org";
    config.region = "other-region";
    config.credentials.accessKeyId = "other_access";
    config.credentials.sessionToken = "other-session";
    expect(await store.read("current")).toEqual(Uint8Array.from([1, 2, 3]));
    await store.write(`baselines/${generation}`, Uint8Array.from([4]));
    expect(f.calls.every((call) => call.key.startsWith("tarubot/control/v1/infra/"))).toBe(true);
    await expect(store.read("tarubot/infra.tfstate")).rejects.toThrow("invalid-control-storage");
    expect(f.options().endpoint).toBe("https://invented-bucket.region.example.org");
    expect(f.options().accessKeyId).toBe("invented_access");
  });
  test("qualifies the regional origin exactly once and preserves the existing infra prefix", async () => {
    const f = fake();
    const config = configuration();
    const store = createControlStorage(config, { createClient: f.factory });
    expect(f.options()).toEqual({
      bucket: "invented-bucket",
      endpoint: "https://invented-bucket.region.example.org",
      region: "us-east-1",
      virtualHostedStyle: true,
      retry: 0,
      accessKeyId: "invented_access",
      secretAccessKey: "invented-secret",
      sessionToken: "",
    });
    config.bucket = "changed-bucket";
    config.credentials.accessKeyId = "changed_access";
    expect(store.scope).toBe("infra");
    expect(store.namespace).toBe("tarubot/control/v1/infra/");
    expect(Object.isFrozen(store)).toBe(true);
    expect(await store.read("current")).toEqual(Uint8Array.from([1, 2, 3]));
    await store.write(`baselines/${generation}`, Uint8Array.from([4]));
    expect(f.calls.filter((call) => call.method !== "presign")).toEqual([
      { method: "read", key: `${store.namespace}current`, options: { retry: 0 } },
      {
        method: "write",
        key: `${store.namespace}baselines/${generation}`,
        options: { type: "application/octet-stream", retry: 0 },
      },
    ]);
    const other = configuration();
    other.credentials.secretAccessKey = "different-invented-secret";
    expect(createControlStorage(other, { createClient: fake().factory }).binding).toBe(
      store.binding,
    );
    other.bucket = "other-bucket";
    expect(createControlStorage(other, { createClient: fake().factory }).binding).not.toBe(
      store.binding,
    );
  });
  test("allows exact journal and repair keys within three disjoint physical scopes", async () => {
    const namespaces = new Set<string>();
    for (const scope of ["infra", "trust-staging", "trust-production"] as const) {
      const f = fake();
      const store = createControlStorage(configuration(scope), { createClient: f.factory });
      namespaces.add(store.namespace);
      const target = scope === "infra" ? "infra" : scope.slice("trust-".length);
      const keys =
        target === "infra"
          ? [
              "current",
              ...["intents", "baselines", "completed"].map((key) => `${key}/${generation}`),
            ]
          : [
              ...["registration", "authorization-current", "current"].map(
                (key) => `trust/${target}/${key}`,
              ),
              ...[
                "authorizations",
                "attempts",
                "consumed",
                "intents",
                "references",
                "records",
                "publication-intents",
                "publications",
                "completed",
              ].map((key) => `trust/${target}/${key}/${generation}`),
            ];
      keys.push(
        `recovery/${target}/registration`,
        `recovery/${target}/current`,
        `recovery/${target}/intents/${generation}`,
        `recovery/${target}/completed/${generation}`,
      );
      for (const key of keys) {
        expect(await store.read(key)).toEqual(Uint8Array.from([1, 2, 3]));
        await store.write(key, Uint8Array.from([4]));
      }
      expect(f.calls.every((call) => call.key.startsWith(store.namespace))).toBe(true);
    }
    expect(namespaces.size).toBe(3);
  });
  test("state, traversal, foreign roles and unknown keys fail before any native operation", async () => {
    for (const scope of ["infra", "trust-staging", "trust-production"] as const) {
      const f = fake();
      const store = createControlStorage(configuration(scope), { createClient: f.factory });
      const count = f.calls.length;
      const target = scope === "infra" ? "infra" : scope.slice("trust-".length);
      const foreign = target === "staging" ? "production" : "staging";
      for (const key of [
        "",
        "tarubot/infra.tfstate",
        "/current",
        "../current",
        "current/..",
        "current?versionId=invented",
        "current#private",
        "current\n",
        "current%2f..",
        "current\\..",
        "intents/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        `baselines/${generation}/extra`,
        `trust/${foreign}/current`,
        `recovery/${foreign}/current`,
        `recovery/${target}/unknown/${generation}`,
        scope === "infra" ? "trust/staging/registration" : "current",
      ]) {
        await expect(store.read(key)).rejects.toThrow("invalid-control-storage");
        await expect(store.write(key, Uint8Array.from([1]))).rejects.toThrow(
          "invalid-control-storage",
        );
      }
      expect(f.calls).toHaveLength(count);
    }
  });
  test("closed canonical configuration rejects ambiguous addressing and implicit credentials", () => {
    const deltas = [
      { scope: "staging" },
      { bucket: "a" },
      { bucket: "dotted.bucket" },
      { bucket: "-bucket" },
      { bucket: "Bucket" },
      { bucket: "b".repeat(64) },
      { endpoint: "http://region.example.org" },
      { endpoint: "https://REGION.example.org" },
      { endpoint: "https://region.example.org/" },
      { endpoint: "https://region.example.org:443" },
      { endpoint: "https://invented-bucket.region.example.org" },
      { endpoint: "https://user:private@region.example.org" },
      { endpoint: "https://region.example.org?private" },
      { endpoint: "https://region.example.org#private" },
      { endpoint: "https://192.0.2.1" },
      { endpoint: "https://region..example.org" },
      { endpoint: `https://${"r".repeat(64)}.example.org` },
      { endpoint: `https://${Array(4).fill("r".repeat(60)).join(".")}` },
      { region: "" },
      { region: "us-east-1/private" },
      { prefix: "tarubot/infra.tfstate" },
      { credentials: { accessKeyId: "invented", secretAccessKey: "invented" } },
      { credentials: { ...configuration().credentials, sessionToken: "" } },
      { credentials: { ...configuration().credentials, accessKeyId: "private\n" } },
      { credentials: { ...configuration().credentials, secretAccessKey: "private\r" } },
      { credentials: { ...configuration().credentials, sessionToken: "private\n" } },
      { credentials: { ...configuration().credentials, profile: "private" } },
    ];
    for (const delta of deltas) {
      let called = false;
      expect(() =>
        createControlStorage({ ...configuration(), ...delta } as ControlStorageConfig, {
          createClient: () => {
            called = true;
            throw new Error("invented-private-constructor-error");
          },
        }),
      ).toThrow("invalid-control-storage");
      expect(called).toBe(false);
    }
  });
  test("local preflight rejects wrong native routing and effective credential scope", async () => {
    const changes: Array<(url: URL) => void> = [
      (url) => {
        url.hostname = "region.example.org";
      },
      (url) => {
        url.pathname = "/other/current";
      },
      (url) => {
        url.username = "private";
      },
      (url) => {
        url.searchParams.set("X-Amz-Credential", "invented_access/20260930/other/s3/aws4_request");
      },
      (url) => {
        url.searchParams.append("X-Amz-Credential", "invented-duplicate");
      },
      (url) => {
        url.searchParams.set("X-Amz-Security-Token", "invented-ambient-session");
      },
      (url) => {
        url.searchParams.delete("X-Amz-Date");
      },
    ];
    for (const change of changes) {
      const f = fake();
      f.changeUrl(change);
      expect(() => createControlStorage(configuration(), { createClient: f.factory })).toThrow(
        "invalid-control-storage",
      );
      expect(f.calls.map((call) => call.method)).toEqual(["presign"]);
    }
    // Preflight failures cannot masquerade as a missing object, including between operations.
    const f = fake();
    const store = createControlStorage(configuration(), { createClient: f.factory });
    f.presignError(Object.assign(new Error("invented-private"), { code: "NoSuchKey" }));
    await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    await expect(store.write("current", Uint8Array.from([1]))).rejects.toThrow(
      "control-storage-write-failed",
    );
    expect(f.calls.every((call) => call.method === "presign")).toBe(true);
  });
  test("only explicit object NoSuchKey is absence; write acknowledgement failure never retries", async () => {
    for (const code of ["NoSuchKey", "AccessDenied", "NoSuchBucket", "Timeout", "404"]) {
      const f = fake();
      const store = createControlStorage(configuration(), { createClient: f.factory });
      f.error(Object.assign(new Error("invented-private-diagnostic"), { code }));
      if (code === "NoSuchKey") expect(await store.read("current")).toBeNull();
      else await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
      expect(f.calls.filter((call) => call.method === "read")).toHaveLength(1);
    }
    const f = fake();
    const store = createControlStorage(configuration(), { createClient: f.factory });
    f.error({ code: "NoSuchKey" });
    await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    f.partialError(Object.assign(new Error("invented-partial-read"), { code: "NoSuchKey" }));
    await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    f.writeError(new Error("invented-private-acknowledgement-error"));
    await expect(store.write("current", Uint8Array.from([1]))).rejects.toThrow(
      "control-storage-write-failed",
    );
    expect(f.calls.filter((call) => call.method === "write")).toHaveLength(1);
    expect(f.writes).toEqual([Uint8Array.from([1])]);
  });
  test("empty or oversized objects fail, oversized streams cancel, and pending writes copy input", async () => {
    const f = fake();
    const store = createControlStorage(configuration(), { createClient: f.factory });
    f.bytes([]);
    await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    f.bytes([new Uint8Array(64 * 1024 * 1024 + 1)], true);
    await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    expect(f.cancelled()).toBe(1);
    for (const bytes of [new Uint8Array(0), new Uint8Array(64 * 1024 * 1024 + 1)])
      await expect(store.write("current", bytes)).rejects.toThrow("invalid-control-storage");
    expect(f.calls.filter((call) => call.method === "write")).toHaveLength(0);
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.beforeWrite(() => waiting);
    const bytes = Uint8Array.from([7, 8]);
    const writing = store.write("current", bytes);
    bytes.fill(9);
    finish();
    await writing;
    expect(f.writes).toEqual([Uint8Array.from([7, 8])]);
  });
  test("native minimal-env presigning proves bucket routing and refuses inherited session credentials", () => {
    const moduleUrl = new URL("../../scripts/control-storage.ts", import.meta.url).href;
    const probe = (ambient: boolean, temporary: boolean) => {
      const config = configuration("trust-staging");
      if (temporary) config.credentials.sessionToken = "invented-explicit-session";
      const code = `
        import {createControlStorage} from ${JSON.stringify(moduleUrl)};
        try {
          const store=createControlStorage(${JSON.stringify(config)});
          console.log(store.namespace === "tarubot/control/v1/trust-staging/" ? "ok" : "wrong");
        } catch(error) {
          console.log(error instanceof Error && error.message === "invalid-control-storage"
            ? "invalid-control-storage" : "unexpected");
        }
      `;
      // No inherited environment, dotenv or URL/query diagnostics reach this child process.
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
        env: {
          PATH: "/usr/bin:/bin",
          ...(ambient
            ? {
                S3_SESSION_TOKEN: "invented-ambient-session",
                AWS_SESSION_TOKEN: "invented-other-ambient-session",
              }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stderr).toString()).toBe("");
      return Buffer.from(result.stdout).toString().trim();
    };
    expect(probe(false, false)).toBe("ok");
    expect(probe(true, false)).toBe("invalid-control-storage");
    expect(probe(true, true)).toBe("ok");
    const source = readFileSync(
      new URL("../../scripts/control-storage.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("import.meta.main");
    expect(source).not.toContain("readVersion(");
  });
});
