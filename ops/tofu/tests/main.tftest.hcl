# OpenTofu's own tests of the module (2.36.0, issue #62), run by CI's "Infrastructure checks" job:
#
#   tofu -chdir=ops/tofu test -var-file=examples/example.tfvars.json
#
# with TF_VAR_state_passphrase set to a throwaway. The providers are mocked, so nothing here needs
# a token or the network beyond the provider download, and every run is a plan. They pin:
#   - the user data: the example host's rendering equals examples/user-data-without-hash.yaml,
#     and with the example hash examples/user-data-with-hash.yaml, byte for byte (CI runs
#     `cloud-init schema` over those two files, so the schema check covers what the module sends);
#   - no rendering carries a host key or any private key, and every one seeds verify-required;
#   - the instance's settings, the firewall's rules and the unproxied records;
#   - each access list: exactly the hosts' CIDR entries plus db_allow_extra (a set, so membership);
#   - the validations and the Configure-key precondition refuse bad values.

# The addresses a mocked Linode reports, from the documentation ranges. The provider reports the
# IPv6 SLAAC address with its /128, as the Linode API does. Firewall IDs are numbers in the API,
# and the instance takes one, so the mock's must parse as one.
mock_provider "linode" {
  override_resource {
    target = linode_instance.host
    values = {
      ipv4 = ["192.0.2.10"]
      ipv6 = "2001:db8:1::10/128"
    }
  }
  override_resource {
    target = linode_firewall.host
    values = {
      id = "1001"
    }
  }
}

mock_provider "cloudflare" {}

# `tofu test` can't import (its providers refuse ImportResourceState), and every configured
# cluster has an import block, so the runs plan with no cluster. The access list's entries are
# checked through local.host_access, and tests/unit/infra.test.ts pins the resource's wiring and
# its import block.
variables {
  state_passphrase = "tofu-test-only-throwaway-passphrase"
  database_ids     = {}
}

