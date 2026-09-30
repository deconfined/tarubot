/** Invented complete plans exercise the policy without a provider, state backend or credentials. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPlan, handoffBinding } from "../../scripts/infra-policy.js";

const v = {
  hosts: {
    staging: {
      label: "example-staging",
      fqdn: "staging.example.org",
      region: "us-east",
      type: "g6-standard-1",
      role: "staging",
    },
  },
  root_keys: ["invented-root-public-key"],
  configure_keys: { staging: "invented-configure-public-key" },
  root_password_hash: "",
  cloudflare_zone_id: "0".repeat(32),
  database_ids: { primary: "100" },
  db_allow_extra: ["198.51.100.10/32"],
};
type Value = Record<string, unknown>;
function change(type: string, name: string, index: string, values: Value) {
  return {
    type,
    name,
    index,
    mode: "managed",
    address: `${type}.${name}[${JSON.stringify(index)}]`,
    provider_name: `registry.opentofu.org/${type.startsWith("linode_") ? "linode/linode" : "cloudflare/cloudflare"}`,
    change: {
      actions: ["no-op"],
      before: structuredClone(values),
      after: structuredClone(values),
      after_unknown: {} as Value,
      before_sensitive: {},
      after_sensitive: {},
    },
  };
}
const host = change("linode_instance", "host", "staging", {
  id: "200",
  label: v.hosts.staging.label,
  region: "us-east",
  type: "g6-standard-1",
  image: "linode/almalinux10",
  booted: true,
  disk_encryption: "enabled",
  firewall_id: 300,
  interface_generation: "legacy_config",
  interface: [{ purpose: "public" }],
  ipv4: ["192.0.2.10"],
  ipv6: "2001:db8::10/128",
  root_pass: "invented-unchanged-hash",
  metadata: [{ user_data: "invented-unchanged-data" }],
});
const firewall = change("linode_firewall", "host", "staging", {
  id: "300",
  inbound_policy: "DROP",
  outbound_policy: "ACCEPT",
  inbound: [{ protocol: "TCP", ports: "22", action: "ACCEPT" }],
});
const a = change("cloudflare_dns_record", "a", "staging", {
  id: "invented-a-record",
  name: v.hosts.staging.fqdn,
  zone_id: v.cloudflare_zone_id,
  type: "A",
  content: "192.0.2.10",
  proxied: false,
  ttl: 300,
  modified_on: "2026-01-01T00:00:00Z",
});
const aaaa = change("cloudflare_dns_record", "aaaa", "staging", {
  ...a.change.after,
  id: "invented-aaaa-record",
  type: "AAAA",
  content: "2001:db8::10",
});
const acl = change("linode_database_access_controls", "db", "primary", {
  id: "100:postgresql",
  database_id: 100,
  database_type: "postgresql",
  allow_list: v.db_allow_extra,
});
// Import intent is explicit; cluster presence can no longer be inferred from a database ID alone.
const clusterConfig = {
  label: "example-database",
  engine_id: "postgresql/17",
  region: "us-east",
  type: "g6-standard-1",
  cluster_size: 1,
  suspended: false,
  updates: { day_of_week: 2, duration: 4, frequency: "weekly", hour_of_day: 22 },
  private_network: { vpc_id: 1, subnet_id: 2, public_access: false },
  expected_encrypted: true,
  expected_ssl_connection: true,
  engine_config: {},
};
const cluster = change("linode_database_postgresql_v2", "cluster", "primary", {
  id: "100",
  ...Object.fromEntries(
    Object.entries(clusterConfig).filter(
      ([key]) => !key.startsWith("expected_") && key !== "engine_config",
    ),
  ),
  encrypted: true,
  ssl_connection: true,
});
const outputs = {
  hosts: {
    actions: ["no-op"],
    before: { staging: "staging" },
    after: { staging: "staging" },
    after_unknown: false,
  },
  addresses: {
    actions: ["no-op"],
    before: { staging: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" } },
    after: { staging: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" } },
    after_unknown: false,
  },
};
/** Reconcile the duplicated planned-values view, as tofu show does; missing/mismatch is tested separately. */
function plan(resources = [host, firewall, a, aaaa, acl], expected = v) {
  return {
    format_version: "1.2",
    terraform_version: "1.12.6",
    errored: false,
    variables: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, { value }])),
    checks: [{ status: "pass", instances: [{ status: "pass" }] }],
    resource_changes: structuredClone(resources),
    output_changes: structuredClone(outputs),
    planned_values: {
      root_module: {
        resources: resources
          .filter(
            (r) =>
              !(
                r.change.actions.length === 1 &&
                ["delete", "forget"].includes(r.change.actions[0] ?? "")
              ),
          )
          .map(({ change, ...resource }) => ({
            ...resource,
            values: structuredClone(change.after),
          })),
      },
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([key, c]) => [key, { value: c.after }]),
      ),
    },
  };
}
function edit(which: typeof host, values: Value) {
  const r = structuredClone(which);
  r.change.actions = ["update"];
  r.change.after = { ...r.change.after, ...values };
  return r;
}
function decision(resources: (typeof host)[], expected = v) {
  const clusters = resources.some((r) => r.type === "linode_database_postgresql_v2")
    ? { existing_databases: { primary: clusterConfig } }
    : {};
  const current = { ...expected, ...clusters };
  return classifyPlan(plan(resources, current), current, { ...v, ...clusters });
}

