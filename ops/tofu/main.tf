# Selected OVH US stack: OpenStack compute/networking, OVH Essential PostgreSQL and Cloudflare
# DNS. This creates a NEW database target; it neither imports nor migrates the live database.
locals {
  # Only public-safe role/database keys may appear in resource addresses or workflow summaries.
  host_keys     = nonsensitive(toset(keys(var.hosts)))
  database_keys = nonsensitive(toset(keys(var.databases)))
  user_data = {
    for k in local.host_keys : k => templatefile("${path.module}/cloud-init.yaml.tftpl", {
      hostname           = split(".", var.hosts[k].fqdn)[0]
      fqdn               = var.hosts[k].fqdn
      root_keys          = concat(var.root_keys, [lookup(var.configure_keys, var.hosts[k].role, "")])
      root_password_hash = var.root_password_hash
    })
  }
  # The public-network contract requires one IPv4 and one IPv6 address. Missing IPv6 is a
  # refusal, not permission to invent an AAAA record or silently weaken enrollment checks.
  host_ipv4 = { for k in local.host_keys : k => openstack_compute_instance_v2.host[k].access_ip_v4 }
  host_ipv6 = { for k in local.host_keys : k => openstack_compute_instance_v2.host[k].access_ip_v6 }
  host_access = concat(
    [for k in sort(tolist(local.host_keys)) : "${local.host_ipv6[k]}/128"],
    [for k in sort(tolist(local.host_keys)) : "${local.host_ipv4[k]}/32"],
  )
  # Remove Neutron's default rules, then express all six rules explicitly. Stable names depend
  # on public role keys, not VM labels, so renaming a VM cannot also change its firewall.
  rules = {
    ssh4  = { direction = "ingress", ethertype = "IPv4", protocol = "tcp", port = 22, cidr = "0.0.0.0/0" }
    ssh6  = { direction = "ingress", ethertype = "IPv6", protocol = "tcp", port = 22, cidr = "::/0" }
    icmp4 = { direction = "ingress", ethertype = "IPv4", protocol = "icmp", port = null, cidr = "0.0.0.0/0" }
    icmp6 = { direction = "ingress", ethertype = "IPv6", protocol = "ipv6-icmp", port = null, cidr = "::/0" }
    out4  = { direction = "egress", ethertype = "IPv4", protocol = null, port = null, cidr = "0.0.0.0/0" }
    out6  = { direction = "egress", ethertype = "IPv6", protocol = null, port = null, cidr = "::/0" }
  }
  host_rules = merge({}, [for k in local.host_keys : {
    for name, rule in local.rules : "${k}-${name}" => merge(rule, { host_key = k })
  }]...)
}

resource "openstack_networking_secgroup_v2" "host" {
  for_each             = local.host_keys
  name                 = "tarubot-${each.key}-fw"
  region               = "US-EAST-VA-1"
  tenant_id            = var.openstack_project_id
  delete_default_rules = true
  stateful             = true
}

resource "openstack_networking_secgroup_rule_v2" "host" {
  for_each          = local.host_rules
  region            = "US-EAST-VA-1"
  tenant_id         = var.openstack_project_id
  security_group_id = openstack_networking_secgroup_v2.host[each.value.host_key].id
  direction         = each.value.direction
  ethertype         = each.value.ethertype
  protocol          = each.value.protocol
  port_range_min    = each.value.port
  port_range_max    = each.value.port
  remote_ip_prefix  = each.value.cidr
}

resource "openstack_compute_instance_v2" "host" {
  for_each            = local.host_keys
  name                = var.hosts[each.key].label
  region              = "US-EAST-VA-1"
  image_id            = var.hosts[each.key].image_id
  flavor_id           = var.hosts[each.key].flavor_id
  power_state         = "active"
  config_drive        = true
  security_groups     = [openstack_networking_secgroup_v2.host[each.key].name]
  user_data           = local.user_data[each.key]
  stop_before_destroy = true
  # d2-2 includes its local root disk. Do not add a separately billed boot volume or silently
  # substitute a diskless flavor. The owner pins the AlmaLinux 10-UEFI image and d2-2 IDs.
  network {
    uuid           = var.hosts[each.key].network_id
    access_network = true
  }
  depends_on = [openstack_networking_secgroup_rule_v2.host]
  lifecycle {
    # First-boot public keys/hash remain deliberate creation-only intent. The full-plan policy
    # compares them against the durable input baseline even when OpenTofu ignores user_data.
    ignore_changes = [user_data]
    precondition {
      condition     = contains(keys(var.configure_keys), var.hosts[each.key].role)
      error_message = "configure_keys has no key for this host's role."
    }
    postcondition {
      condition     = can(cidrhost("${self.access_ip_v4}/32", 0)) && !strcontains(self.access_ip_v4, ":") && can(cidrhost("${self.access_ip_v6}/128", 0)) && strcontains(self.access_ip_v6, ":")
      error_message = "The applied public-network host must have IPv4 and IPv6 addresses."
    }
  }
}

resource "cloudflare_dns_record" "a" {
  for_each = local.host_keys
  zone_id  = var.cloudflare_zone_id
  name     = var.hosts[each.key].fqdn
  type     = "A"
  content  = local.host_ipv4[each.key]
  proxied  = false
  ttl      = 300
}
resource "cloudflare_dns_record" "aaaa" {
  for_each = local.host_keys
  zone_id  = var.cloudflare_zone_id
  name     = var.hosts[each.key].fqdn
  type     = "AAAA"
  content  = local.host_ipv6[each.key]
  proxied  = false
  ttl      = 300
}

resource "ovh_cloud_project_database" "cluster" {
  for_each            = local.database_keys
  service_name        = var.ovh_project_id
  description         = var.databases[each.key].description
  engine              = "postgresql"
  version             = var.databases[each.key].version
  plan                = "essential"
  flavor              = var.databases[each.key].flavor
  disk_size           = var.databases[each.key].disk_size_gb
  backup_time         = var.databases[each.key].backup_time
  maintenance_time    = var.databases[each.key].maintenance_time
  deletion_protection = true
  nodes {
    region = "US-EAST-VA"
  }
  # The supported service resource owns the COMPLETE restriction set, not deprecated individual
  # restriction resources. Preserve extra entries during an owner-reviewed migration window.
  dynamic "ip_restrictions" {
    for_each = toset(concat(local.host_access, var.db_allow_extra))
    content {
      ip          = ip_restrictions.value
      description = "tarubot-managed"
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}
