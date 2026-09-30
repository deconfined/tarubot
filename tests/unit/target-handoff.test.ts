/** Invented encrypted handoffs and independent job receipts; no APIs, backend or token lookup. */
import { describe, expect, test } from "bun:test";
import { privateDigest, RecordCodec, type ControlStore } from "../../scripts/infra-control.js";
import {
  AppliedTargetHandoff,
  type AppliedTargetContext,
  type AppliedTargetJobProof,
  type AppliedTargetJobRequest,
  type AppliedTargetReceipt,
} from "../../scripts/target-handoff.js";
import type { AppliedTargetEnvelope } from "../../scripts/target-descriptor.js";

const backend = "a".repeat(64);
const passphrase = "invented-descriptor-only-private-key".repeat(2);
const generation = "11111111-1111-4111-8111-111111111111";
const timestamp = 1_800_000_000_000;
function fixture(mode: "apply" | "no-changes" = "apply") {
  const release = {
    version: "2.36.11",
    commit: "1".repeat(40),
    config_commit: "1".repeat(40),
    digest: `sha256:${"2".repeat(64)}`,
    publication_run: "1234",
    schema_head: "001_initial.sql",
  };
  const producer = {
    repository: "deconfined/tarubot" as const,
    workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" as const,
    ref: "refs/heads/main" as const,
    event: "push" as const,
    attempt: 1 as const,
    commit: release.commit,
    run: release.publication_run,
  };
  const context: AppliedTargetContext = { target: "staging", release, producer };
  const state = {
    lineage: "22222222-2222-4222-8222-222222222222",
    serial: 5,
    digest: "3".repeat(64),
  };
  const baselineDigest = "4".repeat(64);
  const envelope: AppliedTargetEnvelope = {
    schema: 1,
    purpose: "tarubot-applied-target-v1",
    descriptor: {
      schema: 1,
      target: "staging",
      provider: "linode",
      instance_id: "123",
      fqdn: "staging.example.org",
      addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
      dns_zone_id: "5".repeat(32),
      applied_generation: generation,
      state,
    },
    release,
    verification: { mode, producer },
    baseline: {
      generation,
      state,
      run:
        mode === "apply"
          ? { commit: producer.commit, run: producer.run }
          : { commit: "e".repeat(40), run: "987" },
      binding: "6".repeat(64),
      baseline_digest: baselineDigest,
      completion_digest: privateDigest({ generation, baseline: baselineDigest }),
    },
  };
  return { context, envelope, expires_at: timestamp + 3_600_000 };
}
function validProof(request: AppliedTargetJobRequest, now: number): AppliedTargetJobProof {
  return {
    schema: 1,
    purpose: "tarubot-applied-target-job-proof-v1",
    receipt: structuredClone(request.receipt),
    producer: structuredClone(request.receipt.producer),
    head_commit: request.receipt.release.commit,
    workflow_ref: request.job.workflow_ref,
    workflow_commit: request.job.workflow_commit,
    job_name: request.job.job_name,
    job_id: 321,
    status: "completed",
    conclusion: "success",
    critical_step: {
      name: request.job.critical_step,
      number: 7,
      status: "completed",
      conclusion: "success",
    },
    observed_at: now,
    expires_at: now + 30_000,
  };
}
function rig() {
  const records = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const writes: string[] = [];
  const proofs: AppliedTargetJobRequest[] = [];
  let time = timestamp;
  let onRead: ((key: string) => void | Promise<void>) | undefined;
  let onWrite: ((key: string) => void | Promise<void>) | undefined;
  let verify = async (request: AppliedTargetJobRequest): Promise<AppliedTargetJobProof> =>
    validProof(request, time);
  const store: ControlStore = {
    async read(key) {
      reads.push(key);
      await onRead?.(key);
      const bytes = records.get(key);
      return bytes === undefined ? null : Uint8Array.from(bytes);
    },
    async write(key, bytes) {
      writes.push(key);
      records.set(key, Uint8Array.from(bytes));
      await onWrite?.(key);
    },
  };
  const configuration = { target: "staging" as const, backend, descriptor_passphrase: passphrase };
  const dependencies = {
    store,
    async verifyProducerJob(request: AppliedTargetJobRequest) {
      proofs.push(request);
      return verify(request);
    },
    now: () => time,
  };
  const handoff = new AppliedTargetHandoff(configuration, dependencies);
  return {
    handoff,
    configuration,
    dependencies,
    records,
    reads,
    writes,
    proofs,
    clock(value: number) {
      time = value;
    },
    onRead(value: typeof onRead) {
      onRead = value;
    },
    onWrite(value: typeof onWrite) {
      onWrite = value;
    },
    verify(value: typeof verify) {
      verify = value;
    },
  };
}
async function sealed(mode: "apply" | "no-changes" = "apply") {
  const r = rig();
  const request = fixture(mode);
  const receipt = await r.handoff.seal(request);
  return { ...r, request, receipt };
}

