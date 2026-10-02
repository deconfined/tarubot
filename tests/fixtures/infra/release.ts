/** Complete invented OVH/OpenStack plan. It is transport evidence, not service acceptance. */
export const releaseInputs = {
  hosts: {
    staging: {
      label: "example-staging",
      fqdn: "staging.example.org",
      role: "staging",
      image_id: "00000000-0000-0000-0000-000000000010",
      flavor_id: "00000000-0000-0000-0000-000000000020",
      network_id: "00000000-0000-0000-0000-000000000030",
    },
  },
  root_keys: ["ssh-ed25519 AAAAEXAMPLE0001 invented-root"],
  configure_keys: { staging: "ssh-ed25519 AAAAEXAMPLE0002 invented-configure" },
  root_password_hash: "",
  cloudflare_zone_id: "0".repeat(32),
  ovh_project_id: "1".repeat(32),
  openstack_project_id: "2".repeat(32),
  databases: {
    primary: {
      description: "Invented PostgreSQL service",
      version: "17",
      flavor: "example-database-flavor",
      disk_size_gb: 80,
      backup_time: "02:00:00",
      maintenance_time: "03:00:00",
    },
  },
  db_allow_extra: ["198.51.100.10/32"],
};
export function inventedResource(
  type: string,
  name: string,
  index: string,
  values: Record<string, unknown>,
) {
  return {
    address: `${type}.${name}[${JSON.stringify(index)}]`,
    type,
    name,
    index,
    mode: "managed",
    provider_name: `registry.opentofu.org/${type.startsWith("openstack_") ? "terraform-provider-openstack/openstack" : type.startsWith("ovh_") ? "ovh/ovh" : "cloudflare/cloudflare"}`,
    change: {
      actions: ["no-op"],
      before: structuredClone(values),
      after: structuredClone(values),
      after_unknown: {} as Record<string, unknown>,
      before_sensitive: {},
      after_sensitive: {},
    },
  };
}
export function releasePlan(label = releaseInputs.hosts.staging.label) {
  const h = releaseInputs.hosts.staging;
  const variables = { ...releaseInputs, hosts: { staging: { ...h, label } } };
  const host = inventedResource("openstack_compute_instance_v2", "host", "staging", {
    id: "00000000-0000-0000-0000-000000000040",
    name: h.label,
    region: "US-EAST-VA-1",
    image_id: h.image_id,
    flavor_id: h.flavor_id,
    power_state: "active",
    config_drive: true,
    stop_before_destroy: true,
    security_groups: ["tarubot-staging-fw"],
    block_device: [],
    network: [{ uuid: h.network_id, access_network: true }],
    access_ip_v4: "192.0.2.10",
    access_ip_v6: "2001:db8::10",
    user_data: "invented-unchanged-data",
  });
  host.change.after.name = label;
  if (label !== h.label) host.change.actions = ["update"];
  const firewall = inventedResource("openstack_networking_secgroup_v2", "host", "staging", {
    id: "00000000-0000-0000-0000-000000000050",
    name: "tarubot-staging-fw",
    region: "US-EAST-VA-1",
    tenant_id: releaseInputs.openstack_project_id,
    delete_default_rules: true,
    stateful: true,
  });
  const rules = [
    ["ssh4", "ingress", "IPv4", "tcp", 22, "0.0.0.0/0"],
    ["ssh6", "ingress", "IPv6", "tcp", 22, "::/0"],
    ["icmp4", "ingress", "IPv4", "icmp", null, "0.0.0.0/0"],
    ["icmp6", "ingress", "IPv6", "ipv6-icmp", null, "::/0"],
    ["out4", "egress", "IPv4", null, null, "0.0.0.0/0"],
    ["out6", "egress", "IPv6", null, null, "::/0"],
  ].map(([key, direction, ethertype, protocol, port, cidr]) =>
    inventedResource("openstack_networking_secgroup_rule_v2", "host", `staging-${key}`, {
      id: `invented-${key}-rule`,
      region: "US-EAST-VA-1",
      tenant_id: releaseInputs.openstack_project_id,
      security_group_id: firewall.change.after.id,
      direction,
      ethertype,
      protocol,
      port_range_min: port,
      port_range_max: port,
      remote_ip_prefix: cidr,
    }),
  );
  const dns = { name: h.fqdn, zone_id: releaseInputs.cloudflare_zone_id, proxied: false, ttl: 300 };
  const resources = [
    host,
    firewall,
    ...rules,
    inventedResource("cloudflare_dns_record", "a", "staging", {
      ...dns,
      id: "invented-a-record",
      type: "A",
      content: "192.0.2.10",
    }),
    inventedResource("cloudflare_dns_record", "aaaa", "staging", {
      ...dns,
      id: "invented-aaaa-record",
      type: "AAAA",
      content: "2001:db8::10",
    }),
    inventedResource("ovh_cloud_project_database", "cluster", "primary", {
      id: "00000000-0000-0000-0000-000000000060",
      service_name: releaseInputs.ovh_project_id,
      ...Object.fromEntries(
        Object.entries(releaseInputs.databases.primary).filter(([key]) => key !== "disk_size_gb"),
      ),
      disk_size: 80,
      engine: "postgresql",
      plan: "essential",
      deletion_protection: true,
      nodes: [{ region: "US-EAST-VA", network_id: null, subnet_id: null }],
      ip_restrictions: [...releaseInputs.db_allow_extra, "192.0.2.10/32", "2001:db8::10/128"].map(
        (ip) => ({ ip, description: "tarubot-managed", status: "active" }),
      ),
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
