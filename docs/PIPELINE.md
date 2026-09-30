# Release-integrated infrastructure pipeline

## Status and scope

This is the implementation specification for the next pipeline, not a claim that it is deployed. [DEPLOYMENT](DEPLOYMENT.md) describes the shipped path. Keep the milestone table below current as code lands. A contributor should need this specification, the code and its tests, not a resumed conversation.

The agreed direction is **safe auto-apply**, using the existing Linode PostgreSQL cluster, AlmaLinux 10 with SELinux enforcing, Ansible and rootless Podman/Quadlet. The documentation site stays in place. Production deployment still requires the owner's GitHub environment approval. Credentials stay in GitHub Actions secrets, never in the checkout, user data or an agent session.

The owner selected **durable automatic trust on first use (TOFU)** for initial SSH enrollment. This accepts possible interception of the first observation. DNSSEC/SSHFP protects subsequent connections; it cannot authenticate that first observation retroactively. Hosts generate their own SSH keys; normal enrollment needs no manual pinning.

Authorization remains unchanged: this document authorizes no live operation, environment change, workflow dispatch, shared-bot restart or Discord write. Do not repurpose approval-gated `infra` to bypass its reviewer. Production's byte-pinned Compose files and `deploy`/`notify` jobs remain unchanged until a separately reviewed cutover; prepare that separately from staging/safety work.

## Target release flow

```text
PR checks + security + code-owner review
  → merged-main validation
  → build AMD64/ARM64 → scan both images → publish → sign exact index digest
  → verify release identity → infrastructure plan → classify
      no changes: continue
      safe changes: apply exact saved plan → verify infrastructure
      review required / invalid: stop automatic promotion
  → verify SSH trust → Configure staging → deploy exact digest
  → staging acceptance for this digest and schema
  → owner's production environment approval
  → reverify release/state/trust → deploy production → verify + notify
```

- Bind version, source/configuration commits, image index digest, publication run, plan digest and policy revision. A mutable tag is not evidence. Preserve exact provenance identity/ref/commit verification and migration immutability.
- PR/fork/suggestion/build/scan code receives no deployment/provider credentials. Pin actions, tools and providers. Separate build registry write from signing OIDC/attestation write permissions.
- Scan each platform's built digest with a pinned scanner for fixable high/critical vulnerabilities. Exceptions are reviewed, bounded, reasoned and expire. Scan errors or expired exceptions block signing/promotion. Candidate blobs may be published before scanning, but no signed/promoted deployable release bypasses it.
- Plan infrastructure for merged releases, including infrastructure-only changes. Documentation-only changes may skip host deployment, not required identity/security verification. Production-only recovery is an explicit reviewed dispatch, distinct from automatic promotion.
- Missing hosts/credentials, skipped jobs, `configured`, `preflight-ok`, `superseded` and green publication never satisfy staging acceptance. Failed/absent staging blocks automatic production promotion.
- Partial apply, stale plan, lost result or uncertain host outcome blocks downstream deployment; do not assume the previous state survived unchanged.

## Infrastructure ownership and existing-cluster adoption

| Layer | Owner |
| --- | --- |
| Existing cluster, VM, firewall, A/AAAA records, database access controls | OpenTofu; each field has one writer |
| First-boot hostname, public login keys, optional console hash | cloud-init; private host keys generated locally |
| Packages, sshd, users, SELinux, updates | reviewed configuration commit's `site.yml` as root |
| Runtime secrets, rootless unit, migrations, backups, commands | release commit's `bot.yml` |
| Durable enrollment and SSHFP publication | dedicated enrollment job; no competing OpenTofu SSHFP writer |
| Secrets, protection rules, provider/account changes, destructive recovery | owner |

The current module imports access controls, not the cluster. Extend it with `linode_database_postgresql_v2` at the pinned provider version and a declarative import of the privately supplied existing identifier. Never infer current settings from examples or retrieve admin credentials into an agent session.

