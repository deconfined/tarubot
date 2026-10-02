/** Credential-free policy and private handoff binding. Never print provider-controlled values. */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  "ovh_project_id",
  "openstack_project_id",
  "databases",
  "db_allow_extra",
];
/** Selected stack only: obsolete database IDs/import maps are not compatibility inputs. */
export function inputs(value: unknown): ObjectValue {
  const v = object(value);
  requireEvidence(isDeepStrictEqual(Object.keys(v).sort(), [...inputKeys].sort()));
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
  const hosts = object(v.hosts);
  const labels = new Set<string>(),
    names = new Set<string>();
  for (const [key, entry] of Object.entries(hosts)) {
    requireEvidence(/^(staging|production)(-[0-9]{1,2})?$/u.test(key));
    const h = object(entry);
    requireEvidence(
      isDeepStrictEqual(Object.keys(h).sort(), [
        "flavor_id",
        "fqdn",
        "image_id",
        "label",
        "network_id",
        "role",
      ]),
    );
    requireEvidence(h.role === key.split("-")[0]);
    const label = text(h.label),
      fqdn = text(h.fqdn);
    requireEvidence(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(label) && !label.includes("--"));
    requireEvidence(
      fqdn.length <= 253 &&
        fqdn.includes(".") &&
        fqdn.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)),
    );
    requireEvidence(!labels.has(label) && !names.has(fqdn));
    labels.add(label);
    names.add(fqdn);
    requireEvidence(uuid.test(text(h.image_id)) && uuid.test(text(h.network_id)));
    requireEvidence(/^[a-zA-Z0-9_-]{1,64}$/u.test(text(h.flavor_id)));
  }
  for (const key of ["cloudflare_zone_id", "ovh_project_id", "openstack_project_id"])
    requireEvidence(/^[0-9a-f]{32}$/u.test(text(v[key])));
  for (const [key, entry] of Object.entries(object(v.databases))) {
    const d = object(entry);
    requireEvidence(
      /^[a-z]{1,16}$/u.test(key) &&
        isDeepStrictEqual(Object.keys(d).sort(), [
          "backup_time",
          "description",
          "disk_size_gb",
          "flavor",
          "maintenance_time",
          "version",
        ]),
    );
    requireEvidence(
      text(d.description).trim().length > 0 &&
        ["14", "15", "16", "17", "18"].includes(text(d.version)),
    );
    requireEvidence(/^[a-z0-9-]{2,64}$/u.test(text(d.flavor)));
    requireEvidence(Number.isSafeInteger(d.disk_size_gb) && Number(d.disk_size_gb) > 0);
    for (const time of ["backup_time", "maintenance_time"])
      requireEvidence(/^([01][0-9]|2[0-3]):[0-5][0-9]:00$/u.test(text(d[time])));
  }
  const keys = list(v.root_keys).map(text);
  requireEvidence(
    keys.length > 0 &&
      keys.every((key) =>
        /^(verify-required )?(ssh-ed25519|sk-ssh-ed25519@openssh[.]com) AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$/u.test(
          key,
        ),
      ),
  );
  for (const [role, key] of Object.entries(object(v.configure_keys)))
    requireEvidence(
      ["staging", "production"].includes(role) &&
        /^ssh-ed25519 AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$/u.test(text(key)),
    );
  for (const h of Object.values(hosts))
    requireEvidence(Object.hasOwn(object(v.configure_keys), text(object(h).role)));
  const hash = text(v.root_password_hash);
  requireEvidence(
    hash === "" ||
      /^(\$y\$[./0-9A-Za-z]+\$[./0-9A-Za-z]{1,86}\$[./0-9A-Za-z]{43}|\$6\$(rounds=[1-9][0-9]{3,8}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86})$/u.test(
        hash,
      ),
  );
  for (const entry of list(v.db_allow_extra)) {
    const [ip, prefix, extra] = text(entry).split("/");
    const family = isIP(ip ?? "");
    requireEvidence(
      family !== 0 &&
        extra === undefined &&
        prefix !== undefined &&
        /^[0-9]+$/u.test(prefix) &&
        Number(prefix) <= (family === 4 ? 32 : 128),
    );
  }
  return v;
}

