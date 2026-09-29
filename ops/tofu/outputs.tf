# The original Infrastructure workflow prints only plan actions and access-list counts. The
# environment pipeline reads the sensitive connection output into a private file after apply.

# Each host's role, by key. Both are public words (variables.tf keeps them so), so this output
# is not sensitive.
output "hosts" {
  description = "Each host's role, by host key."
  value       = { for k in local.host_keys : k => nonsensitive(var.hosts[k].role) }
}

# Each host's public addresses. Sensitive: the repository and its Actions logs are public, and
# the addresses lead straight to the host names.
output "addresses" {
  description = "Each host's public IPv4 and IPv6 address (without the /128), by host key."
  sensitive   = true
  value = {
    for k in local.host_keys : k => {
      ipv4 = local.host_ipv4[k]
      ipv6 = local.host_ipv6[k]
    }
  }
}

# The environment pipeline consumes this privately on the same runner after apply. The stable
# instance identity distinguishes an explicit replacement from an unexpected SSH key change.
output "host_connection" {
  description = "Private connection details for Ansible and durable SSH host-key pinning."
  sensitive   = true
  value = {
    for k in local.host_keys : k => {
      instance_id = tostring(linode_instance.host[k].id)
      address     = local.host_ipv4[k]
    }
  }
}
