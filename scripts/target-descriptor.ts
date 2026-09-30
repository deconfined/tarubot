/**
 * Pure private projection from already authenticated completed infrastructure evidence. This
 * module does not read a backend, approve an operation, attest a producer or confer SSH trust.
 * Future adapters must authenticate every journal path, hold the serialized writer boundary,
 * seal this value privately and independently confirm the exact producer job's final success.
 */
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  privateDigest,
  stateEvidence,
  verifyAppliedPlan,
  type RunIdentity,
  type Snapshot,
  type StateEvidence,
} from "./infra-control.js";
import { classifyPlan, inputs } from "./infra-policy.js";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import { targetDescriptor, type TargetDescriptor, type TargetRole } from "./ssh-trust.js";

type Value = Record<string, unknown>;
const purpose = "tarubot-applied-target-v1";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-applied-target-evidence");
}
function object(value: unknown): Value {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: string[]): Value {
  const v = object(value);
  valid(isDeepStrictEqual(Object.keys(v).sort(), [...keys].sort()));
  return v;
}
function list(value: unknown): unknown[] {
  valid(Array.isArray(value));
  return value;
}
function generation(value: unknown): asserts value is string {
  valid(typeof value === "string" && uuid.test(value));
}
function digest(value: unknown): asserts value is string {
  valid(typeof value === "string" && sha.test(value));
}
function run(value: unknown): RunIdentity {
  const r = exact(value, ["commit", "run"]);
  valid(typeof r.commit === "string" && /^[a-f0-9]{40}$/u.test(r.commit));
  valid(typeof r.run === "string" && /^[1-9][0-9]{0,19}$/u.test(r.run));
  return structuredClone(r) as unknown as RunIdentity;
}
function state(value: unknown): StateEvidence {
  const s = exact(value, ["lineage", "serial", "digest"]);
  generation(s.lineage);
  valid(Number.isSafeInteger(s.serial) && typeof s.serial === "number" && s.serial >= 0);
  digest(s.digest);
  return structuredClone(s) as unknown as StateEvidence;
}
function role(value: unknown): asserts value is TargetRole {
  valid(value === "staging" || value === "production");
}

export interface AppliedTargetProducer {
  repository: "deconfined/tarubot";
  workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main";
  ref: "refs/heads/main";
  event: "push";
  attempt: 1;
  commit: string;
  run: string;
}
function producer(value: unknown, release: ReleaseIdentity): AppliedTargetProducer {
  const p = exact(value, [
    "repository",
    "workflow_ref",
    "ref",
    "event",
    "attempt",
    "commit",
    "run",
  ]);
  valid(
    p.repository === "deconfined/tarubot" &&
      p.workflow_ref === "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" &&
      p.ref === "refs/heads/main" &&
      p.event === "push" &&
      p.attempt === 1 &&
      p.commit === release.commit &&
      p.run === release.publication_run,
  );
  return structuredClone(p) as unknown as AppliedTargetProducer;
}

/** Current verification can reopen a prior completed baseline without inventing a new Apply. */
export interface AppliedTargetEnvelope {
  schema: 1;
  purpose: "tarubot-applied-target-v1";
  descriptor: TargetDescriptor;
  release: ReleaseIdentity;
  verification: { mode: "apply" | "no-changes"; producer: AppliedTargetProducer };
  baseline: {
    generation: string;
    state: StateEvidence;
    run: RunIdentity;
    binding: string;
    baseline_digest: string;
    completion_digest: string;
  };
}

/** Plaintext inputs are internal private evidence, never a public artifact or target credential. */
export interface AppliedTargetExtraction {
  target: TargetRole;
  release: ReleaseIdentity;
  producer: AppliedTargetProducer;
  mode: "apply" | "no-changes";
  plan: unknown;
  applied_show: unknown;
  /** Two stable POST-operation state pulls surround show and completed-journal inspection. */
  state_readback: unknown;
  state_reopened: unknown;
  snapshot: Snapshot;
  /** These exact links must first be decrypted from their expected InfrastructureJournal paths. */
  completed: { current: unknown; intent: unknown; baseline: unknown; completion: unknown };
  /** Apply reopens the prior history at current.intent.previous; no-changes requires null. */
  prior_completed: {
    generation: string;
    intent: unknown;
    baseline: unknown;
    completion: unknown;
  } | null;
}

/** Every historical reference is reopened; a digest supplied without its exact record is insufficient. */
function history(id: unknown, intent: unknown, baseline: unknown, completion: unknown) {
  generation(id);
  const b = exact(baseline, ["intent", "state"]);
  const i = exact(intent, ["generation", "previous", "kind", "run", "binding", "inputs", "before"]);
  valid(isDeepStrictEqual(b.intent, i));
  valid(i.generation === id);
  if (i.previous !== null) generation(i.previous);
  valid(i.previous !== i.generation);
  valid(i.kind === "apply" || i.kind === "baseline");
  valid((i.kind === "baseline") === (i.previous === null));
  const observed = state(b.state);
  const before = state(i.before);
  valid(before.lineage === observed.lineage);
  valid(
    i.kind === "baseline" ? isDeepStrictEqual(before, observed) : observed.serial > before.serial,
  );
  const baselineRun = run(i.run);
  digest(i.binding);
  const settings = inputs(i.inputs);
  const c = exact(completion, ["generation", "baseline"]);
  const baselineDigest = privateDigest(b);
  valid(c.generation === id && c.baseline === baselineDigest);
  return {
    intent: i,
    settings,
    baseline: {
      generation: id,
      state: observed,
      run: baselineRun,
      binding: i.binding,
      baseline_digest: baselineDigest,
      completion_digest: privateDigest(c),
    },
  };
}