/** Fields from signed OVH 2.9.0 / OpenStack 3.4.0 schemas. New fields cannot ride safe changes. */
const fields: Record<string, string[]> = {
  openstack_compute_instance_v2:
    "access_ip_v4 access_ip_v6 admin_pass all_metadata all_tags availability_zone availability_zone_hints config_drive created flavor_id flavor_name force_delete hypervisor_hostname id image_id image_name key_pair metadata name network_mode power_state region security_groups stop_before_destroy tags updated user_data block_device network personality scheduler_hints timeouts vendor_options".split(
      " ",
    ),
  openstack_networking_secgroup_v2:
    "all_tags delete_default_rules description id name region stateful tags tenant_id timeouts".split(
      " ",
    ),
  openstack_networking_secgroup_rule_v2:
    "description direction ethertype id port_range_max port_range_min protocol region remote_address_group_id remote_group_id remote_ip_prefix security_group_id tenant_id timeouts".split(
      " ",
    ),
  ovh_cloud_project_database:
    "advanced_configuration backup_regions backup_time created_at deletion_protection description disk_size disk_type endpoints engine flavor id kafka_rest_api kafka_schema_registry maintenance_time network_type opensearch_acls_enabled plan service_name status version ip_restrictions nodes timeouts".split(
      " ",
    ),
  cloudflare_dns_record:
    "id zone_id include_shadow_metadata name comment content priority type data private_routing proxied ttl tags settings comment_modified_on created_on modified_on proxiable tags_modified_on meta".split(
      " ",
    ),
};
/** Only named control fields, including unchanged nested fields, can support a safe plan. */
function knownNestedFields(type: string, values: ObjectValue): void {
  const record = (value: unknown, keys: string[]) =>
    requireEvidence(Object.keys(object(value)).every((key) => keys.includes(key)));
  const records = (value: unknown, keys: string[]) =>
    list(value).forEach((v) => {
      record(v, keys);
    });
  if (type === "ovh_cloud_project_database") {
    if (values.ip_restrictions != null)
      records(values.ip_restrictions, ["ip", "description", "status"]);
    if (values.nodes != null) records(values.nodes, ["region", "network_id", "subnet_id"]);
  }
  if (type === "openstack_compute_instance_v2" && values.network != null)
    records(values.network, [
      "access_network",
      "fixed_ip_v4",
      "fixed_ip_v6",
      "mac",
      "name",
      "port",
      "uuid",
    ]);
}
const providers: Record<string, string> = {
  openstack_compute_instance_v2: "registry.opentofu.org/terraform-provider-openstack/openstack",
  openstack_networking_secgroup_v2: "registry.opentofu.org/terraform-provider-openstack/openstack",
  openstack_networking_secgroup_rule_v2:
    "registry.opentofu.org/terraform-provider-openstack/openstack",
  ovh_cloud_project_database: "registry.opentofu.org/ovh/ovh",
  cloudflare_dns_record: "registry.opentofu.org/cloudflare/cloudflare",
};
/** One explicit dual-stack firewall, matching main.tf; defaults are removed before these rules. */
const rules: Record<
  string,
  {
    direction: string;
    ethertype: string;
    protocol: string | null;
    port: number | null;
    cidr: string;
  }
