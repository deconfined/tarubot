# Native credential-free tests of the selected resource schemas and exact cloud-init renderings.
# Mock addresses/IDs are invented; successful mocks do not prove image availability or OVH access.
mock_provider "openstack" {
  override_resource {
    target = openstack_compute_instance_v2.host
    values = {
      id           = "00000000-0000-0000-0000-000000000040"
      access_ip_v4 = "192.0.2.10"
      access_ip_v6 = "2001:db8:1::10"
    }
  }
}
mock_provider "ovh" {}
mock_provider "cloudflare" {}
variables {
  state_passphrase = "tofu-test-only-throwaway-passphrase"
}
run "selected_stack" {
  command = plan
  assert {
    condition     = openstack_compute_instance_v2.host["staging"].user_data == file("examples/user-data-without-hash.yaml")
    error_message = "The module must render the reviewed cloud-init example exactly."
  }
  assert {
    condition = (
      openstack_compute_instance_v2.host["staging"].region == "US-EAST-VA-1"
      && openstack_compute_instance_v2.host["staging"].image_id == var.hosts["staging"].image_id
      && openstack_compute_instance_v2.host["staging"].flavor_id == var.hosts["staging"].flavor_id
      && openstack_compute_instance_v2.host["staging"].network[0].uuid == var.hosts["staging"].network_id
      && openstack_compute_instance_v2.host["staging"].power_state == "active"
      && openstack_compute_instance_v2.host["staging"].config_drive
      && openstack_compute_instance_v2.host["staging"].key_pair == null
      && openstack_compute_instance_v2.host["staging"].admin_pass == null
      && length(openstack_compute_instance_v2.host["staging"].block_device) == 0
    )
    error_message = "The host must use the pinned US image/flavor/public network and local disk, with cloud-init alone seeding access."
  }
  assert {
    condition = (
      openstack_networking_secgroup_v2.host["staging"].delete_default_rules
      && openstack_networking_secgroup_v2.host["staging"].stateful
      && length(openstack_networking_secgroup_rule_v2.host) == 6
      && openstack_networking_secgroup_rule_v2.host["staging-ssh4"].port_range_min == 22
      && openstack_networking_secgroup_rule_v2.host["staging-ssh6"].port_range_max == 22
      && openstack_networking_secgroup_rule_v2.host["staging-icmp6"].protocol == "ipv6-icmp"
    )
    error_message = "The firewall must remove defaults and allow only SSH/ICMP ingress and explicit dual-stack egress."
  }
  assert {
    condition = (
      ovh_cloud_project_database.cluster["primary"].engine == "postgresql"
      && ovh_cloud_project_database.cluster["primary"].plan == "essential"
      && length(ovh_cloud_project_database.cluster["primary"].nodes) == 1
      && ovh_cloud_project_database.cluster["primary"].nodes[0].region == "US-EAST-VA"
      && ovh_cloud_project_database.cluster["primary"].deletion_protection
      && toset([for r in ovh_cloud_project_database.cluster["primary"].ip_restrictions : r.ip]) == toset(concat(local.host_access, var.db_allow_extra))
    )
    error_message = "The NEW Essential service must have one selected-region node, deletion protection and the complete restriction set."
  }
  assert {
    condition = (
      !cloudflare_dns_record.a["staging"].proxied && !cloudflare_dns_record.aaaa["staging"].proxied
      && cloudflare_dns_record.a["staging"].ttl == 300 && cloudflare_dns_record.aaaa["staging"].ttl == 300
      && !strcontains(openstack_compute_instance_v2.host["staging"].user_data, "PRIVATE KEY")
      && !strcontains(openstack_compute_instance_v2.host["staging"].user_data, "ssh_keys")
      && strcontains(openstack_compute_instance_v2.host["staging"].user_data, "PubkeyAuthOptions verify-required")
    )
    error_message = "DNS must be unproxied; user data may contain public access keys, never seeded host/private keys."
  }
}
run "with_console_hash" {
  command = plan
  variables {
    root_password_hash = "$y$j9T$EXAMPLE.SALT.ONLY$EXAMPLE.HASH.NOT.A.REAL.PASSWORD.EXAMPLE..."
  }
  assert {
    condition     = openstack_compute_instance_v2.host["staging"].user_data == file("examples/user-data-with-hash.yaml")
    error_message = "The console-hash rendering must match its reviewed schema-checked example."
  }
}
run "empty_baseline" {
  command = plan
  variables {
    hosts     = {}
    databases = {}
  }
  assert {
    condition     = length(openstack_compute_instance_v2.host) == 0 && length(ovh_cloud_project_database.cluster) == 0
    error_message = "An empty input baseline must not provision a host or database."
  }
}
run "bad_project" {
  command = plan
  variables { ovh_project_id = "invalid" }
  expect_failures = [var.ovh_project_id]
}
run "bad_key" {
  command = plan
  variables { root_keys = ["private-or-invalid-key"] }
  expect_failures = [var.root_keys]
}
run "short_passphrase" {
  command = plan
  variables { state_passphrase = "short" }
  expect_failures = [var.state_passphrase]
}
run "missing_configure_key" {
  command = plan
  variables { configure_keys = {} }
  expect_failures = [openstack_compute_instance_v2.host["staging"]]
}

# Validate private settings through the native module as well as through the Bun adapters.
run "bad_tenant" {
  command = plan
  variables { openstack_project_id = "invalid" }
  expect_failures = [var.openstack_project_id]
}
run "bad_console_hash" {
  command = plan
  variables { root_password_hash = "not-a-console-hash" }
  expect_failures = [var.root_password_hash]
}
run "bad_extra_cidr" {
  command = plan
  variables { db_allow_extra = ["192.0.2.1/33"] }
  expect_failures = [var.db_allow_extra]
}
run "bad_configure_key" {
  command = plan
  variables { configure_keys = { staging = "not-a-public-key" } }
  expect_failures = [var.configure_keys]
}
run "bad_image" {
  command = plan
  variables {
    hosts = {
      staging = {
        label      = "example-staging"
        fqdn       = "staging.example.org"
        role       = "staging"
        image_id   = "almalinux"
        flavor_id  = "00000000-0000-0000-0000-000000000020"
        network_id = "00000000-0000-0000-0000-000000000030"
      }
    }
  }
  expect_failures = [var.hosts]
}
run "bad_database_size" {
  command = plan
  variables {
    databases = {
      primary = {
        description      = "Invented PostgreSQL service"
        version          = "17"
        flavor           = "example-database-flavor"
        disk_size_gb     = 1.5
        backup_time      = "02:00:00"
        maintenance_time = "03:00:00"
      }
    }
  }
  expect_failures = [var.databases]
}
