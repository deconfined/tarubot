/** A complete invented Linode plan shared by replacement-release tests; no real IDs or keys. */
export const releaseInputs = {
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
export function releasePlan(label = releaseInputs.hosts.staging.label) {
  const variables = {
    ...releaseInputs,
    hosts: { staging: { ...releaseInputs.hosts.staging, label } },
  };
  const resource = (
    type: string,
    name: string,
    index: string,
    values: Record<string, unknown>,
  ) => ({
    address: `${type}.${name}[${JSON.stringify(index)}]`,
    type,
    name,
    index,
    mode: "managed",
    provider_name: `registry.opentofu.org/${type.startsWith("linode_") ? "linode/linode" : "cloudflare/cloudflare"}`,
    change: {
      actions: ["no-op"],
      before: structuredClone(values),
      after: structuredClone(values),
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
    },
  });
  const host = resource("linode_instance", "host", "staging", {
    id: "200",
    label: releaseInputs.hosts.staging.label,
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
  host.change.after.label = label;
  if (label !== releaseInputs.hosts.staging.label) host.change.actions = ["update"];
  const dns = {
    name: "staging.example.org",
    zone_id: releaseInputs.cloudflare_zone_id,
    proxied: false,
    ttl: 300,
  };
  const resources = [
    host,
    resource("linode_firewall", "host", "staging", {
      id: "300",
      inbound_policy: "DROP",
      outbound_policy: "ACCEPT",
      inbound: [{ protocol: "TCP", ports: "22", action: "ACCEPT" }],
    }),
    resource("cloudflare_dns_record", "a", "staging", {
      ...dns,
      id: "invented-a-record",
      type: "A",
      content: "192.0.2.10",
    }),
    resource("cloudflare_dns_record", "aaaa", "staging", {
      ...dns,
      id: "invented-aaaa-record",
      type: "AAAA",
      content: "2001:db8::10",
    }),
    resource("linode_database_access_controls", "db", "primary", {
      id: "100:postgresql",
      database_id: 100,
      database_type: "postgresql",
      allow_list: releaseInputs.db_allow_extra,
    }),
  ];
  const outputs = {
    hosts: { staging: "staging" },
    addresses: { staging: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" } },
  };
  return {
    format_version: "1.2",
    terraform_version: "1.12.6",
    errored: false,
    variables: Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [key, { value }]),
    ),
    resource_changes: resources,
    checks: [{ status: "pass" }],
    planned_values: {
      root_module: {
        resources: resources.map(({ change, ...r }) => ({ ...r, values: change.after })),
      },
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([key, value]) => [key, { value, sensitive: true }]),
      ),
    },
    output_changes: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [
        key,
        { actions: ["no-op"], before: value, after: value, after_unknown: false },
      ]),
    ),
  };
}
