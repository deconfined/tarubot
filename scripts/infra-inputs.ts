/** Private input/plan fences shared by manual phases. No import/adoption compatibility path. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inputs } from "./infra-policy.js";

export function requirePlannedInputs(plan: unknown, expected: unknown): void {
  const p = plan as { variables: Record<string, { value: unknown }> };
  const planned = Object.fromEntries(
    Object.entries(p.variables)
      .filter(([key]) => key !== "state_passphrase")
      .map(([key, entry]) => [key, entry.value]),
  );
  if (!isDeepStrictEqual(inputs(planned), inputs(expected)))
    throw new Error("invalid-input-evidence");
}
/** Apply never imports an existing service or crosses back into the live Linode resource path. */
export function guardInfrastructurePlan(plan: unknown, expected: unknown): void {
  requirePlannedInputs(plan, expected);
  const p = plan as {
    resource_changes: {
      type: string;
      name: string;
      index: string;
      address: string;
      mode: string;
      provider_name: string;
      change: { importing?: unknown; actions: string[] };
    }[];
  };
  const providers: Record<string, string> = {
    openstack_compute_instance_v2: "registry.opentofu.org/terraform-provider-openstack/openstack",
    openstack_networking_secgroup_v2:
      "registry.opentofu.org/terraform-provider-openstack/openstack",
    openstack_networking_secgroup_rule_v2:
      "registry.opentofu.org/terraform-provider-openstack/openstack",
    ovh_cloud_project_database: "registry.opentofu.org/ovh/ovh",
    cloudflare_dns_record: "registry.opentofu.org/cloudflare/cloudflare",
  };
  if (
    !Array.isArray(p.resource_changes) ||
    p.resource_changes.some(
      (r) =>
        !Object.hasOwn(providers, r.type) ||
        r.provider_name !== providers[r.type] ||
        r.change.importing != null ||
        r.change.actions.includes("forget"),
    )
  )
    throw new Error("invalid-input-evidence");
  // Enforce public-safe module addresses BEFORE the public change list is printed. Deletions
  // can name a removed role key, but never a state-controlled hostname, account ID or module.
  for (const r of p.resource_changes) {
    const database = r.type === "ovh_cloud_project_database";
    const name = database ? "cluster" : r.type === "cloudflare_dns_record" ? r.name : "host";
    const pattern = database
      ? /^[a-z]{1,16}$/u
      : r.type === "openstack_networking_secgroup_rule_v2"
        ? /^(staging|production)(-[0-9]{1,2})?-(ssh4|ssh6|icmp4|icmp6|out4|out6)$/u
        : /^(staging|production)(-[0-9]{1,2})?$/u;
    if (
      r.mode !== "managed" ||
      !pattern.test(r.index) ||
      (r.type === "cloudflare_dns_record" && !["a", "aaaa"].includes(name)) ||
      r.name !== name ||
      r.address !== `${r.type}.${name}[${JSON.stringify(r.index)}]`
    )
      throw new Error("invalid-input-evidence");
  }
  if (new Set(p.resource_changes.map((r) => r.address)).size !== p.resource_changes.length)
    throw new Error("invalid-input-evidence");
}
if (import.meta.main) {
  try {
    const [command, directory] = process.argv.slice(2);
    if (process.argv.length !== 4 || !directory) throw new Error();
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
    const expected = read("values.tfvars.json");
    if (command === "validate") inputs(expected);
    else if (command === "inputs") requirePlannedInputs(read("plan.json"), expected);
    else if (command === "guard") guardInfrastructurePlan(read("plan.json"), expected);
    else throw new Error();
  } catch {
    console.log(
      "::error::Private infrastructure input or plan evidence is invalid; nothing was applied.",
    );
    process.exitCode = 1;
  }
}
