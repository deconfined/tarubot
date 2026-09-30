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
  // Linode v4.5.0 at c77ffd4d69cde96fb01b9bf83f6506e5cab957a4:
  // linode/firewall/framework_schema_resource.go and framework_schema_datasource.go.
  linode_firewall: `id label tags disabled inbound outbound inbound_policy outbound_policy version
    fingerprint linodes nodebalancers interfaces devices status created updated`.split(/\s+/u),
  // The same pinned source's linode/databasepostgresqlv2/framework_resource_schema.go;
  // framework_resource.go adds create/update/delete timeouts through BaseResource.
  linode_database_postgresql_v2: `id engine_id label region type allow_list ca_cert cluster_size
    fork_restore_time fork_source suspended updates created encrypted engine host_primary
    host_secondary host_standby members oldest_restore_time pending_updates platform port
    private_network root_password root_username ssl_connection status updated version timeouts
    engine_config_pg_autovacuum_analyze_scale_factor engine_config_pg_autovacuum_analyze_threshold
    engine_config_pg_autovacuum_max_workers engine_config_pg_autovacuum_naptime
    engine_config_pg_autovacuum_vacuum_cost_delay engine_config_pg_autovacuum_vacuum_cost_limit
    engine_config_pg_autovacuum_vacuum_scale_factor engine_config_pg_autovacuum_vacuum_threshold
    engine_config_pg_bgwriter_delay engine_config_pg_bgwriter_flush_after engine_config_pg_bgwriter_lru_maxpages
    engine_config_pg_bgwriter_lru_multiplier engine_config_pg_deadlock_timeout engine_config_pg_default_toast_compression
    engine_config_pg_idle_in_transaction_session_timeout engine_config_pg_jit engine_config_pg_max_files_per_process
    engine_config_pg_max_locks_per_transaction engine_config_pg_max_logical_replication_workers
    engine_config_pg_max_parallel_workers engine_config_pg_max_parallel_workers_per_gather
    engine_config_pg_max_pred_locks_per_transaction engine_config_pg_max_replication_slots
    engine_config_pg_max_slot_wal_keep_size engine_config_pg_max_stack_depth engine_config_pg_max_standby_archive_delay
    engine_config_pg_max_standby_streaming_delay engine_config_pg_max_wal_senders engine_config_pg_max_worker_processes
    engine_config_pg_password_encryption engine_config_pg_pg_partman_bgw_interval engine_config_pg_pg_partman_bgw_role
    engine_config_pg_pg_stat_monitor_pgsm_enable_query_plan engine_config_pg_pg_stat_monitor_pgsm_max_buckets
    engine_config_pg_pg_stat_statements_track engine_config_pg_temp_file_limit engine_config_pg_timezone
    engine_config_pg_track_activity_query_size engine_config_pg_track_commit_timestamp engine_config_pg_track_functions
    engine_config_pg_track_io_timing engine_config_pg_wal_sender_timeout engine_config_pg_wal_writer_delay
    engine_config_pg_stat_monitor_enable engine_config_pglookout_max_failover_replication_time_lag
    engine_config_shared_buffers_percentage engine_config_work_mem`.split(/\s+/u),
};
/** Nested controls have named fields too; unchanged unknown fields cannot ride a safe update. */
function knownNestedFields(type: string, values: ObjectValue): void {
  const record = (value: unknown, keys: string[]) =>
    requireEvidence(Object.keys(object(value)).every((key) => keys.includes(key)));
  const records = (value: unknown, keys: string[]) =>
    list(value).forEach((v) => {
      record(v, keys);
    });
  if (type === "linode_firewall") {
    for (const key of ["inbound", "outbound"])
      if (values[key] !== undefined && values[key] !== null)
        records(values[key], [
          "label",
          "action",
          "protocol",
          "description",
          "ports",
          "ipv4",
          "ipv6",
        ]);
    if (values.devices !== undefined && values.devices !== null)
      records(values.devices, ["id", "entity_id", "type", "label", "url"]);
  } else if (type === "linode_database_postgresql_v2") {
    // Pinned linode/helper/databaseshared/{updates,private_network,pending_updates}.go.
    if (values.updates !== undefined && values.updates !== null)
      record(values.updates, ["day_of_week", "duration", "frequency", "hour_of_day"]);
    if (values.private_network !== undefined && values.private_network !== null)
      record(values.private_network, ["vpc_id", "subnet_id", "public_access"]);
    if (values.pending_updates !== undefined && values.pending_updates !== null)
      records(values.pending_updates, ["deadline", "description", "planned_for"]);
  }
}
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
    if (Object.hasOwn(p, "complete")) requireEvidence(p.complete === true);
    if (Object.hasOwn(p, "applyable")) requireEvidence(typeof p.applyable === "boolean");
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
        else {
          requireEvidence(differences(r).length === 0);
          if (r.type === "linode_database_postgresql_v2")
            requireEvidence(String(object(r.change.after).id) === object(v.database_ids)[r.index]);
        }
        continue;
      }
      if (r.action !== '["no-op"]' && r.action !== '["update"]') {
        reasons.add("lifecycle-change");
        continue;
      }
      const delta = differences(r);
      if (r.action === '["no-op"]') {
        requireEvidence(delta.length === 0);
        const after = object(r.change.after);
        // A provider no-op must still describe the configured object, rather than merely
        // matching its own duplicated views. Ignored creation-only inputs stay baseline-bound.
        if (r.type === "linode_instance") {
          const host = object(object(v.hosts)[r.index]);
          const firewall = resources.find(
            (entry) => entry.type === "linode_firewall" && entry.index === r.index,
          );
          requireEvidence(
            ["label", "region", "type"].every((key) => after[key] === host[key]) &&
              after.image === "linode/almalinux10" &&
              after.booted === true &&
              after.disk_encryption === "enabled" &&
              after.interface_generation === "legacy_config" &&
              list(after.interface).length === 1 &&
              object(list(after.interface)[0]).purpose === "public" &&
              firewall &&
              String(after.firewall_id) === String(object(firewall.change.after).id),
          );
        } else if (r.type === "cloudflare_dns_record") {
          const host = resources.find(
            (entry) => entry.type === "linode_instance" && entry.index === r.index,
          );
          requireEvidence(host);
          const addresses = object(host.change.after);
          const ipv4 = list(addresses.ipv4);
          const ipv6 = text(addresses.ipv6);
          requireEvidence(ipv4.length === 1 && isIP(text(ipv4[0])) === 4);
          requireEvidence(ipv6.endsWith("/128") && isIP(ipv6.slice(0, -4)) === 6);
          const isIPv6 = r.address.includes(".aaaa[");
          requireEvidence(
            after.zone_id === v.cloudflare_zone_id &&
              after.name === object(object(v.hosts)[r.index]).fqdn &&
              after.type === (isIPv6 ? "AAAA" : "A") &&
              after.proxied === false &&
              after.content === (isIPv6 ? ipv6.slice(0, -4) : ipv4[0]),
          );
        } else
          requireEvidence(
            String(after.database_id) === object(v.database_ids)[r.index] &&
              after.database_type === "postgresql" &&
              after.id === `${object(v.database_ids)[r.index]}:postgresql`,
          );
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
