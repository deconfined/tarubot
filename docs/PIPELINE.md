# Release pipeline

The [agreed threat model](THREAT_MODEL.md) governs this design: minimal complexity, standard components and protection against realistic mistakes, abuse and failures. This document keeps the intended flow and unresolved acceptance criteria. Implementation history belongs in commits and PRs.

## Current status

Production still uses Compose. Staging uses the reviewed Ansible host and bot playbooks, with a manually pinned host key. Infrastructure is dispatch-only: read-only Plan, then owner-approved Apply. The full-plan classifier is advisory; automatic Apply is disabled.

The integrated replacement publisher, automatic enrollment and staging-gated production path are **not ready for activation**. Offline tests and implementation commits do not establish live acceptance. Experimental control/connection tooling remains fenced pending simplification under the threat model. See [DEPLOYMENT](DEPLOYMENT.md) for implemented operations and [HOSTING](HOSTING.md) for recovery.

## Intended flow

1. Review and merge to protected `main`; pass CI and security checks. An explicit version increase declares a release; maintenance merges publish no bot image.
2. Build AMD64 and ARM64 images, scan their exact digests and publish a GitHub attestation for the resulting image index. Verify the exact publisher identity and digest before use.
3. Plan infrastructure with read-only credentials. Classify the complete plan as no change, a permitted automatic update or owner review required. Apply only the exact saved plan.
4. Establish or verify durable SSH trust for the applied host generation, including locally validated DNSSEC SSHFP.
5. Run Configure from the reviewed configuration commit, then the release's Bot playbook on staging. Use ordinary Ansible and strict OpenSSH after deployment-level checks.
6. Verify that staging runs the exact image and expected schema, and passes practical acceptance.
7. Request the owner's production approval. Recheck release, target and trust before production deployment, then verify its health.

A reviewed workflow in its intended protected environment is the command authority. Configure deliberately has root. A separate worker broker, custom OCI measurement or fresh authorization proof for every Ansible command is outside this design.

## Ownership

| Component | Responsibility |
| --- | --- |
| OpenTofu | Hosts, firewalls, A/AAAA records and database access lists; optional import-only adoption of the existing managed cluster. |
| cloud-init | First-boot public login keys and optional root console password hash. The guest generates its own SSH host key. |
| Ansible | Host configuration from reviewed `main`; bot deployment from the selected release. Use `ansible.builtin`, with no Galaxy dependencies. |
| Enrollment | Persist the first host key for an explicitly approved new generation and write its SSHFP record. |
| Owner | Environment credentials, protection rules, sensitive infrastructure changes, enrollment/recovery and production approval. |

Retain Linode compute, the existing managed PostgreSQL cluster and private object storage. Hosts use AlmaLinux 10, enforcing SELinux and rootless Quadlet. Do not provision a replacement database as a shortcut. Detailed inputs and owner procedures live in the [OpenTofu runbook](../ops/tofu/README.md).

## Infrastructure safety policy

Compare the complete private `tofu show -json` result, including actions, imports, known values, outputs and relevant unknowns. Compare intended inputs against the last verified applied-input baseline as well: creation-only fields ignored by lifecycle rules must not conceal security drift. Missing, unrecognized or uncertain evidence cannot authorize an automatic update.

The automatic allowlist is deliberately small:

| Complete plan | Decision |
| --- | --- |
| Recognized no-op resources and outputs, with no imports | No change. |
| Existing VM label only | Safe update. |
| TTL only on existing unproxied A/AAAA records, within 300–3600 seconds | Safe update. |
| Database access-list additions consisting only of unchanged module-managed host IPv4 `/32` or IPv6 `/128` addresses, preserving every previous entry | Safe update. |
| Provisioning, import, rebuild, deletion/replacement, image, network, firewall, power, keys, security settings, database mutation, access removal/widening, or anything outside the allowlist | Owner review required, or invalid. Never automatic. |

Existing-cluster adoption is a separate import-only operation. The owner records actual settings privately; the saved plan must import the expected cluster without remote changes. A separate read-only no-change verification follows Apply. Defaults and example values are not evidence of existing settings.

Public summaries contain fixed decisions/reasons and safe counts, not hostnames, addresses, account/zone/cluster IDs, keys, private plan values or raw diagnostics. Encrypt state, saved plans and retained records. Keep decrypted plan/state JSON and provider responses in private working memory/files and remove them when the operation ends.

