# The module's inputs (2.36.0, issue #62). The real values are the TOFU_VARS secret, the same in
# the `infra-plan` and `infra` environments: one JSON tfvars document, whose shape
# ops/tofu/examples/example.tfvars.json shows with placeholders. The state passphrase comes from
# TF_VAR_state_passphrase instead.
#
# Every variable is sensitive, so OpenTofu never prints a value in a plan, and every validation
# message is fixed text that never echoes one. Two things do reach the public Actions log on
# purpose: the map keys of `hosts` and `database_ids` (they are part of resource addresses such as
# linode_instance.host["staging"]) and each host's role. Their patterns below keep them to a few
# public-safe words. Literal dollars in a pattern are written [$], because HCL has no \$ escape,
# and dots [.], because \. is not an HCL string escape either.

variable "hosts" {
  description = "The hosts to build, by a public key: staging or production, optionally followed by -N."
  type = map(object({
    # The Linode's label, which the Cloud Firewall's label is derived from.
    label = string
    # The host's DNS name; its first label is the hostname. OpenTofu writes its A and AAAA records.
    fqdn = string
    # A Linode region and plan type, such as us-east and g6-standard-1.
    region = string
    type   = string
    # staging or production: which Configure key goes on the host, and which environment deploys it.
    role = string
  }))
  default   = {}
  nullable  = false
  sensitive = true

  # Keys appear in public logs as part of resource addresses, so they are limited to the role and
  # an optional number, and the role must match the key.
  validation {
    condition = alltrue([
      for k, h in var.hosts : can(regex("^(staging|production)(-[0-9]{1,2})?$", k)) && split("-", k)[0] == h.role
    ])
    error_message = "Every hosts key must be staging or production, optionally followed by -N (one or two digits), and its role must equal the key's part before -N."
  }

  # A label is the Linode's display name inside the account, not a DNS name or an address, and
  # infra.yml doesn't mask it (don't put the domain in one). Linode's rules, kept to lowercase and
  # '-': 3 to 64 characters, starting and ending with a letter or digit, no doubled '-'. That also
  # keeps the firewall label derived from it (main.tf) within Linode's rules.
  validation {
    condition = alltrue([
      for h in values(var.hosts) : can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label)) && !strcontains(h.label, "--")
    ])
    error_message = "Every host label must be 3 to 64 characters of a-z, 0-9 and '-', start and end with a letter or digit, and hold no doubled '-'."
  }

  validation {
    condition     = length(distinct([for h in values(var.hosts) : h.label])) == length(var.hosts)
    error_message = "Host labels must be unique."
  }

  # A lowercase DNS name with at least two labels (host.example.org), at most 253 characters.
  validation {
    condition = alltrue([
      for h in values(var.hosts) : (
        can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", h.fqdn))
        && length(h.fqdn) <= 253
      )
    ])
    error_message = "Every host fqdn must be a lowercase DNS name with at least two labels."
  }

  validation {
    condition     = length(distinct([for h in values(var.hosts) : h.fqdn])) == length(var.hosts)
    error_message = "Host fqdns must be unique."
  }

  validation {
    condition = alltrue([
      for h in values(var.hosts) : can(regex("^[a-z0-9-]{2,32}$", h.region)) && can(regex("^[a-z0-9-]{2,64}$", h.type))
    ])
    error_message = "Every host region and type must be a Linode identifier of a-z, 0-9 and '-'."
  }
}

variable "root_keys" {
  description = "Root's SSH keys on every host: the owner's FIDO2 key with verify-required, and an optional operator key."
  type        = list(string)
  nullable    = false
  sensitive   = true

  # An optional verify-required option, the key type, the base64 key and an optional comment,
  # on one line of printable ASCII. cloud-init writes these; sshd enforces verify-required itself
  # (cloud-init.yaml.tftpl).
  validation {
    condition = length(var.root_keys) > 0 && alltrue([
      for k in var.root_keys : can(regex("^(verify-required )?(ssh-ed25519|sk-ssh-ed25519@openssh[.]com) AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$", k))
    ])
    error_message = "root_keys must hold at least one key, each an optional verify-required, then ssh-ed25519 or sk-ssh-ed25519@openssh.com, the base64 key and an optional comment, on one line."
  }
}

variable "configure_keys" {
  description = "The public half of each role's ANSIBLE_SSH_KEY, the key host.yml's Configure step logs in with as root."
  type        = map(string)
  nullable    = false
  sensitive   = true

  validation {
    condition = alltrue([
      for role, k in var.configure_keys : contains(["staging", "production"], role) && can(regex("^ssh-ed25519 AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$", k))
    ])
    error_message = "configure_keys must map staging or production to one ssh-ed25519 public key line."
  }
}

