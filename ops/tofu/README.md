# OpenTofu: TaruBot's hosts

This module builds the provider side of TaruBot's hosts (2.36.0, issue #62). `.github/workflows/infra.yml` plans and applies it from GitHub Actions, after @deconfined approves each job in the `infra` environment. The owner's decisions are in REQUIREMENTS.md, "Approved pipeline amendments (2026-09-29)".

The four layers each have one owner:
- **OpenTofu** (this module) builds the VM, its firewall, its DNS records and the database access lists.
- **cloud-init** (`cloud-init.yaml.tftpl`) sets the hostname and root's credentials at first boot.
- **Ansible** configures the host (`ops/ansible/site.yml`) and deploys the bot (`ops/ansible/bot.yml`), from `.github/workflows/host.yml`.
- **GitHub environments** hold every secret.

## What it builds

For each entry in `hosts`:
- a Linode running `linode/almalinux10`, with disk encryption, booted, on one public interface of the pinned type (`interface_generation = "legacy_config"`, question 27 of #50);
- its Cloud Firewall: inbound SSH (TCP 22) and ICMP from anywhere, everything else dropped; outbound open;
- an A and an AAAA record for its `fqdn` in Cloudflare, unproxied, with a 300 s TTL.

For each entry in `database_ids`, the managed PostgreSQL cluster's **whole** access list: every host's IPv6 `/128` and IPv4 `/32`, then `db_allow_extra`. It carries `prevent_destroy`, because deleting it would empty the list and cut production off. An `import` block adopts an existing list on the first apply, and does nothing after that.

The user data carries only public keys, root's optional password hash and the hostname:
- root's keys: `root_keys`, plus the host's role's Configure key;
- root's password: the owner's hash (for the Lish console only; sshd refuses passwords), or locked when `root_password_hash` is empty;
- password SSH off, and the Python bindings Ansible needs (`python3`, `python3-libselinux`);
- one sshd drop-in line, `PubkeyAuthOptions verify-required`. cloud-init drops the options on root's key lines, so sshd enforces verify-required itself until Configure writes the full drop-in. Only FIDO keys are affected.

The provider refuses a Linode without a root password or keys, so each Linode gets a random throwaway password, which the user data replaces with the hash or locks. cloud-init stays the only writer of root's keys.

It never builds:
- **SSH host keys.** Each host makes its own Ed25519 key at first boot, and the owner pins it from their own machine ([Pinning a new host key](#pinning-a-new-host-key)). State holds no private key.
- **SSH fingerprint records** in DNS.
- **Database clusters.** They stay outside OpenTofu, and so does their admin password.

User data takes effect only when a Linode is created (`ignore_changes = [metadata]`). Changing the template, a key or the hash never plans a rebuild; a [rebuild](#rebuilding-a-host) is always deliberate.

## The `infra` environment

@deconfined creates it and fills it; agents never read, set or change it. It has a required reviewer (@deconfined, self-review allowed), admins can't bypass it, and it accepts deployments from `main` only.

| Secret | What it holds |
|---|---|
| `LINODE_TOKEN` | A Linode personal access token with an expiry: Linodes, Firewalls and Databases read/write, and Events read-only (the provider waits on events). |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with DNS edit on the one zone. |
| `TOFU_STATE_BUCKET` | The private Object Storage bucket for the state. |
| `TOFU_STATE_ENDPOINT` | `https://<region>.linodeobjects.com`, the bucket's cluster. |
| `TOFU_STATE_ACCESS_KEY`, `TOFU_STATE_SECRET_KEY` | An Object Storage key limited to that bucket, read/write. |
| `TOFU_STATE_PASSPHRASE` | At least 16 characters (32 or more random ones recommended), kept in the owner's password manager. State and saved plans are encrypted with a key derived from it; without it the state can't be read. |
| `TOFU_VARS` | The module's values, one JSON document (below). |

### `TOFU_VARS`

One JSON object with exactly these seven keys. `examples/example.tfvars.json` shows the shape with placeholders. Store it compact, on one line, so GitHub masks it as one value:

```sh
jq -c . values.json | gh secret set TOFU_VARS --env infra
```

| Key | Value |
|---|---|
| `hosts` | A map of hosts, keyed `staging` or `production`, optionally followed by `-N` (`staging-2`). Each holds `label`, `fqdn`, `region`, `type` and `role`; `role` must equal the key's part before `-N`. `{}` builds no host. |
| `root_keys` | Root's keys on every host: the owner's FIDO2 line (`verify-required sk-ssh-ed25519@openssh.com AAAA… comment`) and an optional operator key (`ssh-ed25519 AAAA… comment`). Never the agent VM's key. |
| `configure_keys` | A map from role to the public half of that environment's `ANSIBLE_SSH_KEY`, one `ssh-ed25519` line each. |
| `root_password_hash` | `""` to lock root's password, or a yescrypt (`mkpasswd -m yescrypt`) or SHA-512 (`openssl passwd -6`) crypt hash for the console. |
| `cloudflare_zone_id` | The zone's 32-character ID. |
| `database_ids` | A map from a short name (`primary`: 1 to 16 lowercase letters) to a Linode database ID. |
| `db_allow_extra` | Access-list entries that aren't hosts built here, such as the old production host during the move. |

Rules that keep the public log clean:
- **Map keys and resource addresses appear in public logs** (`create linode_instance.host["staging"]`), and so do roles. That is why the keys are held to those few words. Nothing else from `TOFU_VARS` ever prints.
- **Every label must contain a `-`** (8 to 63 characters of `a-z`, `0-9` and `-`, starting with a letter, never two `-` in a row), and must not occur inside a host key. The workflow masks each label in the log. A label with a `-` can never equal a plain word the log prints, so masking it censors nothing else.
- **`db_allow_extra` uses the form the Linode API stores**: a CIDR with its prefix length (`198.51.100.10/32`, `2001:db8::10/128`). Copy each entry exactly as Cloud Manager shows it. An entry written any other way shows as a change on every plan.

The workflow masks every `fqdn` and label, the zone ID, each `db_allow_extra` entry and its bare address, the hash, and each key's base64 field before anything else prints. Database IDs are never printed.

## Operating it

Every change is two dispatches of **Infrastructure** from `main`:

1. `operation=plan`. Approve the Plan job. Its summary lists each change as `ACTION ADDRESS`, with `+N -M` (entries added and removed) on each access list. Read it.
2. `operation=apply`, if the plan was what you meant. Approve the Plan job, then the Apply job. Apply plans again and refuses unless its change list equals the one you approved. It then applies and prints only the counts, plus one line per host it built.

The plan refuses to go on:
- a delete or a replace, unless you dispatch with `allow_destroy`;
- the removal of any access-list entry, unless you dispatch with `allow_access_removal`;
- any change it can't name.

**The runbook rule.** Never apply a destroy, a replace, an in-place change (on production's instance, a `type` resize reboots it) or an access-list removal you didn't intend. After any apply that touches an access list, check production's readiness: the heartbeat check and `/sync status` in Discord.

There is no state lock. Runs serialize through the workflow's `infra` concurrency group, and a [hand run](#a-hand-run-when-actions-is-down) must never overlap one.

## The first apply

It is two applies, so that adopting the existing access list can't change it.

1. **Import only.** Set `TOFU_VARS` with `"hosts": {}`, `database_ids` holding the cluster, and `db_allow_extra` set to exactly the list Cloud Manager shows now, including the production Compose host's IPv4 and IPv6. Dispatch a plan. It must show only:

   ```
   import linode_database_access_controls.db["primary"] +0 -0
   ```

   Anything else means a value is wrong: fix `TOFU_VARS` and never apply. Then dispatch an apply.

2. **Staging.** Add the `staging` entry to `hosts`, with a label that contains a `-`. The plan must show creates for `linode_firewall.host["staging"]`, `linode_instance.host["staging"]` and the two records, plus one access-list update that only adds entries:

   ```
   update linode_database_access_controls.db["primary"] +2 -0
   ```

   Apply it, check production's readiness, then [pin the new host's key](#pinning-a-new-host-key).

## Pinning a new host key

After every build or rebuild, the owner pins the new host's key from their own machine, trusting it on first use. The workflow never prints a host key: scanners index keys by address, so a key in a public log would lead to the address and the name.

```sh
ssh-keyscan -q -t ed25519 <name> 2>/dev/null | cut -d' ' -f2- | gh secret set TARGET_HOST_KEY --env <role>
```

`TARGET_HOST_KEY` holds exactly `ssh-ed25519 <key>`, with no host name. The `-q` matters: without it `ssh-keyscan` also prints a `# <name>:22 SSH-2.0-…` banner line on standard output, which would reach the secret, and the host job would refuse it. Before running it, make sure `<name>` already resolves to the new addresses Cloud Manager shows, not to a rebuilt host's old ones. To check the key itself, compare `ssh-keyscan -q -t ed25519 <name> 2>/dev/null | ssh-keygen -lf -` with the Ed25519 fingerprint cloud-init printed on the Lish console at first boot.

A new host also needs `TARGET_HOST` (its DNS name) and `ANSIBLE_SSH_KEY` (the Configure key's private half) in its environment before its first Configure.

## Rebuilding a host

Dispatch `operation=apply` with `replace=linode_instance.host["<key>"]`, `allow_destroy` and `allow_access_removal`: the old addresses leave the access list and the new ones join it. The plan shows a `replace` of the instance, updates of its two records and `+2 -2` on the access list. Then pin the new key.

A new owner key, Configure key or root hash reaches a host only through a rebuild, since user data applies only at creation. Until then, root's `authorized_keys` can be edited by hand, logged in with the FIDO2 key.

## A hand run when Actions is down

From the owner's machine, never from an agent's, and never while an Infrastructure run is active. Keep the files in a private directory (`umask 077`):

```sh
cat > backend.hcl <<'EOF'
bucket         = "<bucket>"
endpoints      = { s3 = "https://<region>.linodeobjects.com" }
use_path_style = false
EOF
# values.tfvars.json holds the same document as TOFU_VARS.
export AWS_ACCESS_KEY_ID=<state access key> AWS_SECRET_ACCESS_KEY=<state secret key>
export TF_VAR_state_passphrase=<passphrase> LINODE_TOKEN=<token> CLOUDFLARE_API_TOKEN=<token>
tofu -chdir=ops/tofu init -lockfile=readonly -backend-config="$PWD/backend.hcl"
tofu -chdir=ops/tofu plan -var-file="$PWD/values.tfvars.json" -out="$PWD/plan.bin"
tofu -chdir=ops/tofu apply "$PWD/plan.bin"
```

The same runbook rule applies. `tofu output -json addresses` shows the hosts' addresses; nothing else reads that output.

## Checks and upgrades

CI's "Infrastructure checks" job runs, on pull requests and dispatches:

```sh
export TF_VAR_state_passphrase=ci-only-throwaway-passphrase
tofu -chdir=ops/tofu fmt -check -recursive
tofu -chdir=ops/tofu init -backend=false -input=false -lockfile=readonly
tofu -chdir=ops/tofu validate
tofu -chdir=ops/tofu test -var-file=examples/example.tfvars.json
```

It also runs `cloud-init schema` over `examples/user-data-*.yaml`. `tests/main.tftest.hcl` checks that the module renders exactly those two files, so the schema check covers what the module sends. After changing the template, render the examples again and commit them with it. `tests/unit/infra.test.ts` pins the rest statically.

**Upgrading OpenTofu.**
1. Download `tofu_<v>_linux_amd64.zip`, `tofu_<v>_SHA256SUMS` and `tofu_<v>_SHA256SUMS.gpgsig` from the release page, https://github.com/opentofu/opentofu/releases.
2. Import OpenTofu's signing key, `opentofu.asc`, which their installer script also pins. Its fingerprint is `E3E6 E43D 84CB 852E ADB0 051D 0C0A F313 E5FD 9F80`.
3. `gpg --verify tofu_<v>_SHA256SUMS.gpgsig tofu_<v>_SHA256SUMS`, then `sha256sum -c` the zip against its line.
4. Write `<v>` to `.opentofu-version`, and that one SUMS line to `opentofu.sha256`. Raise `required_version` in `versions.tf` if the module needs the new release.

**Upgrading a provider.**
1. Raise its constraint in `versions.tf`.
2. Run `tofu init -upgrade -backend=false`.
3. Run `tofu providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64`.
4. Run the checks above, read the provider's changelog for this module's resources, and commit `.terraform.lock.hcl` with the constraint.

Dependabot reads neither the OpenTofu registry nor these pins, so both upgrades are by hand.