function completed(request: AppliedTargetExtraction) {
  const snapshot = exact(request.snapshot, ["generation", "state", "inputs"]);
  generation(snapshot.generation);
  const observed = stateEvidence(request.state_readback);
  valid(isDeepStrictEqual(stateEvidence(request.state_reopened), observed));
  valid(isDeepStrictEqual(state(snapshot.state), observed));
  const links = exact(request.completed, ["current", "intent", "baseline", "completion"]);
  const current = exact(links.current, ["baseline", "pending"]);
  valid(current.baseline === snapshot.generation && current.pending === null);
  const verified = history(snapshot.generation, links.intent, links.baseline, links.completion);
  valid(
    isDeepStrictEqual(verified.baseline.state, observed) &&
      isDeepStrictEqual(verified.intent.inputs, snapshot.inputs),
  );
  let priorSettings = verified.settings;
  if (request.mode === "apply") {
    valid(verified.intent.kind === "apply");
    valid(
      isDeepStrictEqual(verified.baseline.run, {
        commit: request.producer.commit,
        run: request.producer.run,
      }),
    );
    const prior = exact(request.prior_completed, [
      "generation",
      "intent",
      "baseline",
      "completion",
    ]);
    valid(prior.generation === verified.intent.previous);
    const reopened = history(prior.generation, prior.intent, prior.baseline, prior.completion);
    valid(isDeepStrictEqual(reopened.baseline.state, verified.intent.before));
    priorSettings = reopened.settings;
  } else {
    valid(request.prior_completed === null);
  }
  return { baseline: verified.baseline, settings: verified.settings, priorSettings };
}

/** Bind show's full values to the raw state whose digest is in the completed baseline. */
function resources(request: AppliedTargetExtraction): Map<string, Value> {
  const shown = object(request.applied_show);
  const values = object(shown.values);
  const root = object(values.root_module);
  valid(root.child_modules === undefined);
  const found = new Map<string, Value>();
  for (const value of list(root.resources)) {
    const r = object(value);
    valid(typeof r.address === "string" && r.mode === "managed" && !found.has(r.address));
    valid(r.module_address === undefined && r.deposed === undefined);
    found.set(r.address, r);
  }
  const raw = object(request.state_readback);
  const rawAddresses = new Set<string>();
  for (const value of list(raw.resources)) {
    const r = object(value);
    valid(r.mode === "managed" && r.module === undefined);
    valid(typeof r.type === "string" && typeof r.name === "string");
    valid(typeof r.provider === "string");
    for (const value of list(r.instances)) {
      const instance = object(value);
      valid(
        typeof instance.index_key === "string" &&
          instance.deposed === undefined &&
          instance.status === undefined,
      );
      const address = `${r.type}.${r.name}[${JSON.stringify(instance.index_key)}]`;
      valid(!rawAddresses.has(address));
      rawAddresses.add(address);
      const actual = found.get(address);
      valid(
        actual &&
          actual.type === r.type &&
          actual.name === r.name &&
          actual.index === instance.index_key,
      );
      valid(r.provider === `provider[${JSON.stringify(actual.provider_name)}]`);
      valid(isDeepStrictEqual(object(instance.attributes), object(actual.values)));
    }
  }
  valid(isDeepStrictEqual([...rawAddresses].sort(), [...found.keys()].sort()));
  valid(isDeepStrictEqual(object(raw.outputs), object(values.outputs)));
  return found;
}

