/** Credential-free policy and private handoff binding. Never print provider-controlled values. */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

type ObjectValue = Record<string, unknown>;
export type PolicyDecision = "invalid" | "review-required" | "safe" | "no-changes";
export interface PolicyResult {
  revision: "1";
  decision: PolicyDecision;
  reasons: string[];
}

/** Keep exception messages fixed: even JSON parse errors can contain secrets. */
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-evidence");
}
function object(value: unknown): ObjectValue {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function list(value: unknown): unknown[] {
  requireEvidence(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  requireEvidence(typeof value === "string");
  return value;
}
/** Canonical JSON is independent of key order, but retains array ordering and every value. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  requireEvidence(encoded !== undefined);
  return encoded;
}
/** OpenTofu masks may contain booleans, nested objects and arrays, never truthy strings. */
function unknownMask(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(unknownMask).some(Boolean);
  return Object.values(object(value)).map(unknownMask).some(Boolean);
}

const inputKeys = [
  "hosts",
  "root_keys",
  "configure_keys",
  "root_password_hash",
  "cloudflare_zone_id",
  "database_ids",
  "db_allow_extra",
];
function inputs(value: unknown): ObjectValue {
  const v = object(value);
  requireEvidence(isDeepStrictEqual(Object.keys(v).sort(), [...inputKeys].sort()));
  const hosts = object(v.hosts);
  for (const [key, entry] of Object.entries(hosts)) {
    requireEvidence(/^(staging|production)(-[0-9]{1,2})?$/u.test(key));
    const host = object(entry);
    requireEvidence(
      isDeepStrictEqual(Object.keys(host).sort(), ["fqdn", "label", "region", "role", "type"]),
    );
    requireEvidence(host.role === key.split("-")[0]);
    for (const field of ["fqdn", "label", "region", "type"]) text(host[field]);
  }
  for (const [key, id] of Object.entries(object(v.database_ids))) {
    requireEvidence(/^[a-z]{1,16}$/u.test(key) && /^[0-9]{1,20}$/u.test(text(id)));
  }
  list(v.root_keys).forEach(text);
  Object.values(object(v.configure_keys)).forEach(text);
  text(v.root_password_hash);
  requireEvidence(/^[0-9a-f]{32}$/u.test(text(v.cloudflare_zone_id)));
  list(v.db_allow_extra).forEach(text);
  return v;
}

/** Pinned-provider top-level fields. Unknown additions need review, never implicit acceptance. */
const fields: Record<string, string[]> = {
  linode_instance: `id image backup_id stackscript_id stackscript_data label tags capabilities locks
    boot_config_label region maintenance_policy type resize_disk migration_type status ip_address
    ipv6 ipv4 private_ip private_ip_address authorized_keys authorized_users root_pass swap_size
    kernel boot_size backups_enabled watchdog_enabled host_uuid booted firewall_id shared_ipv4
    metadata network_helper placement_group placement_group_externally_managed interface_generation
    has_user_data disk_encryption lke_cluster_id specs alerts backups interface linode_interfaces
    config disk timeouts`.split(/\s+/u),
  cloudflare_dns_record: `id zone_id include_shadow_metadata name comment content priority type data
    private_routing proxied ttl tags settings comment_modified_on created_on modified_on proxiable
    tags_modified_on meta`.split(/\s+/u),
  linode_database_access_controls: ["id", "database_id", "database_type", "allow_list", "timeouts"],
};
const providers: Record<string, string> = {
  linode_instance: "registry.opentofu.org/linode/linode",
  linode_firewall: "registry.opentofu.org/linode/linode",
  linode_database_access_controls: "registry.opentofu.org/linode/linode",
  linode_database_postgresql_v2: "registry.opentofu.org/linode/linode",
  cloudflare_dns_record: "registry.opentofu.org/cloudflare/cloudflare",
};
/** Actions are exact combinations, not a search for a convenient member of the action array. */
const actions = new Set([
  '["no-op"]',
  '["create"]',
  '["update"]',
  '["delete"]',
  '["read"]',
  '["forget"]',
  '["delete","create"]',
  '["create","delete"]',
  '["forget","create"]',
]);

interface Resource {
  address: string;
  type: string;
  index: string;
  change: ObjectValue;
  action: string;
}
function resource(value: unknown, v: ObjectValue): Resource {
  const r = object(value);
  const type = text(r.type);
  const index = text(r.index);
  requireEvidence(Object.hasOwn(providers, type) && r.provider_name === providers[type]);
  requireEvidence(r.mode === "managed" && !Object.hasOwn(r, "module_address"));
  requireEvidence(!Object.hasOwn(r, "deposed") && !Object.hasOwn(r, "previous_address"));
  const database = type.startsWith("linode_database_");
  const name = database
    ? type === "linode_database_access_controls"
      ? "db"
      : "cluster"
    : type === "cloudflare_dns_record"
      ? r.name
      : "host";
  requireEvidence(type !== "cloudflare_dns_record" || name === "a" || name === "aaaa");
  requireEvidence(r.name === name && r.address === `${type}.${name}[${JSON.stringify(index)}]`);
  requireEvidence(Object.hasOwn(object(database ? v.database_ids : v.hosts), index));
  const change = object(r.change);
  const action = JSON.stringify(list(change.actions));
  requireEvidence(actions.has(action));
  requireEvidence(Object.hasOwn(change, "after_unknown"));
  unknownMask(change.after_unknown);
  for (const field of ["before_sensitive", "after_sensitive"])
    if (Object.hasOwn(change, field)) unknownMask(change[field]);
  if (Object.hasOwn(change, "replace_paths")) list(change.replace_paths);
  return { address: text(r.address), type, index, change, action };
}

/** A safe ACL addition must be an exact single address of an unchanged known module host. */
function hostEntries(resources: Resource[]): Set<string> {
  const entries = new Set<string>();
  for (const r of resources) {
    if (r.type !== "linode_instance" || r.action !== '["no-op"]' || r.change.importing) continue;
    const before = object(r.change.before);
    requireEvidence(
      isDeepStrictEqual(before, r.change.after) && !unknownMask(r.change.after_unknown),
    );
    for (const address of list(before.ipv4)) {
      requireEvidence(isIP(text(address)) === 4);
      entries.add(`${address}/32`);
    }
    const ipv6 = text(before.ipv6);
    requireEvidence(ipv6.endsWith("/128") && isIP(ipv6.slice(0, -4)) === 6);
    entries.add(ipv6);
  }
  return entries;
}

/** No computed-field blanket exemption: only DNS's update timestamp can become unknown. */
function differences(r: Resource): string[] {
  const before = object(r.change.before);
  const after = object(r.change.after);
  const unknown = object(r.change.after_unknown);
  requireEvidence(
    before.id !== null && before.id !== undefined && isDeepStrictEqual(before.id, after.id),
  );
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)]);
  requireEvidence([...keys].every((key) => fields[r.type]?.includes(key)));
  const differing: string[] = [];
  for (const key of keys) {
    if (r.type === "cloudflare_dns_record" && key === "modified_on" && unknown[key] === true)
      continue;
    requireEvidence(!unknownMask(unknown[key] ?? false));
    if (!isDeepStrictEqual(before[key], after[key])) differing.push(key);
  }
  // Identity schemas are not configurable deltas either; new/changed identities need review.
  requireEvidence(isDeepStrictEqual(r.change.before_identity, r.change.after_identity));
  requireEvidence(
    !r.change.generated_config &&
      (!r.change.replace_paths || list(r.change.replace_paths).length === 0),
  );
  return differing;
}