describe("safe full-plan policy", () => {
  test("no change requires complete matching evidence and independently persisted baseline intent", () => {
    expect(classifyPlan(plan(), v, v)).toEqual({
      revision: "1",
      decision: "no-changes",
      reasons: [],
    });
    expect(classifyPlan(plan(), v)).toMatchObject({
      decision: "review-required",
      reasons: ["baseline-required"],
    });
    expect(classifyPlan(plan(), v, {})).toMatchObject({ decision: "invalid" });
  });
  test("display label only and bounded unproxied TTL changes are safe", () => {
    const next = { ...v, hosts: { staging: { ...v.hosts.staging, label: "example-renamed" } } };
    expect(
      decision([edit(host, { label: next.hosts.staging.label }), firewall, a, aaaa, acl], next)
        .decision,
    ).toBe("safe");
    for (const record of [a, aaaa])
      for (const ttl of [300, 301, 3600]) {
        const modified = edit(record, { ttl: ttl === 300 ? 600 : ttl });
        modified.change.after_unknown = { modified_on: true };
        delete modified.change.after.modified_on;
        expect(
          decision([
            host,
            firewall,
            record === a ? modified : a,
            record === aaaa ? modified : aaaa,
            acl,
          ]).decision,
        ).toBe("safe");
      }
  });
  test("access additions must preserve all entries and name exact known unchanged hosts", () => {
    for (const address of ["192.0.2.10/32", "2001:db8::10/128"]) {
      const updated = edit(acl, { allow_list: [...v.db_allow_extra, address] });
      expect(decision([host, firewall, a, aaaa, updated]).decision).toBe("safe");
    }
    for (const entries of [
      [],
      ["192.0.2.10/32"],
      [...v.db_allow_extra, "192.0.2.0/24"],
      [...v.db_allow_extra, "2001:db8::/64"],
      [...v.db_allow_extra, "203.0.113.1/32"],
      [...v.db_allow_extra, "192.0.2.10/32", "192.0.2.10/32"],
    ])
      expect(decision([host, firewall, a, aaaa, edit(acl, { allow_list: entries })])).toMatchObject(
        { decision: "review-required", reasons: ["access-change"] },
      );
    // A simultaneous label edit is deliberately not an unchanged-address attestation.
    expect(
      decision([
        edit(host, { label: "example-renamed" }),
        firewall,
        a,
        aaaa,
        edit(acl, { allow_list: [...v.db_allow_extra, "192.0.2.10/32"] }),
      ]).decision,
    ).toBe("review-required");
  });
  test("one-field host deviations are not automatically safe, including credentials and nested values", () => {
    for (const values of [
      { type: "g6-standard-2" },
      { booted: false },
      { image: "linode/other" },
      { disk_encryption: "disabled" },
      { firewall_id: 999 },
      { interface: [{ purpose: "vpc" }] },
      { root_pass: "changed" },
      { metadata: [{ user_data: "changed" }] },
      { ipv4: ["192.0.2.99"] },
    ])
      expect(
        decision([edit(host, { label: "example-renamed", ...values }), firewall, a, aaaa, acl])
          .decision,
      ).not.toBe("safe");
  });
  test("DNS address/name/zone/proxy/type/other fields and out-of-bounds TTL never pass", () => {
    for (const values of [
      { ttl: 1 },
      { ttl: 299 },
      { ttl: 3601 },
      { ttl: 300.5 },
      { proxied: true },
      { content: "192.0.2.99" },
      { name: "other.example.org" },
      { zone_id: "f".repeat(32) },
      { type: "SSHFP" },
      { comment: "changed" },
      { private_routing: true },
    ])
      expect(
        decision([host, firewall, edit(a, { ttl: 600, ...values }), aaaa, acl]).decision,
      ).not.toBe("safe");
  });
  test("cluster mutation, lifecycle changes, firewall exposure and imports require review", () => {
    expect(decision([host, firewall, a, aaaa, acl, cluster]).decision).toBe("no-changes");
    expect(
      decision([host, firewall, a, aaaa, acl, edit(cluster, { type: "g6-standard-2" })]),
    ).toMatchObject({ decision: "review-required", reasons: ["cluster-change"] });
    expect(
      decision([host, edit(firewall, { inbound_policy: "ACCEPT" }), a, aaaa, acl]).decision,
    ).toBe("review-required");
    for (const actions of [
      ["create"],
      ["delete"],
      ["delete", "create"],
      ["create", "delete"],
      ["forget"],
      ["forget", "create"],
    ]) {
      const changed = { ...host, change: { ...host.change, actions } };
      expect(decision([changed, firewall, a, aaaa, acl]).decision).toBe("review-required");
    }
    const imported = { ...acl, change: { ...acl.change, importing: { id: "100:postgresql" } } };
    expect(decision([host, firewall, a, aaaa, imported])).toMatchObject({
      decision: "review-required",
      reasons: ["import"],
    });
    const updated = {
      ...edit(acl, { allow_list: [...v.db_allow_extra, "192.0.2.10/32"] }),
      change: {
        ...edit(acl, { allow_list: [...v.db_allow_extra, "192.0.2.10/32"] }).change,
        importing: { id: "100:postgresql" },
      },
    };
    expect(decision([host, firewall, a, aaaa, updated]).decision).toBe("review-required");
  });
  test("unknown firewall and cluster fields cannot ride no-ops or another resource's safe change", () => {
    const renamed = { ...v, hosts: { staging: { ...v.hosts.staging, label: "example-renamed" } } };
    // These values agree in both duplicated plan views; only the pinned schema can reject them.
    for (const [original, values] of [
      [firewall, { unexpected_security_control: "opaque" }],
      [
        firewall,
        { inbound: [{ protocol: "TCP", ports: "22", action: "ACCEPT", unexpected_control: true }] },
      ],
      [
        firewall,
        { devices: [{ id: 1, entity_id: 200, type: "linode", unexpected_control: true }] },
      ],
      [cluster, { unexpected_cluster_control: "opaque" }],
      [cluster, { updates: { day_of_week: 2, unexpected_control: true } }],
      [cluster, { private_network: { vpc_id: 1, subnet_id: 2, unexpected_control: true } }],
      [cluster, { pending_updates: [{ deadline: "example", unexpected_control: true }] }],
    ] as const) {
      const unrecognized = structuredClone(original);
      Object.assign(unrecognized.change.before, values);
      Object.assign(unrecognized.change.after, values);
      const otherResources = [host, firewall, a, aaaa, acl].filter(
        (r) => r.address !== original.address,
      );
      expect(decision([...otherResources, unrecognized]).decision).toBe("invalid");
      expect(
        decision(
          [
            ...otherResources.filter((r) => r.address !== host.address),
            edit(host, { label: renamed.hosts.staging.label }),
            unrecognized,
          ],
          renamed,
        ).decision,
      ).toBe("invalid");
    }
    const knownFirewall = structuredClone(firewall);
    const knownCluster = structuredClone(cluster);
    Object.assign(knownFirewall.change.before, {
      disabled: false,
      inbound: [
        { label: "allow-ssh", action: "ACCEPT", protocol: "TCP", ports: "22", ipv4: ["0.0.0.0/0"] },
      ],
      devices: [{ id: 1, entity_id: 200, type: "linode", label: "example", url: "example" }],
    });
    Object.assign(knownCluster.change.before, {
      root_password: "invented-unchanged-password",
      updates: { day_of_week: 2, duration: 4, frequency: "weekly", hour_of_day: 22 },
      private_network: { vpc_id: 1, subnet_id: 2, public_access: false },
      pending_updates: [{ deadline: "example", description: "example", planned_for: "example" }],
    });
    knownFirewall.change.after = structuredClone(knownFirewall.change.before);
    knownCluster.change.after = structuredClone(knownCluster.change.before);
    expect(decision([host, knownFirewall, a, aaaa, acl, knownCluster]).decision).toBe("no-changes");
    expect(
      decision(
        [
          edit(host, { label: renamed.hosts.staging.label }),
          knownFirewall,
          a,
          aaaa,
          acl,
          knownCluster,
        ],
        renamed,
      ).decision,
    ).toBe("safe");
  });
  test("no-op identity and configured host/DNS intent must agree independently of duplicated views", () => {
    for (const [original, values] of [
      [acl, { database_id: 999 }],
      [acl, { id: "999:postgresql" }],
      [acl, { database_type: "mysql" }],
      [cluster, { id: "999" }],
      [host, { label: "example-unconfigured" }],
      [host, { region: "other-region" }],
      [host, { type: "g6-standard-2" }],
      [host, { image: "linode/other" }],
      [host, { booted: false }],
      [host, { disk_encryption: "disabled" }],
      [host, { interface_generation: "linode" }],
      [host, { interface: [{ purpose: "vpc" }] }],
      [host, { firewall_id: 999 }],
      [a, { zone_id: "f".repeat(32) }],
      [a, { name: "other.example.org" }],
      [a, { type: "AAAA" }],
      [a, { content: "192.0.2.99" }],
      [aaaa, { type: "A" }],
      [aaaa, { content: "2001:db8::99" }],
      [aaaa, { proxied: true }],
    ] as const) {
      const inconsistent = structuredClone(original);
      Object.assign(inconsistent.change.before, values);
      Object.assign(inconsistent.change.after, values);
      const remaining = [host, firewall, a, aaaa, acl].filter(
        (r) => r.address !== original.address,
      );
      expect(decision([...remaining, inconsistent]).decision).toBe("invalid");
    }
    for (const original of [firewall, cluster]) {
      const inconsistent = structuredClone(original);
      Object.assign(inconsistent.change, {
        before_identity: { id: "one" },
        after_identity: { id: "two" },
      });
      expect(
        decision(
          [host, firewall, a, aaaa, acl]
            .filter((r) => r.address !== original.address)
            .concat(inconsistent),
        ).decision,
      ).toBe("invalid");
    }
  });
  test("ignored creation-only intent and private expected inputs cannot hide behind no-op resources", () => {
    for (const next of [
      { ...v, root_keys: ["changed"] },
      { ...v, configure_keys: { staging: "changed" } },
      { ...v, root_password_hash: "changed" },
      { ...v, cloudflare_zone_id: "f".repeat(32) },
    ]) {
      if (next.cloudflare_zone_id === v.cloudflare_zone_id)
        expect(classifyPlan(plan(undefined, next), next, v)).toMatchObject({
          decision: "review-required",
          reasons: ["changed-intent"],
        });
      else expect(classifyPlan(plan(undefined, next), next, v).decision).toBe("invalid");
      expect(classifyPlan(plan(), next, v).decision).toBe("invalid");
    }
  });
  test("unsupported/malformed/incomplete plan, failed checks and unknown values fail closed", () => {
    for (const patch of [
      { format_version: "2.0" },
      { terraform_version: "1.13.0" },
      { errored: true },
      { errored: undefined },
      { complete: false },
      { applyable: "false" },
      { deferred_changes: [{}] },
      { resource_changes: undefined },
      { resource_changes: null },
      { variables: undefined },
      { output_changes: undefined },
      { checks: [{ status: "fail" }] },
      { checks: [{ status: "unknown" }] },
      { checks: [{ status: "pass", instances: [{ status: "error" }] }] },
    ])
      expect(classifyPlan({ ...plan(), ...patch }, v, v).decision).toBe("invalid");
    for (const after_unknown of [
      { ipv4: true },
      { metadata: [{ user_data: true }] },
      { label: "false" },
    ]) {
      const r = { ...host, change: { ...host.change, after_unknown } };
      expect(decision([r, firewall, a, aaaa, acl]).decision).toBe("invalid");
    }
  });
  test("wrong provider/index/address/module, moved/deposed/duplicate/omitted objects and unknown fields fail closed", () => {
    for (const patch of [
      { provider_name: "registry.example.org/linode/linode" },
      { mode: "data" },
      { index: "production" },
      { address: 'module.other.linode_instance.host["staging"]' },
      { module_address: "module.other" },
      { previous_address: host.address },
      { deposed: "invented" },
      { name: "other" },
    ])
      expect(decision([{ ...host, ...patch }, firewall, a, aaaa, acl]).decision).toBe("invalid");
    expect(decision([host, host, firewall, a, aaaa, acl]).decision).toBe("invalid");
    expect(decision([firewall, a, aaaa, acl]).decision).toBe("invalid");
    expect(decision([edit(host, { unexpected: "opaque" }), firewall, a, aaaa, acl]).decision).toBe(
      "invalid",
    );
    const bad = { ...host, change: { ...host.change, actions: ["update", "no-op"] } };
    expect(decision([bad, firewall, a, aaaa, acl]).decision).toBe("invalid");
  });
  test("drift, output-only changes and inconsistent duplicated views cannot be ignored", () => {
    expect(classifyPlan({ ...plan(), resource_drift: [host] }, v, v)).toMatchObject({
      decision: "review-required",
      reasons: ["drift"],
    });
    const p = plan();
    p.output_changes.hosts.actions = ["update"];
    expect(classifyPlan(p, v, v)).toMatchObject({
      decision: "review-required",
      reasons: ["output-change"],
    });
    p.planned_values.root_module.resources.pop();
    expect(classifyPlan(p, v, v).decision).toBe("invalid");
    const other = plan();
    other.planned_values.outputs.hosts = { value: { staging: "production" } };
    expect(classifyPlan(other, v, v).decision).toBe("invalid");
  });
  test("hostile values and parser failures never enter public reasons", () => {
    const secret = "private.example.org 203.0.113.99 token=NEVER-PRINT";
    for (const p of [
      secret,
      { ...plan(), format_version: secret },
      { ...plan(), resource_changes: [{ ...host, address: secret }] },
    ])
      expect(JSON.stringify(classifyPlan(p, v, v))).not.toContain(secret);
  });
});

