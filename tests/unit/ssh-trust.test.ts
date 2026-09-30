/**
 * Pure trust foundation tests use invented encrypted storage, RFC keys and documentation
 * addresses. They perform no resolution, provider mutation, subprocess or SSH authentication.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { privateDigest, RecordCodec, type ControlStore } from "../../scripts/infra-control.js";
import {
  canonicalEd25519,
  dnssecEvidence,
  enrollmentAuthorization,
  targetDescriptor,
  TrustJournal,
  type DnssecEvidence,
  type DnsWriter,
  type EnrollmentAuthorization,
  type PublicationRequest,
  type ScanEvidence,
  type Sshfp,
  type SshfpRecord,
  type TargetDescriptor,
  type ValidatorPin,
} from "../../scripts/ssh-trust.js";

const passphrase = "invented dedicated staging trust passphrase with sufficient entropy";
const backend = "a".repeat(64);
const initialGeneration = "11111111-1111-4111-8111-111111111111";
const rotationGeneration = "22222222-2222-4222-8222-222222222222";
const appliedGeneration = "33333333-3333-4333-8333-333333333333";
const enrollmentRun = { commit: "1".repeat(40), run: "12345" };
const approvalRun = { commit: "2".repeat(40), run: "12344" };
const instant = 1_800_000_000_000;
const pin: ValidatorPin = {
  name: "unbound",
  version: "1.26.1",
  mode: "local-validating",
  binary_sha256: "b".repeat(64),
  anchor_sha256: "c".repeat(64),
  runtime_manifest_sha256: "d".repeat(64),
};
// RFC 7479 section 4 hashes the complete SSH key blob, including its SSH string framing.
const rfcKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const rfcFingerprint = "a87f1b687ac0e57d2a081a2f282672334d90ed316d2b818ca9580ea384d92401";
const rfcSshfp: Sshfp = { algorithm: 4, digest_type: 2, fingerprint: rfcFingerprint };
const rotatedBlob = Buffer.from(rfcKey.split(" ")[1] as string, "base64");
rotatedBlob[50] = (rotatedBlob[50] ?? 0) ^ 1;
const rotatedKey = `ssh-ed25519 ${rotatedBlob.toString("base64")}`;
const prefix = "trust/staging/";
const codec = new RecordCodec(
  passphrase,
  privateDigest({ purpose: "tarubot-ssh-trust-v1", target: "staging", backend }),
);
type Fault = "before" | "after" | "readback";

/** Latest-object storage intentionally provides no CAS, distributed lock or failed-ack history. */
class MemoryStore implements ControlStore {
  data = new Map<string, Uint8Array>();
  events: string[] = [];
  writeCount = 0;
  faultAt = 0;
  fault: Fault = "before";
  corruptKey: string | null = null;
  readError = false;
  async read(key: string): Promise<Uint8Array | null> {
    this.events.push(`read:${key}`);
    if (this.readError) throw new Error("invented-private-storage-diagnostic");
    if (this.corruptKey === key) {
      this.corruptKey = null;
      return new Uint8Array([1, 2, 3]);
    }
    const value = this.data.get(key);
    return value ? Uint8Array.from(value) : null;
  }
  async write(key: string, value: Uint8Array): Promise<void> {
    this.events.push(`write:${key}`);
    this.writeCount++;
    const fail = this.faultAt === this.writeCount;
    if (fail && this.fault === "before") throw new Error("invented-private-write-diagnostic");
    this.data.set(key, Uint8Array.from(value));
    if (fail && this.fault === "after") throw new Error("invented-private-write-diagnostic");
    if (fail && this.fault === "readback") this.corruptKey = key;
  }
  failNext(offset: number, fault: Fault): void {
    this.faultAt = this.writeCount + offset;
    this.fault = fault;
  }
  put(path: string, value: unknown): void {
    this.data.set(prefix + path, codec.seal(prefix + path, value));
  }
  get(path: string): unknown {
    const bytes = this.data.get(prefix + path);
    return bytes ? codec.open(prefix + path, bytes) : null;
  }
}