run "the_example_host" {
  command = plan

  assert {
    condition     = base64decode(linode_instance.host["staging"].metadata[0].user_data) == file("examples/user-data-without-hash.yaml")
    error_message = "The example host's user data must equal examples/user-data-without-hash.yaml."
  }

  # The template must never carry a host key (cloud-init's ssh_keys) or any private key, and
  # must always seed sshd's verify-required, since cloud-init drops the option from root's keys.
  assert {
    condition = alltrue([
      for k, i in linode_instance.host : (
        !strcontains(base64decode(i.metadata[0].user_data), "ssh_keys")
        && !strcontains(base64decode(i.metadata[0].user_data), "PRIVATE KEY")
        && strcontains(base64decode(i.metadata[0].user_data), "\n      PubkeyAuthOptions verify-required\n")
      )
    ])
    error_message = "User data must hold no host key or private key, and must seed PubkeyAuthOptions verify-required."
  }

  assert {
    condition = (
      linode_instance.host["staging"].image == "linode/almalinux10"
      && linode_instance.host["staging"].disk_encryption == "enabled"
      && linode_instance.host["staging"].booted == true
      && linode_instance.host["staging"].interface_generation == "legacy_config"
      && length(linode_instance.host["staging"].interface) == 1
      && linode_instance.host["staging"].interface[0].purpose == "public"
      && linode_instance.host["staging"].firewall_id == 1001
      && linode_instance.host["staging"].label == "tarubot-staging"
    )
    error_message = "The instance must be AlmaLinux 10 with disk encryption, booted, on one pinned public interface, behind its own firewall."
  }

  # cloud-init is the only writer of root's keys: the Linode gets only a throwaway password,
  # which uuid() leaves unknown until apply (tests/unit/infra.test.ts pins its expression).
  assert {
    condition = (
      linode_instance.host["staging"].authorized_keys == null
      && linode_instance.host["staging"].authorized_users == null
    )
    error_message = "The instance must carry no authorized_keys or authorized_users."
  }

  assert {
    condition = (
      linode_firewall.host["staging"].label == "tarubot-staging-fw"
      && linode_firewall.host["staging"].inbound_policy == "DROP"
      && linode_firewall.host["staging"].outbound_policy == "ACCEPT"
      && length(linode_firewall.host["staging"].inbound) == 3
    )
    error_message = "The firewall must drop inbound by default, accept outbound, and hold exactly three inbound rules."
  }

  assert {
    condition = anytrue([
      for r in linode_firewall.host["staging"].inbound : (
        r.action == "ACCEPT" && r.protocol == "TCP" && r.ports == "22"
        && r.ipv4 == tolist(["0.0.0.0/0"]) && r.ipv6 == tolist(["::/0"])
      )
    ])
    error_message = "The firewall must accept TCP 22 from every IPv4 and IPv6 address."
  }

  assert {
    condition = (
      anytrue([for r in linode_firewall.host["staging"].inbound : r.protocol == "ICMP" && r.ipv4 == tolist(["0.0.0.0/0"])])
      && anytrue([for r in linode_firewall.host["staging"].inbound : r.protocol == "ICMP" && r.ipv6 == tolist(["::/0"])])
    )
    error_message = "The firewall must accept ICMP over IPv4 and ICMPv6."
  }

  assert {
    condition = (
      cloudflare_dns_record.a["staging"].name == "staging.example.org"
      && cloudflare_dns_record.a["staging"].type == "A"
      && cloudflare_dns_record.a["staging"].content == "192.0.2.10"
      && cloudflare_dns_record.a["staging"].proxied == false
      && cloudflare_dns_record.a["staging"].ttl == 300
      && cloudflare_dns_record.aaaa["staging"].name == "staging.example.org"
      && cloudflare_dns_record.aaaa["staging"].type == "AAAA"
      && cloudflare_dns_record.aaaa["staging"].content == "2001:db8:1::10"
      && cloudflare_dns_record.aaaa["staging"].proxied == false
      && cloudflare_dns_record.aaaa["staging"].ttl == 300
    )
    error_message = "The A and AAAA records must name the host's fqdn, carry its bare addresses, and be unproxied with a 300 s TTL."
  }

  # allow_list is a set in the provider: the test compares membership, not order.
  assert {
    condition = toset(concat(local.host_access, var.db_allow_extra)) == toset([
      "2001:db8:1::10/128",
      "192.0.2.10/32",
      "2001:db8:5::10/128",
      "198.51.100.10/32",
    ])
    error_message = "The access list must hold exactly the host's IPv6 /128 and IPv4 /32 entries plus db_allow_extra."
  }

  assert {
    condition     = length(linode_database_access_controls.db) == 0
    error_message = "With no cluster configured, the module must plan no access list."
  }

  assert {
    condition     = output.hosts == { staging = "staging" }
    error_message = "The hosts output must map each host key to its role."
  }
}

run "the_example_host_with_a_root_hash" {
  command = plan

  variables {
    # Obviously fake, and shaped like a yescrypt hash so the validation accepts it.
    root_password_hash = "$y$j9T$EXAMPLE.SALT.ONLY$EXAMPLE.HASH.NOT.A.REAL.PASSWORD.EXAMPLE..."
  }

  assert {
    condition     = base64decode(linode_instance.host["staging"].metadata[0].user_data) == file("examples/user-data-with-hash.yaml")
    error_message = "With the example hash, the user data must equal examples/user-data-with-hash.yaml."
  }
}

