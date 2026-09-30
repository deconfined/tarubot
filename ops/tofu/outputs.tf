# The module's outputs (2.36.0, issue #62; host_connection since 2.37.0). No workflow prints them:
# the Deploy workflow prints only the plan's actions, resource addresses and access-list counts.

# Each host's role, by key. Both are public words (variables.tf keeps them so), so this output
# is not sensitive.
output "hosts" {
  description = "Each host's role, by host key."
  value       = { for k in local.host_keys : k => nonsensitive(var.hosts[k].role) }
}

# Each host's Linode instance ID and public addresses. The approving `prod` job reads it into a
# private file (ops/tofu/ci/tofu-ci.sh output) for ops/tofu/ci/host.sh pin, which keys each host's
# pin by the instance ID, so a rebuilt host is told apart from a changed key, and stores the
# addresses so every later job connects without OpenTofu, IPv6 first. Sensitive: the repository
# and its Actions logs are public, and the addresses lead straight to the host names. The ID is a
# string, as host.sh compares it; the IPv6 address is bare, without the API's /128.
output "host_connection" {
  description = "Each host's Linode instance ID, bare IPv6 address and IPv4 address, by host key."
  sensitive   = true
  value = {
    for k in local.host_keys : k => {
      instance_id = tostring(linode_instance.host[k].id)
      ipv6        = local.host_ipv6[k]
      ipv4        = local.host_ipv4[k]
    }
  }
}