1. The owner records current region, engine/version, plan, node count, SSL/encryption, maintenance and supported settings privately. Match them exactly; check the pinned provider schema for computed credentials/defaults affecting import.
2. Add `prevent_destroy`; independently forbid cluster creation, deletion, replacement and automatic mutation in policy. Removing the block can remove lifecycle protection, so it is insufficient alone.
3. Preserve the existing access-control resource/state address. The cluster resource must not also write `allow_list`; ignore that overlapping field if the provider exposes it on both resources. Resolve other overlapping writers before adoption.
4. First plan has **only expected imports with no remote mutations**, matching current access controls, including old production addresses. No import-plus-update, host build, resize, upgrade or credential reset.
5. Owner-approved Apply imports that exact encrypted saved plan. Verify unchanged cluster identity/settings, a subsequent no-change plan and production readiness. Record public-safe results, not identifiers.
6. Provision staging in a separate reviewed plan. Retain old production access until its separately approved move/acceptance. Rebuilding a VM never justifies replacing the database.

Cluster state/provider reads may include admin credentials. Read-only database tokens are credential-sensitive; encryption, runner lifetime, least permissions and filtering apply to reads too.

## Safe-plan policy

Classify the **full private `tofu show -json` output**, not the summary or change counts. Return fixed public-safe decision/reason codes and counts only. Missing, malformed, unsupported or contradictory evidence fails closed; never echo arbitrary addresses, provider text, fields or identifiers.

Initial automatic allowlist:

| Change | Decision |
| --- | --- |
| Complete valid plan, recognized no-ops only, no imports | `no-changes` |
| Existing VM display label only; identity, networking, image, power, size and credentials unchanged | `safe` |
| Existing unproxied A/AAAA TTL only, within 300–3600 seconds; zone/name/type/address unchanged | `safe` |
| Existing access list adds only module-managed unchanged hosts' known IPv4 `/32` or IPv6 `/128`, preserving every previous entry | `safe` |
| Import-only adoption, initial VM/DNS/firewall creation, firewall edits, resize/reboot/network/image changes, enrollment/replacement | `review-required` |
| Cluster mutation, access removal/widening, credentials/keys/hash change, delete/replace, unknown critical values or unrecognized resource/field | Never automatic; `review-required` or `invalid` |

Implementation rules:

- Match provider source, type/name, canonical root-module address and configured public role/key. Reject deposed resources, unexpected modules, duplicates, unsupported actions and unknown resource kinds even on no-op. Validate format/version, completion/error flags, checks and resource/output changes; missing lists are not evidence of no changes.
- Compare every before/after field, not selected fields. Allow only named configurable differences, accounting explicitly for computed fields using the pinned schema. Unknown/sensitive configurable differences cannot become safe by omission. Output-only changes also need recognition.
- Unknown new-host addresses are not safe additions. Review host provisioning, then replan once addresses are known. The existing summary's count reconstruction remains presentation only.
- Preserve previous access entries byte-for-byte. Broad CIDRs, unrelated addresses and arbitrary `db_allow_extra` additions need review even without removals. Drift correction outside the allowlist is never automatic.
- Compare private planned/current inputs, including creation-only/ignored keys/hash. Bind both environments' backend identity and inputs to the saved plan. Policy changes require code-owner review.
- Automatic runs have no destroy/access-removal/replace/target/override switch. Sensitive operations require a fresh owner-reviewed dispatch/plan, never a silent fallback from failed automatic policy.

### Plan transfer, credentials and concurrency

Retain enforced native state/plan encryption and one-day encrypted-plan artifacts. Upload no plaintext state/JSON plans, credentials, inventories, trust records or provider logs. Private temporary files use `umask 077` and cleanup on every exit. Before Apply, recheck bytes, release, private inputs, backend binding, freshness and classification; apply the same file, never replan with write credentials.

| Gate | Credentials and authority |
| --- | --- |
| `infra-plan` | Existing main-only read-only planning credentials, no reviewer |
| `infra` | Existing main-only owner-approved writes for imports/builds/sensitive changes |
| Proposed `infra-auto` | Separate main-only write credential environment, owner-provisioned with no reviewer; policy is its execution gate |
| `staging`, `production`, `notify` | Retain target isolation and production approval; enrollment/host secrets load only for their target |