/** Extraction is a consistency check, never evidence that a plan alone was applied successfully. */
export function deriveAppliedTarget(value: AppliedTargetExtraction): AppliedTargetEnvelope {
  try {
    const request = structuredClone(value);
    exact(request, [
      "target",
      "release",
      "producer",
      "mode",
      "plan",
      "applied_show",
      "state_readback",
      "state_reopened",
      "snapshot",
      "completed",
      "prior_completed",
    ]);
    role(request.target);
    const release = structuredClone(releaseIdentity(request.release));
    const verifiedProducer = producer(request.producer, release);
    valid(request.mode === "apply" || request.mode === "no-changes");
    const { baseline, settings, priorSettings } = completed(request);
    const policy = classifyPlan(request.plan, settings, priorSettings);
    valid(policy.decision === (request.mode === "apply" ? "safe" : "no-changes"));
    verifyAppliedPlan(request.plan, request.applied_show);
    const all = resources(request);
    const hosts = object(settings.hosts);
    const keys = Object.keys(hosts).filter((key) => object(hosts[key]).role === request.target);
    valid(keys.length === 1);
    const hostKey = keys[0];
    valid(hostKey);
    const at = (type: string, name: string, key: string): Value => {
      const r = all.get(`${type}.${name}[${JSON.stringify(key)}]`);
      valid(r);
      return object(r.values);
    };
    const outputs = object(object(object(request.applied_show).values).outputs);
    const hostOutput = object(outputs.hosts);
    const addressOutput = object(outputs.addresses);
    valid(hostOutput.sensitive === false && addressOutput.sensitive === true);
    const outputRoles: Value = {};
    const outputAddresses: Value = {};
    const canonicalAddresses: Value = {};
    for (const key of Object.keys(hosts)) {
      const h = object(hosts[key]);
      const instance = at("linode_instance", "host", key);
      const ipv4 = list(instance.ipv4);
      valid(ipv4.length === 1 && typeof ipv4[0] === "string" && isIP(ipv4[0]) === 4);
      valid(typeof instance.ipv6 === "string" && instance.ipv6.endsWith("/128"));
      const v6 = instance.ipv6.slice(0, -4);
      valid(isIP(v6) === 6);
      const ipv6 = new URL(`http://[${v6}]/`).hostname.slice(1, -1);
      const firewall = at("linode_firewall", "host", key);
      valid(String(instance.firewall_id) === String(firewall.id));
      for (const [recordName, type, content] of [
        ["a", "A", ipv4[0]],
        ["aaaa", "AAAA", v6],
      ] as const) {
        const dns = at("cloudflare_dns_record", recordName, key);
        valid(
          dns.zone_id === settings.cloudflare_zone_id &&
            dns.name === h.fqdn &&
            dns.type === type &&
            dns.proxied === false &&
            dns.content === content,
        );
      }
      outputRoles[key] = h.role;
      outputAddresses[key] = { ipv4: ipv4[0], ipv6: v6 };
      canonicalAddresses[key] = { ipv4: ipv4[0], ipv6 };
    }
    valid(
      isDeepStrictEqual(hostOutput.value, outputRoles) &&
        isDeepStrictEqual(addressOutput.value, outputAddresses),
    );
    const instance = at("linode_instance", "host", hostKey);
    valid(
      typeof instance.id === "string" ||
        (Number.isSafeInteger(instance.id) && Number(instance.id) > 0),
    );
    valid(/^[1-9][0-9]{0,19}$/u.test(String(instance.id)));
    valid(BigInt(String(instance.id)) <= BigInt(Number.MAX_SAFE_INTEGER));
    const descriptor = targetDescriptor({
      schema: 1,
      target: request.target,
      provider: "linode",
      instance_id: String(instance.id),
      fqdn: object(hosts[hostKey]).fqdn,
      addresses: canonicalAddresses[hostKey],
      dns_zone_id: settings.cloudflare_zone_id,
      applied_generation: baseline.generation,
      state: baseline.state,
    });
    return {
      schema: 1,
      purpose,
      descriptor,
      release,
      verification: { mode: request.mode, producer: verifiedProducer },
      baseline,
    };
  } catch {
    throw new Error("invalid-applied-target-evidence");
  }
}

/** Parsing privately decrypted fields does not authenticate a producer or grant any target action. */
export function appliedTargetEnvelope(
  value: unknown,
  expected: { target: TargetRole; release: ReleaseIdentity; producer: AppliedTargetProducer },
): AppliedTargetEnvelope {
  try {
    // Snapshot before validation: accessor-bearing callers cannot mutate fields between checks.
    const snapshot = structuredClone({ value, expected });
    const e = exact(snapshot.value, [
      "schema",
      "purpose",
      "descriptor",
      "release",
      "verification",
      "baseline",
    ]);
    valid(e.schema === 1 && e.purpose === purpose);
    const descriptor = targetDescriptor(e.descriptor);
    role(snapshot.expected.target);
    valid(descriptor.target === snapshot.expected.target);
    const release = releaseIdentity(e.release);
    valid(isDeepStrictEqual(release, releaseIdentity(snapshot.expected.release)));
    const verification = exact(e.verification, ["mode", "producer"]);
    valid(verification.mode === "apply" || verification.mode === "no-changes");
    const identity = producer(verification.producer, release);
    valid(isDeepStrictEqual(identity, producer(snapshot.expected.producer, release)));
    const b = exact(e.baseline, [
      "generation",
      "state",
      "run",
      "binding",
      "baseline_digest",
      "completion_digest",
    ]);
    valid(
      b.generation === descriptor.applied_generation &&
        isDeepStrictEqual(state(b.state), descriptor.state),
    );
    const baselineRun = run(b.run);
    for (const key of ["binding", "baseline_digest", "completion_digest"]) digest(b[key]);
    valid(
      b.completion_digest ===
        privateDigest({ generation: b.generation, baseline: b.baseline_digest }),
    );
    if (verification.mode === "apply")
      valid(isDeepStrictEqual(baselineRun, { commit: identity.commit, run: identity.run }));
    return structuredClone(e) as unknown as AppliedTargetEnvelope;
  } catch {
    throw new Error("invalid-applied-target-evidence");
  }
}
