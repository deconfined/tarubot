# OpenTofu: TaruBot's hosts

The selected stack is **OVH US**, not a multi-provider module. OpenStack 3.4.0 provisions compute/networking in `US-EAST-VA-1`; OVH 2.9.0 provisions a **new**, single-node Essential PostgreSQL service in `US-EAST-VA` through `ovh-us`. Cloudflare owns A/AAAA DNS. Native encrypted state and private records use Standard S3 with signing region `us-east-va` and endpoint `https://s3.us-east-va.io.cloud.ovh.us`.

The source conversion and offline checks are implemented. **Real-service acceptance, activation, provisioning and application-data migration are not completed or authorized by this runbook.** Production's existing Compose bot and managed database remain unchanged. The automatic replacement pipeline stays fenced. Only the owner operates real infrastructure, administers environments or holds their credentials; see [AGENTS](../../AGENTS.md).

## What it builds

For each `hosts` entry:

- An OpenStack VM with an explicit **AlmaLinux 10-UEFI image ID**, **d2-2 flavor ID** and public network ID. d2-2 has a local root disk; the module adds no separately billed boot volume. The owner must verify image/flavor/network compatibility, availability, pricing and workload headroom before provisioning. There is no claim of Linode-style disk encryption on OVH.
- A stateful Neutron security group with defaults removed and six explicit rules: dual-stack SSH/ICMP ingress and open IPv4/IPv6 egress. A host label does not rename its security group.
- Unproxied Cloudflare A and AAAA records with 300-second TTL. The selected network must actually yield both address families; missing IPv6 is a refusal, not permission to invent an AAAA record.

For each `databases` entry, a **new** Essential PostgreSQL service with one selected-region node, explicit version/flavor/disk/maintenance/backup settings, deletion protection and `prevent_destroy`. The service owns its **complete** `ip_restrictions` set: every module host's IPv4 `/32` and IPv6 `/128`, plus `db_allow_extra`. It does not use the deprecated individual restriction resource.

There are no import blocks, database-ID inputs or existing-cluster adoption operation. This module never imports the live database, copies SQL data, creates database users/application databases, changes the bot's database URL or retires the old service. Provisioning an empty service is not a migration. Retain old-host access during any separately reviewed migration window.

cloud-init alone seeds public root/operator/Configure keys, an optional console password hash, hostname and Python bindings. SSH password access is off. `PubkeyAuthOptions verify-required` protects FIDO keys until Configure supplies the full drop-in. The guest generates its own Ed25519 host key; no host/private key is seeded in OpenTofu. User data is creation-only (`ignore_changes = [user_data]`); ignored access-key/hash intent remains bound to the durable applied-input baseline.

Ansible's reviewed `site.yml` owns host configuration; the release's `bot.yml` owns bot delivery. AlmaLinux 10, enforcing SELinux and rootless Quadlet remain the target contract.

## The `infra-plan` and `infra` environments

The owner sets both environments to accept only protected `main`. `infra-plan` is read-only, without an approval; `infra` requires the owner's approval and contains write-scoped credentials. Agents never inspect, create or change these environments, secrets or variables. GitHub's default environment branch rules are insufficient: the owner reads protections back at setup and after changes; the workflow does not administer them.

