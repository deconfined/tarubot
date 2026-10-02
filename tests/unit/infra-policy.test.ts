/** Invented complete plans: selected provider pins, whole-plan refusal and private binding. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPlan, handoffBinding } from "../../scripts/infra-policy.js";
import { releaseInputs as v, releasePlan } from "../fixtures/infra/release.js";

const vm = "openstack_compute_instance_v2",
  db = "ovh_cloud_project_database";
const plan = () => structuredClone(releasePlan());
const entry = (p: ReturnType<typeof plan>, type: string, name?: string) => {
  const r = p.resource_changes.find((r) => r.type === type && (!name || r.name === name));
  if (!r) throw new Error("Missing invented resource");
  return r;
};
/** Reconcile the independent planned-values view after deliberately changing plan evidence. */
function decision(p = plan(), expected: unknown = v) {
  p.planned_values.root_module.resources = p.resource_changes
    .filter(
      (r) =>
        !(
          r.change.actions.length === 1 && ["delete", "forget"].includes(r.change.actions[0] ?? "")
        ),
    )
    .map(({ change, ...r }) => ({ ...r, values: structuredClone(change.after) }));
  return classifyPlan(p, expected, v);
}

describe("selected-stack complete-plan policy", () => {
  test("all eleven resources and independent applied intent are required", () => {
    expect(decision()).toEqual({ revision: "1", decision: "no-changes", reasons: [] });
    expect(classifyPlan(plan(), v)).toMatchObject({
      decision: "review-required",
      reasons: ["baseline-required"],
    });
    expect(classifyPlan(plan(), v, {}).decision).toBe("invalid");
    for (let i = 0; i < plan().resource_changes.length; i++) {
      const p = plan();
      p.resource_changes.splice(i, 1);
      expect(decision(p).decision).toBe("invalid");
    }
  });
  test("only VM display-name and bounded unproxied TTL updates are safe", () => {
    const next = { ...v, hosts: { staging: { ...v.hosts.staging, label: "example-renamed" } } };
    expect(decision(releasePlan("example-renamed"), next).decision).toBe("safe");
    for (const name of ["a", "aaaa"])
      for (const ttl of [301, 600, 3600]) {
        const p = plan(),
          r = entry(p, "cloudflare_dns_record", name);
        r.change.actions = ["update"];
        r.change.after.ttl = ttl;
        r.change.after_unknown = { modified_on: true };
        expect(decision(p).decision).toBe("safe");
      }
  });
  test("complete restriction additions preserve whole entries and attest unchanged hosts", () => {
    for (const ip of ["192.0.2.10/32", "2001:db8::10/128"]) {
      const p = plan(),
        r = entry(p, db);
      r.change.actions = ["update"];
      r.change.before.ip_restrictions = (
        r.change.before.ip_restrictions as { ip: string }[]
      ).filter((e) => e.ip !== ip);
      expect(decision(p).decision).toBe("safe");
      const renamed = releasePlan("example-renamed");
      entry(renamed, db).change = r.change;
      const next = { ...v, hosts: { staging: { ...v.hosts.staging, label: "example-renamed" } } };
      expect(decision(renamed, next).decision).toBe("review-required");
    }
    for (const patch of [{ description: "changed" }, { status: "pending" }]) {
      const p = plan(),
        r = entry(p, db);
      r.change.actions = ["update"];
      Object.assign((r.change.after.ip_restrictions as Record<string, unknown>[])[0] ?? {}, patch);
      expect(decision(p).decision).toBe("review-required");
    }
  });
  test("broad/external additions, removals, duplicates and unknown restrictions are not safe", () => {
    for (const ip of ["192.0.2.0/24", "2001:db8::/64", "203.0.113.1/32"]) {
      const next = { ...v, db_allow_extra: [...v.db_allow_extra, ip] },
        p = plan(),
        r = entry(p, db);
      p.variables.db_allow_extra = { value: next.db_allow_extra };
      r.change.actions = ["update"];
      (r.change.after.ip_restrictions as unknown[]).push({
        ip,
        description: "tarubot-managed",
        status: "active",
      });
      expect(decision(p, next).decision).toBe("review-required");
    }
    for (const restrictions of [[], [{ ip: "192.0.2.10/32" }, { ip: "192.0.2.10/32" }]]) {
      const p = plan(),
        r = entry(p, db);
      r.change.actions = ["update"];
      r.change.after.ip_restrictions = restrictions;
      expect(decision(p).decision).not.toBe("safe");
    }
    const p = plan();
    entry(p, db).change.after_unknown = { ip_restrictions: true };
    expect(decision(p).decision).toBe("invalid");
  });
  test("all database settings and firewall changes require review", () => {
    for (const [type, values] of [
      [db, { disk_size: 160 }],
      [db, { deletion_protection: false }],
      [db, { version: "18" }],
      [db, { plan: "business" }],
      [db, { nodes: [{ region: "US-EAST-VA" }, { region: "US-EAST-VA" }] }],
      ["openstack_networking_secgroup_v2", { delete_default_rules: false }],
      ["openstack_networking_secgroup_rule_v2", { port_range_max: 443 }],
    ] as const) {
      const p = plan(),
        r = entry(p, type);
      r.change.actions = ["update"];
      Object.assign(r.change.after, values);
      expect(decision(p).decision).toBe("review-required");
    }
  });
  test("one-field host/DNS deviations cannot ride safe changes or duplicated no-ops", () => {
    for (const [type, patch] of [
      [vm, { flavor_id: "other" }],
      [vm, { image_id: v.hosts.staging.network_id }],
      [vm, { region: "other-region" }],
      [vm, { config_drive: false }],
      [vm, { security_groups: ["default"] }],
      [vm, { admin_pass: "private" }],
      [vm, { key_pair: "other" }],
      [vm, { access_ip_v4: "192.0.2.99" }],
      [vm, { network: [{ uuid: "other" }] }],
      [vm, { block_device: [{ source_type: "volume" }] }],
      [vm, { power_state: "shutoff" }],
      ["cloudflare_dns_record", { ttl: 1 }],
      ["cloudflare_dns_record", { ttl: 299 }],
      ["cloudflare_dns_record", { ttl: 3601 }],
      ["cloudflare_dns_record", { ttl: 300.5 }],
      ["cloudflare_dns_record", { proxied: true }],
      ["cloudflare_dns_record", { zone_id: "f".repeat(32) }],
      ["cloudflare_dns_record", { name: "other.example.org" }],
      ["cloudflare_dns_record", { type: "SSHFP" }],
      ["cloudflare_dns_record", { content: "192.0.2.99" }],
      ["cloudflare_dns_record", { private_routing: true }],
    ] as const) {
      const p = plan(),
        r = entry(p, type);
      r.change.actions = ["update"];
      Object.assign(
        r.change.after,
        type === vm ? { name: "example-renamed", ...patch } : { ttl: 600, ...patch },
      );
      expect(decision(p).decision).not.toBe("safe");
    }
    for (const [type, patch] of [
      [vm, { name: "other" }],
      ["openstack_networking_secgroup_v2", { tenant_id: "f".repeat(32) }],
      ["openstack_networking_secgroup_rule_v2", { remote_group_id: "other" }],
      [db, { service_name: "f".repeat(32) }],
      [db, { engine: "mysql" }],
      [db, { nodes: [{ region: "US-EAST-VA", network_id: "other" }] }],
      [db, { deletion_protection: false }],
      [db, { disk_size: 160 }],
      [db, { ip_restrictions: [] }],
    ] as const) {
      const p = plan(),
        r = entry(p, type);
      Object.assign(r.change.before, patch);
      Object.assign(r.change.after, patch);
      expect(decision(p).decision).toBe("invalid");
    }
  });
  test("lifecycle needs review; imports/forget/legacy provider objects are refused", () => {
    for (const actions of [["create"], ["delete"], ["delete", "create"], ["create", "delete"]]) {
      const p = plan();
      entry(p, vm).change.actions = actions;
      expect(decision(p).decision).toBe("review-required");
    }
    for (const actions of [["forget"], ["forget", "create"], ["update", "no-op"]]) {
      const p = plan();
      entry(p, vm).change.actions = actions;
      expect(decision(p).decision).toBe("invalid");
    }
    const p = plan();
    Object.assign(entry(p, db).change, { importing: { id: "invented" } });
    expect(decision(p).decision).toBe("invalid");
  });
  test("unknown fields/nested controls and changed identities fail closed", () => {
    for (const type of [
      vm,
      db,
      "openstack_networking_secgroup_v2",
      "openstack_networking_secgroup_rule_v2",
    ]) {
      const p = plan(),
        r = entry(p, type);
      r.change.before.unexpected = true;
      r.change.after.unexpected = true;
      expect(decision(p).decision).toBe("invalid");
      const next = plan();
      Object.assign(entry(next, type).change, {
        before_identity: { id: "one" },
        after_identity: { id: "two" },
      });
      expect(decision(next).decision).toBe("invalid");
    }
    for (const key of ["nodes", "ip_restrictions"]) {
      const p = plan(),
        r = entry(p, db);
      Object.assign((r.change.before[key] as unknown[])[0] ?? {}, { unexpected: true });
      r.change.after = structuredClone(r.change.before);
      expect(decision(p).decision).toBe("invalid");
    }
  });
  test("ignored access keys/hash and private expected inputs stay baseline-bound", () => {
    for (const patch of [
      { root_keys: ["ssh-ed25519 AAAACHANGED invented-root"] },
      { configure_keys: { staging: "ssh-ed25519 AAAACHANGED invented-configure" } },
      { root_password_hash: `$6$salt$${"a".repeat(86)}` },
    ]) {
      const next = { ...v, ...patch },
        p = plan();
      Object.assign(
        p.variables,
        Object.fromEntries(Object.entries(next).map(([key, value]) => [key, { value }])),
      );
      expect(decision(p, next)).toMatchObject({
        decision: "review-required",
        reasons: ["changed-intent"],
      });
      expect(classifyPlan(plan(), next, v).decision).toBe("invalid");
    }
  });
  test("malformed/incomplete native evidence, failed checks and unknown values fail closed", () => {
    for (const patch of [
      { format_version: "2.0" },
      { terraform_version: "1.13.0" },
      { errored: true },
      { errored: undefined },
      { complete: false },
      { applyable: "false" },
      { deferred_changes: [{}] },
      { resource_changes: null },
      { variables: undefined },
      { output_changes: undefined },
      { checks: [{ status: "unknown" }] },
      { checks: [{ status: "pass", instances: [{ status: "error" }] }] },
    ])
      expect(classifyPlan({ ...plan(), ...patch }, v, v).decision).toBe("invalid");
    for (const after_unknown of [
      { access_ip_v4: true },
      { network: [{ uuid: true }] },
      { name: "false" },
    ]) {
      const p = plan();
      entry(p, vm).change.after_unknown = after_unknown;
      expect(decision(p).decision).toBe("invalid");
    }
    for (const patch of [
      { provider_name: "registry.example.org/ovh/ovh" },
      { mode: "data" },
      { index: "production" },
      { address: "module.other.host" },
      { module_address: "module.other" },
      { previous_address: "other" },
      { deposed: "invented" },
      { name: "other" },
    ]) {
      const p = plan();
      Object.assign(entry(p, vm), patch);
      expect(decision(p).decision).toBe("invalid");
    }
    const p = plan();
    p.resource_changes.push(entry(p, vm));
    expect(decision(p).decision).toBe("invalid");
  });
  test("drift/output-only changes and inconsistent views cannot be ignored or leak private values", () => {
    expect(classifyPlan({ ...plan(), resource_drift: [{}] }, v, v)).toMatchObject({
      decision: "review-required",
      reasons: ["drift"],
    });
    const p = plan();
    const hosts = p.output_changes.hosts;
    if (!hosts) throw new Error("Missing invented outputs");
    hosts.actions = ["update"];
    expect(classifyPlan(p, v, v)).toMatchObject({
      decision: "review-required",
      reasons: ["output-change"],
    });
    p.planned_values.root_module.resources.pop();
    expect(classifyPlan(p, v, v).decision).toBe("invalid");
    const secret = "private.example.org 203.0.113.99 token=NEVER-PRINT";
    expect(JSON.stringify(classifyPlan({ ...plan(), format_version: secret }, v, v))).not.toContain(
      secret,
    );
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
  test("deterministic canonical inputs expose only a keyed digest", () => {
    seed();
    const binding = handoffBinding(scratch, environment);
    expect(binding).toMatch(/^[0-9a-f]{64}$/u);
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
      if (!file || value === undefined) throw new Error("Missing invented binding input");
      writeFileSync(join(scratch, file), value);
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
  test("CLI parser failures print a fixed message, not their input/path", () => {
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
