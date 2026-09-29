# The module's outputs (2.36.0, issue #62). No workflow reads them: infra.yml prints only the
# plan's actions, resource addresses and access-list counts. They are for a hand run
# (README.md, "A hand run").

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