describe("private plan/backend/run binding", () => {
  const scratch = mkdtempSync(join(tmpdir(), "infra-policy-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const environment = {
    TF_VAR_state_passphrase: "invented-passphrase-with-at-least-32-characters",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
  };
  function seed() {
    writeFileSync(join(scratch, "plan.bin"), "synthetic-encrypted-plan");
    writeFileSync(join(scratch, "backend.hcl"), 'bucket = "example-bucket"\n');
    writeFileSync(join(scratch, "values.tfvars.json"), JSON.stringify(v));
  }
  test("same file/input/backend/run/key is deterministic and exposes only a keyed digest", () => {
    seed();
    const binding = handoffBinding(scratch, environment);
    expect(binding).toMatch(/^[0-9a-f]{64}$/u);
    expect(handoffBinding(scratch, environment)).toBe(binding);
    writeFileSync(
      join(scratch, "values.tfvars.json"),
      JSON.stringify(Object.fromEntries(Object.entries(v).reverse()), null, 2),
    );
    expect(handoffBinding(scratch, environment)).toBe(binding);
  });
  test("plan/backend/ignored-input/commit/run/key changes are all bound", () => {
    seed();
    const binding = handoffBinding(scratch, environment);
    for (const [file, value] of [
      ["plan.bin", "other-plan"],
      ["backend.hcl", 'bucket = "other-example-bucket"'],
      ["values.tfvars.json", JSON.stringify({ ...v, root_password_hash: "changed" })],
    ]) {
      seed();
      writeFileSync(join(scratch, file ?? ""), value ?? "");
      expect(handoffBinding(scratch, environment)).not.toBe(binding);
    }
    seed();
    for (const patch of [
      { GITHUB_SHA: "2".repeat(40) },
      { GITHUB_RUN_ID: "1235" },
      { TF_VAR_state_passphrase: `${environment.TF_VAR_state_passphrase}-other` },
    ])
      expect(handoffBinding(scratch, { ...environment, ...patch })).not.toBe(binding);
    for (const patch of [
      { GITHUB_RUN_ATTEMPT: "2" },
      { GITHUB_RUN_ID: "" },
      { GITHUB_SHA: "main" },
      { TF_VAR_state_passphrase: "short" },
    ])
      expect(() => handoffBinding(scratch, { ...environment, ...patch })).toThrow(
        "invalid-evidence",
      );
  });
  test("CLI reports a fixed message for malformed JSON, not its path or input", () => {
    seed();
    const secret = "private.example.org-token-NEVER-PRINT";
    writeFileSync(join(scratch, "plan.json"), `{${secret}`);
    const run = Bun.spawnSync([process.execPath, "scripts/infra-policy.ts", "classify", scratch]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe(
      "::error::Infrastructure policy input or binding is invalid; nothing was applied.\n",
    );
    expect(run.stderr.toString()).toBe("");
    expect(readFileSync(join(scratch, "plan.json"), "utf8")).toContain(secret);
  });
});
