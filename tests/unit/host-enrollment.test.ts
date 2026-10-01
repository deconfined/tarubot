import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  checkValidatedDns,
  HostEnrollmentRecords,
  plannedNewHostTargets,
  projectNewAppliedHosts,
  publishSshfp,
  scanEd25519,
  validateHostDns,
  verifyAppliedInstance,
  type AppliedHost,
  type EnrollmentHelpers,
} from "../../scripts/host-enrollment.js";
import { RecordCodec, type ControlStore } from "../../scripts/infra-control.js";

const blob = Buffer.concat([
  Buffer.from("0000000b", "hex"),
  Buffer.from("ssh-ed25519"),
  Buffer.from("00000020", "hex"),
  Buffer.alloc(32, 9),
]);
const observed = {
  key: `ssh-ed25519 ${blob.toString("base64")}`,
  sshfp: createHash("sha256").update(blob).digest("hex"),
};
const host: AppliedHost = {
  hostKey: "staging",
  target: "staging",
  instanceId: 123,
  fqdn: "bot.example.org",
  ipv4: "192.0.2.7",
  ipv6: "2001:db8::7",
  zoneId: "a".repeat(32),
  generation: "00000000-0000-0000-0000-000000000001",
  state: { lineage: "00000000-0000-0000-0000-000000000002", serial: 2, digest: "b".repeat(64) },
  run: { commit: "c".repeat(40), run: "42" },
  binding: "d".repeat(64),
};
const credentials = {
  linodeToken: "invented-linode-token",
  cloudflareToken: "invented-cloudflare-token",
};
const codec = () => new RecordCodec("invented-private-record-passphrase-12345", "e".repeat(64));
const goodHelpers: EnrollmentHelpers = {
  verifyInstance: async () => {},
  scanKey: async () => structuredClone(observed),
  publishSshfp: async () => {},
  validateDns: async () => {},
};
class MemoryStore implements ControlStore {
  readonly values = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.values.get(path)?.slice() ?? null;
  }
  async write(path: string, value: Uint8Array) {
    this.values.set(path, Uint8Array.from(value));
  }
}
function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("missing invented fixture item");
  return value;
}
function projectionFixture() {
  const inputs = {
    hosts: { staging: { role: "staging", fqdn: host.fqdn } },
    cloudflare_zone_id: host.zoneId,
  };
  const plan = {
    resource_changes: [
      {
        address: 'linode_instance.host["staging"]',
        mode: "managed",
        type: "linode_instance",
        name: "host",
        index: "staging",
        change: { actions: ["create"], before: null },
      },
    ],
  };
  const resource = (type: string, name: string, values: Record<string, unknown>) => ({
    address: `${type}.${name}["staging"]`,
    mode: "managed",
    type,
    name,
    index: "staging",
    values,
  });
  const applied = {
    values: {
      root_module: {
        resources: [
          resource("linode_instance", "host", {
            id: "123",
            ipv4: [host.ipv4],
            ipv6: `${host.ipv6}/128`,
          }),
          resource("cloudflare_dns_record", "a", {
            name: host.fqdn,
            zone_id: host.zoneId,
            type: "A",
            content: host.ipv4,
            proxied: false,
          }),
          resource("cloudflare_dns_record", "aaaa", {
            name: host.fqdn,
            zone_id: host.zoneId,
            type: "AAAA",
            content: host.ipv6,
            proxied: false,
          }),
        ],
      },
    },
  };
  const completion = {
    generation: host.generation,
    state: host.state,
    run: host.run,
    binding: host.binding,
  };
  return { plan, inputs, applied, completion };
}
describe("new applied-host projection", () => {
  test("uses actual applied instance and DNS resources with the completed baseline", () => {
    const f = projectionFixture();
    expect(plannedNewHostTargets(f.plan, f.inputs)).toEqual(["staging"]);
    expect(projectNewAppliedHosts(f.plan, f.applied, f.inputs, f.completion)).toEqual([host]);
    at(f.applied.values.root_module.resources, 0).values = {
      id: "456",
      ipv4: [host.ipv4],
      ipv6: `${host.ipv6}/128`,
    };
    expect(projectNewAppliedHosts(f.plan, f.applied, f.inputs, f.completion)[0]?.instanceId).toBe(
      456,
    );
  });
  test("does not reenroll replacements, updates or imports and rejects duplicate roles", () => {
    const f = projectionFixture();
    for (const actions of [["update"], ["no-op"]]) {
      at(f.plan.resource_changes, 0).change.actions = actions;
      expect(plannedNewHostTargets(f.plan, f.inputs)).toEqual([]);
      expect(projectNewAppliedHosts(f.plan, f.applied, f.inputs, f.completion)).toEqual([]);
    }
    at(f.plan.resource_changes, 0).change.actions = ["delete", "create"];
    expect(() => plannedNewHostTargets(f.plan, f.inputs)).toThrow("host-enrollment-failed");
    at(f.plan.resource_changes, 0).change.actions = ["create"];
    Object.assign(at(f.plan.resource_changes, 0).change, { importing: { id: "123" } });
    expect(() => plannedNewHostTargets(f.plan, f.inputs)).toThrow("host-enrollment-failed");
    delete (at(f.plan.resource_changes, 0).change as { importing?: unknown }).importing;
    Object.assign(f.inputs.hosts, { "staging-2": { role: "staging", fqdn: "other.example.org" } });
    expect(() => plannedNewHostTargets(f.plan, f.inputs)).toThrow("host-enrollment-failed");
  });
  test("refuses wrong DNS, duplicate actual resources, non-null before and unsafe instance IDs", () => {
    const mutate = [
      (f: ReturnType<typeof projectionFixture>) =>
        Object.assign(at(f.applied.values.root_module.resources, 1).values, {
          content: "192.0.2.8",
        }),
      (f: ReturnType<typeof projectionFixture>) =>
        f.applied.values.root_module.resources.push(at(f.applied.values.root_module.resources, 0)),
      (f: ReturnType<typeof projectionFixture>) =>
        Object.assign(at(f.plan.resource_changes, 0).change, { before: {} }),
      (f: ReturnType<typeof projectionFixture>) =>
        Object.assign(at(f.applied.values.root_module.resources, 0).values, {
          id: "9007199254740993",
        }),
    ];
    for (const change of mutate) {
      const f = projectionFixture();
      change(f);
      expect(() => projectNewAppliedHosts(f.plan, f.applied, f.inputs, f.completion)).toThrow(
        "host-enrollment-failed",
      );
    }
  });
});

