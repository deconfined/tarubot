/** Deployment trust uses genuine encrypted records and ordinary stock OpenSSH files. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HostEnrollmentRecords,
  type AppliedHost,
  type HostEnrollmentRecord,
} from "../../scripts/host-enrollment.js";
import { hostRecordCodec } from "../../scripts/infra-control-cli.js";
import type { ControlStore } from "../../scripts/infra-control.js";
import { hostTrust, prepareHostTrust, type HostTrustHelpers } from "../../scripts/host-trust.js";

const scratch = mkdtempSync(join(tmpdir(), "host-trust-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const blob = Buffer.concat([
  Buffer.from("0000000b", "hex"),
  Buffer.from("ssh-ed25519"),
  Buffer.from("00000020", "hex"),
  Buffer.alloc(32, 7),
]);
const record: HostEnrollmentRecord = {
  schema: 1,
  status: "complete",
  host: {
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
  },
  observed: {
    key: `ssh-ed25519 ${blob.toString("base64")}`,
    sshfp: createHash("sha256").update(blob).digest("hex"),
  },
};
const privateMarker =
  "-----BEGIN OPENSSH PRIVATE KEY-----\ninvented\n-----END OPENSSH PRIVATE KEY-----";
class MemoryStore implements ControlStore {
  values = new Map<string, Uint8Array>();
  reads: string[] = [];
  async read(path: string) {
    this.reads.push(path);
    return this.values.get(path)?.slice() ?? null;
  }
  async write(path: string, value: Uint8Array) {
    this.values.set(path, Uint8Array.from(value));
  }
}
function fixture(value: HostEnrollmentRecord | null = record) {
  const directory = mkdtempSync(join(scratch, "runner "));
  const store = new MemoryStore();
  const codec = hostRecordCodec(
    "example-bucket",
    "https://storage.example.org",
    "invented-private-record-passphrase-12345",
  );
  const persist = (path: string, value: unknown) => store.values.set(path, codec.seal(path, value));
  if (value) persist("hosts/staging", value);
  const records = new HostEnrollmentRecords(store, codec);
  const probes: string[] = [],
    masks: string[] = [],
    dns: Array<[AppliedHost, string]> = [];
  const helpers: HostTrustHelpers = {
    validateDns: async (host, sshfp) => {
      dns.push([structuredClone(host), sshfp]);
    },
    reachable: async (address) => {
      probes.push(address);
      return true;
    },
    checkPrivateKey: async () => {},
    mask: (value) => {
      masks.push(value);
    },
  };
  return {
    directory,
    store,
    records,
    persist,
    probes,
    masks,
    dns,
    helpers,
    ssh: join(directory, "ssh"),
  };
}
function inventory(directory: string) {
  return JSON.parse(readFileSync(join(directory, "inventory.json"), "utf8")).all.hosts.target;
}

describe("durable enrolled deployment trust", () => {
  test("reads encrypted completion twice, validates DNS once, and pins literal IPv6 with private stock files", async () => {
    const f = fixture();
    await prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers);
    expect(f.store.reads).toEqual([
      "hosts/pending",
      "hosts/staging",
      "hosts/pending",
      "hosts/staging",
    ]);
    expect(f.dns).toEqual([[record.host, record.observed?.sshfp ?? ""]]);
    expect(f.probes).toEqual([record.host.ipv6]);
    expect(statSync(f.ssh).mode & 0o777).toBe(0o700);
    for (const name of ["key", "known_hosts", "inventory.json"])
      expect(statSync(join(f.ssh, name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(f.ssh, "known_hosts"), "utf8")).toBe(
      `target ${record.observed?.key}\n`,
    );
    expect(readFileSync(join(f.ssh, "key"), "utf8")).toBe(`${privateMarker}\n`);
    const target = inventory(f.ssh);
    expect(target.ansible_host).toBe(record.host.ipv6);
    expect(target.ansible_user).toBe("root");
    expect(target.ansible_ssh_private_key_file).toBe(join(f.ssh, "key"));
    for (const argument of [
      "-F /dev/null",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "GlobalKnownHostsFile=/dev/null",
      "HostKeyAlias=target",
      "HostKeyAlgorithms=ssh-ed25519",
      "UpdateHostKeys=no",
      "VerifyHostKeyDNS=no",
      "AddressFamily=inet6",
      "LogLevel=FATAL",
    ])
      expect(target.ansible_ssh_common_args).toContain(argument);
    expect(target.ansible_ssh_common_args).toContain(
      `UserKnownHostsFile='"${join(f.ssh, "known_hosts")}"'`,
    );
    expect(f.masks).toContain(record.host.ipv4);
    expect(f.masks).toContain(record.host.ipv6);
    expect(f.masks).toContain(record.observed?.key ?? "");
  });

  test("an IPv6-unreachable runner uses IPv4 with the same stored key", async () => {
    const f = fixture();
    f.helpers.reachable = async (address) => {
      f.probes.push(address);
      return address === record.host.ipv4;
    };
    await prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers);
    expect(f.probes).toEqual([record.host.ipv6, record.host.ipv4]);
    expect(inventory(f.ssh).ansible_host).toBe(record.host.ipv4);
    expect(inventory(f.ssh).ansible_ssh_common_args).toContain("AddressFamily=inet");
    expect(readFileSync(join(f.ssh, "known_hosts"), "utf8")).toBe(
      `target ${record.observed?.key}\n`,
    );
  });

  test("absence, incomplete enrollment, a mismatched target and any global pending target stop before DNS", async () => {
    for (const value of [
      null,
      { ...record, status: "pending" as const },
      { ...record, host: { ...record.host, target: "production" as const } },
    ]) {
      const f = fixture(value);
      await expect(
        prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
      ).rejects.toThrow("host-trust-failed");
      expect(f.dns).toHaveLength(0);
      expect(existsSync(f.ssh)).toBe(false);
    }
    const f = fixture();
    f.persist("hosts/pending", { schema: 1, targets: ["production"] });
    await expect(
      prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
    ).rejects.toThrow("host-trust-failed");
    expect(f.dns).toHaveLength(0);
  });

  test("DNS validation and both-address reachability failures leave no inventory or credentials", async () => {
    const dns = fixture();
    dns.helpers.validateDns = async () => {
      throw new Error("invented-private-resolver-diagnostic");
    };
    await expect(
      prepareHostTrust("staging", dns.directory, privateMarker, dns.records, dns.helpers),
    ).rejects.toThrow(/^host-trust-failed$/u);
    expect(dns.probes).toHaveLength(0);
    expect(existsSync(dns.ssh)).toBe(false);
    const down = fixture();
    down.helpers.reachable = async (address) => {
      down.probes.push(address);
      return false;
    };
    await expect(
      prepareHostTrust("staging", down.directory, privateMarker, down.records, down.helpers),
    ).rejects.toThrow("host-trust-failed");
    expect(down.probes).toEqual([record.host.ipv6, record.host.ipv4]);
    expect(existsSync(down.ssh)).toBe(false);
  });

  test("reopens reject changed trust or new pending work before writing the inventory", async () => {
    for (const pending of [false, true]) {
      const f = fixture();
      f.helpers.reachable = async () => {
        if (pending) f.persist("hosts/pending", { schema: 1, targets: ["staging"] });
        else f.persist("hosts/staging", { ...record, host: { ...record.host, instanceId: 456 } });
        return true;
      };
      await expect(
        prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
      ).rejects.toThrow("host-trust-failed");
      expect(existsSync(f.ssh)).toBe(false);
    }
  });

  test("storage authentication failures remain private and do not start resolver/probe work", async () => {
    const f = fixture();
    const bytes = f.store.values.get("hosts/staging");
    if (!bytes) throw new Error("missing invented record");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(
      prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
    ).rejects.toThrow("host-trust-failed");
    expect(f.dns).toHaveLength(0);
    expect(existsSync(f.ssh)).toBe(false);
  });

  test("failed key validation removes only newly-created private files", async () => {
    const f = fixture();
    f.helpers.checkPrivateKey = async () => {
      throw new Error("invented-private-key-diagnostic");
    };
    await expect(
      prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
    ).rejects.toThrow("host-trust-failed");
    expect(existsSync(f.ssh)).toBe(false);
    mkdirSync(f.ssh);
    writeFileSync(join(f.ssh, "existing"), "keep");
    await expect(
      prepareHostTrust("staging", f.directory, privateMarker, f.records, f.helpers),
    ).rejects.toThrow("host-trust-failed");
    expect(readFileSync(join(f.ssh, "existing"), "utf8")).toBe("keep");
  });

  test.skipIf(Bun.which("ssh-keygen") === null)(
    "stock ssh-keygen accepts an invented unlocked key and refuses a locked key",
    async () => {
      for (const passphrase of ["", "invented-test-passphrase"]) {
        const f = fixture();
        const path = join(f.directory, "generated");
        const child = Bun.spawnSync([
          "ssh-keygen",
          "-q",
          "-t",
          "ed25519",
          "-N",
          passphrase,
          "-C",
          "",
          "-f",
          path,
        ]);
        expect(child.exitCode).toBe(0);
        const helpers = {
          validateDns: f.helpers.validateDns,
          reachable: f.helpers.reachable,
          mask: f.helpers.mask,
        };
        const promise = prepareHostTrust(
          "staging",
          f.directory,
          readFileSync(path, "utf8"),
          f.records,
          helpers,
        );
        if (passphrase) {
          await expect(promise).rejects.toThrow("host-trust-failed");
          expect(existsSync(f.ssh)).toBe(false);
        } else {
          await promise;
          expect(existsSync(join(f.ssh, "inventory.json"))).toBe(true);
        }
      }
    },
  );

  test("fixed CLI and production fence refuse before any storage or host work", async () => {
    await expect(hostTrust({ TARGET: "production" })).rejects.toThrow("host-trust-failed");
    const child = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL("../../scripts/host-trust.ts", import.meta.url)),
        "unexpected",
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", timeout: 5_000 },
    );
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toBe("::error::Host trust could not be verified.\n");
  });
});