> = {
  ssh4: { direction: "ingress", ethertype: "IPv4", protocol: "tcp", port: 22, cidr: "0.0.0.0/0" },
  ssh6: { direction: "ingress", ethertype: "IPv6", protocol: "tcp", port: 22, cidr: "::/0" },
  icmp4: {
    direction: "ingress",
    ethertype: "IPv4",
    protocol: "icmp",
    port: null,
    cidr: "0.0.0.0/0",
  },
  icmp6: {
    direction: "ingress",
    ethertype: "IPv6",
    protocol: "ipv6-icmp",
    port: null,
    cidr: "::/0",
  },
  out4: { direction: "egress", ethertype: "IPv4", protocol: null, port: null, cidr: "0.0.0.0/0" },
  out6: { direction: "egress", ethertype: "IPv6", protocol: null, port: null, cidr: "::/0" },
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
  raw: ObjectValue;
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
  const database = type === "ovh_cloud_project_database";
  const name = database ? "cluster" : type === "cloudflare_dns_record" ? r.name : "host";
  requireEvidence(type !== "cloudflare_dns_record" || name === "a" || name === "aaaa");
  requireEvidence(r.name === name && r.address === `${type}.${name}[${JSON.stringify(index)}]`);
  const hostKey =
    type === "openstack_networking_secgroup_rule_v2"
      ? index.replace(/-(ssh4|ssh6|icmp4|icmp6|out4|out6)$/u, "")
      : index;
  requireEvidence(Object.hasOwn(object(database ? v.databases : v.hosts), hostKey));
  if (type === "openstack_networking_secgroup_rule_v2")
    requireEvidence(Object.keys(rules).some((key) => index === `${hostKey}-${key}`));
  const change = object(r.change);
  const action = JSON.stringify(list(change.actions));
  requireEvidence(actions.has(action));
  requireEvidence(Object.hasOwn(change, "after_unknown"));
  unknownMask(change.after_unknown);
  for (const field of ["before_sensitive", "after_sensitive"])
    if (Object.hasOwn(change, field)) unknownMask(change[field]);
  if (Object.hasOwn(change, "replace_paths")) list(change.replace_paths);
  return { raw: r, address: text(r.address), type, index, change, action };
}