/** Baseline is independently persisted applied intent, not another copy of this run's inputs. */
function unchangedIntent(current: ObjectValue, baseline: unknown): boolean {
  const previous = inputs(baseline);
  for (const key of [
    "root_keys",
    "configure_keys",
    "root_password_hash",
    "database_ids",
    "cloudflare_zone_id",
  ])
    if (!isDeepStrictEqual(current[key], previous[key])) return false;
  const strippedHosts = (v: ObjectValue) =>
    Object.fromEntries(
      Object.entries(object(v.hosts)).map(([key, host]) => {
        const { label: _label, ...rest } = object(host);
        return [key, rest];
      }),
    );
  return isDeepStrictEqual(strippedHosts(current), strippedHosts(previous));
}

/** Conservative pure classifier; it has no provider, state, credential or network access. */
export function classifyPlan(plan: unknown, expected: unknown, baseline?: unknown): PolicyResult {
  const reasons = new Set<string>();
  const result = (decision: PolicyDecision): PolicyResult => ({
    revision: "1",
    decision,
    reasons: [...reasons].sort(),
  });
  try {
    const p = object(plan);
    const v = inputs(expected);
    // This policy is tied to the tool/provider pins, not future JSON semantics.
    requireEvidence(
      p.format_version === "1.2" && p.terraform_version === "1.12.6" && p.errored === false,
    );
    for (const flag of ["complete", "applyable"])
      if (Object.hasOwn(p, flag)) requireEvidence(p[flag] === true);
    if (p.deferred_changes !== undefined) requireEvidence(list(p.deferred_changes).length === 0);
    for (const check of list(p.checks ?? [])) {
      const c = object(check);
      requireEvidence(c.status === "pass");
      for (const instance of list(c.instances ?? []))
        requireEvidence(object(instance).status === "pass");
    }
    const plannedInputs = Object.fromEntries(
      Object.entries(object(p.variables))
        .filter(([key]) => key !== "state_passphrase")
        .map(([key, entry]) => [key, object(entry).value]),
    );
    requireEvidence(isDeepStrictEqual(plannedInputs, v));
    const resources = list(p.resource_changes).map((r) => resource(r, v));
    requireEvidence(new Set(resources.map((r) => r.address)).size === resources.length);
    const expectedAddresses = Object.keys(object(v.hosts))
      .flatMap((key) => [
        `linode_instance.host[${JSON.stringify(key)}]`,
        `linode_firewall.host[${JSON.stringify(key)}]`,
        `cloudflare_dns_record.a[${JSON.stringify(key)}]`,
        `cloudflare_dns_record.aaaa[${JSON.stringify(key)}]`,
      ])
      .concat(
        Object.keys(object(v.database_ids)).map(
          (key) => `linode_database_access_controls.db[${JSON.stringify(key)}]`,
        ),
      );
    // Cluster adoption is a later module milestone; recognize it without granting mutation rights.
    requireEvidence(
      isDeepStrictEqual(
        resources
          .filter((r) => r.type !== "linode_database_postgresql_v2")
          .map((r) => r.address)
          .sort(),
        expectedAddresses.sort(),
      ),
    );
    // Omitting a managed host must not turn its ACL address into evidence.
    const planned = object(object(p.planned_values).root_module);
    requireEvidence(!planned.child_modules || list(planned.child_modules).length === 0);
    const addresses = list(planned.resources ?? []).map((r) => text(object(r).address));
    requireEvidence(new Set(addresses).size === addresses.length);
    const surviving = resources.filter(
      (r) => r.action !== '["delete"]' && r.action !== '["forget"]',
    );
    requireEvidence(
      isDeepStrictEqual([...addresses].sort(), surviving.map((r) => r.address).sort()),
    );
    for (const entry of list(planned.resources ?? [])) {
      const value = object(entry);
      const r = resources.find((r) => r.address === value.address);
      requireEvidence(
        r && value.type === r.type && value.mode === "managed" && value.index === r.index,
      );
      requireEvidence(
        value.provider_name === providers[r.type] &&
          isDeepStrictEqual(value.values, r.change.after),
      );
    }
    if (list(p.resource_drift ?? []).length) reasons.add("drift");
    if (baseline === undefined) reasons.add("baseline-required");
    else if (!unchangedIntent(v, baseline)) reasons.add("changed-intent");
    const knownEntries = hostEntries(resources);
    for (const r of resources) {
      if (r.change.importing) reasons.add("import");
      if (r.type === "linode_database_postgresql_v2" || r.type === "linode_firewall") {
        if (r.action !== '["no-op"]')
          reasons.add(r.type === "linode_firewall" ? "firewall-change" : "cluster-change");
        else
          requireEvidence(
            isDeepStrictEqual(r.change.before, r.change.after) &&
              !unknownMask(r.change.after_unknown),
          );
        continue;
      }
      if (r.action !== '["no-op"]' && r.action !== '["update"]') {
        reasons.add("lifecycle-change");
        continue;
      }
      const delta = differences(r);
      if (r.action === '["no-op"]') {
        requireEvidence(delta.length === 0);
        continue;
      }
      if (r.type === "linode_instance") {
        const label = object(r.change.after).label;
        if (
          delta.length !== 1 ||
          delta[0] !== "label" ||
          typeof label !== "string" ||
          !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/u.test(label) ||
          label.includes("--")
        )
          reasons.add("instance-change");
      } else if (r.type === "cloudflare_dns_record") {
        const after = object(r.change.after);
        const ttl = after.ttl;
        if (
          delta.length !== 1 ||
          delta[0] !== "ttl" ||
          after.proxied !== false ||
          after.type !== (r.address.includes(".aaaa[") ? "AAAA" : "A") ||
          after.zone_id !== v.cloudflare_zone_id ||
          after.name !== object(object(v.hosts)[r.index]).fqdn ||
          typeof ttl !== "number" ||
          !Number.isInteger(ttl) ||
          ttl < 300 ||
          ttl > 3600
        )
          reasons.add("dns-change");
      } else {
        const before = object(r.change.before);
        const after = object(r.change.after);
        const oldEntries = list(before.allow_list).map(text);
        const newEntries = list(after.allow_list).map(text);
        const added = newEntries.filter((entry) => !oldEntries.includes(entry));
        if (
          delta.length !== 1 ||
          delta[0] !== "allow_list" ||
          after.database_type !== "postgresql" ||
          String(after.database_id) !== object(v.database_ids)[r.index] ||
          new Set(newEntries).size !== newEntries.length ||
          oldEntries.some((entry) => !newEntries.includes(entry)) ||
          added.length === 0 ||
          added.some((entry) => !knownEntries.has(entry))
        )
          reasons.add("access-change");
      }
    }
    const outputs = object(p.output_changes);
    requireEvidence(isDeepStrictEqual(Object.keys(outputs).sort(), ["addresses", "hosts"]));
    const plannedOutputs = object(object(p.planned_values).outputs);
    requireEvidence(isDeepStrictEqual(Object.keys(plannedOutputs).sort(), ["addresses", "hosts"]));
    for (const [name, value] of Object.entries(outputs)) {
      requireEvidence(name === "hosts" || name === "addresses");
      const c = object(value);
      requireEvidence(Object.hasOwn(c, "after_unknown") && !unknownMask(c.after_unknown));
      requireEvidence(isDeepStrictEqual(object(plannedOutputs[name]).value, c.after));
      if (!isDeepStrictEqual(c.actions, ["no-op"]) || !isDeepStrictEqual(c.before, c.after))
        reasons.add("output-change");
    }
    if (reasons.size) return result("review-required");
    return result(resources.some((r) => r.action !== '["no-op"]') ? "safe" : "no-changes");
  } catch {
    // No exception text, path, key, value or diagnostics are ever included in public output.
    return { revision: "1", decision: "invalid", reasons: ["invalid-evidence"] };
  }
}

