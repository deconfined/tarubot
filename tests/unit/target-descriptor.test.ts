/** Invented completed journal links and full module values; no backend, provider or target reads. */
import { describe, expect, test } from "bun:test";
import { privateDigest, stateEvidence } from "../../scripts/infra-control.js";
import { classifyPlan, inputs } from "../../scripts/infra-policy.js";
import {
  appliedTargetEnvelope,
  deriveAppliedTarget,
  type AppliedTargetExtraction,
  type AppliedTargetProducer,
} from "../../scripts/target-descriptor.js";
import { releasePlan } from "../fixtures/infra/release.js";

type Value = Record<string, unknown>;
const object = (v: unknown) => v as Value;
const release = {
  version: "2.36.10",
  commit: "1".repeat(40),
  config_commit: "1".repeat(40),
  digest: `sha256:${"2".repeat(64)}`,
  publication_run: "1234",
  schema_head: "001_initial.sql",
};
const producer: AppliedTargetProducer = {
  repository: "deconfined/tarubot",
  workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
  ref: "refs/heads/main",
  event: "push",
  attempt: 1,
  commit: release.commit,
  run: release.publication_run,
};
const generation = "11111111-1111-4111-8111-111111111111";
const priorGeneration = "33333333-3333-4333-8333-333333333333";
const lineage = "22222222-2222-4222-8222-222222222222";
type Plan = ReturnType<typeof releasePlan>;
function fixture(
  mode: "apply" | "no-changes" = "no-changes",
  edit?: (p: Plan) => void,
): AppliedTargetExtraction {
  const p = releasePlan(mode === "apply" ? "example-renamed" : undefined);
  const hostOutput = p.planned_values.outputs.hosts;
  if (!hostOutput) throw new Error("missing invented host output");
  hostOutput.sensitive = false;
  edit?.(p);
  const applied = {
    format_version: "1.0",
    terraform_version: "1.12.6",
    values: structuredClone(p.planned_values),
  };
  const resources = new Map<string, Value>();
  for (const r of applied.values.root_module.resources) {
    const key = `${r.type}.${r.name}`;
    let group = resources.get(key);
    if (!group) {
      group = {
        mode: "managed",
        type: r.type,
        name: r.name,
        provider: `provider[${JSON.stringify(r.provider_name)}]`,
        instances: [],
      };
      resources.set(key, group);
    }
    (group.instances as unknown[]).push({
      index_key: r.index,
      schema_version: 0,
      attributes: structuredClone(r.values),
    });
  }
  const raw = {
    version: 4,
    terraform_version: "1.12.6",
    lineage,
    serial: 5,
    resources: [...resources.values()],
    outputs: structuredClone(applied.values.outputs),
  };
  const evidence = stateEvidence(raw);
  const settings = inputs(
    Object.fromEntries(Object.entries(p.variables).map(([key, value]) => [key, value.value])),
  );
  const intent = {
    generation,
    previous: mode === "apply" ? priorGeneration : null,
    kind: mode === "apply" ? "apply" : "baseline",
    run:
      mode === "apply"
        ? { commit: producer.commit, run: producer.run }
        : { commit: "e".repeat(40), run: "987" },
    binding: "f".repeat(64),
    inputs: settings,
    before: mode === "apply" ? { ...evidence, serial: 4, digest: "a".repeat(64) } : evidence,
  };
  const baseline = { intent, state: evidence };
  const original = releasePlan();
  const priorIntent = {
    generation: priorGeneration,
    previous: null,
    kind: "baseline",
    run: { commit: "e".repeat(40), run: "987" },
    binding: "b".repeat(64),
    inputs: inputs(
      Object.fromEntries(
        Object.entries(original.variables).map(([key, value]) => [key, value.value]),
      ),
    ),
    before: intent.before,
  };
  const priorBaseline = { intent: priorIntent, state: intent.before };
  return {
    target: "staging",
    release: structuredClone(release),
    producer: structuredClone(producer),
    mode,
    plan: p,
    applied_show: applied,
    state_readback: raw,
    state_reopened: structuredClone(raw),
    snapshot: { generation, state: evidence, inputs: settings },
    completed: {
      current: { baseline: generation, pending: null },
      intent: structuredClone(intent),
      baseline,
      completion: { generation, baseline: privateDigest(baseline) },
    },
    prior_completed:
      mode === "apply"
        ? {
            generation: priorGeneration,
            intent: structuredClone(priorIntent),
            baseline: priorBaseline,
            completion: { generation: priorGeneration, baseline: privateDigest(priorBaseline) },
          }
        : null,
  };
}
function refuse(request: AppliedTargetExtraction) {
  expect(() => deriveAppliedTarget(request)).toThrow("invalid-applied-target-evidence");
}
/** Rebind hashes only when testing internally consistent hostile resource values, never valid authority. */
function rebind(request: AppliedTargetExtraction) {
  request.state_reopened = structuredClone(request.state_readback);
  const s = stateEvidence(request.state_readback);
  request.snapshot.state = s;
  const b = object(request.completed.baseline);
  b.state = s;
  const i = object(request.completed.intent);
  if (i.kind === "baseline") i.before = s;
  b.intent = structuredClone(i);
  request.completed.completion = { generation, baseline: privateDigest(b) };
}

