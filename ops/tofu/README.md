# OpenTofu: TaruBot's hosts

This module builds the provider side of TaruBot's hosts (2.36.0, issue #62). Since 2.37.0 the Deploy workflow (`.github/workflows/deploy.yml`) is its only runner. Its **Infrastructure plan** job plans the module in the `infra-plan` environment, with read-only credentials and no approval. A job of `.github/workflows/host.yml` in the `prod` environment then applies exactly that saved plan, after @deconfined approves it.

The owner's decisions are in REQUIREMENTS.md, "Approved pipeline amendments (2026-09-29)" and "Approved unified-pipeline amendments (2026-09-29)". [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) is the runbook: the setup, the first apply, building and rebuilding a host, and every approval. This file is the module's reference.

The four layers each have one owner:
- **OpenTofu** (this module) builds the VM, its firewall, its DNS records and the database access lists.
- **cloud-init** (`cloud-init.yaml.tftpl`) sets the hostname and root's credentials at first boot.
- **Ansible** configures the host (`ops/ansible/site.yml`) and deploys the bot (`ops/ansible/bot.yml`), from `host.yml`.
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
- **SSH host keys.** Each host makes its own Ed25519 key at first boot. The approving `prod` job pins it on first use (`ci/host.sh pin`), right after the apply and before any login, in the pin store beside the state: `tarubot/pins/<key>.json`, keyed by the Linode instance ([docs/HOSTING.md](../../docs/HOSTING.md#host-keys)). State holds no private key, and nothing is pinned by hand.
- **SSH fingerprint records** in DNS.
- **Database clusters.** They stay outside OpenTofu, and so does their admin password.

User data takes effect only when a Linode is created (`ignore_changes = [metadata]`). Changing the template, a key or the hash never plans a rebuild; a [rebuild](#rebuilding-a-host) is always deliberate.

**Outputs.**
- `hosts` names each host and its role.
- The sensitive `host_connection` gives each host's instance ID (a string), its IPv6 address (bare, without `/128`) and its IPv4 address. `ci/tofu-ci.sh output` writes it to a private file for `ci/host.sh pin`, and nothing prints it.

## Where the values and secrets live

@deconfined creates the environments and fills them; agents never read, set or change them. Each accepts deployments from `main` only (deployment branches "Selected branches and tags", with the one branch rule `main`).
- **`infra-plan`** has no required reviewer, so a plan runs without an approval. It holds read-only credentials only, and the one copy of `TOFU_VARS`.
- **`prod`** has a required reviewer (@deconfined, self-review allowed), and admins can't bypass it. It holds the write credentials, and every apply, for either host, runs there.
- **`staging`** holds only the state bucket's read-only key, the bucket and the endpoint, to read its pin.
- There is no `infra` environment since 2.37.0.

`infra-plan`'s branch rule is the only thing between another ref's code and its secrets, and GitHub leaves it off by default. An environment made in the UI starts with no branch rule, and one a workflow creates by naming it (a typo) has no rules at all. No run checks the rules: they are @deconfined's own settings, which they read back once when they make the environments ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), step 0.8) and again after any change.

| Secret | Environment | What it holds |
|---|---|---|
| `LINODE_READ_TOKEN` | `infra-plan` | A Linode personal access token with a short expiry, such as 90 days: Linodes, Firewalls, Databases and Events, each read-only. Databases read-only also shows each cluster's admin user and password, and no narrower scope exists, so this token is as sensitive as the database's admin password, and it runs without an approval (a risk @deconfined accepted on 2026-09-29; REQUIREMENTS.md "Accepted risks"). |
| `CLOUDFLARE_READ_TOKEN` | `infra-plan` | A Cloudflare API token with Zone Read and DNS Read on the one zone. |
| `TOFU_STATE_READ_ACCESS_KEY`, `TOFU_STATE_READ_SECRET_KEY` | `infra-plan`, `staging` | An Object Storage key limited to the state bucket, read-only. It reads the state and the pins. |
| `LINODE_WRITE_TOKEN` | `prod` | A Linode personal access token with an expiry: Linodes, Firewalls and Databases read/write, and Events read-only (the provider waits on events). |
| `CLOUDFLARE_WRITE_TOKEN` | `prod` | A Cloudflare API token with DNS edit on the one zone. |
| `TOFU_STATE_WRITE_ACCESS_KEY`, `TOFU_STATE_WRITE_SECRET_KEY` | `prod` | An Object Storage key limited to the state bucket, read/write. It writes the state and the pins. |
| `TOFU_STATE_BUCKET` | `infra-plan`, `staging`, `prod` | The private Object Storage bucket for the state and the pins. Its name has no dot: the backend and the pin store use virtual-hosted addresses. |
| `TOFU_STATE_ENDPOINT` | `infra-plan`, `staging`, `prod` | `https://<region>.linodeobjects.com`, the bucket's cluster, with no path. |
| `TOFU_STATE_PASSPHRASE` | `infra-plan`, `prod` | At least 32 characters, random, kept in the owner's password manager; the script and the module refuse a shorter one. State and saved plans are encrypted with a key derived from it, and the saved plan is a public artifact for a day, so the passphrase is all that protects it. Without it the state can't be read. |
| `TOFU_VARS` | `infra-plan` only | The module's values, one JSON document (below). |

The bucket, the endpoint and the passphrase must be the same wherever they appear. The saved plan records the Infrastructure plan job's bucket and endpoint, and the apply writes the new state there. The approving job decrypts the saved plan with `prod`'s passphrase, and takes the values from the plan itself: `tofu show -json` of the encrypted saved plan carries every variable's value (checked with OpenTofu 1.12.6). So `prod` holds no `TOFU_VARS`.

Every other Object Storage key is limited to its own bucket. Any key that can write the state bucket could replace a pin, and with it redirect a deploy and the secrets it carries.

### `TOFU_VARS`

One JSON object with exactly these seven keys. `examples/example.tfvars.json` shows the shape with placeholders. Store it compact, on one line, so GitHub masks it as one value:

```sh
jq -c . values.json | gh secret set TOFU_VARS --env infra-plan
```

| Key | Value |
|---|---|
| `hosts` | A map of hosts, keyed `staging` or `prod`, optionally followed by `-N` (`staging-2`). Each holds `label`, `fqdn`, `region`, `type` and `role`; `role` must equal the key's part before `-N`. `{}` builds no host. The Deploy workflow deploys only the plain `staging` and `prod` keys. |
| `root_keys` | Root's keys on every host: the owner's FIDO2 line (`verify-required sk-ssh-ed25519@openssh.com AAAA… comment`) and an optional operator key (`ssh-ed25519 AAAA… comment`). Never the agent VM's key. |
| `configure_keys` | A map from role (`staging`, `prod`) to the public half of that environment's `ANSIBLE_SSH_KEY`, one `ssh-ed25519` line each. |
| `root_password_hash` | `""` to lock root's password, or a yescrypt (`mkpasswd -m yescrypt`) or SHA-512 (`openssl passwd -6`) crypt hash for the console. |
| `cloudflare_zone_id` | The zone's 32-character ID. |
| `database_ids` | A map from a short name (`primary`: 1 to 16 lowercase letters) to a Linode database ID. |
| `db_allow_extra` | Access-list entries that aren't hosts built here, such as the Compose production host until the cutover, and the owner's own address. |

Rules that keep the public log clean:
- **Map keys and resource addresses appear in public logs** (`create linode_instance.host["staging"]`), and so do roles. That is why the keys are held to those few words. Nothing else from `TOFU_VARS` ever prints.
- **A label is the Linode's display name** inside the account, not a DNS name or an address, so the workflow doesn't mask it. It follows Linode's rules: 3 to 64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit, never two `-` in a row. Don't put the domain in it.
- **`db_allow_extra` uses the form the Linode API stores**: a CIDR with its prefix length (`198.51.100.10/32`, `2001:db8::10/128`). Copy each entry exactly as Cloud Manager shows it. An entry written any other way shows as a change on every plan.

The `values` and `adopt` phases mask every `fqdn`, the zone ID, each `db_allow_extra` entry and its bare address, the hash, and each key's base64 field before anything else prints. Database IDs are never printed.

## The CI scripts

`ci/tofu-ci.sh` runs one phase per workflow step, and the rules it applies live in the jq programs beside it: `shape.jq` (the value's shape), `masks.jq` (what is masked), `summary.jq` (the change list), `diag.jq` (the diagnostics filter) and `applied.jq` (the apply's counts). Each step's environment holds only the secrets its phase needs.

| Phase | Where | What it does |
|---|---|---|
| `install` | both jobs, and CI | The release in `.opentofu-version`, checked against `opentofu.sha256`. |
| `backend` | both | `backend.hcl` from the bucket and endpoint, virtual-hosted. |
| `values` | the Infrastructure plan | `TOFU_VARS`, checked and masked, and the rebuild target (`REBUILD_TARGET`: empty, `staging` or `prod`, from the Deploy plan's checked output), which becomes `-replace`. Nothing reads the event payload. |
| `init` | both | The backend and the providers from the lock file; the passphrase must be 32 characters or more. |
| `plan` | the Infrastructure plan | A saved, encrypted plan, with the read-only credentials and `-lock=false`. |
| `summarize` | the Infrastructure plan | The change list (`ACTION ADDRESS`, `+N -M` on access lists), whether there are changes, the saved plan's SHA-256, then the guards. |
| `adopt` | the approving `prod` job | The saved plan must match that SHA-256 and change list (an empty list when there are no changes, for a pins-only run); its own values, checked and masked, become the job's. |
| `apply` | the approving `prod` job | Exactly the adopted plan, only when it has changes. OpenTofu refuses it as stale if the state changed since. |
| `output` | the approving `prod` job | `host_connection`, into a private file for `ci/host.sh pin`. |

`ci/host.sh` holds the host keys: `status` in the Infrastructure plan job lists the hosts the approving job must pin, `pin` writes exactly those pins, and `connect` reads a pin and probes the host, IPv6 first ([docs/HOSTING.md](../../docs/HOSTING.md#host-keys)).

**The guards.** The plan refuses to go on:
- a delete or a replace, unless the dispatch has `allow_destroy`;
- the removal of any access-list entry, unless it has `allow_access_removal`;
- any change it can't name.

A `rebuild` alone allows exactly its own instance's replace (`linode_instance.host["<target>"]`) and the removal of that instance's two old access-list entries, its IPv6 `/128` and IPv4 `/32`, read privately from the plan. Anything else still needs its switch.

**The runbook rule.** Never apply a destroy, a replace, an in-place change (on the prod instance, a `type` resize reboots it) or an access-list removal you didn't intend. After any apply that touches an access list, check production's readiness: the heartbeat check and `/sync status` in Discord.

**The saved plan** travels from the Infrastructure plan job to the approving job as a workflow artifact kept for one day, so approve within the day or dispatch again. It is uploaded only when it has changes or keys to pin. The repository is public, so anyone signed in to GitHub can download that artifact while it lasts. It is only ever OpenTofu's encrypted plan file (`versions.tf` enforces plan encryption), readable only with the state passphrase, which is why the passphrase must be at least 32 random characters.

There is no state lock. The applies serialize through `host.yml`'s `host-prod` concurrency group, and a [hand run](#a-hand-run-when-actions-is-down) must never overlap a Deploy run. The plan runs with `-lock=false` because its state key is read-only and could never write a lock: the backend configures none today (no `use_lockfile`), and the flag keeps a later one from making the plan write.

## Rebuilding a host

Dispatch Deploy with `target=<staging|prod>` and `rebuild=true` ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), step 4.6). The plan shows a `replace` of the instance, updates of its two records and `+2 -2` on the access list, since the old addresses leave it and the new ones join it. Once @deconfined approves `prod`, the approving job applies it and pins the new instance's key. The replace deletes the old instance first, so the bot on it stops: on a host that runs a bot, dispatch the rebuild with `action=deploy` and the live version, and the same run starts it again.

A new owner key, Configure key or root hash reaches a host only through a rebuild, since user data applies only at creation. A new Configure key is made the way docs/DEPLOYMENT.md's step 0.6 makes the first one: without a passphrase, its private half straight into the environment's `ANSIBLE_SSH_KEY`. Until then, root's `authorized_keys` can be edited by hand, logged in with the FIDO2 key.

## A hand run when Actions is down

From the owner's machine, never from an agent's, and never while a Deploy run is active. Run it from the repository's root. Every file it writes (the backend settings, the values, OpenTofu's working directory and the saved plan) goes to a private directory outside the checkout, so none of them can be committed, and the directory goes afterwards:

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

The same runbook rule applies. `tofu output -json host_connection` shows each host's instance and addresses; nothing else reads that output. A hand apply that creates or replaces a host writes no pin: dispatch Deploy with `action=infra` afterwards, and approve the plan that lists the host as needing one. For a hand Ansible run, the known-hosts line is `target <the pin's host_key>`, read from `tarubot/pins/<key>.json` with your own bucket credentials.

## Checks and upgrades

CI's "Infrastructure checks" job runs, on pull requests and dispatches:

```sh
export TF_VAR_state_passphrase=ci-only-throwaway-state-passphrase
tofu -chdir=ops/tofu fmt -check -recursive
tofu -chdir=ops/tofu init -backend=false -input=false -lockfile=readonly
tofu -chdir=ops/tofu validate
tofu -chdir=ops/tofu test -var-file=examples/example.tfvars.json
```

It also runs `cloud-init schema` over `examples/user-data-*.yaml`. `tests/main.tftest.hcl` checks that the module renders exactly those two files, so the schema check covers what the module sends. After changing the template, render the examples again and commit them with it. `tests/unit/infra.test.ts` pins the module and runs `ci/`'s jq programs and the script's phases against sample plans with a stand-in for `tofu`. `tests/unit/host-pin.test.ts` runs `ci/host.sh` against stand-ins for `ssh`, `ssh-keyscan`, `curl` and `ip`. CI's ShellCheck covers both scripts.

**Upgrading OpenTofu.**
1. Download `tofu_<v>_linux_amd64.zip`, `tofu_<v>_SHA256SUMS` and `tofu_<v>_SHA256SUMS.gpgsig` from the release page, https://github.com/opentofu/opentofu/releases.
2. Import OpenTofu's signing key, `opentofu.asc`, which their installer script also pins. Its fingerprint is `E3E6 E43D 84CB 852E ADB0 051D 0C0A F313 E5FD 9F80`.
3. `gpg --verify tofu_<v>_SHA256SUMS.gpgsig tofu_<v>_SHA256SUMS`, then `sha256sum -c` the zip against its line.
4. Write `<v>` to `.opentofu-version`, and that one SUMS line to `opentofu.sha256`. Raise `required_version` in `versions.tf` if the module needs the new release.

Before relying on a new release, check again that `tofu show -json` of an encrypted saved plan still lists every variable's value: the approving job's `adopt` depends on it.

**Upgrading a provider.**
1. Raise its constraint in `versions.tf`.
2. Run `tofu init -upgrade -backend=false`.
3. Run `tofu providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64`.
4. Run the checks above, read the provider's changelog for this module's resources, and commit `.terraform.lock.hcl` with the constraint.

Dependabot reads neither the OpenTofu registry nor these pins, so both upgrades are by hand.