/** A safe ACL addition must be an exact single address of an unchanged known module host. */
function hostEntries(resources: Resource[]): Set<string> {
  const entries = new Set<string>();
  for (const r of resources) {
    if (
      r.type !== "openstack_compute_instance_v2" ||
      r.action !== '["no-op"]' ||
      r.change.importing
    )
      continue;
    const before = object(r.change.before);
    requireEvidence(
      isDeepStrictEqual(before, r.change.after) && !unknownMask(r.change.after_unknown),
    );
    requireEvidence(isIP(text(before.access_ip_v4)) === 4 && isIP(text(before.access_ip_v6)) === 6);
    entries.add(`${before.access_ip_v4}/32`);
    entries.add(`${before.access_ip_v6}/128`);
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
  knownNestedFields(r.type, before);
  knownNestedFields(r.type, after);
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
    "ovh_project_id",
    "openstack_project_id",
    "databases",
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

/** A duplicated no-op view is insufficient: it must describe the configured selected stack. */
function configured(r: Resource, v: ObjectValue, resources: Resource[]): void {
  const after = object(r.change.after);
  const hostKey =
    r.type === "openstack_networking_secgroup_rule_v2"
      ? r.index.replace(/-(ssh4|ssh6|icmp4|icmp6|out4|out6)$/u, "")
      : r.index;
  const firewall = resources.find(
    (entry) => entry.type === "openstack_networking_secgroup_v2" && entry.index === hostKey,
  );
  if (r.type.startsWith("openstack_")) requireEvidence(after.region === "US-EAST-VA-1");
  if (r.type === "openstack_compute_instance_v2") {
    const host = object(object(v.hosts)[r.index]);
    const network = list(after.network);
    requireEvidence(
      after.name === host.label &&
        after.image_id === host.image_id &&
        after.flavor_id === host.flavor_id &&
        after.power_state === "active" &&
        after.config_drive === true &&
        after.stop_before_destroy === true &&
        !after.key_pair &&
        !after.admin_pass &&
        list(after.block_device ?? []).length === 0 &&
        network.length === 1 &&
        object(network[0]).uuid === host.network_id &&
        object(network[0]).access_network === true &&
        firewall &&
        isDeepStrictEqual(after.security_groups, [object(firewall.change.after).name]),
    );
  } else if (r.type === "openstack_networking_secgroup_v2") {
    requireEvidence(
      after.name === `tarubot-${r.index}-fw` &&
        after.tenant_id === v.openstack_project_id &&
        after.delete_default_rules === true &&
        after.stateful === true,
    );
  } else if (r.type === "openstack_networking_secgroup_rule_v2") {
    const rule = rules[r.index.slice(hostKey.length + 1)];
    requireEvidence(
      rule &&
        firewall &&
        after.security_group_id === object(firewall.change.after).id &&
        after.tenant_id === v.openstack_project_id &&
        after.direction === rule.direction &&
        after.ethertype === rule.ethertype &&
        (after.protocol || null) === rule.protocol &&
        (after.port_range_min || null) === rule.port &&
        (after.port_range_max || null) === rule.port &&
        after.remote_ip_prefix === rule.cidr &&
        !after.remote_group_id &&
        !after.remote_address_group_id,
    );
  } else if (r.type === "cloudflare_dns_record") {
    const host = resources.find(
      (entry) => entry.type === "openstack_compute_instance_v2" && entry.index === r.index,
    );
    requireEvidence(host);
    const addresses = object(host.change.after),
      isIPv6 = r.raw.name === "aaaa";
    requireEvidence(
      isIP(text(addresses.access_ip_v4)) === 4 && isIP(text(addresses.access_ip_v6)) === 6,
    );
    requireEvidence(
      after.zone_id === v.cloudflare_zone_id &&
        after.name === object(object(v.hosts)[r.index]).fqdn &&
        after.type === (isIPv6 ? "AAAA" : "A") &&
        after.proxied === false &&
        after.content === addresses[isIPv6 ? "access_ip_v6" : "access_ip_v4"],
    );
  } else {
    const db = object(object(v.databases)[r.index]),
      nodes = list(after.nodes);
    requireEvidence(
      after.service_name === v.ovh_project_id &&
        after.engine === "postgresql" &&
        after.plan === "essential" &&
        after.deletion_protection === true &&
        nodes.length === 1 &&
        object(nodes[0]).region === "US-EAST-VA" &&
        !object(nodes[0]).network_id &&
        !object(nodes[0]).subnet_id,
    );
    for (const key of ["description", "version", "flavor", "backup_time", "maintenance_time"])
      requireEvidence(after[key] === db[key]);
    requireEvidence(after.disk_size === db.disk_size_gb);
    const wanted = new Set(list(v.db_allow_extra).map(text));
    for (const host of resources.filter(
      (entry) => entry.type === "openstack_compute_instance_v2",
    )) {
      const values = object(host.change.after);
      wanted.add(`${text(values.access_ip_v4)}/32`);
      wanted.add(`${text(values.access_ip_v6)}/128`);
    }
    const restrictions = restrictionEntries(after.ip_restrictions);
    requireEvidence(
      isDeepStrictEqual(restrictions.map((entry) => text(entry.ip)).sort(), [...wanted].sort()),
    );
  }
}
/** Restriction sets include descriptions/status; compare whole old entries, not only IP strings. */
function restrictionEntries(value: unknown): ObjectValue[] {
  const entries = list(value).map(object);
  const ips = entries.map((entry) => text(entry.ip));
  requireEvidence(new Set(ips).size === ips.length);
  return entries;
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
    if (Object.hasOwn(p, "complete")) requireEvidence(p.complete === true);
    if (Object.hasOwn(p, "applyable")) requireEvidence(typeof p.applyable === "boolean");
    if (p.deferred_changes !== undefined) requireEvidence(list(p.deferred_changes).length === 0);
    for (const check of list(p.checks ?? [])) {
      const c = object(check);
      requireEvidence(c.status === "pass");
      for (const instance of list(c.instances ?? []))
        requireEvidence(object(instance).status === "pass");
    }
    const plannedInputs = inputs(
      Object.fromEntries(
        Object.entries(object(p.variables))
          .filter(([key]) => key !== "state_passphrase")
          .map(([key, entry]) => [key, object(entry).value]),
      ),
    );
    requireEvidence(isDeepStrictEqual(plannedInputs, v));
    const resources = list(p.resource_changes).map((r) => resource(r, v));
    requireEvidence(new Set(resources.map((r) => r.address)).size === resources.length);
    const expectedAddresses = Object.keys(object(v.hosts))
      .flatMap((key) => [
        `openstack_compute_instance_v2.host[${JSON.stringify(key)}]`,
        `openstack_networking_secgroup_v2.host[${JSON.stringify(key)}]`,
        ...Object.keys(rules).map(
          (rule) =>
            `openstack_networking_secgroup_rule_v2.host[${JSON.stringify(`${key}-${rule}`)}]`,
        ),
        `cloudflare_dns_record.a[${JSON.stringify(key)}]`,
        `cloudflare_dns_record.aaaa[${JSON.stringify(key)}]`,
      ])
      .concat(
        Object.keys(object(v.databases)).map(
          (key) => `ovh_cloud_project_database.cluster[${JSON.stringify(key)}]`,
        ),
      );
    // Every configured resource, including every firewall rule, is required even on a no-op.
    requireEvidence(
      isDeepStrictEqual(resources.map((r) => r.address).sort(), expectedAddresses.sort()),
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
      // This module creates new services. Import/forget semantics are not a migration path.
      requireEvidence(!r.change.importing && !r.action.includes("forget"));
      if (r.action !== '["no-op"]' && r.action !== '["update"]') {
        reasons.add("lifecycle-change");
        continue;
      }
      const delta = differences(r);
      if (r.action === '["no-op"]') {
        requireEvidence(delta.length === 0);
        configured(r, v, resources);
        continue;
      }
      if (r.type.startsWith("openstack_networking_")) {
        reasons.add("firewall-change");
      } else if (r.type === "openstack_compute_instance_v2") {
        const name = object(r.change.after).name;
        if (
          delta.length !== 1 ||
          delta[0] !== "name" ||
          name !== object(object(v.hosts)[r.index]).label
        )
          reasons.add("instance-change");
        else configured(r, v, resources);
      } else if (r.type === "cloudflare_dns_record") {
        const after = object(r.change.after),
          ttl = after.ttl;
        if (
          delta.length !== 1 ||
          delta[0] !== "ttl" ||
          typeof ttl !== "number" ||
          !Number.isInteger(ttl) ||
          ttl < 300 ||
          ttl > 3600
        )
          reasons.add("dns-change");
        else configured(r, v, resources);
      } else {
        if (delta.length !== 1 || delta[0] !== "ip_restrictions") {
          reasons.add("cluster-change");
          continue;
        }
        configured(r, v, resources);
        const before = restrictionEntries(object(r.change.before).ip_restrictions);
        const after = restrictionEntries(object(r.change.after).ip_restrictions);
        const oldIPs = before.map((entry) => text(entry.ip));
        const added = after.filter((entry) => !oldIPs.includes(text(entry.ip)));
        if (
          before.some((entry) => !after.some((next) => isDeepStrictEqual(entry, next))) ||
          added.length === 0 ||
          added.some(
            (entry) =>
              !knownEntries.has(text(entry.ip)) ||
              entry.description !== "tarubot-managed" ||
              entry.status !== "active",
          )
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
    const changed = resources.some((r) => r.action !== '["no-op"]');
    // Some show formats report an empty plan as not applyable: it can continue, never mutate.
    requireEvidence(!changed || p.applyable !== false);
    return result(changed ? "safe" : "no-changes");
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
    domain: "tarubot-infra-handoff-v2",
    digest,
    backend: readFileSync(join(directory, "backend.hcl"), "utf8"),
    inputs: JSON.parse(readFileSync(join(directory, "values.tfvars.json"), "utf8")),
    policy: createHash("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
    controlCode: [
      "infra-control.ts",
      "infra-control-cli.ts",
      "release-infra.ts",
      "release-policy.ts",
      "infra-inputs.ts",
      "host-enrollment.ts",
      "ovh-client.ts",
    ].map((name) =>
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    ),
    control: existsSync(join(directory, "control-context.json"))
      ? JSON.parse(readFileSync(join(directory, "control-context.json"), "utf8"))
      : null,
    shownPlan: existsSync(join(directory, "plan.json"))
      ? JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"))
      : null,
    baseline: existsSync(join(directory, "baseline-inputs.json"))
      ? JSON.parse(readFileSync(join(directory, "baseline-inputs.json"), "utf8"))
      : null,
    release: existsSync(join(directory, "release-context.json"))
      ? JSON.parse(readFileSync(join(directory, "release-context.json"), "utf8"))
      : null,
    operation: environment.GITHUB_EVENT_PATH
      ? (JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8")).inputs?.operation ?? null)
      : null,
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
      const baseline = existsSync(join(directory, "baseline-inputs.json"))
        ? read("baseline-inputs.json")
        : undefined;
      // Persisted evidence enables classification, not unattended write authority.
      console.log(
        JSON.stringify(
          classifyPlan(read("plan.json"), read("values.tfvars.json"), baseline ?? undefined),
        ),
      );
    }
  } catch {
    console.log("::error::Infrastructure policy input or binding is invalid; nothing was applied.");
    process.exitCode = 1;
  }
}