function descriptor(): TargetDescriptor {
  return {
    schema: 1,
    target: "staging",
    provider: "linode",
    instance_id: "1234",
    fqdn: "host.example.org",
    addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
    dns_zone_id: "d".repeat(32),
    applied_generation: appliedGeneration,
    state: {
      lineage: "44444444-4444-4444-8444-444444444444",
      serial: 12,
      digest: "e".repeat(64),
    },
  };
}
function authorization(d = descriptor(), previous: string | null = null): EnrollmentAuthorization {
  return {
    schema: 1,
    target: d.target,
    generation: previous === null ? initialGeneration : rotationGeneration,
    previous,
    kind: previous === null ? "initial" : "rotation",
    descriptor_digest: privateDigest(d),
    run: approvalRun,
    approved_at: instant - 1000,
    expires_at: instant + 3_600_000,
  };
}
function scans(d = descriptor(), key = rfcKey, now = instant): ScanEvidence {
  const round = [
    { address: d.addresses.ipv4, key },
    { address: d.addresses.ipv6, key },
  ];
  return { schema: 1, observed_at: now, rounds: [round, structuredClone(round)] };
}
function dns(name = descriptor().fqdn, sshfp = rfcSshfp, now = instant): DnssecEvidence {
  return {
    schema: 1,
    validator: structuredClone(pin),
    name,
    type: "SSHFP",
    secure: true,
    bogus: false,
    havedata: true,
    nxdomain: false,
    rcode: 0,
    observed_at: now,
    ttl: 300,
    expires_at: now + 300_000,
    records: [sshfp],
  };
}
class Writer implements DnsWriter {
  records: SshfpRecord[] = [];
  writes: PublicationRequest[] = [];
  reads = 0;
  async read(_request: PublicationRequest): Promise<SshfpRecord[]> {
    this.reads++;
    return structuredClone(this.records);
  }
  async write(request: PublicationRequest): Promise<SshfpRecord> {
    this.writes.push(structuredClone(request));
    const rr: SshfpRecord = {
      id: request.record_id ?? "f".repeat(32),
      zone_id: request.zone_id,
      name: request.name,
      type: "SSHFP",
      sshfp: request.sshfp,
    };
    this.records = [structuredClone(rr)];
    return rr;
  }
}
function fixture() {
  const store = new MemoryStore();
  const clock = { now: instant };
  const d = descriptor();
  const a = authorization(d);
  const writer = new Writer();
  const journal = new TrustJournal(store, {
    target: "staging",
    backend,
    passphrase,
    validator: pin,
    now: () => clock.now,
  });
  let observations = 0;
  const observe = async () => {
    observations++;
    store.events.push("observe");
    return scans(d, rfcKey, clock.now);
  };
  const validate = async (request: PublicationRequest) =>
    dns(request.name, request.sshfp, clock.now);
  return {
    store,
    clock,
    d,
    a,
    writer,
    journal,
    observe,
    validate,
    observations: () => observations,
  };
}
async function pending() {
  const f = fixture();
  await f.journal.recordAuthorization(f.a);
  const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
  return { ...f, ticket };
}
async function published() {
  const f = await pending();
  await f.journal.publish(f.ticket, f.writer, f.validate);
  return f;
}
async function established() {
  const f = await published();
  await f.journal.finish(f.ticket);
  return f;
}
async function refusal(action: Promise<unknown>): Promise<void> {
  try {
    await action;
    throw new Error("expected trust refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid-ssh-trust");
  }
}
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}

describe("canonical SSH Ed25519 and minimized target evidence", () => {
  test("published RFC 7479 vector uses all 51 blob bytes", () => {
    const parsed = canonicalEd25519(rfcKey);
    expect(parsed.sshfp).toEqual(rfcSshfp);
    expect(parsed.blob.length).toBe(51);
    expect(createHash("sha256").update(parsed.blob.slice(19)).digest("hex")).not.toBe(
      rfcFingerprint,
    );
  });
  test("options, comments, certificates and malformed or noncanonical blobs are rejected", () => {
    const blob = Buffer.from(canonicalEd25519(rfcKey).blob);
    const wrongType = Buffer.from(blob);
    wrongType[4] = (wrongType[4] ?? 0) | 0x80; // ASCII decoding must not mask an invalid high bit.
    const wrongLength = Buffer.from(blob);
    wrongLength.writeUInt32BE(31, 15);
    for (const key of [
      null,
      `${rfcKey} comment`,
      `${rfcKey}\n`,
      `${rfcKey}=`,
      rfcKey.replace(" ", "  "),
      `from="192.0.2.10" ${rfcKey}`,
      rfcKey.replace("ssh-ed25519 ", "ssh-ed25519-cert-v01@openssh.com "),
      `ssh-ed25519 ${wrongType.toString("base64")}`,
      `ssh-ed25519 ${wrongLength.toString("base64")}`,
      `ssh-ed25519 ${Buffer.concat([blob, Buffer.from([0])]).toString("base64")}`,
    ])
      expect(() => canonicalEd25519(key)).toThrow("invalid-ssh-trust");
  });
  test("descriptor copies exact applied proof and rejects aliases or ambiguous addresses", () => {
    const value = descriptor();
    const copy = targetDescriptor(value);
    value.addresses.ipv4 = "192.0.2.11";
    expect(copy.addresses.ipv4).toBe("192.0.2.10");
    for (const delta of [
      { fqdn: "HOST.example.org" },
      { fqdn: "host.example.org." },
      { fqdn: "192.0.2.10" },
      { fqdn: "host" },
      { instance_id: "01234" },
      { provider: "other" },
      { dns_zone_id: "private-provider-diagnostic" },
      { applied_generation: null },
      { state: { ...copy.state, serial: -1 } },
      { state: { ...copy.state, digest: "short" } },
      { addresses: { ipv4: "192.0.2.010", ipv6: "2001:db8::10" } },
      { addresses: { ipv4: "192.0.2.10", ipv6: "2001:0db8:0:0:0:0:0:10" } },
      { addresses: { ipv4: "192.0.2.10", ipv6: "fe80::1%eth0" } },
      { extra: true },
    ])
      expect(() => targetDescriptor({ ...copy, ...delta })).toThrow("invalid-ssh-trust");
  });
  test("authorization shape binds a distinct generation, predecessor, descriptor and approval run", () => {
    const a = authorization();
    expect(enrollmentAuthorization(a)).toEqual(a);
    for (const delta of [
      { kind: "rotation" },
      { previous: a.generation },
      { previous: rotationGeneration },
      { descriptor_digest: null },
      { run: { ...approvalRun, run: "012" } },
      { expires_at: a.approved_at },
      { expires_at: a.approved_at + 24 * 60 * 60_000 + 1 },
      { approved_at: -1 },
      { approved: true },
    ])
      expect(() => enrollmentAuthorization({ ...a, ...delta })).toThrow("invalid-ssh-trust");
  });
});