/** Keyed binding avoids public dictionary hashes of private backend/settings values. */
export function handoffBinding(directory: string, environment: NodeJS.ProcessEnv): string {
  const key = environment.TF_VAR_state_passphrase ?? "";
  requireEvidence(key.length >= 32);
  requireEvidence(/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? ""));
  requireEvidence(
    /^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "") &&
      environment.GITHUB_RUN_ATTEMPT === "1",
  );
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "plan.bin")))
    .digest("hex");
  const binding = {
    domain: "tarubot-infra-handoff-v1",
    digest,
    backend: readFileSync(join(directory, "backend.hcl"), "utf8"),
    inputs: JSON.parse(readFileSync(join(directory, "values.tfvars.json"), "utf8")),
    policy: createHash("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
    commit: environment.GITHUB_SHA,
    run: environment.GITHUB_RUN_ID,
  };
  return createHmac("sha256", key).update(canonical(binding)).digest("hex");
}

if (import.meta.main) {
  try {
    const [command, directory] = process.argv.slice(2);
    requireEvidence(process.argv.length === 4 && directory);
    if (command === "binding") console.log(handoffBinding(directory, process.env));
    else {
      requireEvidence(command === "classify");
      const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
      // No baseline is wired into the live workflow yet: this is advisory, never write permission.
      console.log(JSON.stringify(classifyPlan(read("plan.json"), read("values.tfvars.json"))));
    }
  } catch {
    console.log("::error::Infrastructure policy input or binding is invalid; nothing was applied.");
    process.exitCode = 1;
  }
}
