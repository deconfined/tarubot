# What TaruBot's OpenTofu module builds (2.36.0, issue #62):
#
#   per host (var.hosts)       a Linode with disk encryption, its Cloud Firewall, and an A and an
#                              AAAA record. cloud-init user data (cloud-init.yaml.tftpl) sets its
#                              hostname and root's credentials; ops/ansible/site.yml does the rest.
#   per cluster (database_ids) the managed PostgreSQL cluster's whole access list: every host's
#                              addresses plus db_allow_extra. The clusters stay outside OpenTofu.
#
# It never builds SSH host keys (each host makes its own at first boot, and the owner pins it from
# their own machine: README.md, "Pinning a new host key"), SSH fingerprint records in DNS, or
# database clusters.

locals {
  # The host and cluster keys, which appear in resource addresses. The maps are sensitive; their
  # keys are held to public-safe words by variables.tf, so for_each may use them in the clear.
  host_keys     = nonsensitive(toset(keys(var.hosts)))
  database_keys = nonsensitive(toset(keys(var.database_ids)))

  # Each host's cloud-init user data. Root gets the common keys plus its role's Configure key;
  # a missing Configure key renders as "" and the instance's precondition refuses the plan.
  user_data = {
    for k in local.host_keys : k => templatefile("${path.module}/cloud-init.yaml.tftpl", {
      hostname           = split(".", var.hosts[k].fqdn)[0]
      fqdn               = var.hosts[k].fqdn
      root_keys          = concat(var.root_keys, [lookup(var.configure_keys, var.hosts[k].role, "")])
      root_password_hash = var.root_password_hash
    })
  }

  # The Linode API reports a host's IPv6 SLAAC address with its /128; DNS wants the bare address.
  host_ipv6 = { for k in local.host_keys : k => split("/", linode_instance.host[k].ipv6)[0] }

  # A host's one IPv4 address. Private networking is never enabled here, so the set holds only
  # the public address; one() fails the plan loudly if that ever stops being true.
  host_ipv4 = { for k in local.host_keys : k => one(linode_instance.host[k].ipv4) }

  # Every host's database access, IPv6 first (the hosts prefer it), in the CIDR form the API stores.
  host_access = concat(
    [for k in sort(tolist(local.host_keys)) : "${local.host_ipv6[k]}/128"],
    [for k in sort(tolist(local.host_keys)) : "${local.host_ipv4[k]}/32"],
  )
}

# Inbound, only SSH (from anywhere: GitHub's runners have no fixed addresses) and ICMP; outbound,
# everything. Rootless Podman publishes no port, and sshd is the only listener (site.yml).
resource "linode_firewall" "host" {
  for_each = local.host_keys

  # Firewall labels are 3 to 32 characters: the host's label, cut to fit, then "-fw".
  label           = format("%s-fw", trimsuffix(substr(var.hosts[each.key].label, 0, 29), "-"))
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  inbound {
    label    = "accept-ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  inbound {
    label    = "accept-icmp"
    action   = "ACCEPT"
    protocol = "ICMP"
    ipv4     = ["0.0.0.0/0"]
  }

  # ICMPv6 (path MTU discovery, among others). Linode's ICMP keyword covers ICMPv6 for IPv6
  # addresses; numeric protocols such as 58 aren't available to every account yet.
  inbound {
    label    = "accept-icmpv6"
    action   = "ACCEPT"
    protocol = "ICMP"
    ipv6     = ["::/0"]
  }
}

resource "linode_instance" "host" {
  for_each = local.host_keys

  label           = var.hosts[each.key].label
  region          = var.hosts[each.key].region
  type            = var.hosts[each.key].type
  image           = "linode/almalinux10"
  disk_encryption = "enabled"
  firewall_id     = linode_firewall.host[each.key].id
  booted          = true

  # The network interface type is pinned rather than left to the account's default (question 27
  # of #50): classic configuration-profile interfaces, with one public interface.
  interface_generation = "legacy_config"
  interface {
    purpose = "public"
  }

  # The provider refuses an image without a root password or keys, and cloud-init must stay the
  # only writer of root's keys. So the Linode gets a random throwaway password (about 512 bits
  # derived from two random UUIDs; state keeps only the provider's hash of it), which the user
  # data replaces with the owner's hash or locks.
  root_pass = base64sha512("${uuid()}${uuid()}")

  metadata {
    user_data = base64encode(local.user_data[each.key])
  }

  lifecycle {
    # A template, key or hash change must never plan a rebuild of every host: user data takes
    # effect only through a deliberate replace (infra.yml's replace input, README.md "Rebuilding
    # a host"). root_pass is new on every plan, and only the create uses it.
    ignore_changes = [metadata, root_pass]

    precondition {
      condition     = contains(keys(var.configure_keys), var.hosts[each.key].role)
      error_message = "configure_keys has no key for this host's role."
    }
  }
}

# Unproxied records with a short TTL: the name must lead to the host itself, for SSH and for the
# owner's ssh-keyscan. No SSH fingerprint records: the owner pins each new host's key (trust on
# first use).
resource "cloudflare_dns_record" "a" {
  for_each = local.host_keys

  zone_id = var.cloudflare_zone_id
  name    = var.hosts[each.key].fqdn
  type    = "A"
  content = local.host_ipv4[each.key]
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "aaaa" {
  for_each = local.host_keys

  zone_id = var.cloudflare_zone_id
  name    = var.hosts[each.key].fqdn
  type    = "AAAA"
  content = local.host_ipv6[each.key]
  proxied = false
  ttl     = 300
}

# One access list per cluster, owning the whole list. allow_list is a set in the provider, so the
# order above doesn't matter to the API; each entry must be in the CIDR form the API stores.
resource "linode_database_access_controls" "db" {
  for_each = local.database_keys

  # Not sensitive: an imported list's ID never is, and a sensitivity change alone would turn the
  # first import's plan from a no-op into an update. No workflow prints it.
  database_id   = tonumber(nonsensitive(var.database_ids[each.key]))
  database_type = "postgresql"
  allow_list    = concat(local.host_access, var.db_allow_extra)

  lifecycle {
    # Deleting this resource empties the cluster's access list and cuts production off.
    # Retiring a cluster is a deliberate `tofu state rm` after the cluster itself is deleted.
    prevent_destroy = true
  }
}

# The access lists already exist: the first apply adopts each one. Once a list is in state, its
# import block does nothing. The provider's import ID is "<database id>:<database type>".
# OpenTofu refuses a sensitive import ID; a database ID is no credential, and no workflow prints
# the plan's text, where it would appear.
import {
  for_each = local.database_keys

  to = linode_database_access_controls.db[each.key]
  id = nonsensitive("${var.database_ids[each.key]}:postgresql")
}
