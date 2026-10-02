/** Selected private-input contract rejects obsolete adoption paths without touching providers. */
import { describe, expect, test } from "bun:test";
import { inputs } from "../../scripts/infra-policy.js";
import { guardInfrastructurePlan, requirePlannedInputs } from "../../scripts/infra-inputs.js";
import { releaseInputs, releasePlan } from "../fixtures/infra/release.js";

describe("OVH private-input and manual-plan fences", () => {
  test("one selected contract, no legacy database IDs or adoption-map defaults", () => {
    expect(inputs(releaseInputs)).toEqual(releaseInputs);
    for (const patch of [
      { database_ids: {} },
      { existing_databases: {} },
      { unknown: "NEVER-PRINT" },
    ])
      expect(() => inputs({ ...releaseInputs, ...patch })).toThrow("invalid-evidence");
    for (const key of Object.keys(releaseInputs)) {
      const v: Record<string, unknown> = { ...releaseInputs };
      delete v[key];
      expect(() => inputs(v)).toThrow("invalid-evidence");
    }
  });
  test("explicit image/network IDs, project IDs, database settings and public keys are validated", () => {
    for (const patch of [
      { image_id: "almalinux" },
      { network_id: "public" },
      { flavor_id: "" },
      { role: "production" },
      { fqdn: "private invalid" },
      { label: "invalid--label" },
      { extra: true },
    ])
      expect(() =>
        inputs({
          ...releaseInputs,
          hosts: { staging: { ...releaseInputs.hosts.staging, ...patch } },
        }),
      ).toThrow("invalid-evidence");
    for (const patch of [
      { version: "13" },
      { disk_size_gb: 1.5 },
      { backup_time: "25:00:00" },
      { flavor: "" },
      { description: " " },
      { extra: true },
    ])
      expect(() =>
        inputs({
          ...releaseInputs,
          databases: { primary: { ...releaseInputs.databases.primary, ...patch } },
        }),
      ).toThrow("invalid-evidence");
    for (const patch of [
      { ovh_project_id: "invalid" },
      { openstack_project_id: "invalid" },
      { root_keys: [] },
      { root_password_hash: "private" },
      { configure_keys: {} },
      { db_allow_extra: ["192.0.2.1/33"] },
    ])
      expect(() => inputs({ ...releaseInputs, ...patch })).toThrow("invalid-evidence");
  });
  test("manual and baseline steps bind the complete private planned inputs", () => {
    expect(() => requirePlannedInputs(releasePlan(), releaseInputs)).not.toThrow();
    expect(() =>
      requirePlannedInputs(releasePlan(), {
        ...releaseInputs,
        root_keys: ["ssh-ed25519 AAAACHANGED"],
      }),
    ).toThrow();
    expect(() => guardInfrastructurePlan(releasePlan(), releaseInputs)).not.toThrow();
    for (const patch of [
      { type: "linode_instance" },
      { provider_name: "registry.example.org/ovh/ovh" },
      { address: 'openstack_compute_instance_v2.privatehostname["staging"]' },
      { index: "private-account-identifier" },
      { mode: "data" },
    ]) {
      const p = releasePlan();
      const host = p.resource_changes[0];
      if (!host) throw new Error("Missing invented host");
      Object.assign(host, patch);
      expect(() => guardInfrastructurePlan(p, releaseInputs)).toThrow("invalid-input-evidence");
    }
    for (const change of [{ importing: { id: "invented" } }, { actions: ["forget"] }]) {
      const p = releasePlan();
      const host = p.resource_changes[0];
      if (!host) throw new Error("Missing invented host");
      Object.assign(host.change, change);
      expect(() => guardInfrastructurePlan(p, releaseInputs)).toThrow("invalid-input-evidence");
    }
  });
});
