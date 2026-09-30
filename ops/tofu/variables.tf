# The module's inputs (2.36.0, issue #62; prod names since 2.37.0). The real values are the
# TOFU_VARS secret, which only the `infra-plan` environment holds: one JSON tfvars document, whose
# shape ops/tofu/examples/example.tfvars.json shows with placeholders. Deploy's Infrastructure plan
# job plans with it, and the approving `prod` job reads the same values back from the encrypted
# saved plan (ops/tofu/ci/tofu-ci.sh adopt), so there is no second copy. The state passphrase
# comes from TF_VAR_state_passphrase instead.
#
# Every variable is sensitive, so OpenTofu never prints a value in a plan, and every validation
# message is fixed text that never echoes one. Two things do reach the public Actions log on
# purpose: the map keys of `hosts` and `database_ids` (they are part of resource addresses such as
# linode_instance.host["staging"]) and each host's role. Their patterns below keep them to a few
# public-safe words. Literal dollars in a pattern are written [$], because HCL has no \$ escape,
# and dots [.], because \. is not an HCL string escape either.

variable "hosts" {
  description = "The hosts to build, by a public key: staging or prod, optionally followed by -N."
  type = map(object({
    # The Linode's label, which the Cloud Firewall's label is derived from.
    label = string
    # The host's DNS name; its first label is the hostname. OpenTofu writes its A and AAAA records.
    fqdn = string
    # A Linode region and plan type, such as us-east and g6-standard-1.
    region = string
    type   = string
    # staging or prod: which Configure key goes on the host, and which environment deploys it.
    role = string
  }))
  default   = {}
  nullable  = false
  sensitive = true

  # Keys appear in public logs as part of resource addresses, so they are limited to the role and
  # an optional number, and the role must match the key.
  validation {
    condition = alltrue([
      for k, h in var.hosts : can(regex("^(staging|prod)(-[0-9]{1,2})?$", k)) && split("-", k)[0] == h.role
    ])
    error_message = "Every hosts key must be staging or prod, optionally followed by -N (one or two digits), and its role must equal the key's part before -N."
  }

  # A label is the Linode's display name inside the account, not a DNS name or an address, and
  # no workflow masks it (don't put the domain in one). Linode's rules, kept to lowercase and
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
  description = "The public half of each role's ANSIBLE_SSH_KEY, the key Deploy's host job (host.yml) logs in with as root."
  type        = map(string)
  nullable    = false
  sensitive   = true

  validation {
    condition = alltrue([
      for role, k in var.configure_keys : contains(["staging", "prod"], role) && can(regex("^ssh-ed25519 AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$", k))
    ])
    error_message = "configure_keys must map staging or prod to one ssh-ed25519 public key line."
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

  # At least 32 characters: it is the only key to the saved plan, which Deploy's Infrastructure
  # plan job keeps as a one-day artifact that anyone signed in to GitHub can download from the
  # public repository.
  validation {
    condition     = length(var.state_passphrase) >= 32
    error_message = "state_passphrase must be at least 32 characters."
  }
}