| Secret | Environment | Purpose |
| --- | --- | --- |
| `OVH_READ_APPLICATION_KEY`, `OVH_READ_APPLICATION_SECRET`, `OVH_READ_CONSUMER_KEY` | `infra-plan` | OVH API application credentials and consumer authorization scoped to the selected project's required GET reads. |
| `OPENSTACK_READ_USERNAME`, `OPENSTACK_READ_PASSWORD` | `infra-plan` | Project-scoped OpenStack principal whose provider resource reads are permitted and writes refused. Authentication/token issuance must still work. |
| `CLOUDFLARE_READ_TOKEN` | `infra-plan` | Zone/DNS reads on the selected zone. |
| `TOFU_STATE_READ_ACCESS_KEY`, `TOFU_STATE_READ_SECRET_KEY` | `infra-plan` | State/control bucket reads only. |
| `OVH_WRITE_APPLICATION_KEY`, `OVH_WRITE_APPLICATION_SECRET`, `OVH_WRITE_CONSUMER_KEY` | `infra` | Owner-reviewed OVH provisioning/settings writes and the instance GET used by enrollment. |
| `OPENSTACK_WRITE_USERNAME`, `OPENSTACK_WRITE_PASSWORD` | `infra` | Selected project's compute/networking writes and reads. |
| `CLOUDFLARE_WRITE_TOKEN` | `infra` | DNS edit/read on the selected zone, including enrollment SSHFP. |
| `TOFU_STATE_WRITE_ACCESS_KEY`, `TOFU_STATE_WRITE_SECRET_KEY` | `infra` | State/control bucket reads/writes. |
| `TOFU_STATE_BUCKET` | both | Private state/control bucket. |
| `TOFU_STATE_ENDPOINT` | both | Standard S3 endpoint above, without a bucket prefix or path. Do not use global `.net`, legacy `.perf` or Swift endpoints. |
| `TOFU_STATE_REGION` | both | Explicit SigV4 signing region `us-east-va`, distinct from compute/database region spelling. Replacement Host also needs this value. |
| `TOFU_STATE_PASSPHRASE` | both | At least 32 random characters; the owner's password manager retains it. Native state, saved plans and control records require it. |
| `TOFU_VARS` | both | The identical private JSON input document described below. |

Phase wiring uses `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`, `OS_USERNAME`, `OS_PASSWORD` and `CLOUDFLARE_API_TOKEN`. Routing is fixed to `ovh-us` and the US OpenStack identity endpoint; the tenant comes from the explicit private input, not an ambient project selection. The official pinned OVH SDK signs enrollment's readback; no custom API-signing implementation is used. Its credentialed diagnostics are suppressed.

Secret names are a contract, **not proof of least privilege**. The owner must privately demonstrate successful required reads and refused writes with the actual Plan principals. OVH GET rules and OpenStack roles are different mechanisms; a broadly privileged principal is not read-only because its secret contains `READ`. Document unavoidable read exposure privately; agents hold no environment credentials.

The five shared values (bucket, endpoint, signing region, passphrase and input document) must match. Saved-plan handoff binds private backend/settings, plan bytes, source/run and relevant policy/control/enrollment code. Compare and Apply refuse mismatches before effects. The full-plan policy is advisory in the manual workflow; it never removes the `infra` approval gate.

### `TOFU_VARS`

Exactly nine fields, with no legacy/default adoption map. Use `examples/example.tfvars.json` as a **placeholder shape**, never evidence of account image, flavor or database settings. Values and keys are checked by `scripts/infra-inputs.ts`, the Bun policy and sensitive OpenTofu variables. Unknown fields are refused.

| Key | Private value |
| --- | --- |
| `hosts` | Map keyed `staging` or `production`, optionally `-N`. Each object has `label`, `fqdn`, `role`, `image_id`, `flavor_id`, `network_id`. Role matches the key's prefix. Resolve and verify the selected image/flavor/network IDs privately; do not commit them. `{}` builds no VM. |
| `ovh_project_id` | OVH Public Cloud service/project identifier. |
| `openstack_project_id` | OpenStack tenant identifier for the same selected account/project; do not assume the two identifiers are interchangeable. |
| `databases` | Map keyed by 1–16 lowercase letters. Each object has `description`, PostgreSQL `version`, `flavor`, positive integral `disk_size_gb`, and UTC `backup_time`/`maintenance_time` in `HH:MM:00` form. Essential/single-node/region/deletion protection are fixed. `{}` creates no service. |
| `root_keys` | Public Ed25519/FIDO key lines; FIDO may carry `verify-required`. Never an agent VM key. |
| `configure_keys` | Role to the public Ed25519 half of that environment's `ANSIBLE_SSH_KEY`. |
| `root_password_hash` | Empty to lock root's password, or an owner-generated yescrypt/SHA-512 console hash. |
| `cloudflare_zone_id` | Selected private zone identifier. |
| `db_allow_extra` | Additional explicit IPv4/IPv6 CIDRs, including retained old-host access when separately reviewed. |

Only validated role/database keys appear in public resource addresses, for example `openstack_compute_instance_v2.host["staging"]`. All private identifying host/database strings, project/zone IDs, extra CIDRs/bare addresses, key blobs and the console hash are masked before other output. Mask commands escape `%` and line breaks. Native diagnostics and decrypted JSON stay in private runner files; the saved plan alone may leave the job, encrypted and retained for one day.

