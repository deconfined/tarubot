# TaruBot's OpenTofu root module (2.36.0, issue #62): the tool and provider pins, the state
# backend and state encryption. What the module builds is in main.tf; README.md says how it runs.
#
# The real values never live in the repository. .github/workflows/infra.yml passes them from the
# `infra-plan` (Plan) and `infra` (Apply) GitHub environments: TOFU_VARS as a -var-file, the
# backend's bucket, endpoint and signing region as a -backend-config file, and the state passphrase
# as TF_VAR_state_passphrase.
terraform {
  # ops/tofu/.opentofu-version names the release CI and infra.yml install; it must satisfy this
  # (tests/unit/infra.test.ts checks). 1.12 is the release this module was written and tested on.
  required_version = ">= 1.12.0"

  # Exact releases are in .terraform.lock.hcl, with hashes for linux and darwin on amd64 and
  # arm64. Upgrading one is `tofu init -upgrade`, then `tofu providers lock` with those four
  # platforms (README.md, "Checks and upgrades"). No TLS or random provider: the module makes no
  # keys.
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 4.5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }

  # The selected state target is private OVH Standard S3-compatible Object Storage. This is a
  # partial configuration: the bucket, endpoint, SigV4 region and use_path_style come
  # from the -backend-config file infra.yml writes (backend.hcl; README.md has its form), so no
  # bucket or endpoint is named here. Operational routing is virtual-hosted. The credentials are
  # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, filled from
  # infra-plan's read-only state key in the Plan job and infra's read/write one in the Apply job.
  backend "s3" {
    key = "tarubot/infra.tfstate"
    # Nothing here is AWS: skip the checks that would call AWS's own services.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    # No use_lockfile: the selected backend's conditional writes are unverified. The `infra`
    # concurrency group serializes runs, and a hand run must never overlap one. Plan also runs
    # with -lock=false, since its state key is read-only.
  }

  # Native state encryption. State holds the database access lists, the hosts' addresses and
  # root's optional password hash, so it is written only encrypted, and so is a saved plan
  # (enforced = true refuses to read or write either in plain text). The saved plan also travels
  # from infra.yml's Plan job to its Apply job as a one-day artifact, which anyone signed in to
  # GitHub can download from this public repository, so this is what protects it there.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

# Credentials come from the environment only: LINODE_TOKEN and CLOUDFLARE_API_TOKEN, which
# infra.yml sets on its Plan step from infra-plan's read-only tokens and on its Apply step from
# infra's write tokens.
provider "linode" {}

provider "cloudflare" {}