describe("pinned local DNSSEC SSHFP evidence", () => {
  test("positive local validation binds exact name, 4/2 digest and TTL expiry", () => {
    const value = dns();
    value.records.push({ algorithm: 1, digest_type: 1, fingerprint: "ab".repeat(20) });
    expect(dnssecEvidence(value, value.name, rfcSshfp, pin, instant)).toEqual(value);
    expect(dnssecEvidence(value, value.name, rfcSshfp, pin, instant + 60_000)).toEqual(value);
    expect(() => dnssecEvidence(value, value.name, rfcSshfp, pin, instant + 60_001)).toThrow(
      "invalid-ssh-trust",
    );
  });
  test("remote AD, wrong validator, stale answers and conflicting fingerprints cannot satisfy trust", () => {
    const value = dns();
    for (const delta of [
      { ad: true },
      { validator: { ...pin, mode: "remote-ad" } },
      { validator: { ...pin, version: "1.26.0" } },
      { validator: { ...pin, binary_sha256: "0".repeat(64) } },
      { validator: { ...pin, anchor_sha256: "0".repeat(64) } },
      { validator: { ...pin, runtime_manifest_sha256: "0".repeat(64) } },
      { name: "other.example.org" },
      { secure: false },
      { bogus: true },
      { havedata: false },
      { nxdomain: true },
      { rcode: 2 },
      { ttl: 0 },
      { ttl: 0.5 },
      { ttl: 86401 },
      { expires_at: value.expires_at + 1 },
      { observed_at: instant + 1, expires_at: instant + 300_001 },
      { observed_at: instant - 60_001, expires_at: instant + 239_999 },
      { records: [] },
      { records: [rfcSshfp, rfcSshfp] },
      { records: [{ ...rfcSshfp, fingerprint: "0".repeat(64) }] },
      { records: [{ ...rfcSshfp, fingerprint: rfcFingerprint.toUpperCase() }] },
      { records: [{ algorithm: 4, digest_type: 1, fingerprint: "ab".repeat(20) }] },
    ])
      expect(() =>
        dnssecEvidence({ ...value, ...delta }, value.name, rfcSshfp, pin, instant),
      ).toThrow("invalid-ssh-trust");
    const expired = { ...value, ttl: 1, expires_at: instant + 1000 };
    expect(() => dnssecEvidence(expired, value.name, rfcSshfp, pin, instant + 1000)).toThrow(
      "invalid-ssh-trust",
    );
  });
});