describe("private completed applied-target projection", () => {
  test("no-change verification retains prior baseline identity and exposes only minimized private fields", () => {
    const request = fixture();
    const evidence = deriveAppliedTarget(request);
    expect(evidence.descriptor).toEqual({
      schema: 1,
      target: "staging",
      provider: "linode",
      instance_id: "200",
      fqdn: "staging.example.org",
      addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
      dns_zone_id: "0".repeat(32),
      applied_generation: generation,
      state: request.snapshot.state,
    });
    expect(evidence.verification).toEqual({ mode: "no-changes", producer });
    expect(evidence.baseline.run).toEqual({ commit: "e".repeat(40), run: "987" });
    expect(evidence.baseline.baseline_digest).toBe(privateDigest(request.completed.baseline));
    expect(evidence.baseline.completion_digest).toBe(privateDigest(request.completed.completion));
    const serialized = JSON.stringify(evidence);
    for (const privateField of [
      "invented-root-public-key",
      "invented-configure-public-key",
      "invented-unchanged-hash",
      "invented-unchanged-data",
      "database_ids",
      "root_keys",
      "inputs",
      "metadata",
      "example-staging",
      "g6-standard-1",
    ])
      expect(serialized).not.toContain(privateField);
    expect(evidence).not.toHaveProperty("verified");
    expect(evidence).not.toHaveProperty("successful");
  });
  test("Apply extraction binds the newly completed baseline to this exact producer", () => {
    const request = fixture("apply");
    const evidence = deriveAppliedTarget(request);
    expect(evidence.baseline.run).toEqual({ commit: producer.commit, run: producer.run });
    expect(evidence.verification.mode).toBe("apply");
    expect(appliedTargetEnvelope(evidence, { target: "staging", release, producer })).toEqual(
      evidence,
    );
    object(request.completed.intent).run = { commit: "b".repeat(40), run: "9" };
    rebind(request);
    refuse(request);
  });
  test("Apply requires all prior completed links and exact predecessor state rather than an input assertion", () => {
    for (const mutate of [
      (r: AppliedTargetExtraction) => {
        r.prior_completed = null;
      },
      (r: AppliedTargetExtraction) => {
        delete (r as unknown as Value).prior_completed;
      },
      (r: AppliedTargetExtraction) => {
        object(r.prior_completed).generation = generation;
      },
      (r: AppliedTargetExtraction) => {
        object(r.prior_completed).intent = null;
      },
      (r: AppliedTargetExtraction) => {
        object(r.prior_completed).baseline = null;
      },
      (r: AppliedTargetExtraction) => {
        object(r.prior_completed).completion = null;
      },
      (r: AppliedTargetExtraction) => {
        object(object(r.prior_completed).completion).generation = generation;
      },
      (r: AppliedTargetExtraction) => {
        object(object(r.prior_completed).completion).baseline = "a".repeat(64);
      },
      (r: AppliedTargetExtraction) => {
        object(object(r.prior_completed).intent).binding = "a".repeat(64);
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.intent).before = { ...r.snapshot.state, serial: 3 };
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        const prior = object(r.prior_completed);
        const state = { ...r.snapshot.state, serial: 3 };
        const intent = object(prior.intent);
        intent.before = state;
        const baseline = { intent: structuredClone(intent), state };
        prior.baseline = baseline;
        prior.completion = { generation: priorGeneration, baseline: privateDigest(baseline) };
      },
    ]) {
      const request = fixture("apply");
      mutate(request);
      refuse(request);
    }
    const noChanges = fixture();
    noChanges.prior_completed = fixture("apply").prior_completed;
    refuse(noChanges);
  });
  test("ignored creation inputs are checked against the authenticated prior baseline during Apply", () => {
    for (const [key, value] of [
      ["root_keys", ["invented-new-root-public-key"]],
      ["configure_keys", { staging: "invented-new-configure-public-key" }],
      ["root_password_hash", "invented-new-console-hash"],
    ] as const) {
      const request = fixture("apply", (p) => {
        object(p.variables)[key] = { value };
      });
      // The regression is meaningful: comparing only the after-inputs to themselves is safe,
      // despite the provider plan retaining the ignored creation values from the older state.
      expect(
        classifyPlan(request.plan, request.snapshot.inputs, request.snapshot.inputs).decision,
      ).toBe("safe");
      const prior = object(request.prior_completed);
      expect(
        classifyPlan(request.plan, request.snapshot.inputs, object(prior.intent).inputs).reasons,
      ).toContain("changed-intent");
      refuse(request);
      // Replacing only the historical input assertion cannot preserve its completion digest.
      object(prior.intent).inputs = structuredClone(request.snapshot.inputs);
      refuse(request);
    }
  });
  test("expanded provider IPv6 is validated against exact module outputs then canonicalized", () => {
    const request = fixture("no-changes", (p) => {
      const host = p.resource_changes.find((r) => r.type === "linode_instance");
      const dns = p.resource_changes.find((r) => r.name === "aaaa");
      if (!host || !dns) throw new Error("missing invented address resources");
      const ip = "2001:0db8:0000:0000:0000:0000:0000:0010";
      host.change.before.ipv6 = `${ip}/128`;
      host.change.after.ipv6 = `${ip}/128`;
      dns.change.before.content = ip;
      dns.change.after.content = ip;
      object(object(p.planned_values.outputs.addresses).value).staging = {
        ipv4: "192.0.2.10",
        ipv6: ip,
      };
      const output = object(p.output_changes.addresses);
      output.before = structuredClone(object(p.planned_values.outputs.addresses).value);
      output.after = structuredClone(output.before);
    });
    expect(deriveAppliedTarget(request).descriptor.addresses.ipv6).toBe("2001:db8::10");
  });
  test("missing baseline, pending intent or any broken durable link is not a successful outcome", () => {
    for (const mutate of [
      (r: AppliedTargetExtraction) => {
        r.snapshot.generation = null;
      },
      (r: AppliedTargetExtraction) => {
        r.completed.current = null;
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.current).pending = generation;
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.current).baseline = "3".repeat(36);
      },
      (r: AppliedTargetExtraction) => {
        r.completed.completion = null;
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.completion).baseline = "a".repeat(64);
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.intent).binding = "a".repeat(64);
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.baseline).state = { ...r.snapshot.state, serial: 6 };
      },
      (r: AppliedTargetExtraction) => {
        r.snapshot.inputs = { ...r.snapshot.inputs, extra: "private" };
      },
      (r: AppliedTargetExtraction) => {
        object(r.completed.intent).previous = generation;
        rebind(r);
      },
    ]) {
      const request = fixture();
      mutate(request);
      refuse(request);
    }
  });
  test("stable post-operation raw state must bind every applied show attribute and identity", () => {
    for (const mutate of [
      (r: AppliedTargetExtraction) => {
        object(r.state_reopened).serial = 6;
      },
      (r: AppliedTargetExtraction) => {
        const raw = object(r.state_readback);
        raw.serial = 6;
        r.state_reopened = structuredClone(raw);
      },
      (r: AppliedTargetExtraction) => {
        const values = object(object(r.applied_show).values);
        object((object(values.root_module).resources as unknown[])[0]).values = { id: "999" };
      },
      (r: AppliedTargetExtraction) => {
        const raw = object(r.state_readback);
        const group = object((raw.resources as unknown[])[0]);
        object((group.instances as unknown[])[0]).attributes = { id: "999" };
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        object((object(r.state_readback).resources as unknown[])[0]).provider =
          'provider["registry.opentofu.org/linode/linode"].other';
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        const group = object((object(r.state_readback).resources as unknown[])[0]);
        group.module = "module.other";
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        const group = object((object(r.state_readback).resources as unknown[])[0]);
        object((group.instances as unknown[])[0]).status = "tainted";
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        const group = object((object(r.state_readback).resources as unknown[])[0]);
        (group.instances as unknown[]).push(structuredClone((group.instances as unknown[])[0]));
        rebind(r);
      },
      (r: AppliedTargetExtraction) => {
        object(r.state_readback).outputs = {};
        rebind(r);
      },
    ]) {
      const request = fixture();
      mutate(request);
      refuse(request);
    }
  });
  test("coherently forged outputs cannot select a different host, DNS name or address", () => {
    for (const field of ["ipv4", "role"] as const) {
      const request = fixture("no-changes", (p) => {
        const key = field === "ipv4" ? "addresses" : "hosts";
        const output = object(p.planned_values.outputs[key]);
        output.value =
          field === "ipv4"
            ? { staging: { ipv4: "192.0.2.11", ipv6: "2001:db8::10" } }
            : { staging: "production" };
        const change = object(p.output_changes[key]);
        change.before = structuredClone(output.value);
        change.after = structuredClone(output.value);
      });
      refuse(request);
    }
  });
  test("multiple hosts for one role are refused rather than selected by map or resource order", () => {
    const request = fixture("no-changes", (p) => {
      const vars = object(p.variables.hosts?.value);
      vars["staging-1"] = {
        ...object(vars.staging),
        label: "example-staging-extra",
        fqdn: "extra.example.org",
      };
      const copies = p.resource_changes
        .filter((r) => r.type !== "linode_database_access_controls")
        .map((r) => {
          const copy = structuredClone(r);
          copy.index = "staging-1";
          copy.address = `${r.type}.${r.name}["staging-1"]`;
          if (r.type === "linode_instance") {
            copy.change.before.label = "example-staging-extra";
            copy.change.after.label = "example-staging-extra";
          }
          if (r.type === "cloudflare_dns_record") {
            copy.change.before.name = "extra.example.org";
            copy.change.after.name = "extra.example.org";
          }
          return copy;
        });
      p.resource_changes.push(...copies);
      p.planned_values.root_module.resources.push(
        ...copies.map(({ change, ...r }) => ({ ...r, values: change.after })),
      );
      object(object(p.planned_values.outputs.hosts).value)["staging-1"] = "staging";
      object(object(p.planned_values.outputs.addresses).value)["staging-1"] = {
        ipv4: "192.0.2.10",
        ipv6: "2001:db8::10",
      };
      for (const key of ["hosts", "addresses"]) {
        const change = object(p.output_changes[key]);
        change.before = structuredClone(object(p.planned_values.outputs[key]).value);
        change.after = structuredClone(change.before);
      }
    });
    refuse(request);
  });
  test("unknown/module/unsafe resource plans and absent requested roles cannot become descriptors", () => {
    for (const mutate of [
      (r: AppliedTargetExtraction) => {
        r.target = "production";
      },
      (r: AppliedTargetExtraction) => {
        r.mode = "apply";
      },
      (r: AppliedTargetExtraction) => {
        object(object(r.plan).planned_values).root_module = { child_modules: [], resources: [] };
      },
      (r: AppliedTargetExtraction) => {
        const p = r.plan as Plan;
        object(p.resource_changes[0]).module_address = "module.other";
      },
      (r: AppliedTargetExtraction) => {
        const p = r.plan as Plan;
        const host = p.resource_changes[0];
        if (host) host.change.after_unknown = { id: true };
      },
      (r: AppliedTargetExtraction) => {
        const p = r.plan as Plan;
        const host = p.resource_changes[0];
        if (host) host.provider_name = "registry.opentofu.org/other/linode";
      },
      (r: AppliedTargetExtraction) => {
        const p = r.plan as Plan;
        const host = p.resource_changes[0];
        if (host) host.change.actions = ["delete"];
      },
    ]) {
      const request = fixture();
      mutate(request);
      refuse(request);
    }
    for (const id of ["0200", "0", "9999999999999999", "private diagnostic"]) {
      const request = fixture("no-changes", (p) => {
        const host = p.resource_changes[0];
        if (host) {
          host.change.before.id = id;
          host.change.after.id = id;
        }
      });
      refuse(request);
    }
  });
  test("producer identity is fixed to the matching main publication, never a dispatch override", () => {
    for (const delta of [
      { repository: "other/repo" },
      { workflow_ref: "other.yml" },
      { ref: "refs/heads/topic" },
      { event: "workflow_dispatch" },
      { attempt: 2 },
      { commit: "a".repeat(40) },
      { run: "9999" },
      { verified: true },
    ]) {
      const request = fixture();
      Object.assign(request.producer, delta);
      refuse(request);
    }
  });
  test("strict wrapped fields reject replay and mutations while preserving independent clones", () => {
    const request = fixture();
    const envelope = deriveAppliedTarget(request);
    const expected = { target: "staging" as const, release, producer };
    expect(appliedTargetEnvelope(envelope, expected)).toEqual(envelope);
    for (const mutate of [
      (e: typeof envelope) => {
        e.purpose = "other" as typeof e.purpose;
      },
      (e: typeof envelope) => {
        e.descriptor.target = "production";
      },
      (e: typeof envelope) => {
        e.baseline.state.serial++;
      },
      (e: typeof envelope) => {
        e.baseline.generation = "a".repeat(36);
      },
      (e: typeof envelope) => {
        e.baseline.completion_digest = "a".repeat(64);
      },
      (e: typeof envelope) => {
        Object.assign(e.verification, { successful: true });
      },
      (e: typeof envelope) => {
        e.verification.producer.run = "99";
      },
    ]) {
      const e = structuredClone(envelope);
      mutate(e);
      expect(() => appliedTargetEnvelope(e, expected)).toThrow("invalid-applied-target-evidence");
    }
    request.release.commit = "b".repeat(40);
    request.snapshot.state.serial = 999;
    expect(envelope.release.commit).toBe(release.commit);
    expect(envelope.descriptor.state.serial).toBe(5);
    const parsed = appliedTargetEnvelope(envelope, expected);
    parsed.descriptor.addresses.ipv4 = "192.0.2.99";
    expect(envelope.descriptor.addresses.ipv4).toBe("192.0.2.10");
  });
  test("an accessor cannot mutate a descriptor after the envelope's target was checked", () => {
    const envelope = deriveAppliedTarget(fixture());
    const baseline = structuredClone(envelope.baseline);
    Object.defineProperty(envelope, "baseline", {
      enumerable: true,
      get: () => {
        envelope.descriptor.target = "production";
        return baseline;
      },
    });
    const parsed = appliedTargetEnvelope(envelope, { target: "staging", release, producer });
    expect(envelope.descriptor.target).toBe("production");
    expect(parsed.descriptor.target).toBe("staging");
    expect(parsed.baseline).toEqual(baseline);
    expect(() => appliedTargetEnvelope(envelope, { target: "staging", release, producer })).toThrow(
      "invalid-applied-target-evidence",
    );
  });
});
