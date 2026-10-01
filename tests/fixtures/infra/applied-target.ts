/** Full invented raw state and show must agree; empty resource stand-ins cannot prove a target. */
import { inputs } from "../../../scripts/infra-policy.js";
import type { AppliedTargetProducer } from "../../../scripts/target-descriptor.js";
import { releaseIdentity } from "../../../scripts/release-policy.js";
import { releasePlan } from "./release.js";
import {
  InfrastructureJournal,
  RecordCodec,
  stateEvidence,
  type ControlStore,
} from "../../../scripts/infra-control.js";
import { baselineFixtureInstant, baselineRunFixture } from "./baseline-run.js";
import { createInfrastructureBaselineRunVerifier } from "../../../scripts/infra-baseline-run.js";

export const candidateRelease = releaseIdentity({
  version: "2.36.24",
  commit: "1".repeat(40),
  config_commit: "1".repeat(40),
  digest: `sha256:${"2".repeat(64)}`,
  publication_run: "1234",
  schema_head: "001_initial.sql",
});
export const candidateProducer: AppliedTargetProducer = {
  repository: "deconfined/tarubot",
  workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
  ref: "refs/heads/main",
  event: "push",
  attempt: 1,
  commit: candidateRelease.commit,
  run: candidateRelease.publication_run,
};
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-value");
  return value;
}
export function appliedTargetFixture(label?: string, serial = 10, both = false) {
  const plan = releasePlan(label);
  if (both) {
    // Add a second wholly invented role with full state, DNS and firewall consistency.
    const production = {
      label: "example-production",
      fqdn: "production.example.org",
      region: "us-east",
      type: "g6-standard-1",
      role: "production",
    };
    Object.assign(present(plan.variables.hosts).value, { production });
    Object.assign(present(plan.variables.configure_keys).value, {
      production: "invented-production-configure-key",
    });
    const additional = plan.resource_changes
      .filter((resource) => resource.index === "staging")
      .map((resource) => {
        const copy = structuredClone(resource);
        copy.index = "production";
        copy.address = `${copy.type}.${copy.name}["production"]`;
        const values = copy.change.after;
        if (copy.type === "linode_instance")
          Object.assign(values, {
            id: "201",
            label: production.label,
            firewall_id: 301,
            ipv4: ["192.0.2.11"],
            ipv6: "2001:db8::11/128",
          });
        if (copy.type === "linode_firewall") values.id = "301";
        if (copy.type === "cloudflare_dns_record")
          Object.assign(values, {
            id: `invented-production-${copy.name}`,
            name: production.fqdn,
            content: copy.name === "a" ? "192.0.2.11" : "2001:db8::11",
          });
        copy.change.before = structuredClone(values);
        copy.change.actions = ["no-op"];
        return copy;
      });
    plan.resource_changes.push(...additional);
    plan.planned_values.root_module.resources = plan.resource_changes.map(
      ({ change, ...resource }) => ({ ...resource, values: change.after }),
    );
    Object.assign(present(plan.planned_values.outputs.hosts).value, { production: "production" });
    Object.assign(present(plan.planned_values.outputs.addresses).value, {
      production: { ipv4: "192.0.2.11", ipv6: "2001:db8::11" },
    });
    for (const [name, value] of Object.entries(plan.planned_values.outputs)) {
      const change = plan.output_changes[name];
      if (change) {
        change.before = structuredClone(value.value);
        change.after = structuredClone(value.value);
      }
    }
  }
  const hosts = plan.planned_values.outputs.hosts;
  if (!hosts) throw new Error("missing-invented-hosts");
  hosts.sensitive = false;
  const show = {
    format_version: "1.0",
    terraform_version: "1.12.6",
    values: structuredClone(plan.planned_values),
  };
  const groups = new Map<string, Record<string, unknown>>();
  for (const resource of show.values.root_module.resources) {
    const name = `${resource.type}.${resource.name}`;
    let group = groups.get(name);
    if (!group) {
      group = {
        mode: "managed",
        type: resource.type,
        name: resource.name,
        provider: `provider[${JSON.stringify(resource.provider_name)}]`,
        instances: [],
      };
      groups.set(name, group);
    }
    (group.instances as unknown[]).push({
      index_key: resource.index,
      schema_version: 0,
      attributes: structuredClone(resource.values),
    });
  }
  const raw = {
    version: 4,
    terraform_version: "1.12.6",
    lineage: "11111111-1111-4111-8111-111111111111",
    serial,
    resources: [...groups.values()],
    outputs: structuredClone(show.values.outputs),
  };
  const settings = inputs(
    Object.fromEntries(Object.entries(plan.variables).map(([name, value]) => [name, value.value])),
  );
  return { plan, show, raw, settings };
}

const codec = new RecordCodec("invented-projection-journal-passphrase-1234567890", "a".repeat(64));
/** Every historical request passes the real parser; the current Apply remains unfinished. */
export async function nativeTargetFixture(both = false) {
  const objects = new Map<string, Uint8Array>();
  const clock = { now: baselineFixtureInstant };
  const status = { historical: true, current: false };
  const hooks: {
    read?: (path: string, value: Uint8Array | null) => Promise<Uint8Array | null>;
    written?: (path: string, value: Uint8Array) => Promise<void>;
  } = {};
  const store: ControlStore = {
    async read(path) {
      const value = objects.get(path) ?? null;
      return hooks.read ? hooks.read(path, value) : value;
    },
    async write(path, bytes, beforeWrite) {
      beforeWrite?.();
      objects.set(path, Uint8Array.from(bytes));
      await hooks.written?.(path, bytes);
    },
  };
  const journal = new InfrastructureJournal(store, codec, {
    now: () => clock.now,
    verifyBaselineRun: async (request, denial) => {
      const current = request.run.run === candidateRelease.publication_run;
      const source = baselineRunFixture(request, { automatic: current });
      source.clock.now = clock.now;
      if (!(current ? status.current : status.historical)) {
        Object.assign(source.apply, { status: "in_progress", conclusion: null });
      }
      return createInfrastructureBaselineRunVerifier(source.configuration, {
        get: source.get,
        now: () => clock.now,
      })(request, denial);
    },
  });
  const before = appliedTargetFixture(undefined, 10, both);
  const first = await journal.inspect(stateEvidence(before.raw));
  await journal.finish(
    await journal.begin(
      first,
      before.settings,
      { commit: "e".repeat(40), run: "1000" },
      "b".repeat(64),
      "baseline",
    ),
    first.state,
  );
  const snapshot = await journal.inspect(first.state);
  const after = appliedTargetFixture("example-renamed", 11, both);
  const evidence = (mode: "apply" | "no-changes") => {
    const values = mode === "apply" ? after : before;
    return {
      plan: values.plan,
      applied_show: values.show,
      state_readback: values.raw,
      state_reopened: structuredClone(values.raw),
    };
  };
  const prepare = (expires_at?: number, targets: ("staging" | "production")[] = ["staging"]) =>
    journal.prepareTargetCandidates({
      targets,
      release: candidateRelease,
      producer: candidateProducer,
      ...(expires_at === undefined ? {} : { expires_at }),
    });
  const begin = () =>
    journal.begin(
      snapshot,
      after.settings,
      { commit: candidateRelease.commit, run: candidateRelease.publication_run },
      "c".repeat(64),
      "apply",
    );
  return {
    journal,
    objects,
    codec,
    hooks,
    clock,
    status,
    before,
    after,
    snapshot,
    evidence,
    prepare,
    begin,
  };
}