variable "root_password_hash" {
  description = "Root's console password as a yescrypt or SHA-512 crypt hash, or empty to lock root's password."
  type        = string
  default     = ""
  nullable    = false
  sensitive   = true

  # The pattern of the parked 2.36.0's tb_root_password_hash_pattern (56a9ba0), with [$] for $.
  validation {
    condition     = var.root_password_hash == "" || can(regex("^([$]y[$][./0-9A-Za-z]+[$][./0-9A-Za-z]{1,86}[$][./0-9A-Za-z]{43}|[$]6[$](rounds=[1-9][0-9]{3,8}[$])?[./0-9A-Za-z]{1,16}[$][./0-9A-Za-z]{86})$", var.root_password_hash))
    error_message = "root_password_hash must be empty, or one yescrypt ($y$) or SHA-512 ($6$) crypt hash."
  }
}

variable "cloudflare_zone_id" {
  description = "The Cloudflare zone that holds the hosts' A and AAAA records."
  type        = string
  nullable    = false
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be 32 lowercase hexadecimal characters."
  }
}

variable "database_ids" {
  description = "The managed PostgreSQL clusters whose access lists this module owns, by a short public name (primary)."
  type        = map(string)
  nullable    = false
  sensitive   = true

  # The keys appear in public logs as linode_database_access_controls.db["<key>"]; the IDs never do.
  validation {
    condition = alltrue([
      for k, id in var.database_ids : can(regex("^[a-z]{1,16}$", k)) && can(regex("^[0-9]{1,20}$", id))
    ])
    error_message = "database_ids keys must be 1 to 16 lowercase letters, and every value a numeric Linode database ID."
  }
}