describe("private authenticated applied-target handoff", () => {
  test("persists encrypted exact bytes and consumes only independently successful Apply job evidence", async () => {
    const r = await sealed();
    expect(r.proofs).toHaveLength(0);
    expect(r.writes).toEqual([r.receipt.path]);
    const bytes = r.records.get(r.receipt.path);
    expect(bytes).toBeDefined();
    for (const privateValue of [
      "staging.example.org",
      "192.0.2.10",
      passphrase,
      r.request.context.release.digest,
    ])
      expect(Buffer.from(bytes ?? []).includes(Buffer.from(privateValue))).toBe(false);
    const result = await r.handoff.read({ context: r.request.context, receipt: r.receipt });
    expect(result.envelope).toEqual(r.request.envelope);
    expect(r.proofs).toHaveLength(1);
    expect(r.proofs[0]?.job).toEqual({
      workflow_ref: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
      workflow_commit: r.request.context.release.config_commit,
      job_name: "Apply infrastructure",
      critical_step: "Seal applied target descriptor",
    });
    expect(Object.isFrozen(result.envelope.descriptor.addresses)).toBe(true);
    expect(Object.isFrozen(r.proofs[0]?.receipt.release)).toBe(true);
    expect(Object.isFrozen(r.receipt)).toBe(true);
    expect(JSON.stringify(r.handoff)).not.toContain(passphrase);
    expect(Bun.inspect(r.handoff)).not.toContain(passphrase);
  });

  test("no-change consumption proves current Plan success while retaining a historical completed baseline", async () => {
    const r = await sealed("no-changes");
    const result = await r.handoff.read({ context: r.request.context, receipt: r.receipt });
    expect(result.envelope.baseline.run).toEqual({ commit: "e".repeat(40), run: "987" });
    expect(result.envelope.verification.producer.run).toBe("1234");
    expect(r.proofs[0]?.job.job_name).toBe("Plan infrastructure");
    expect(Object.keys(result.proof)).not.toContain("run_conclusion");
  });

  test("dedicated purpose/backend/target/path domains prevent cross-record or wrong-key decryption", async () => {
    const r = await sealed();
    const bytes = r.records.get(r.receipt.path);
    expect(bytes).toBeDefined();
    for (const binding of [
      backend,
      privateDigest({ purpose: "tarubot-trust-v1", target: "staging", backend }),
      privateDigest({
        purpose: "tarubot-applied-target-handoff-v1",
        target: "production",
        backend,
      }),
    ]) {
      const codec = new RecordCodec(passphrase, binding);
      expect(() => codec.open(r.receipt.path, bytes ?? new Uint8Array())).toThrow(
        "invalid-control-record",
      );
    }
    const original = new RecordCodec(passphrase, r.handoff.binding);
    expect(() => original.open(`${r.receipt.path}/foreign`, bytes ?? new Uint8Array())).toThrow(
      "invalid-control-record",
    );
    const wrongKey = new AppliedTargetHandoff(
      {
        target: "staging",
        backend,
        descriptor_passphrase: "different-invented-dedicated-private-key",
      },
      r.dependencies,
    );
    await expect(wrongKey.read({ context: r.request.context, receipt: r.receipt })).rejects.toThrow(
      "target-handoff-read-failed",
    );
    expect(r.proofs).toHaveLength(0);
  });

  test("immutable sealing refuses existing bytes and uncertain acknowledged storage writes without retry", async () => {
    const r = await sealed();
    await expect(r.handoff.seal(r.request)).rejects.toThrow("target-handoff-seal-failed");
    expect(r.writes).toHaveLength(1);
    const uncertain = rig();
    uncertain.onWrite(() => {
      throw new Error("private-provider-diagnostic-invented");
    });
    await expect(uncertain.handoff.seal(fixture())).rejects.toThrow("target-handoff-seal-failed");
    expect(uncertain.records.size).toBe(1);
    uncertain.onWrite(undefined);
    await expect(uncertain.handoff.seal(fixture())).rejects.toThrow("target-handoff-seal-failed");
    expect(uncertain.writes).toHaveLength(1);
  });

  test("refuses expected receipt/release/producer/path/digest substitution before job verification", async () => {
    const r = await sealed();
    const changes: Array<
      (q: { context: AppliedTargetContext; receipt: AppliedTargetReceipt }) => void
    > = [
      (q) => {
        q.context.target = "production";
      },
      (q) => {
        q.context.release.version = "2.36.12";
      },
      (q) => {
        q.context.release.digest = `sha256:${"9".repeat(64)}`;
      },
      (q) => {
        q.context.release.schema_head = "002_other.sql";
      },
      (q) => {
        q.context.producer.run = "4321";
      },
      (q) => {
        q.receipt.backend = "b".repeat(64);
      },
      (q) => {
        q.receipt.path += "/foreign";
      },
      (q) => {
        q.receipt.payload_digest = "b".repeat(64);
      },
      (q) => {
        q.receipt.ciphertext_digest = "b".repeat(64);
      },
      (q) => {
        q.receipt.mode = "no-changes";
      },
      (q) => {
        q.receipt.issued_at += 1;
      },
      (q) => {
        q.receipt.expires_at -= 1;
      },
      (q) => {
        Object.assign(q.receipt, { approved: true });
      },
    ];
    for (const change of changes) {
      const q = structuredClone({ context: r.request.context, receipt: r.receipt });
      change(q);
      await expect(r.handoff.read(q)).rejects.toThrow("target-handoff-read-failed");
    }
    expect(r.proofs).toHaveLength(0);
  });

  test("requires exact fresh job/step/workflow/head and private ciphertext/payload binding, never generic run success", async () => {
    const r = await sealed();
    const changes: Array<(p: AppliedTargetJobProof) => void> = [
      (p) => {
        p.job_name = "Plan infrastructure";
      },
      (p) => {
        p.job_id = 0;
      },
      (p) => {
        p.head_commit = "e".repeat(40);
      },
      (p) => {
        p.workflow_commit = "e".repeat(40);
      },
      (p) => {
        p.workflow_ref = "foreign" as AppliedTargetJobProof["workflow_ref"];
      },
      (p) => {
        p.producer.attempt = 2 as 1;
      },
      (p) => {
        p.producer.run = "999";
      },
      (p) => {
        p.receipt.payload_digest = "f".repeat(64);
      },
      (p) => {
        p.receipt.ciphertext_digest = "f".repeat(64);
      },
      (p) => {
        p.receipt.target = "production";
      },
      (p) => {
        p.receipt.backend = "f".repeat(64);
      },
      (p) => {
        p.status = "in_progress" as "completed";
      },
      (p) => {
        p.conclusion = "failure" as "success";
      },
      (p) => {
        p.critical_step.name = "Apply infrastructure" as "Seal applied target descriptor";
      },
      (p) => {
        p.critical_step.number = 0;
      },
      (p) => {
        p.critical_step.conclusion = "skipped" as "success";
      },
      (p) => {
        p.observed_at -= 1;
      },
      (p) => {
        p.observed_at += 1;
      },
      (p) => {
        p.expires_at = timestamp;
      },
      (p) => {
        p.expires_at += 1;
      },
      (p) => {
        Object.assign(p, { run_conclusion: "success" });
      },
    ];
    for (const change of changes) {
      r.verify(async (request) => {
        const proof = validProof(request, timestamp);
        change(proof);
        return proof;
      });
      await expect(
        r.handoff.read({ context: r.request.context, receipt: r.receipt }),
      ).rejects.toThrow("target-handoff-read-failed");
    }
    r.verify(async () => true as unknown as AppliedTargetJobProof);
    await expect(
      r.handoff.read({ context: r.request.context, receipt: r.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
  });

  test("copies producer and consumer inputs before awaits and job responses before final readback", async () => {
    const r = rig();
    const request = fixture();
    const original = structuredClone(request);
    r.onRead(() => {
      request.context.release.version = "2.36.12";
      request.envelope.descriptor.fqdn = "changed.example.org";
    });
    const receipt = await r.handoff.seal(request);
    expect(receipt.release).toEqual(original.context.release);
    r.onRead(undefined);
    const q = { context: structuredClone(original.context), receipt: structuredClone(receipt) };
    let response: AppliedTargetJobProof | undefined;
    r.verify(async (expected) => {
      q.context.producer.run = "4321";
      q.receipt.ciphertext_digest = "f".repeat(64);
      response = validProof(expected, timestamp);
      r.onRead(() => {
        if (response) response.job_name = "Plan infrastructure";
      });
      return response;
    });
    const result = await r.handoff.read(q);
    expect(result.envelope).toEqual(original.envelope);
    expect(result.proof.job_name).toBe("Apply infrastructure");
    expect(response?.job_name).toBe("Plan infrastructure");
  });

  test("runtime-private captured dependencies resist serialization, constructor mutation and callback replacement", async () => {
    const r = rig();
    Object.assign(r.configuration, {
      target: "production",
      backend: "b".repeat(64),
      descriptor_passphrase: "hostile",
    });
    r.dependencies.verifyProducerJob = async () => {
      throw new Error("replaced-private-callback");
    };
    r.dependencies.store.read = async () => {
      throw new Error("replaced-private-reader");
    };
    r.dependencies.store.write = async () => {
      throw new Error("replaced-private-writer");
    };
    expect(() => Object.assign(r.handoff, { verify: async () => true, codec: null })).toThrow();
    const request = fixture();
    const receipt = await r.handoff.seal(request);
    const result = await r.handoff.read({ context: request.context, receipt });
    expect(result.envelope).toEqual(request.envelope);
    expect(r.proofs).toHaveLength(1);
    expect(Object.keys(r.handoff).sort()).toEqual(["backend", "binding", "target"]);
  });

  test("the independently trusted verifier capability is captured once before constructor getter substitution", async () => {
    const r = rig();
    let accesses = 0;
    const handoff = new AppliedTargetHandoff(r.configuration, {
      store: r.dependencies.store,
      get verifyProducerJob() {
        accesses++;
        return accesses === 1
          ? async (request: AppliedTargetJobRequest) => validProof(request, timestamp)
          : async () => true as unknown as AppliedTargetJobProof;
      },
      now: () => timestamp,
    });
    const request = fixture();
    const receipt = await handoff.seal(request);
    const result = await handoff.read({ context: request.context, receipt });
    expect(result.envelope).toEqual(request.envelope);
    expect(accesses).toBe(1);
  });

  test("readback must preserve exact ciphertext before and after independent job proof", async () => {
    for (const stage of ["seal", "read", "final"] as const) {
      const r = rig();
      const request = fixture();
      if (stage === "seal")
        r.onWrite((key) => {
          r.records.get(key)?.fill(0);
        });
      if (stage === "seal") {
        await expect(r.handoff.seal(request)).rejects.toThrow("target-handoff-seal-failed");
        continue;
      }
      const receipt = await r.handoff.seal(request);
      if (stage === "read") r.records.get(receipt.path)?.fill(0);
      else
        r.verify(async (expected) => {
          r.records.get(receipt.path)?.fill(0);
          return validProof(expected, timestamp);
        });
      await expect(r.handoff.read({ context: request.context, receipt })).rejects.toThrow(
        "target-handoff-read-failed",
      );
      expect(r.proofs).toHaveLength(stage === "read" ? 0 : 1);
    }
    const missing = await sealed();
    missing.records.clear();
    await expect(
      missing.handoff.read({ context: missing.request.context, receipt: missing.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
  });

  test("expiry/deadlines are rechecked around writes and every final readback; late acknowledgements never succeed", async () => {
    for (const stage of ["before-write", "after-write", "seal-readback"] as const) {
      const r = rig();
      const request = fixture();
      request.expires_at = timestamp + 100;
      if (stage === "before-write")
        r.onRead(() => {
          r.clock(timestamp + 100);
        });
      if (stage === "after-write")
        r.onWrite(() => {
          r.clock(timestamp + 100);
        });
      if (stage === "seal-readback")
        r.onWrite(() => {
          r.onRead(() => {
            r.clock(timestamp + 100);
          });
        });
      await expect(r.handoff.seal(request)).rejects.toThrow("target-handoff-seal-failed");
      expect(r.writes).toHaveLength(stage === "before-write" ? 0 : 1);
    }
    const r = await sealed();
    r.verify(async (request) => {
      r.onRead(() => {
        r.clock(timestamp + 30_000);
      });
      return validProof(request, timestamp);
    });
    await expect(
      r.handoff.read({ context: r.request.context, receipt: r.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
    const late = await sealed();
    late.onRead(() => {
      late.clock(timestamp + 60_001);
    });
    await expect(
      late.handoff.read({ context: late.request.context, receipt: late.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
    expect(late.proofs).toHaveLength(0);
    const backwards = await sealed();
    backwards.onRead(() => {
      backwards.clock(timestamp - 1);
    });
    await expect(
      backwards.handoff.read({ context: backwards.request.context, receipt: backwards.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
  });

  test("bounded JSON/ciphertext and explicit mandatory constructor boundaries reject before use", async () => {
    const r = rig();
    let invoked = false;
    const getter = fixture();
    Object.defineProperty(getter.envelope.descriptor, "fqdn", {
      enumerable: true,
      get() {
        invoked = true;
        return "staging.example.org";
      },
    });
    await expect(r.handoff.seal(getter)).rejects.toThrow("target-handoff-seal-failed");
    expect(invoked).toBe(false);
    const enormous = fixture();
    Object.assign(enormous.envelope, { extra: "x".repeat(65_537) });
    await expect(r.handoff.seal(enormous)).rejects.toThrow("target-handoff-seal-failed");
    expect(r.reads).toHaveLength(0);
    for (const invalid of [undefined, true, {}])
      expect(
        () =>
          new AppliedTargetHandoff(r.configuration, {
            store: r.dependencies.store,
            verifyProducerJob: invalid as never,
          }),
      ).toThrow("invalid-target-handoff");
    const present = await sealed();
    present.records.set(present.receipt.path, new Uint8Array(65_569));
    await expect(
      present.handoff.read({ context: present.request.context, receipt: present.receipt }),
    ).rejects.toThrow("target-handoff-read-failed");
    expect(present.proofs).toHaveLength(0);
  });

  test("unresolved transport acknowledgements stop at expiry and preserve uncertain immutable bytes", async () => {
    const r = rig();
    const request = fixture();
    request.expires_at = timestamp + 20;
    r.onWrite(() => new Promise<void>(() => {}));
    await expect(r.handoff.seal(request)).rejects.toThrow("target-handoff-seal-failed");
    expect(r.records.size).toBe(1);
    expect(r.writes).toHaveLength(1);
    r.onWrite(undefined);
    await expect(r.handoff.seal(request)).rejects.toThrow("target-handoff-seal-failed");
    expect(r.writes).toHaveLength(1);
  });

  test("shared-memory ciphertext cannot change the authenticated snapshot while job evidence awaits", async () => {
    const r = await sealed();
    const original = r.records.get(r.receipt.path);
    if (!original) throw new Error("missing-invented-sealed-record");
    const shared = new Uint8Array(new SharedArrayBuffer(original.length));
    shared.set(original);
    const handoff = new AppliedTargetHandoff(
      { target: "staging", backend, descriptor_passphrase: passphrase },
      {
        store: { read: async () => shared, write: async () => {} },
        async verifyProducerJob(request) {
          // Both the first and final transport returns share a backing buffer. Keeping the first
          // view would accept the changed bytes after checking its old authenticated digest.
          shared.fill(0);
          return validProof(request, timestamp);
        },
        now: () => timestamp,
      },
    );
    await expect(handoff.read({ context: r.request.context, receipt: r.receipt })).rejects.toThrow(
      "target-handoff-read-failed",
    );
  });
});
