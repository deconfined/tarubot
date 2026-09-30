# OpenTofu: TaruBot's hosts

This module builds the provider side of TaruBot's hosts (2.36.0, issue #62). `.github/workflows/infra.yml` plans and applies it from GitHub Actions: its Plan job runs in the `infra-plan` environment with read-only credentials and no approval, and its Apply job runs in `infra`, after @deconfined approves it. The owner's decisions are in REQUIREMENTS.md, "Approved pipeline amendments (2026-09-29)" (the environments are its confirmed item 4).

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

## The `infra-plan` and `infra` environments

@deconfined creates both and fills them; agents never read, set or change them. Both accept deployments from `main` only: deployment branches "Selected branches and tags", with the one branch rule `main`.
- **`infra-plan`** has no required reviewer, so a plan runs without an approval. It holds read-only credentials only.
- **`infra`** has a required reviewer (@deconfined, self-review allowed), and admins can't bypass it. It holds the write credentials.

`infra-plan`'s branch rule is the only thing between another ref's code and its secrets, and GitHub leaves it off by default: an environment made in the UI starts with no branch rule, and one a workflow creates by naming it (a typo) has no rules at all. No run checks the rules: the owner reads them back at setup and after any change ([owner checklist](../../docs/DEPLOYMENT.md#first-host-setup-owner-checklist)); the original approval is linked from [REQUIREMENTS.md](../../REQUIREMENTS.md).

| Secret | Environment | What it holds |
|---|---|---|
| `LINODE_READ_TOKEN` | `infra-plan` | A Linode personal access token with a short expiry, such as 90 days: Linodes, Firewalls, Databases and Events, each read-only. Databases read-only also shows each cluster's admin user and password, and no narrower scope exists, so this token is as sensitive as the database's admin password, and it runs without an approval (a risk @deconfined accepted on 2026-09-29; REQUIREMENTS.md "Accepted risks"). |
| `CLOUDFLARE_READ_TOKEN` | `infra-plan` | A Cloudflare API token with Zone Read and DNS Read on the one zone. |
| `TOFU_STATE_READ_ACCESS_KEY`, `TOFU_STATE_READ_SECRET_KEY` | `infra-plan` | An Object Storage key limited to the state bucket, read-only. |
| `LINODE_WRITE_TOKEN` | `infra` | A Linode personal access token with an expiry: Linodes, Firewalls and Databases read/write, and Events read-only (the provider waits on events). |
| `CLOUDFLARE_WRITE_TOKEN` | `infra` | A Cloudflare API token with DNS edit on the one zone. |
| `TOFU_STATE_WRITE_ACCESS_KEY`, `TOFU_STATE_WRITE_SECRET_KEY` | `infra` | An Object Storage key limited to the state bucket, read/write. |
| `TOFU_STATE_BUCKET` | both | The private Object Storage bucket for the state. |
| `TOFU_STATE_ENDPOINT` | both | `https://<region>.linodeobjects.com`, the bucket's cluster. |
| `TOFU_STATE_PASSPHRASE` | both | At least 32 characters, random, kept in the owner's password manager; the workflow and the module refuse a shorter one. State and saved plans are encrypted with a key derived from it, and the saved plan is a public artifact for a day, so the passphrase is all that protects it. Without it the state can't be read. |
| `TOFU_VARS` | both | The module's values, one JSON document (below). |

The four secrets marked "both" must hold the same value in each environment:
- **The bucket and endpoint.** The saved plan records the Plan job's bucket and endpoint, and OpenTofu writes the new state there; `infra`'s own copies serve only its `init`. So `infra`'s read/write key must be for that same bucket, and `TOFU_STATE_BUCKET` and `TOFU_STATE_ENDPOINT` must match exactly, or the apply changes the resources and then fails to write the state.
- **The passphrase.** Apply decrypts the saved plan with its own copy.
- **`TOFU_VARS`.** The saved plan applies the values it was planned with, `infra-plan`'s. Apply masks with its own copy and refuses to go on when the two differ, since a key or hash set in one copy alone changes no line of the change list.

The `_READ_` and `_WRITE_` names keep each job to its own kind: the Plan job reads only `_READ_` secrets and the Apply job only `_WRITE_` ones (`tests/unit/infra.test.ts` checks).

### `TOFU_VARS`

One JSON object with exactly these seven keys. `examples/example.tfvars.json` shows the shape with placeholders. Store it compact, on one line, so GitHub masks it as one value, in both environments:

```sh
for e in infra-plan infra; do jq -c . values.json | gh secret set TOFU_VARS --env "$e"; done
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
- **A label is the Linode's display name** inside the account, not a DNS name or an address, so the workflow doesn't mask it. It follows Linode's rules: 3 to 64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit, never two `-` in a row. Don't put the domain in it.
- **`db_allow_extra` uses the form the Linode API stores**: a CIDR with its prefix length (`198.51.100.10/32`, `2001:db8::10/128`). Copy each entry exactly as Cloud Manager shows it. An entry written any other way shows as a change on every plan.

The workflow masks every `fqdn`, the zone ID, each `db_allow_extra` entry and its bare address, the hash, and each key's base64 field before anything else prints. Database IDs are never printed.

Each of the workflow's steps runs one phase of `ci/tofu-ci.sh` (install, prepare and init in Plan and Apply; plan and summarize in Plan; compare and apply in Apply), and the rules it applies live in the jq programs beside it: `shape.jq` (the value's shape), `masks.jq` (what is masked), `summary.jq` (the change list), `diag.jq` (the diagnostics filter) and `applied.jq` (the apply's counts). Plan and Apply run the same code, and each step's environment holds only the secrets its phase needs.

## Operating it

Every change is one dispatch of **Infrastructure** from `main` and one approval:

1. `operation=apply`. The Plan job runs at once, with no approval. Its summary lists each change as `ACTION ADDRESS`, with `+N -M` (entries added and removed) on each access list. Read it.
2. If the plan is what you meant, approve the Apply job; if not, reject it. Apply never plans: it fetches the Plan job's saved plan, refuses unless the file's SHA-256 and change list are the ones the Plan job produced and the plan was made with `infra`'s own `TOFU_VARS`, and applies exactly that plan. OpenTofu refuses it as "Saved plan is stale" if the state changed since the Plan job read it. It prints only the counts, plus one line per host it built.

`operation=plan` stops after the Plan job, to look without an apply waiting.

The saved plan travels from Plan to Apply as a workflow artifact kept for one day, so approve within the day or dispatch again. The repository is public, so anyone signed in to GitHub can download that artifact while it lasts. It is only ever OpenTofu's encrypted plan file (`versions.tf` enforces plan encryption), readable only with the state passphrase, which is why the passphrase must be at least 32 random characters. A plan-only run, or a plan the guards refuse, uploads nothing.

The plan refuses to go on:
- a delete or a replace, unless you dispatch with `allow_destroy`;
- the removal of any access-list entry, unless you dispatch with `allow_access_removal`;
- any change it can't name.

**The runbook rule.** Never apply a destroy, a replace, an in-place change (on production's instance, a `type` resize reboots it) or an access-list removal you didn't intend. After any apply that touches an access list, check production's readiness: the heartbeat check and `/sync status` in Discord.

There is no state lock. Runs serialize through the workflow's `infra` concurrency group, and a [hand run](#a-hand-run-when-actions-is-down) must never overlap one. The Plan job plans with `-lock=false` as well, because its state key is read-only and could never write a lock: the backend configures none today (no `use_lockfile`), and the flag keeps a later one from making Plan write.

## The first apply

It is two applies, so that adopting the existing access list can't change it.

1. **Import only.** Set `TOFU_VARS` in both environments with `"hosts": {}`, `database_ids` holding the cluster, and `db_allow_extra` set to exactly the list Cloud Manager shows now, including the production Compose host's IPv4 and IPv6. Dispatch `operation=apply`. The Plan job must show only:

   ```
   import linode_database_access_controls.db["primary"] +0 -0
   ```

   Anything else means a value is wrong: reject the Apply job, fix `TOFU_VARS` and dispatch again. Approve the Apply job only for exactly that line.

2. **Staging.** Add the `staging` entry to `hosts`, in both environments. Dispatch `operation=apply`: the Plan job must show creates for `linode_firewall.host["staging"]`, `linode_instance.host["staging"]` and the two records, plus one access-list update that only adds entries:

   ```
   update linode_database_access_controls.db["primary"] +2 -0
   ```

   Approve the Apply job, check production's readiness, then [pin the new host's key](#pinning-a-new-host-key).

## Pinning a new host key

After every build or rebuild, the owner pins the new host's key from their own machine, trusting it on first use. The workflow never prints a host key: scanners index keys by address, so a key in a public log would lead to the address and the name.

```sh
ssh-keyscan -q -t ed25519 <name> 2>/dev/null | cut -d' ' -f2- | gh secret set TARGET_HOST_KEY --env <role>
```

`TARGET_HOST_KEY` holds exactly `ssh-ed25519 <key>`, with no host name. The `-q` matters: without it `ssh-keyscan` also prints a `# <name>:22 SSH-2.0-…` banner line on standard output, which would reach the secret, and the host job would refuse it. Before running it, make sure `<name>` already resolves to the new addresses Cloud Manager shows, not to a rebuilt host's old ones. To check the key itself, compare `ssh-keyscan -q -t ed25519 <name> 2>/dev/null | ssh-keygen -lf -` with the Ed25519 fingerprint cloud-init printed on the Lish console at first boot.

A new host also needs `TARGET_HOST` (its DNS name) and `ANSIBLE_SSH_KEY` (the Configure key's private half, without a passphrase) in its environment before its first Configure.

Until the new key is pinned, every run for that host fails at its first connection with "Host key verification failed.". The host job runs ssh with `LogLevel=FATAL`, so ssh's "REMOTE HOST IDENTIFICATION HAS CHANGED" banner, which would print the new key's fingerprint in the public log, never prints. The same setting also leaves a host that is down, or has port 22 closed, ending UNREACHABLE with no reason given: check that it's up first.

## Rebuilding a host

Dispatch `operation=apply` with `replace=linode_instance.host["<key>"]`, `allow_destroy` and `allow_access_removal`: the old addresses leave the access list and the new ones join it. The Plan job shows a `replace` of the instance, updates of its two records and `+2 -2` on the access list. Approve the Apply job, then pin the new key.

The workflow reads `replace` from the dispatch's event payload, never from a step's `env:`, which GitHub prints unmasked, and refuses any other value without echoing it. So a host name or address typed there by mistake stays out of the public log.

A new owner key, Configure key or root hash reaches a host only through a rebuild, since user data applies only at creation. Make a new Configure key using the [owner checklist](../../docs/DEPLOYMENT.md#first-host-setup-owner-checklist): without a passphrase, its private half straight into the environment's `ANSIBLE_SSH_KEY`. Until then, root's `authorized_keys` can be edited by hand, logged in with the FIDO2 key.

## A hand run when Actions is down

From the owner's machine, never from an agent's, and never while an Infrastructure run is active. Run it from the repository's root. Every file it writes (the backend settings, the values, OpenTofu's working directory and the saved plan) goes to a private directory outside the checkout, so none of them can be committed, and the directory goes afterwards:

```sh
umask 077
W=$(mktemp -d)
export TF_DATA_DIR="$W/data"
cat > "$W/backend.hcl" <<'EOF'
bucket         = "<bucket>"
endpoints      = { s3 = "https://<region>.linodeobjects.com" }
use_path_style = false
EOF
# Write "$W/values.tfvars.json": the same document as TOFU_VARS.
export AWS_ACCESS_KEY_ID=<read/write state access key> AWS_SECRET_ACCESS_KEY=<its secret key>
export TF_VAR_state_passphrase=<passphrase> LINODE_TOKEN=<write token> CLOUDFLARE_API_TOKEN=<write token>
tofu -chdir=ops/tofu init -lockfile=readonly -backend-config="$W/backend.hcl"
tofu -chdir=ops/tofu plan -var-file="$W/values.tfvars.json" -out="$W/plan.bin"
tofu -chdir=ops/tofu apply "$W/plan.bin"
rm -rf -- "${W:?}"
```

The same runbook rule applies. `tofu output -json addresses` shows the hosts' addresses; nothing else reads that output.

## Checks and upgrades

CI's "Infrastructure checks" job runs, on pull requests and dispatches:

```sh
export TF_VAR_state_passphrase=ci-only-throwaway-state-passphrase
tofu -chdir=ops/tofu fmt -check -recursive
tofu -chdir=ops/tofu init -backend=false -input=false -lockfile=readonly
tofu -chdir=ops/tofu validate
tofu -chdir=ops/tofu test -var-file=examples/example.tfvars.json
```

It also runs `cloud-init schema` over `examples/user-data-*.yaml`. `tests/main.tftest.hcl` checks that the module renders exactly those two files, so the schema check covers what the module sends. After changing the template, render the examples again and commit them with it. `tests/unit/infra.test.ts` pins the workflow and the module, and runs `ci/`'s jq programs and the script's phases against sample plans with a stand-in for `tofu`; CI's ShellCheck covers `ci/tofu-ci.sh`.

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