## Operating it

Infrastructure remains dispatch-only from `main`, first attempts only, with one queued writer group. The owner alone approves/rejects jobs; an agent dispatches only when asked in that session. `operation=plan` previews only. `operation=apply` requests review of the exact saved plan. `operation=baseline` establishes only the initial unchanged applied-input record and invokes no provider Apply. `operation=adopt` is no longer supported.

Plan uses read-only credentials and `-lock=false`. Apply never replans and uses the exact encrypted artifact after digest/change-list/input/backend/run/code comparison and native stale-state checks. An unknown action/address is refused. Deletes/replacements require `allow_destroy`; restriction removals require `allow_access_removal`. Service destruction also remains protected by OpenTofu lifecycle and OVH deletion protection. No override makes an import or another provider acceptable.

All VM lifecycle/security/network/image/flavor/power changes, firewall changes, service creation/settings changes, broad/external restrictions and removals remain owner-reviewed. Only a VM display-name change, bounded unproxied DNS TTL change, or fully known unchanged-host address additions preserving **whole old restriction entries** can qualify for the automatic allowlist. There must be a complete independently persisted baseline and complete matching resource/output evidence. The automatic lane stays disabled regardless of classification.

There is no backend lock today. All writers, including hand runs and recovery, must cooperate with the concurrency boundary; readback/version history is not a distributed lock. A refused or interrupted write is not permission to retry.

### Experimental control records

Leave `TOFU_CONTROL_RECORDS_ENABLED` off until intended-backend persistence/version-history/recovery acceptance passes and the owner enables it. New-host creation requires enabled records and a completed baseline. The owner-approved Apply checks project/instance UUID/region/image/flavor/public-network addresses, observes a stable Ed25519 key, persists it before SSHFP publication, and validates A/AAAA/SSHFP with packaged local Unbound. Infrastructure remains pending until enrollment and exact persistence readbacks finish. A later ordinary Host deployment uses strict SSH and the stored key; it never relearns trust.