describe("explicit durable enrollment and connection boundaries", () => {
  test("journal diagnostics hide bindings and external shadows cannot replace durable enrollment guards", async () => {
    const f = fixture();
    const shadowStore = new MemoryStore();
    expect(Object.keys(f.journal)).toEqual([]);
    expect(JSON.stringify(f.journal)).toBe("{}");
    for (const diagnostic of [Bun.inspect(f.journal), JSON.stringify(f.journal)]) {
      expect(diagnostic).not.toContain(passphrase);
      expect(diagnostic).not.toContain(backend);
      expect(diagnostic).not.toContain(pin.binary_sha256);
    }
    for (const name of ["codec", "store", "target", "pin", "now", "path", "authorizedNow"])
      expect(Reflect.get(f.journal, name)).toBeUndefined();
    Object.assign(f.journal, {
      store: shadowStore,
      codec: new RecordCodec(`${passphrase}-shadow`, "f".repeat(64)),
      target: "production",
      pin: { ...pin, binary_sha256: "e".repeat(64) },
      now: () => 0,
      path: (name: string) => `trust/production/${name}`,
      authorizedNow: () => instant,
      current: async () => null,
      completed: async () => null,
    });
    await f.journal.recordAuthorization(f.a);
    const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
    await f.journal.publish(ticket, f.writer, f.validate);
    await f.journal.finish(ticket);
    expect((await f.journal.inspect(f.d)).key).toBe(rfcKey);
    expect(f.store.events.filter((event) => event.startsWith("write:"))).not.toHaveLength(0);
    expect(
      f.store.events.every((event) => event === "observe" || event.includes("trust/staging/")),
    ).toBe(true);
    expect(shadowStore.writeCount).toBe(0);
    f.store.data.delete(`${prefix}completed/${ticket.generation}`);
    await refusal(f.journal.inspect(f.d));
  });
  test("plain constructor authority is captured once and accessor failures stay redacted", async () => {
    const store = new MemoryStore();
    let accesses = 0;
    const journal = new TrustJournal(store, {
      get target(): "staging" | "production" {
        return ++accesses === 1 ? "staging" : "production";
      },
      backend,
      passphrase,
      validator: pin,
      now: () => instant,
    });
    await journal.recordAuthorization(authorization());
    expect(accesses).toBe(1);
    expect(store.data.has(`${prefix}registration`)).toBe(true);
    expect(
      () =>
        new TrustJournal(store, {
          target: "staging",
          backend,
          get passphrase(): string {
            throw new Error("invented-private-accessor-diagnostic");
          },
          validator: pin,
        }),
    ).toThrow("invalid-ssh-trust");
  });
  test("a missing current never learns a key, and authorization must already be durable", async () => {
    const f = fixture();
    await refusal(f.journal.inspect(f.d));
    await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    expect(f.observations()).toBe(0);
    await f.journal.recordAuthorization(f.a);
    await refusal(f.journal.inspect(f.d));
    await refusal(
      f.journal.begin({ ...f.a, descriptor_digest: "0".repeat(64) }, f.d, enrollmentRun, f.observe),
    );
    await refusal(f.journal.begin(f.a, f.d, approvalRun.run, f.observe));
    expect(f.observations()).toBe(0);
  });
  test("intent, one-shot attempt, consumption and pending read back before observation", async () => {
    const f = await pending();
    const prior = f.store.events.slice(0, f.store.events.indexOf("observe"));
    for (const path of [
      `intents/${f.ticket.operation}`,
      `attempts/${f.a.generation}`,
      `consumed/${f.a.generation}`,
      "current",
    ]) {
      const write = prior.indexOf(`write:${prefix}${path}`);
      expect(write).toBeGreaterThanOrEqual(0);
      expect(prior.slice(write + 1)).toContain(`read:${prefix}${path}`);
    }
    expect(f.store.get(`records/${f.a.generation}`)).toMatchObject({
      enrollment_run: enrollmentRun,
    });
    await refusal(f.journal.inspect(f.d));
    await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    expect(f.observations()).toBe(1);
    for (const bytes of f.store.data.values()) {
      const encoded = Buffer.from(bytes).toString();
      expect(encoded).not.toContain(f.d.fqdn);
      expect(encoded).not.toContain(rfcKey);
      expect(encoded).not.toContain(f.a.descriptor_digest);
    }
  });
  test("owned SSHFP publication precedes completion and successful run confirmation precedes DNS", async () => {
    const f = await published();
    expect(f.writer.writes).toEqual([
      {
        target: "staging",
        generation: f.a.generation,
        zone_id: f.d.dns_zone_id,
        name: f.d.fqdn,
        type: "SSHFP",
        record_id: null,
        previous: null,
        sshfp: rfcSshfp,
      },
    ]);
    await refusal(f.journal.inspect(f.d));
    await f.journal.finish(f.ticket);
    const order: string[] = [];
    const result = await f.journal.connectionTrust(
      f.d,
      async (run) => {
        order.push("confirmed");
        expect(run).toEqual(enrollmentRun);
        return true;
      },
      async (snapshot) => {
        order.push("dns");
        return dns(snapshot.descriptor.fqdn, snapshot.sshfp, f.clock.now);
      },
    );
    expect(order).toEqual(["confirmed", "dns"]);
    expect(result.key).toBe(rfcKey);
    expect(result.record.id).toBe("f".repeat(32));
    expect(result.enrollment_run).toEqual(enrollmentRun);
    expect(result.expires_at).toBe(instant + 300_000);
  });
  test("unconfirmed runs cannot authenticate even with otherwise complete durable links", async () => {
    const f = await established();
    let resolutions = 0;
    const validate = async () => {
      resolutions++;
      return dns();
    };
    for (const confirm of [
      async () => false,
      async () => {
        throw new Error("invented-private-workflow-diagnostic");
      },
    ])
      await refusal(f.journal.connectionTrust(f.d, confirm, validate));
    expect(resolutions).toBe(0);
  });
  test("historical proof survives expiry while each connection requires fresh DNS and exact reopened links", async () => {
    const f = await established();
    f.clock.now += 3_600_000;
    expect((await f.journal.inspect(f.d)).key).toBe(rfcKey);
    await refusal(
      f.journal.connectionTrust(
        f.d,
        async () => true,
        async () => dns(),
      ),
    );
    expect(
      (
        await f.journal.connectionTrust(
          f.d,
          async () => true,
          async (s) => dns(s.descriptor.fqdn, s.sshfp, f.clock.now),
        )
      ).key,
    ).toBe(rfcKey);
    await refusal(
      f.journal.connectionTrust(
        f.d,
        async () => true,
        async () => {
          f.store.data.delete(`${prefix}references/${f.a.generation}`);
          return dns(f.d.fqdn, rfcSshfp, f.clock.now);
        },
      ),
    );
  });
  test("safe baseline updates reuse identity; changing any instance binding requires explicit rotation", async () => {
    const f = await established();
    const updated = {
      ...f.d,
      applied_generation: rotationGeneration,
      state: { ...f.d.state, serial: 13, digest: "0".repeat(64) },
    };
    expect((await f.journal.inspect(updated)).generation).toBe(initialGeneration);
    for (const delta of [
      { instance_id: "1235" },
      { fqdn: "other.example.org" },
      { dns_zone_id: "0".repeat(32) },
      { addresses: { ipv4: "192.0.2.11", ipv6: f.d.addresses.ipv6 } },
      { addresses: { ipv4: f.d.addresses.ipv4, ipv6: "2001:db8::11" } },
    ])
      await refusal(f.journal.inspect({ ...updated, ...delta }));
    await refusal(f.journal.recordAuthorization(authorization()));
  });
  test("rotation consumes exact predecessor and patches only the previously owned SSHFP record", async () => {
    const f = await established();
    const next = {
      ...f.d,
      instance_id: "1235",
      addresses: { ipv4: "192.0.2.11", ipv6: "2001:db8::11" },
      applied_generation: rotationGeneration,
    };
    const a = authorization(next, initialGeneration);
    await refusal(f.journal.recordAuthorization({ ...a, previous: appliedGeneration }));
    await f.journal.recordAuthorization(a);
    // A reserved authorization does not yet replace the current trust.
    expect((await f.journal.inspect(f.d)).generation).toBe(initialGeneration);
    const ticket = await f.journal.begin(a, next, { ...enrollmentRun, run: "12346" }, async () =>
      scans(next, rotatedKey),
    );
    await refusal(f.journal.inspect(f.d));
    await f.journal.publish(ticket, f.writer, f.validate);
    const request = f.writer.writes[1];
    expect(request?.record_id).toBe("f".repeat(32));
    expect(request?.previous?.sshfp).toEqual(rfcSshfp);
    expect(request?.sshfp).toEqual(canonicalEd25519(rotatedKey).sshfp);
    await f.journal.finish(ticket);
    expect((await f.journal.inspect(next)).key).toBe(rotatedKey);
    await refusal(f.journal.inspect(f.d));
  });
  test("an acknowledged rotation attempt blocks old trust even before consumption or pending writes", async () => {
    const f = await established();
    const next = { ...f.d, instance_id: "1235" };
    const a = authorization(next, initialGeneration);
    await f.journal.recordAuthorization(a);
    f.store.failNext(3, "before");
    let observations = 0;
    const observe = async () => {
      observations++;
      return scans(next, rotatedKey);
    };
    await refusal(f.journal.begin(a, next, enrollmentRun, observe));
    await refusal(f.journal.inspect(f.d));
    await refusal(f.journal.begin(a, next, enrollmentRun, observe));
    expect(observations).toBe(0);
    expect(f.writer.writes.length).toBe(1);
  });
  test("rotation refuses any other predecessor record ID before the provider writer", async () => {
    const f = await established();
    const a = authorization(f.d, initialGeneration);
    await f.journal.recordAuthorization(a);
    const ticket = await f.journal.begin(a, f.d, enrollmentRun, async () => scans(f.d, rotatedKey));
    const rr = present(f.writer.records[0]);
    rr.id = "0".repeat(32);
    await refusal(f.journal.publish(ticket, f.writer, f.validate));
    expect(f.writer.writes.length).toBe(1);
    await refusal(f.journal.inspect(f.d));
  });
  test("callback mutations cannot rewrite persisted authorization, target, publication or run bindings", async () => {
    const f = await established();
    const original = await f.journal.inspect(f.d);
    const result = await f.journal.connectionTrust(
      f.d,
      async (run) => {
        run.run = "9999";
        return true;
      },
      async (snapshot) => {
        const evidence = dns(snapshot.descriptor.fqdn, snapshot.sshfp);
        snapshot.key = rotatedKey;
        snapshot.descriptor.fqdn = "other.example.org";
        return evidence;
      },
    );
    expect(result.key).toBe(original.key);
    expect(result.enrollment_run).toEqual(enrollmentRun);
    expect((await f.journal.inspect(f.d)).descriptor.fqdn).toBe(f.d.fqdn);
  });
});

