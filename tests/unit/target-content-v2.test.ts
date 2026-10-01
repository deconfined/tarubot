/** Invented private declarations exercise bindings; parsing itself confers no authority. */
import { describe, expect, test } from "bun:test";
import { privateDigest } from "../../scripts/infra-control.js";
import {
  contentReceiptV2,
  parseTargetContentV2Bytes,
  targetBootstrapV2,
  targetBootstrapV2Path,
  targetContentV2,
  targetContentV2Bytes,
  targetContentV2Digest,
  targetContentV2Path,
  type TargetContentV2,
} from "../../scripts/target-content-v2.js";
import {
  targetIssuancePins as pins,
  type TargetIssuanceStatementV2,
} from "../../scripts/target-issuance.js";
const instant = 1_800_000_000_000;
function fixture() {
  const release = {
    version: "2.36.23",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "23456",
    schema_head: "010_invented.sql",
  };
  const producer = {
    repository: "deconfined/tarubot" as const,
    workflow_ref: pins.publication,
    ref: "refs/heads/main" as const,
    event: "push" as const,
    attempt: 1 as const,
    commit: release.commit,
    run: release.publication_run,
  };
  const generation = "11111111-1111-4111-8111-111111111111",
    state = { lineage: "22222222-2222-4222-8222-222222222222", serial: 5, digest: "c".repeat(64) },
    baseline_digest = "d".repeat(64);
  const content: TargetContentV2 = {
    schema: 2,
    purpose: "tarubot-applied-target-content-v2",
    target: "staging",
    backend: "e".repeat(64),
    release,
    producer,
    mode: "apply",
    issued_at: instant,
    expires_at: instant + 86_400_000,
    envelope: {
      schema: 1,
      purpose: "tarubot-applied-target-v1",
      descriptor: {
        schema: 1,
        target: "staging",
        provider: "linode",
        instance_id: "123",
        fqdn: "staging.example.org",
        addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
        dns_zone_id: "f".repeat(32),
        applied_generation: generation,
        state,
      },
      release,
      verification: { mode: "apply", producer },
      baseline: {
        generation,
        state,
        run: { commit: release.commit, run: release.publication_run },
        binding: "0".repeat(64),
        baseline_digest,
        completion_digest: privateDigest({ generation, baseline: baseline_digest }),
      },
    },
  };
  const context = { target: content.target, backend: content.backend, release };
  const payload_digest = targetContentV2Digest(targetContentV2Bytes(content));
  const receipt = {
    schema: 2 as const,
    purpose: content.purpose,
    target: content.target,
    backend: content.backend,
    release,
    producer,
    mode: content.mode,
    path: targetContentV2Path(content.target, release, payload_digest),
    payload_digest,
    ciphertext_digest: "1".repeat(64),
    issued_at: instant,
    expires_at: content.expires_at,
  };
  const statement: TargetIssuanceStatementV2 = {
    schema: 2,
    purpose: "tarubot-applied-target-issuance-v2",
    content_receipt: receipt,
    source: {
      plan: {
        job_id: 101,
        check_run_id: 1101,
        critical_step: { name: "Plan and require automatic policy", number: 1 },
        projection_step: { name: pins.projection, number: 2 },
      },
      apply: {
        job_id: 102,
        check_run_id: 1102,
        critical_step: { name: "Recheck policy and apply exact saved plan", number: 1 },
        projection_step: { name: pins.projection, number: 2 },
      },
    },
    issuer: {
      repository_owner_id: 123456,
      repository_id: 234567,
      job_path: pins.issuer,
      job_id: 103,
      check_run_id: 1103,
      critical_step: { name: pins.sealing, number: 1 },
    },
    issued_at: instant + 1000,
    valid_until: instant + 86_400_000 - 1000,
  };
  return { content, context, receipt, statement };
}
describe("exact new private v2 declarations", () => {
  test("canonical whole-content hash binds lifetime, minimized envelope and deterministic paths", () => {
    const f = fixture(),
      parsed = targetContentV2(f.content, f.context),
      bytes = targetContentV2Bytes(parsed);
    expect(targetContentV2(parseTargetContentV2Bytes(bytes), f.context)).toEqual(parsed);
    expect(Object.isFrozen(parsed.envelope.descriptor.addresses)).toBe(true);
    expect(contentReceiptV2(f.receipt, f.context)).toEqual(f.receipt);
    expect(targetBootstrapV2Path("staging", f.context.release)).toBe(
      `applied-target-bootstrap-v2/staging/23456/${f.context.release.commit}`,
    );
    const changed = structuredClone(f.content);
    changed.expires_at--;
    expect(targetContentV2Digest(targetContentV2Bytes(changed))).not.toBe(f.receipt.payload_digest);
    expect(
      targetBootstrapV2(
        {
          schema: 2,
          purpose: "tarubot-applied-target-bootstrap-v2",
          statement: f.statement,
          jwt: "a.b.c",
        },
        f.context,
      ).statement,
    ).toEqual(f.statement);
  });
  test("all duplicated headers and envelope projections remain bound", () => {
    for (const mutate of [
      (c: TargetContentV2) => {
        c.schema = 1 as 2;
      },
      (c: TargetContentV2) => {
        c.purpose = "tarubot-applied-target-v1" as TargetContentV2["purpose"];
      },
      (c: TargetContentV2) => {
        c.target = "production";
      },
      (c: TargetContentV2) => {
        c.backend = "9".repeat(64);
      },
      (c: TargetContentV2) => {
        c.release.commit = "9".repeat(40);
      },
      (c: TargetContentV2) => {
        c.producer.run = "999";
      },
      (c: TargetContentV2) => {
        c.mode = "no-changes";
      },
      (c: TargetContentV2) => {
        c.envelope.descriptor.target = "production";
      },
      (c: TargetContentV2) => {
        c.expires_at = c.issued_at + 86_400_001;
      },
      (c: TargetContentV2) => {
        c.expires_at = c.issued_at;
      },
    ]) {
      const f = fixture();
      mutate(f.content);
      expect(() => targetContentV2(f.content, f.context)).toThrow("invalid-target-content-v2");
    }
  });
  test("v1 receipts, path substitution, foreign context and duplicate decoded keys refuse", () => {
    const f = fixture();
    for (const patch of [
      { schema: 1 },
      { purpose: "tarubot-applied-target-handoff-v1" },
      { path: f.receipt.path.replace("content-v2", "content-v1") },
      { payload_digest: "9".repeat(64) },
      { expires_at: instant + 86_400_001 },
    ])
      expect(() => contentReceiptV2({ ...f.receipt, ...patch }, f.context)).toThrow(
        "invalid-target-content-v2",
      );
    expect(() => contentReceiptV2(f.receipt, { ...f.context, target: "production" })).toThrow(
      "invalid-target-content-v2",
    );
    expect(() => parseTargetContentV2Bytes(Buffer.from('{"schema":2,"\\u0073chema":2}'))).toThrow(
      "invalid-target-content-v2",
    );
    expect(() => parseTargetContentV2Bytes(new Uint8Array(65_537))).toThrow(
      "invalid-target-content-v2",
    );
    expect(() =>
      targetBootstrapV2(
        {
          ...{
            schema: 2,
            purpose: "tarubot-applied-target-bootstrap-v2",
            statement: f.statement,
            jwt: "a.b.c",
          },
          extra: true,
        },
        f.context,
      ),
    ).toThrow("invalid-target-content-v2");
  });
  test("accessors never execute and typed-array copy/hash ignores own spoofed hooks", () => {
    const f = fixture();
    let accesses = 0;
    Object.defineProperty(f.content, "target", {
      enumerable: true,
      get() {
        accesses++;
        throw new Error("private-diagnostic");
      },
    });
    expect(() => targetContentV2(f.content, f.context)).toThrow("invalid-target-content-v2");
    expect(accesses).toBe(0);
    const bytes = Buffer.from("invented-private-bytes");
    const before = targetContentV2Digest(bytes);
    Object.defineProperties(bytes, {
      byteLength: {
        get() {
          throw new Error("private-diagnostic");
        },
      },
      length: {
        get() {
          throw new Error("private-diagnostic");
        },
      },
      [Symbol.iterator]: {
        value() {
          throw new Error("private-diagnostic");
        },
      },
    });
    expect(targetContentV2Digest(bytes)).toBe(before);
    expect(() =>
      targetContentV2(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("private-diagnostic");
            },
          },
        ),
        fixture().context,
      ),
    ).toThrow("invalid-target-content-v2");
  });
});