Pending operations, uncertain reads/writes, missing history or conflicting generations stop later mutations. Fence competing writers and reconcile actual provider/state/record outcomes. Do not disable records, delete pending references, restore only newest objects or blindly rerun Apply to bypass recovery. See [recovery](../../docs/PIPELINE.md#recovery).

### Private-backend acceptance

Local S3 rehearsals do not accept the intended service. The owner checks these privately using disposable objects and a separate acceptance bucket; credentials/state/plans never enter an agent session:

1. Read back environment protections and matching shared settings. Verify the selected [OVH US Standard S3 endpoint/signing region](https://support.us.ovhcloud.com/hc/en-us/articles/10667991081107-Object-Storage-Endpoints-and-geoavailability).
2. Use standard S3 bucket-versioning read/write operations to enable/read back versioning. Inspect lifecycle retention: no expiration may discard current/noncurrent `tarubot/control/` history needed for recovery. Backup retention is not a control-record retention policy.
3. With pinned OpenTofu and native PBKDF2/AES-GCM, use a provider-free disposable module to write encrypted state, plan with read-only storage credentials, transfer the exact encrypted bytes and Apply with write credentials. Verify result/digest; advance disposable state and require stale-plan refusal. Wrong passphrases must fail.
4. Exercise native Bun `infrastructureRecords`, `S3ControlStore` and `hostEnrollmentRecords` over verified TLS/virtual-hosted routing with explicit `us-east-va`. Verify ciphertext readback, read-only write refusal, authentication failure distinct from missing objects, and access to retained noncurrent versions. An allow-only policy on a bucket owner is not evidence of write refusal.
5. Interrupt after first-key persistence and simulate lost acknowledgements. Fresh readers must refuse pending operations. Recover selected related versions with standard S3 tools following [the recovery table](../../docs/HOSTING.md#infrastructure-and-enrollment-records); clear the host pending index last and retain old versions.

`tofu state pull` already decrypts to private raw JSON; pinned 1.12.6 has no `-unencrypted` flag. Derive lineage/serial evidence with `stateEvidence`, not `show -json`. Keep all evidence under umask 077. Record only reviewed commit, tool versions, target role, outcomes/refusals and unexercised cases publicly. Keep activation switches off until their corresponding acceptance is complete.

## The first apply

Use a **new, isolated OVH backend**, never the live Linode state. There is no state/address conversion or live-cluster adoption shim. The owner must verify least privilege, backend acceptance, the d2-2/AlmaLinux 10-UEFI/public-network contract, dual-stack availability and database quote first.

The durable controller requires existing encrypted raw state, even for an empty baseline. Privately initialize that isolated backend through a reviewed, provider-free bootstrap with `hosts={}` and `databases={}`, keeping all other required inputs explicit; verify encrypted state/lineage and zero managed resources. Bootstrap does not provision a host/database. After acceptance, enable records and dispatch `operation=baseline`, approving only a complete unchanged plan.

Add the owner-verified staging inputs and new database settings only after that baseline. Review the new VM/group/six rules/DNS/service plan; unknown address restrictions are not automatically safe. Approval includes first enrollment. Check the new service/host's actual identity and restrictions privately. Keep production's data, Compose path and current database credentials untouched. Database migration, staging token movement, live application startup and production cutover are separate owner steps and acceptance records.

## Pinning a new host key

Until replacement Host trust is accepted, the existing manual Host path still uses the owner's `TARGET_HOST_KEY` pin. From the owner's machine, compare the observed Ed25519 fingerprint with the guest console before setting that environment secret; resolve the hostname to the newly applied addresses, not old ones. Agents never hold `ANSIBLE_SSH_KEY` or pin operational trust.

```sh
ssh-keyscan -q -t ed25519 <name> 2>/dev/null | cut -d' ' -f2- | gh secret set TARGET_HOST_KEY --env <role>
```

The secret contains only `ssh-ed25519 <key>`, not a hostname/banner. The manual path also needs owner-set `TARGET_HOST` and `ANSIBLE_SSH_KEY`. Missing/changed trust stops delivery; do not suppress host-key checking. Production Compose remains unchanged.

## Rebuilding a host

Replacement is refused before Apply: first enrollment handles only new hosts and cannot reuse an old generation's trust. `replace=openstack_compute_instance_v2.host["<key>"]` plus destroy/access-removal switches can produce a reviewable plan, not authorize Apply until owner-fenced trust recovery is implemented and accepted. Never delete a trust record or silently change its key to bypass that refusal.

`replace` is read from the dispatch payload, not public step `env:`; invalid input is never echoed. Access-key/hash changes are deliberate creation-only intent and are not routine host updates.

## A hand run when Actions is down

Owner-only, with explicit authorization and all automation/other writers fenced first. An outage does not prove existing runners stopped. Use the exact shared private backend/inputs, phase-scoped OVH/OpenStack/Cloudflare credentials and state passphrase in a private temporary directory; never commit them. Apply only a reviewed encrypted saved plan, preserving journal/enrollment verification and recovery rules. A direct native Apply must not bypass unresolved intent or trust checks. Agents never run real `plan`, `apply`, imports or state edits.

## Checks and upgrades

Credential-free checks (CI's Infrastructure checks):

```sh
export TF_VAR_state_passphrase=ci-only-throwaway-state-passphrase
tofu -chdir=ops/tofu fmt -check -recursive
tofu -chdir=ops/tofu init -backend=false -input=false -lockfile=readonly
tofu -chdir=ops/tofu validate
tofu -chdir=ops/tofu test -var-file=examples/example.tfvars.json
```

Native mocks test signed provider schemas and the exact rendered examples, not the real service. CI also schema-checks cloud-init with jsonschema installed. Bun tests exercise complete policy/refusal evidence and native CLI-to-controller transports with invented values, including stale state, pending enrollment and endpoint/region handoff changes. Offline checks never establish real enrollment, backend retention or live readiness.

Upgrade OpenTofu only after verifying its signed release SHA256SUMS, updating `.opentofu-version`/`opentofu.sha256` and any required version constraint. Upgrade provider constraints and `.terraform.lock.hcl` together, using `init -upgrade -backend=false` and `providers lock` for `linux_amd64`, `linux_arm64`, `darwin_amd64`, `darwin_arm64`; review signing evidence, schema/policy fields and all affected tests. Exact OVH/OpenStack releases and Cloudflare's release line remain pinned. Dependabot does not update these provider pins.