describe("conflicts, interruptions and immutable historical references", () => {
  test("conflicting or unavailable observations consume authorization and never observe twice", async () => {
    const cases: ((scan: ScanEvidence) => void)[] = [
      (s) => {
        present(s.rounds[1][0]).key = rotatedKey;
      },
      (s) => {
        for (const round of s.rounds) present(round[1]).key = rotatedKey;
      },
      (s) => {
        for (const round of s.rounds) for (const entry of round) entry.key = null;
      },
      (s) => {
        s.rounds[0].pop();
      },
      (s) => {
        present(s.rounds[1][1]).address = present(s.rounds[1][0]).address;
      },
      (s) => {
        s.observed_at--;
      },
      (s) => {
        s.observed_at += 1;
      },
    ];
    for (const mutate of cases) {
      const f = fixture();
      await f.journal.recordAuthorization(f.a);
      let observations = 0;
      const observe = async () => {
        observations++;
        const evidence = scans();
        mutate(evidence);
        return evidence;
      };
      await refusal(f.journal.begin(f.a, f.d, enrollmentRun, observe));
      await refusal(f.journal.begin(f.a, f.d, enrollmentRun, observe));
      await refusal(f.journal.inspect(f.d));
      expect(observations).toBe(1);
    }
  });
  test("a consistently unreachable family permits the independently repeated reachable family", async () => {
    const f = fixture();
    await f.journal.recordAuthorization(f.a);
    const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, async () => {
      const evidence = scans();
      for (const round of evidence.rounds) present(round[1]).key = null;
      return evidence;
    });
    await f.journal.publish(ticket, f.writer, f.validate);
    await f.journal.finish(ticket);
    expect((await f.journal.inspect(f.d)).key).toBe(rfcKey);
  });
  test("unknown generations and pending pointers cannot use a valid older completion", async () => {
    for (const head of [
      { generation: rotationGeneration, pending: null },
      { generation: initialGeneration, pending: rotationGeneration },
      { generation: null, pending: rotationGeneration },
      { generation: null, pending: null },
    ]) {
      const f = await established();
      f.store.put("current", { schema: 1, target: "staging", ...head });
      await refusal(f.journal.inspect(f.d));
    }
  });
  test("each missing completion link refuses inspection and reenrollment", async () => {
    const f = await established();
    const entries = Array.from(f.store.data.entries());
    for (const key of entries.map(([key]) => key)) {
      f.store.data = new Map(entries);
      f.store.data.delete(key);
      await refusal(f.journal.inspect(f.d));
      await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    }
    expect(f.observations()).toBe(1);
    // The permanent attempt also fences loss of both transient consumption and current pointers.
    f.store.data = new Map(entries);
    f.store.data.delete(`${prefix}current`);
    f.store.data.delete(`${prefix}consumed/${f.a.generation}`);
    await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    expect(f.observations()).toBe(1);
  });
  test("validly encrypted mismatched history, run identity or references still refuse trust", async () => {
    const f = await established();
    const original = new Map(f.store.data);
    const paths = [
      [`references/${f.a.generation}`, "trust_digest", "0".repeat(64)],
      [`attempts/${f.a.generation}`, "operation", rotationGeneration],
      [`consumed/${f.a.generation}`, "binding", "0".repeat(64)],
      ["registration", "authorization_digest", "0".repeat(64)],
      [`completed/${f.a.generation}`, "publication_digest", "0".repeat(64)],
      ["authorization-current", "previous", rotationGeneration],
      [`records/${f.a.generation}`, "enrollment_run", { ...enrollmentRun, run: "9999" }],
    ] as const;
    for (const [path, field, value] of paths) {
      f.store.data = new Map(original);
      const record = f.store.get(path) as Record<string, unknown>;
      f.store.put(path, { ...record, [field]: value });
      await refusal(f.journal.inspect(f.d));
    }
  });
  test("ciphertext replay across path, backend, role or passphrase is refused", async () => {
    const f = await established();
    const bytes = present(f.store.data.get(`${prefix}records/${f.a.generation}`));
    f.store.data.set(`${prefix}references/${f.a.generation}`, bytes);
    await refusal(f.journal.inspect(f.d));
    for (const options of [
      { backend: "0".repeat(64) },
      { passphrase: `${passphrase} different` },
      { target: "production" as const },
    ]) {
      const journal = new TrustJournal(f.store, {
        target: "staging",
        backend,
        passphrase,
        validator: pin,
        now: () => instant,
        ...options,
      });
      await refusal(journal.inspect(f.d));
    }
  });
  test("all begin write/ack interruptions leave no second observation or usable connection", async () => {
    // A failure before the permanent attempt may be retried once; no observation happened yet.
    // Once an observation occurs, historical attempt/consumption/pending prevent a second scan.
    for (const fault of ["before", "after", "readback"] as const)
      for (let step = 1; step <= 7; step++) {
        const f = fixture();
        await f.journal.recordAuthorization(f.a);
        f.store.failNext(step, fault);
        await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
        try {
          await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
        } catch (error) {
          expect((error as Error).message).toBe("invalid-ssh-trust");
        }
        expect(f.observations()).toBeLessThanOrEqual(1);
        await refusal(f.journal.inspect(f.d));
      }
  });
  test("publication conflicts cannot create another record or overwrite another owner's record", async () => {
    for (const count of [1, 2]) {
      const f = await pending();
      const existing: SshfpRecord = {
        id: "0".repeat(32),
        zone_id: f.d.dns_zone_id,
        name: f.d.fqdn,
        type: "SSHFP",
        sshfp: rfcSshfp,
      };
      f.writer.records = Array.from({ length: count }, () => structuredClone(existing));
      await refusal(f.journal.publish(f.ticket, f.writer, f.validate));
      expect(f.writer.writes.length).toBe(0);
      await refusal(f.journal.inspect(f.d));
    }
  });
  test("an interrupted publication never writes the owned record twice", async () => {
    for (const fault of ["before", "after", "readback"] as const)
      for (let step = 1; step <= 2; step++) {
        const f = await pending();
        f.store.failNext(step, fault);
        await refusal(f.journal.publish(f.ticket, f.writer, f.validate));
        try {
          await f.journal.publish(f.ticket, f.writer, f.validate);
        } catch (error) {
          expect((error as Error).message).toBe("invalid-ssh-trust");
        }
        expect(f.writer.writes.length).toBeLessThanOrEqual(1);
        await refusal(f.journal.inspect(f.d));
      }
  });
  test("DNS write/readback disagreement and DNSSEC failure retain pending trust without retry", async () => {
    for (const broken of ["readback", "dnssec", "write"] as const) {
      const f = await pending();
      const writer: DnsWriter = {
        read: async (r) => {
          const records = await f.writer.read(r);
          if (broken === "readback" && records.length) present(records[0]).id = "0".repeat(32);
          return records;
        },
        write: async (r) => {
          if (broken === "write") throw new Error("invented-private-provider-diagnostic");
          return f.writer.write(r);
        },
      };
      await refusal(
        f.journal.publish(f.ticket, writer, async (r) =>
          broken === "dnssec"
            ? ({ ...dns(r.name, r.sshfp), secure: false } as unknown as DnssecEvidence)
            : f.validate(r),
        ),
      );
      await refusal(f.journal.publish(f.ticket, writer, f.validate));
      await refusal(f.journal.finish(f.ticket));
      await refusal(f.journal.inspect(f.d));
      expect(f.writer.writes.length).toBeLessThanOrEqual(1);
    }
  });
  test("stale approval, stale DNS or changed reference interrupts completion", async () => {
    const staleApproval = await published();
    staleApproval.clock.now = staleApproval.a.expires_at;
    await refusal(staleApproval.journal.finish(staleApproval.ticket));
    const staleDns = await published();
    staleDns.clock.now += 60_001;
    await refusal(staleDns.journal.finish(staleDns.ticket));
    const changed = await pending();
    const writer: DnsWriter = {
      read: (r) => changed.writer.read(r),
      write: async (r) => {
        const result = await changed.writer.write(r);
        changed.store.data.delete(`${prefix}references/${changed.a.generation}`);
        return result;
      },
    };
    await refusal(changed.journal.publish(changed.ticket, writer, changed.validate));
    await refusal(changed.journal.inspect(changed.d));
  });
  test("approval expiry during publication evidence reads prevents a DNS mutation", async () => {
    const f = fixture();
    f.a.expires_at = instant + 1000;
    await f.journal.recordAuthorization(f.a);
    const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
    const originalRead = f.store.read.bind(f.store);
    let headReads = 0;
    f.store.read = async (key) => {
      const result = await originalRead(key);
      // The second active() call follows durable publication intent; expiry inside its
      // remaining reads must be detected before handing the owned record to the DNS writer.
      if (key === `${prefix}current` && ++headReads === 2) f.clock.now = f.a.expires_at;
      return result;
    };
    await refusal(f.journal.publish(ticket, f.writer, f.validate));
    expect(f.writer.writes).toHaveLength(0);
    expect(f.store.get(`publication-intents/${ticket.operation}`)).not.toBeNull();
    expect(f.store.get("current")).toMatchObject({ pending: ticket.operation });
    await refusal(f.journal.publish(ticket, f.writer, f.validate));
    expect(f.observations()).toBe(1);
  });
  test("approval expiry while consuming enrollment prevents a first observation", async () => {
    const f = fixture();
    f.a.expires_at = instant + 1000;
    await f.journal.recordAuthorization(f.a);
    const originalWrite = f.store.write.bind(f.store);
    f.store.write = async (key, bytes) => {
      await originalWrite(key, bytes);
      if (key === `${prefix}current`) f.clock.now = f.a.expires_at;
    };
    await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    expect(f.observations()).toBe(0);
    expect(f.store.get("current")).toMatchObject({ generation: null });
    expect(f.store.get(`attempts/${f.a.generation}`)).not.toBeNull();
    await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
    expect(f.observations()).toBe(0);
  });
  test("approval expiry during completion reads leaves its current generation pending", async () => {
    for (const boundary of ["publication", "completed-existence"] as const) {
      const f = fixture();
      f.a.expires_at = instant + 1000;
      await f.journal.recordAuthorization(f.a);
      const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
      await f.journal.publish(ticket, f.writer, f.validate);
      const originalRead = f.store.read.bind(f.store);
      const delayed =
        boundary === "publication"
          ? `publications/${ticket.operation}`
          : `completed/${ticket.generation}`;
      f.store.read = async (key) => {
        const result = await originalRead(key);
        if (key === prefix + delayed) f.clock.now = f.a.expires_at;
        return result;
      };
      await refusal(f.journal.finish(ticket));
      expect(f.store.get(`completed/${ticket.generation}`)).toBeNull();
      expect(f.store.get("current")).toMatchObject({ pending: ticket.operation });
      await refusal(f.journal.inspect(f.d));
    }
  });
  test("expiry during completion acknowledgement or final reopen fails enrollment success", async () => {
    for (const boundary of ["completed-write", "current-write", "final-reopen"] as const) {
      const f = fixture();
      f.a.expires_at = instant + 1000;
      await f.journal.recordAuthorization(f.a);
      const ticket = await f.journal.begin(f.a, f.d, enrollmentRun, f.observe);
      await f.journal.publish(ticket, f.writer, f.validate);
      const originalRead = f.store.read.bind(f.store);
      const originalWrite = f.store.write.bind(f.store);
      let finalReopen = false;
      f.store.write = async (key, bytes) => {
        await originalWrite(key, bytes);
        if (
          (boundary === "completed-write" && key === `${prefix}completed/${ticket.generation}`) ||
          (boundary === "current-write" && key === `${prefix}current`)
        )
          f.clock.now = f.a.expires_at;
        if (boundary === "final-reopen" && key === `${prefix}current`) finalReopen = true;
      };
      f.store.read = async (key) => {
        const result = await originalRead(key);
        if (finalReopen && key === `${prefix}registration`) f.clock.now = f.a.expires_at;
        return result;
      };
      await refusal(f.journal.finish(ticket));
      // A completed-record acknowledgement fails before pointer advancement. A persisted
      // final pointer remains ambiguous; never silently roll it back or declare run success.
      expect(f.store.get("current")).toMatchObject({
        pending: boundary === "completed-write" ? ticket.operation : null,
      });
      await refusal(
        f.journal.connectionTrust(
          f.d,
          async () => false,
          async () => dns(f.d.fqdn, rfcSshfp, f.clock.now),
        ),
      );
    }
  });
  test("DNS proof expiry during the final durable reopen prevents a connection result", async () => {
    const f = await established();
    const originalRead = f.store.read.bind(f.store);
    let armed = false;
    f.store.read = async (key) => {
      const result = await originalRead(key);
      if (armed) f.clock.now = instant + 1000;
      return result;
    };
    await refusal(
      f.journal.connectionTrust(
        f.d,
        async () => true,
        async () => {
          const proof = { ...dns(), ttl: 1, expires_at: instant + 1000 };
          armed = true;
          return proof;
        },
      ),
    );
  });
  test("completion returns only after exact readback; last-ack ambiguity requires independent run success", async () => {
    for (const fault of ["before", "after", "readback"] as const)
      for (let step = 1; step <= 2; step++) {
        const f = await published();
        f.store.failNext(step, fault);
        await refusal(f.journal.finish(f.ticket));
        // Latest-object storage can reopen a fully persisted final pointer after its failed ack.
        // Durable links alone cannot attest that the enrollment workflow finished successfully.
        if (step === 2 && fault !== "before")
          expect((await f.journal.inspect(f.d)).generation).toBe(initialGeneration);
        else await refusal(f.journal.inspect(f.d));
        await refusal(
          f.journal.connectionTrust(
            f.d,
            async () => false,
            async () => dns(),
          ),
        );
        await refusal(f.journal.begin(f.a, f.d, enrollmentRun, f.observe));
        expect(f.observations()).toBe(1);
      }
  });
  test("storage, scanner, DNS and clock diagnostics are fixed redacted failures", async () => {
    const f = fixture();
    f.store.readError = true;
    await refusal(f.journal.recordAuthorization(f.a));
    f.store.readError = false;
    await f.journal.recordAuthorization(f.a);
    await refusal(
      f.journal.begin(f.a, f.d, enrollmentRun, async () => {
        throw new Error("invented-private-scanner-diagnostic");
      }),
    );
    const g = await established();
    await refusal(
      g.journal.connectionTrust(
        g.d,
        async () => true,
        async () => {
          throw new Error("invented-private-validator-diagnostic");
        },
      ),
    );
    const invalidClock = new TrustJournal(new MemoryStore(), {
      target: "staging",
      backend,
      passphrase,
      validator: pin,
      now: () => {
        throw new Error("invented-private-clock-diagnostic");
      },
    });
    await refusal(invalidClock.recordAuthorization(authorization()));
  });
});