## Plan transfer, credentials and concurrency

Plan uses the read-only `infra-plan` environment on `main`, without a reviewer. Sensitive Apply uses `infra`, with the owner's approval. A future automatic safe-update lane needs a separately owner-created environment; do not weaken `infra` or treat advisory classification as permission to write. Environment administration belongs to the owner under [AGENTS](../AGENTS.md).

Encrypt state and saved plans using native OpenTofu facilities. Bind a saved plan to its bytes, private backend/settings, intended inputs, source execution and policy version. Apply verifies those bindings and native stale-state checks, then applies that file using write credentials. Never replan with write credentials as a substitute.

Serialize infrastructure writers globally and host/enrollment/recovery operations per target using standard Actions concurrency. Retain queued work rather than canceling an active mutation; avoid nested concurrency groups that deadlock. The backend has no state lock today. Manual recovery must fence automation and all other writers. A new distributed lock service is not required.

## Durable SSH trust

The owner explicitly approves enrollment of a new, not-yet-enrolled host generation. Bind it to the instance and addresses from successfully applied state. Observe a consistent Ed25519 key and persist it before SSH authentication. TOFU's first-observation interception risk is accepted; DNSSEC does not retroactively remove it.

Only enrollment writes the expected SSHFP algorithm 4, digest type 2 record. Validate DNSSEC with a standard local validating resolver; a remote server's AD bit alone is insufficient. Ordinary deployment requires a matching validated record and the durable enrolled key.

Use strict OpenSSH `known_hosts`, binding the literal destination address to that key. Disable opportunistic key updates and DNS-based replacement (`UpdateHostKeys=no`, `VerifyHostKeyDNS=no`); use batch operation with the intended identity and no ambient agent/global trust fallback. Do not use `accept-new`, silently relearn a missing key or replace stored trust from DNS alone.

A rebuild or legitimate rotation requires owner-fenced recovery and a new approved generation. Missing, conflicting or changed trust stops deployment. The current manual pinning procedure remains in the [OpenTofu runbook](../ops/tofu/README.md#pinning-a-new-host-key) until automatic enrollment is accepted.

## Recovery

Keep small encrypted, private, versioned records for operation intent/outcome, the applied-input baseline and enrolled trust. Persist intent and its pending reference before a mutation; confirm persistence by readback. A new baseline/generation is usable only after its operation has verified completion; pending operations block it. Use unique generations and preserve history.

A canceled runner, lost acknowledgement, pending operation or conflicting readback does not establish whether the remote effect occurred. Stop competing writers, inspect actual provider/state/host outcomes and reconcile the related records before another mutation. Do not blindly retry, overwrite history, delete a pending marker or restore only the newest object to clear an error. Versioning and readback are recovery aids, not a lock or protection against unrestricted authorized deletion.

Use established encrypted backup tools and the [HOSTING recovery procedure](HOSTING.md). A database restore must account for external Discord effects and preserve the one-writer boundary. Schema-incompatible rollback requires owner recovery or a fix forward. Accepted recovery limits are in the threat model.

## Acceptance

Before enabling the replacement path, demonstrate:

- Exact publisher identity, architecture/index digests and schema binding throughout publication, staging and production admission.
- Real encrypted-state/plan compatibility and private-record persistence against the intended backend; exact saved-plan Apply, stale-plan refusal and owner-reviewed import-only database adoption.
- Owner-approved enrollment followed by ordinary strict SSH; missing/changed keys and DNSSEC failure stop a deployment.
- A complete disposable-host rehearsal, including interruption, unhealthy release and recovery, using invented data and credentials.
- Actual staging startup, sustained readiness, Discord connection and sole database writer lease; command registration, representative authorized commands, the backup timer and a restore drill.
- Owner-reviewed production cutover preserving approval and recovery, followed by separate removal of retired paths.

A green build, configure-only run, skipped job or old fixture does not satisfy these checks. Keep remaining work in issues/PRs ([pipeline work](https://github.com/deconfined/tarubot/issues/62), [live behavior acceptance](https://github.com/deconfined/tarubot/issues/46)), and record version/commit, target role, checks and unexercised cases there. Do not recreate a release-by-release diary here.