describe("encrypted first enrollment", () => {
  test("persists all pending identities and immutable TOFU key before DNS, then clears pending", async () => {
    const store = new MemoryStore(),
      key = codec();
    const events: string[] = [];
    let records: HostEnrollmentRecords;
    records = new HostEnrollmentRecords(store, key, {
      ...goodHelpers,
      verifyInstance: async () => {
        expect((await records.inspect("staging"))?.observed).toBeNull();
        events.push("instance");
      },
      scanKey: async () => {
        events.push("scan");
        return observed;
      },
      publishSshfp: async () => {
        expect((await records.inspect("staging"))?.observed).toEqual(observed);
        await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
        events.push("publish");
      },
      validateDns: async () => {
        events.push("dns");
      },
    });
    await records.enroll([host], credentials, async () => {
      expect((await records.inspect("staging"))?.status).toBe("complete");
      await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
      events.push("finish");
    });
    expect(events).toEqual(["instance", "scan", "publish", "dns", "finish"]);
    expect((await records.inspect("staging"))?.status).toBe("complete");
    await records.requireNoPending();
    for (const bytes of store.values.values()) {
      expect(Buffer.from(bytes).includes(Buffer.from(host.fqdn))).toBe(false);
      expect(Buffer.from(bytes).includes(Buffer.from(observed.key))).toBe(false);
    }
    await expect(records.enroll([host], credentials, async () => {})).rejects.toThrow(
      "host-enrollment-failed",
    );
    expect(events).toHaveLength(5);
  });
  test("unknown DNS mutation stays pending with the same key and forbids another attempt", async () => {
    const store = new MemoryStore();
    let posts = 0;
    const records = new HostEnrollmentRecords(store, codec(), {
      ...goodHelpers,
      publishSshfp: async () => {
        posts++;
        throw new Error("private provider details");
      },
    });
    await expect(records.enroll([host], credentials, async () => {})).rejects.toThrow(
      /^host-enrollment-failed$/,
    );
    expect((await records.inspect("staging"))?.observed).toEqual(observed);
    await expect(records.enroll([], credentials, async () => {})).rejects.toThrow(
      "host-enrollment-failed",
    );
    expect(posts).toBe(1);
    await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
  });
  test("failed ciphertext readback prevents scan/mutation and keeps uncertainty fenced", async () => {
    const store = new MemoryStore();
    let scans = 0;
    const write = store.write.bind(store);
    store.write = async (path, bytes) => {
      await write(path, bytes);
      if (path === "hosts/staging") {
        const saved = store.values.get(path);
        if (saved) saved[20] = (saved[20] ?? 0) ^ 1;
      }
    };
    const records = new HostEnrollmentRecords(store, codec(), {
      ...goodHelpers,
      scanKey: async () => {
        scans++;
        return observed;
      },
    });
    await expect(records.enroll([host], credentials, async () => {})).rejects.toThrow(
      "host-enrollment-failed",
    );
    expect(scans).toBe(0);
    await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
  });
  test("pending index covers both targets even when the second host was never scanned", async () => {
    const production = {
      ...host,
      target: "production" as const,
      hostKey: "production",
      instanceId: 124,
      fqdn: "prod.example.org",
    };
    const records = new HostEnrollmentRecords(new MemoryStore(), codec(), {
      ...goodHelpers,
      verifyInstance: async () => {
        throw new Error();
      },
    });
    await expect(records.enroll([host, production], credentials, async () => {})).rejects.toThrow(
      "host-enrollment-failed",
    );
    expect((await records.inspect("production"))?.status).toBe("pending");
    await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
  });
  test("unknown Infra completion retains host pending, and empty enrollment still finishes Apply", async () => {
    const records = new HostEnrollmentRecords(new MemoryStore(), codec(), goodHelpers);
    let finishes = 0;
    await expect(
      records.enroll([host], credentials, async () => {
        finishes++;
        throw new Error("private failed finish");
      }),
    ).rejects.toThrow(/^host-enrollment-failed$/);
    expect((await records.inspect("staging"))?.status).toBe("complete");
    await expect(records.requireNoPending()).rejects.toThrow("host-enrollment-pending");
    expect(finishes).toBe(1);
    const empty = new HostEnrollmentRecords(new MemoryStore(), codec(), goodHelpers);
    await empty.enroll([], credentials, async () => {
      finishes++;
    });
    expect(finishes).toBe(2);
  });
});