The owner creates/readbacks the safe lane and accepts reviewed workflow code gating its write credentials. Do not remove `infra`'s reviewer. Enrollment tokens need only intended-zone DNS edit and private trust-store access.

Use one shared infrastructure concurrency group across dispatch/release callers, without cancelling queued/running work. Serialize Configure/deploy/enrollment per target. Avoid nested reusable workflows holding the same concurrency group while waiting on each other. Verify backend conditional locks in a disposable lab before enabling them; until then serialization and no overlapping hand runs is the supported boundary, not a distributed-lock claim. Saved-plan staleness does not make concurrent provider writes safe. Recheck obsolete releases before credential gates and after waiting for approval.

## Durable SSH TOFU and DNSSEC SSHFP

### Enrollment

1. Privately obtain provider instance identity/addresses from successfully applied state. Require target A/AAAA resolution to agree, and wait boundedly for DNS/SSH. A hostname is not an instance identity.
2. Look up a durable record by target role and provider instance identity. Runner caches, fresh `known_hosts` and public artifacts are not trust stores. Use private encrypted object storage with version history, restricted writers and tested conditional create/update.
3. With no record, consistently observe exactly one valid Ed25519 key on reachable expected addresses. Atomically persist it **before** authentication/configuration, with instance/address binding, enrollment generation/time and SHA-256 SSHFP. Conflicting concurrent enrollment or failed persistence blocks deployment. Consistency checks do not eliminate the accepted first-use interception risk.
4. With a record, require an exact match. Never use `accept-new`, relearn, fall back to an empty file or overlook a missing record for a previously enrolled instance. Mismatch, lost trust or ambiguous identity stops delivery and alerts the owner.
5. Rebuild/rotation needs a separately approved enrollment generation after fencing the old host. Changed instance/hostname alone cannot authorize forgetting trust. Seeding existing manual pins is owner-authorized migration, not silent pin removal.

### Publication and connection

Publish **`SSHFP 4 2`** (Ed25519/SHA-256) from the persisted key. The enrollment job is the sole SSHFP writer. Update only the expected record/name/type and retain a private trust-revision journal; never remove unrelated records or publish private keys. Initial enrollment/rotation is outside general safe auto-apply.

Cloudflare DNSSEC enablement alone is insufficient. Verify the parent DS/DNSKEY chain using a pinned local validating resolver, not an untrusted remote AD bit. Test bogus/insecure/missing/stale answers; wait boundedly for authoritative publication and validated resolution.

Connections require strict Ed25519 checking against the durable record, a private explicit `known_hosts`, `UpdateHostKeys=no`, batch mode and no global/agent fallback, **plus** matching DNSSEC-validated SSHFP. Never warn-and-continue on absent/bogus/mismatched DNSSEC. SSHFP cannot authorize replacing durable trust. If inventory uses `HostKeyAlias=target`, validate the real DNS name explicitly rather than querying that alias. Mask names/addresses/keys/fingerprints first; keep diagnostics private or fixed-code only.

Trust recovery is an owner-authorized restore from protected version history or newly authenticated observation. An old record must not accept unintended rotation. Provider identity lookup, conditional storage APIs and the local validating resolver are prerequisites, not yet proven capabilities.

## Deployment, staging acceptance and recovery

Preserve builtin-only Ansible, enforcing SELinux, one updater, rootless units with no exposed bot port, verified database TLS and runtime Podman secrets. Keep reviewed configuration and release bot commits explicit. Identity/schema/secret/candidate-unit checks precede mutation; one application has exactly one writer.

Fix these current recovery gaps before promotion-ready Quadlet delivery:

- `ops/ansible/bot.yml` restarts before collecting its stop-time restore point. Restart/ExecStartPre failure can leave `restore_point=-` after committed migrations. Capture old-writer stop boundary/schema durably before migration/start and report them on failure. A timestamp is not proof of provider PITR recoverability.
- `.github/workflows/host.yml` suggests image rollback on unhealthy results without proving schema compatibility. Recommend it only with explicit unchanged-schema evidence; otherwise fix forward/owner-controlled restore. Missing evidence is not same-schema evidence.
- Unreachable hosts/lost results are `outcome-unknown`, not “nothing changed.” Never blindly rerun, restore, start an old worker or remove state. Inspect/fence the writer and live image/schema first.