# Existing clusters are opt-in adoption inputs, never inferred settings for a new database.
# Pinned Linode v4.5.0 schema: databasepostgresqlv2/framework_resource_schema.go at
# c77ffd4d69cde96fb01b9bf83f6506e5cab957a4. SSL and encryption are computed assertions;
# allow_list remains exclusively owned by linode_database_access_controls.db.
variable "existing_databases" {
  description = "Private recorded settings of existing clusters to import, keyed by database_ids; empty preserves access-list-only management."
  type = map(object({
    label                   = string
    engine_id               = string
    region                  = string
    type                    = string
    cluster_size            = number
    suspended               = bool
    expected_encrypted      = bool
    expected_ssl_connection = bool
    updates = object({
      day_of_week = number
      duration    = number
      frequency   = string
      hour_of_day = number
    })
    # Require an explicit null for a cluster outside a private network; no inferred network.
    private_network = object({
      vpc_id        = number
      subnet_id     = number
      public_access = bool
    })
    # Every supported Optional+Computed engine setting is nullable. Omission converts to null,
    # preserving provider-imported values; the owner still records all current configured overrides.
    engine_config = object({
      engine_config_pg_autovacuum_analyze_scale_factor          = optional(number)
      engine_config_pg_autovacuum_analyze_threshold             = optional(number)
      engine_config_pg_autovacuum_max_workers                   = optional(number)
      engine_config_pg_autovacuum_naptime                       = optional(number)
      engine_config_pg_autovacuum_vacuum_cost_delay             = optional(number)
      engine_config_pg_autovacuum_vacuum_cost_limit             = optional(number)
      engine_config_pg_autovacuum_vacuum_scale_factor           = optional(number)
      engine_config_pg_autovacuum_vacuum_threshold              = optional(number)
      engine_config_pg_bgwriter_delay                           = optional(number)
      engine_config_pg_bgwriter_flush_after                     = optional(number)
      engine_config_pg_bgwriter_lru_maxpages                    = optional(number)
      engine_config_pg_bgwriter_lru_multiplier                  = optional(number)
      engine_config_pg_deadlock_timeout                         = optional(number)
      engine_config_pg_default_toast_compression                = optional(string)
      engine_config_pg_idle_in_transaction_session_timeout      = optional(number)
      engine_config_pg_jit                                      = optional(bool)
      engine_config_pg_max_files_per_process                    = optional(number)
      engine_config_pg_max_locks_per_transaction                = optional(number)
      engine_config_pg_max_logical_replication_workers          = optional(number)
      engine_config_pg_max_parallel_workers                     = optional(number)
      engine_config_pg_max_parallel_workers_per_gather          = optional(number)
      engine_config_pg_max_pred_locks_per_transaction           = optional(number)
      engine_config_pg_max_replication_slots                    = optional(number)
      engine_config_pg_max_slot_wal_keep_size                   = optional(number)
      engine_config_pg_max_stack_depth                          = optional(number)
      engine_config_pg_max_standby_archive_delay                = optional(number)
      engine_config_pg_max_standby_streaming_delay              = optional(number)
      engine_config_pg_max_wal_senders                          = optional(number)
      engine_config_pg_max_worker_processes                     = optional(number)
      engine_config_pg_password_encryption                      = optional(string)
      engine_config_pg_pg_partman_bgw_interval                  = optional(number)
      engine_config_pg_pg_partman_bgw_role                      = optional(string)
      engine_config_pg_pg_stat_monitor_pgsm_enable_query_plan   = optional(bool)
      engine_config_pg_pg_stat_monitor_pgsm_max_buckets         = optional(number)
      engine_config_pg_pg_stat_statements_track                 = optional(string)
      engine_config_pg_temp_file_limit                          = optional(number)
      engine_config_pg_timezone                                 = optional(string)
      engine_config_pg_track_activity_query_size                = optional(number)
      engine_config_pg_track_commit_timestamp                   = optional(string)
      engine_config_pg_track_functions                          = optional(string)
      engine_config_pg_track_io_timing                          = optional(string)
      engine_config_pg_wal_sender_timeout                       = optional(number)
      engine_config_pg_wal_writer_delay                         = optional(number)
      engine_config_pg_stat_monitor_enable                      = optional(bool)
      engine_config_pglookout_max_failover_replication_time_lag = optional(number)
      engine_config_shared_buffers_percentage                   = optional(number)
      engine_config_work_mem                                    = optional(number)
    })
  }))
  default   = {}
  nullable  = false
  sensitive = true

  validation {
    condition = alltrue([
      for k, d in var.existing_databases : can(regex("^[a-z]{1,16}$", k)) && contains(keys(var.database_ids), k)
    ])
    error_message = "Every existing_databases key must be a public-safe database_ids key."
  }

  validation {
    condition = length(distinct([
      for k in keys(var.existing_databases) : try(var.database_ids[k], "")
    ])) == length(var.existing_databases)
    error_message = "Existing database adoption keys must refer to distinct clusters."
  }

  validation {
    condition = alltrue([
      for d in values(var.existing_databases) : try(
        d != null && length(trimspace(d.label)) > 0
        && can(regex("^postgresql/[0-9][0-9A-Za-z._-]*$", d.engine_id))
        && length(trimspace(d.region)) > 0 && length(trimspace(d.type)) > 0
        && d.cluster_size >= 1 && floor(d.cluster_size) == d.cluster_size
        && d.suspended != null && d.expected_encrypted != null && d.expected_ssl_connection != null
        && d.engine_config != null,
        false
      )
    ])
    error_message = "Existing clusters require explicit nonempty identity/settings, an integral positive cluster_size, suspension/security observations and an engine_config object."
  }

  validation {
    condition = alltrue([
      for d in values(var.existing_databases) : try(
        d.updates.day_of_week >= 1 && d.updates.day_of_week <= 7 && floor(d.updates.day_of_week) == d.updates.day_of_week
        && d.updates.duration > 0 && floor(d.updates.duration) == d.updates.duration
        && d.updates.frequency == "weekly"
        && d.updates.hour_of_day >= 0 && d.updates.hour_of_day <= 23 && floor(d.updates.hour_of_day) == d.updates.hour_of_day,
        false
      )
    ])
    error_message = "Existing clusters require an explicit weekly maintenance window with day 1-7, an integral positive duration and hour 0-23."
  }

  validation {
    condition = alltrue([
      for d in values(var.existing_databases) : try(
        d.private_network == null ? true : (
          d.private_network.vpc_id > 0 && floor(d.private_network.vpc_id) == d.private_network.vpc_id
          && d.private_network.subnet_id > 0 && floor(d.private_network.subnet_id) == d.private_network.subnet_id
          && d.private_network.public_access != null
        ),
        false
      )
    ])
    error_message = "Every recorded private_network must be explicitly null or hold positive integral VPC/subnet IDs and an explicit public_access flag."
  }
}

variable "db_allow_extra" {
  description = "Access-list entries that aren't OpenTofu hosts, in the CIDR form the Linode API stores (198.51.100.10/32)."
  type        = list(string)
  default     = []
  nullable    = false
  sensitive   = true

  # An explicit prefix length is required: the API stores CIDR entries, and an entry written any
  # other way would show as a change on every plan.
  validation {
    condition = alltrue([
      for x in var.db_allow_extra : can(cidrhost(x, 0)) && strcontains(x, "/")
    ])
    error_message = "Every db_allow_extra entry must be an IPv4 or IPv6 CIDR with an explicit prefix length."
  }
}

variable "state_passphrase" {
  description = "The passphrase state and plan encryption derive their key from (TF_VAR_state_passphrase)."
  type        = string
  nullable    = false
  sensitive   = true

  # At least 32 characters: it is the only key to the saved plan, which infra.yml keeps as a
  # one-day artifact that anyone signed in to GitHub can download from the public repository.
  validation {
    condition     = length(var.state_passphrase) >= 32
    error_message = "state_passphrase must be at least 32 characters."
  }
}
