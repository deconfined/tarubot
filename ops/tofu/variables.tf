# Private OVH US inputs. Every variable is sensitive; only validated map keys reach public
# resource addresses. No account image, flavor or database setting is inferred.
variable "hosts" {
  type = map(object({
    label      = string
    fqdn       = string
    role       = string
    image_id   = string
    flavor_id  = string
    network_id = string
  }))
  default   = {}
  nullable  = false
  sensitive = true
  validation {
    condition = alltrue([for k, h in var.hosts :
      can(regex("^(staging|production)(-[0-9]{1,2})?$", k)) && split("-", k)[0] == h.role
    ])
    error_message = "Every host key must be its role, optionally followed by -N."
  }
  validation {
    condition = alltrue([for h in values(var.hosts) :
      can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label)) && !strcontains(h.label, "--")
      && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", h.fqdn)) && length(h.fqdn) <= 253
      && can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", h.image_id))
      && can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", h.network_id))
      && can(regex("^[a-zA-Z0-9_-]{1,64}$", h.flavor_id))
    ])
    error_message = "Hosts require a valid label/FQDN, explicit AlmaLinux 10 image/network UUIDs and a flavor identifier."
  }
  validation {
    condition     = length(distinct([for h in values(var.hosts) : h.label])) == length(var.hosts) && length(distinct([for h in values(var.hosts) : h.fqdn])) == length(var.hosts)
    error_message = "Host labels and FQDNs must be unique."
  }
}
variable "ovh_project_id" {
  type      = string
  nullable  = false
  sensitive = true
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.ovh_project_id))
    error_message = "ovh_project_id must be the private Public Cloud project identifier."
  }
}
variable "openstack_project_id" {
  type      = string
  nullable  = false
  sensitive = true
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.openstack_project_id))
    error_message = "openstack_project_id must be the private OpenStack tenant identifier."
  }
}
variable "databases" {
  type = map(object({
    description      = string
    version          = string
    flavor           = string
    disk_size_gb     = number
    backup_time      = string
    maintenance_time = string
  }))
  default   = {}
  nullable  = false
  sensitive = true
  validation {
    condition = alltrue([for k, d in var.databases :
      can(regex("^[a-z]{1,16}$", k)) && length(trimspace(d.description)) > 0
      && contains(["14", "15", "16", "17", "18"], d.version)
      && can(regex("^[a-z0-9-]{2,64}$", d.flavor))
      && floor(d.disk_size_gb) == d.disk_size_gb && d.disk_size_gb > 0
      && can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]:00$", d.backup_time))
      && can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]:00$", d.maintenance_time))
    ])
    error_message = "Database keys/settings require explicit PostgreSQL version, flavor, integral positive disk size and UTC backup/maintenance times."
  }
}
variable "root_keys" {
  type      = list(string)
  nullable  = false
  sensitive = true
  validation {
    condition = length(var.root_keys) > 0 && alltrue([for k in var.root_keys :
      can(regex("^(verify-required )?(ssh-ed25519|sk-ssh-ed25519@openssh[.]com) AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$", k))
    ])
    error_message = "root_keys must contain public Ed25519/FIDO key lines, with optional verify-required."
  }
}
variable "configure_keys" {
  type      = map(string)
  nullable  = false
  sensitive = true
  validation {
    condition = alltrue([for role, k in var.configure_keys :
      contains(["staging", "production"], role) && can(regex("^ssh-ed25519 AAAA[0-9A-Za-z+/]+={0,3}( [ -~]+)?$", k))
    ])
    error_message = "configure_keys must map each configured role to a public Ed25519 key line."
  }
}
variable "root_password_hash" {
  type      = string
  default   = ""
  nullable  = false
  sensitive = true
  validation {
    condition     = var.root_password_hash == "" || can(regex("^([$]y[$][./0-9A-Za-z]+[$][./0-9A-Za-z]{1,86}[$][./0-9A-Za-z]{43}|[$]6[$](rounds=[1-9][0-9]{3,8}[$])?[./0-9A-Za-z]{1,16}[$][./0-9A-Za-z]{86})$", var.root_password_hash))
    error_message = "root_password_hash must be empty or a yescrypt/SHA-512 console password hash."
  }
}
variable "cloudflare_zone_id" {
  type      = string
  nullable  = false
  sensitive = true
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a private zone identifier."
  }
}
variable "db_allow_extra" {
  type      = list(string)
  default   = []
  nullable  = false
  sensitive = true
  validation {
    condition     = alltrue([for x in var.db_allow_extra : can(cidrhost(x, 0)) && strcontains(x, "/")])
    error_message = "Every extra database restriction must be an explicit IPv4/IPv6 CIDR."
  }
}
variable "state_passphrase" {
  type      = string
  nullable  = false
  sensitive = true
  validation {
    condition     = length(var.state_passphrase) >= 32
    error_message = "state_passphrase must be at least 32 characters."
  }
}