Staging acceptance binds **this digest/commit/schema**: readiness/database/Discord/lease, a no-restart stability interval, command registration/readback, backup timer and successful encrypted backup. Use a separate database/role and distinct application. Preflight/synthetic checks cannot replace a healthy live bot. Initial setup and backup/schema/recovery changes need a decrypt/restore drill on scratch PostgreSQL, never a live database. Discord-writing acceptance remains owner-authorized.

Failure stops promotion and retains redacted phase/schema/restore evidence. Image rollback needs unchanged schema and a fresh authorized dispatch; no automatic database rollback. Committed migrations require compatible fix-forward or owner-approved restore/fencing. Production cutover fences/stops Compose before Quadlet, retains the existing cluster/data, verifies one writer and preserves recovery. Do not extend `ops/deploy.sh`'s unused legacy Quadlet modes.

## Implementation milestones and acceptance

Each milestone is a coherent signed commit/version change with tests. Code availability and owner-enabled operation are different states.

| Milestone | Deliverable | Status |
| --- | --- | --- |
| 1. Specification | This document and contributor/deployment links | Documented; no runtime change |
| 2. Safety foundation | Full-plan classifier, adversarial fixtures, plan/backend/input binding; reviewed lane intact | Next implementation work |
| 3. Database adoption | Import-only v2 cluster configuration and independent guards | Pending; no agent-run live import |
| 4. Enrollment | Durable TOFU, conditional storage, DNS-only SSHFP writer, local DNSSEC validation | Pending prerequisites/tests |
| 5. Staging delivery | Reusable infrastructure flow, owner-enabled safe lane, recovery fixes, exact-release acceptance | Pending |
| 6. Production cutover | Separate reviewed replacement of frozen Compose path and staging-gated promotion | Pending separate review/owner window |
| 7. Activation | Owner sets credentials/gates, imports cluster, enrolls hosts, rehearses recovery, enables flow | Owner only; not performed |

Offline checks: contributor quality/build/unit/contract checks; synthetic Docker/PostgreSQL suite; shell/workflow checks; OpenTofu fmt/validate/mock plans; Ansible syntax/lint/template checks; site build if user-facing pages change. No root Bun site scripts.

Policy fixtures cover allowed fields and one-field deviations; import-plus-update; deletes/replaces/deposed; wrong providers/modules/indexes; duplicates; ignored-input/credential changes; database settings/removal/widening/unrelated additions; unknown addresses; exposure/drift/output-only changes; incomplete/error/check-failed plans; stale/wrong plan/backend/release; hostile-value redaction. Run phase tests with stand-ins, never live credentials.

Enrollment fixtures cover first/repeat trust, changed key/instance/address, lost record, concurrency/storage failure, invalid keys, SSHFP publication races, DNSSEC failures and leakage. Delivery tests prove failed/skipped/non-deployed staging blocks production, schema-aware recovery, migration/restart-failure evidence and single-writer fencing.

Owner-authorized disposable-lab rehearsal precedes activation: TLS database/S3, DNSSEC, TOFU persistence/conflict/rebuild, two idempotent Configures, isolated healthy deploy/stability/readback, reboot, backup/restore, migration and partial-failure recovery. Only separate live acceptance proves real staging runs.

### Remaining inputs and prerequisites

- Owner's private cluster baseline, supported v2 schema/import behavior and state mapping; no agent credential/state retrieval.
- Owner creation/readback of the safe-apply gate and scoped credentials; no environment setup as a code side effect.
- Private trust backend with verified atomic conditional writes/version retention, provider identity lookup and pinned validating resolver; no ephemeral-cache substitute.
- Reviewed production cutover, single-writer/restore window, DevBot token move and scanner exception policy. A docs merge implies none of these operations.

Record acceptance in CI and concise PR/issue evidence, not duplicate handoff diaries. Update [DEPLOYMENT](DEPLOYMENT.md) when a path ships, and public self-hosting pages when behavior changes, using placeholders only.