const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const fetchFixture = (
  handler: (url: string, options: RequestInit) => Response | Promise<Response>,
) => handler as unknown as typeof fetch;
test("Linode reads bind actual ID and both addresses; boot polling is bounded and private", async () => {
  let gets = 0,
    sleeps = 0;
  const dependencies = {
    fetch: fetchFixture((url, options) => {
      expect(url).toBe("https://api.linode.com/v4/linode/instances/123");
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      gets++;
      return response({
        id: 123,
        ipv4: [host.ipv4],
        ipv6: `${host.ipv6}/128`,
        status: gets === 1 ? "booting" : "running",
      });
    }),
    sleep: async () => {
      sleeps++;
    },
  };
  await verifyAppliedInstance(host, credentials.linodeToken, dependencies);
  expect([gets, sleeps]).toEqual([2, 1]);
  dependencies.fetch = fetchFixture(() =>
    response({ id: 124, ipv4: [host.ipv4], ipv6: `${host.ipv6}/128`, status: "running" }),
  );
  await expect(verifyAppliedInstance(host, credentials.linodeToken, dependencies)).rejects.toThrow(
    /^host-enrollment-failed$/,
  );
});
// Minimal build images lack OpenSSH; hosted CI and the native lab run this executable check.
test.skipIf(Bun.which("/usr/bin/ssh-keygen") === null)(
  "stock keyscan tolerates unavailable IPv6 and keygen validates two consistent rounds",
  async () => {
    const scans: string[] = [];
    const result = await scanEd25519(host, {
      run: async (argv) => {
        if (argv[0]?.endsWith("ssh-keyscan")) {
          scans.push(argv.at(-1) ?? "");
          return {
            code: argv[1] === "-6" ? 1 : 0,
            stdout: argv[1] === "-6" ? "" : `${host.ipv4} ${observed.key}\n`,
          };
        }
        // Real local stock keygen reads invented public bytes only; no private key or host is used.
        const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
        return { code: result.exitCode, stdout: result.stdout.toString() };
      },
    });
    expect(result).toEqual(observed);
    expect(scans).toEqual([host.ipv4, host.ipv6, host.ipv4, host.ipv6]);
  },
);
test("reachable key disagreement and wrong scan address refuse instead of relearning", async () => {
  const other = Buffer.from(blob);
  other[50] = (other[50] ?? 0) ^ 1;
  for (const wrong of [false, true]) {
    await expect(
      scanEd25519(host, {
        run: async (argv) => ({
          code: 0,
          stdout: `${wrong ? "192.0.2.8" : argv.at(-1)} ssh-ed25519 ${argv[1] === "-6" ? other.toString("base64") : blob.toString("base64")}\n`,
        }),
      }),
    ).rejects.toThrow("host-enrollment-failed");
  }
});
function cloudflareRecord(fingerprint = observed.sshfp) {
  return {
    id: "f".repeat(32),
    name: host.fqdn,
    type: "SSHFP",
    data: { algorithm: 4, type: 2, fingerprint },
  };
}
function cloudflareList(records: unknown[]) {
  return {
    success: true,
    errors: [],
    result: records,
    result_info: { page: 1, total_count: records.length },
  };
}
test("Cloudflare writes once only when absent, then reads back exact SSHFP", async () => {
  const methods: string[] = [];
  let exists = false;
  await publishSshfp(host, observed.sshfp, credentials.cloudflareToken, {
    fetch: fetchFixture((_url, options) => {
      methods.push(options.method ?? "");
      if (options.method === "POST") {
        expect(JSON.parse(options.body as string).data).toEqual({
          algorithm: 4,
          type: 2,
          fingerprint: observed.sshfp,
        });
        exists = true;
        return response({ success: true, errors: [], result: cloudflareRecord() });
      }
      return response(cloudflareList(exists ? [cloudflareRecord()] : []));
    }),
  });
  expect(methods).toEqual(["GET", "POST", "GET"]);
});
test("exact existing SSHFP is read-only; duplicates/conflicts and unknown POST refuse", async () => {
  for (const records of [
    [cloudflareRecord()],
    [cloudflareRecord("0".repeat(64))],
    [cloudflareRecord(), cloudflareRecord()],
  ]) {
    let posts = 0;
    const work = publishSshfp(host, observed.sshfp, credentials.cloudflareToken, {
      fetch: fetchFixture((_url, options) => {
        if (options.method === "POST") posts++;
        return response(cloudflareList(records));
      }),
    });
    if (records.length === 1 && records[0]?.data.fingerprint === observed.sshfp) await work;
    else await expect(work).rejects.toThrow("host-enrollment-failed");
    expect(posts).toBe(0);
  }
  let posts = 0;
  await expect(
    publishSshfp(host, observed.sshfp, credentials.cloudflareToken, {
      fetch: fetchFixture((_url, options) => {
        if (options.method === "POST") {
          posts++;
          throw new Error("private provider uncertainty");
        }
        return response(cloudflareList([]));
      }),
    }),
  ).rejects.toThrow(/^host-enrollment-failed$/);
  expect(posts).toBe(1);
});
test("local DNS parsing requires validation and exact A/AAAA/SSHFP, while accepting signatures", () => {
  const output = (type: string, value: string) =>
    `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 7\n;; flags: qr rd ra ad; QUERY: 1, ANSWER: 2\n${host.fqdn}. 300 IN ${type} ${value}\n${host.fqdn}. 300 IN RRSIG ${type} 13 3 300 20271001000000 20260901000000 7 example.org. invented\n`;
  for (const [type, value] of [
    ["A", host.ipv4],
    ["AAAA", host.ipv6],
    ["SSHFP", `4 2 ${observed.sshfp}`],
  ] as const) {
    const text = output(type, value);
    expect(() => checkValidatedDns(text, host, type, observed.sshfp)).not.toThrow();
    for (const bad of [
      text.replace("ra ad", "ra"),
      text.replace("NOERROR", "SERVFAIL"),
      text.replace(host.fqdn, "other.example.org"),
      text.replace(
        value,
        type === "A" ? "192.0.2.8" : type === "AAAA" ? "2001:db8::8" : `4 2 ${"0".repeat(64)}`,
      ),
    ])
      expect(() => checkValidatedDns(bad, host, type, observed.sshfp)).toThrow(
        "host-enrollment-failed",
      );
  }
});
test("DNS helper launches a private local validator and closes it after all three validated queries", async () => {
  let killed = 0,
    configPath = "";
  const process = {
    exitCode: null,
    exited: Promise.resolve(0),
    kill: () => {
      killed++;
    },
  };
  const spawn = spyOn(Bun, "spawn").mockImplementation(
    ((_argv: string[]) => process) as unknown as typeof Bun.spawn,
  );
  try {
    const types: string[] = [];
    await validateHostDns(host, observed.sshfp, {
      run: async (argv) => {
        if (argv[0]?.endsWith("unbound-checkconf")) {
          configPath = argv[1] ?? "";
          const config = await readFile(configPath, "utf8");
          expect(config).toContain('module-config: "validator iterator"');
          expect(config).toContain('trust-anchor-file: "/usr/share/dns/root.key"');
          expect(config).toContain("val-permissive-mode: no");
          expect(config).toContain("interface: 127.0.0.1");
          return { code: 0, stdout: "" };
        }
        expect(argv.slice(0, 2)).toEqual(["/usr/bin/dig", "@127.0.0.1"]);
        expect(argv).toContain("+nocdflag");
        // Default dig splits long SSHFP hex into tokens; the native query disables that formatting.
        expect(argv).toContain("+split=0");
        const type = argv[5] ?? "";
        types.push(type);
        const value =
          type === "A" ? host.ipv4 : type === "AAAA" ? host.ipv6 : `4 2 ${observed.sshfp}`;
        return {
          code: 0,
          stdout: `;; status: NOERROR, id: 1\n;; flags: qr rd ra ad;\n${host.fqdn}. 300 IN ${type} ${value}\n`,
        };
      },
    });
    expect(types).toEqual(["A", "AAAA", "SSHFP"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(killed).toBe(1);
    await expect(readFile(configPath)).rejects.toThrow();
  } finally {
    spawn.mockRestore();
  }
});