# Two hosts and no extra entries: the list is every host's IPv6 /128 and IPv4 /32, nothing else,
# and each host's firewall label fits Linode's 32 characters: the production label's first 29
# characters end in '-', which is dropped before "-fw" is added.
run "two_hosts_share_the_access_list" {
  command = plan

  variables {
    hosts = {
      staging = {
        label  = "tarubot-staging"
        fqdn   = "staging.example.org"
        region = "us-east"
        type   = "g6-standard-1"
        role   = "staging"
      }
      production = {
        label  = "tarubot-production-long-name-01"
        fqdn   = "production.example.org"
        region = "us-east"
        type   = "g6-standard-2"
        role   = "production"
      }
    }
    configure_keys = {
      staging    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0002 configure-staging"
      production = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0003 configure-production"
    }
    db_allow_extra = []
  }

  assert {
    # The mock gives both hosts the same addresses, so the set holds two entries.
    condition     = toset(concat(local.host_access, var.db_allow_extra)) == toset(["2001:db8:1::10/128", "192.0.2.10/32"])
    error_message = "With no extra entries, the access list must hold only the hosts' entries."
  }

  assert {
    condition = (
      linode_firewall.host["production"].label == "tarubot-production-long-name-fw"
      && length(linode_firewall.host["production"].label) <= 32
    )
    error_message = "A long host label must be cut to fit the firewall's 32 characters."
  }

  assert {
    condition     = strcontains(base64decode(linode_instance.host["production"].metadata[0].user_data), "configure-production")
    error_message = "Each host must get its own role's Configure key."
  }
}

# ---- Refusals: each run overrides one value and expects its validation to fail. ----

run "refuses_a_host_key_outside_the_pattern" {
  command = plan
  variables {
    hosts = {
      stage = { label = "tarubot-stage", fqdn = "stage.example.org", region = "us-east", type = "g6-standard-1", role = "staging" }
    }
  }
  expect_failures = [var.hosts]
}

run "refuses_a_role_that_differs_from_its_key" {
  command = plan
  variables {
    hosts = {
      staging = { label = "tarubot-staging", fqdn = "staging.example.org", region = "us-east", type = "g6-standard-1", role = "production" }
    }
  }
  expect_failures = [var.hosts]
}

run "refuses_a_short_label" {
  command = plan
  variables {
    hosts = {
      staging = { label = "tb", fqdn = "staging.example.org", region = "us-east", type = "g6-standard-1", role = "staging" }
    }
  }
  expect_failures = [var.hosts]
}

run "refuses_a_doubled_hyphen_in_a_label" {
  command = plan
  variables {
    hosts = {
      staging = { label = "tarubot--staging", fqdn = "staging.example.org", region = "us-east", type = "g6-standard-1", role = "staging" }
    }
  }
  expect_failures = [var.hosts]
}

run "refuses_a_one_label_fqdn" {
  command = plan
  variables {
    hosts = {
      staging = { label = "tarubot-staging", fqdn = "staging", region = "us-east", type = "g6-standard-1", role = "staging" }
    }
  }
  expect_failures = [var.hosts]
}

run "refuses_a_database_key_outside_the_pattern" {
  command = plan
  variables {
    database_ids = { "db-1" = "0" }
  }
  expect_failures = [var.database_ids]
}

run "refuses_an_extra_entry_without_a_prefix_length" {
  command = plan
  variables {
    db_allow_extra = ["198.51.100.10"]
  }
  expect_failures = [var.db_allow_extra]
}

run "refuses_an_extra_entry_that_is_not_an_address" {
  command = plan
  variables {
    db_allow_extra = ["staging.example.org/32"]
  }
  expect_failures = [var.db_allow_extra]
}

run "refuses_a_malformed_root_hash" {
  command = plan
  variables {
    root_password_hash = "$1$EXAMPLE$not.a.supported.hash"
  }
  expect_failures = [var.root_password_hash]
}

run "refuses_a_root_key_with_other_options" {
  command = plan
  variables {
    root_keys = ["no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0001 owner-operator"]
  }
  expect_failures = [var.root_keys]
}

run "refuses_a_configure_key_that_is_not_ssh_ed25519" {
  command = plan
  variables {
    configure_keys = {
      staging = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tEXAMPLE configure-staging"
    }
  }
  expect_failures = [var.configure_keys]
}

# One character short of the 32 the saved plan's public artifact calls for.
run "refuses_a_short_state_passphrase" {
  command = plan
  variables {
    state_passphrase = "a-31-character-throwaway-phrase"
  }
  expect_failures = [var.state_passphrase]
}

# A host whose role has no Configure key: the instance's precondition refuses the plan.
run "refuses_a_host_without_its_configure_key" {
  command = plan
  variables {
    configure_keys = {
      production = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0003 configure-production"
    }
  }
  expect_failures = [linode_instance.host]
}
