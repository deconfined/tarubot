# Release-integrated infrastructure pipeline

## Status and scope

This is the implementation specification for the next pipeline, not a claim that it is deployed. [DEPLOYMENT](DEPLOYMENT.md) describes the shipped path. Keep the milestone table below current as code lands. A contributor should need this specification, the code and its tests, not a resumed conversation.

The agreed direction is **safe auto-apply**, using the existing Linode PostgreSQL cluster, AlmaLinux 10 with SELinux enforcing, Ansible and rootless Podman/Quadlet. The documentation site stays in place. Production deployment still requires the owner's GitHub environment approval. Credentials stay in GitHub Actions secrets, never in the checkout, user data or an agent session.

**Initial provider: Linode**, for compute, the existing PostgreSQL cluster and private Object Storage. Object storage conditional writes are not required. Use workflow-serialized writes and verified persistence, not a distributed-lock claim; retain native passphrase-based state/plan encryption and GitHub environment secrets. No external lock service, Secret Manager or KMS is a prerequisite. OVH remains an optional later owner-selected migration, requiring separate review and recovery/cutover acceptance; do not add a second provider or replace the current database for this implementation.

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

The module optionally imports `linode_database_postgresql_v2` through the private `existing_databases` map, using existing `database_ids`. Empty or omitted configuration preserves the access-controls-only path. The owner supplies exact current settings; examples cannot establish those settings. Never retrieve admin credentials into an agent session. See [the adoption runbook](../ops/tofu/README.md) before changing private inputs.

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

Use the shared `infra` concurrency group across every dispatch/release infrastructure writer, including applied-input baseline updates; retain `cancel-in-progress: false` and `queue: max`. Serialize Configure/deploy/enrollment and each target's trust/SSHFP writes in its shared target group. Avoid nested reusable workflows holding the same group while waiting on each other. Recheck obsolete releases before credential gates and after waiting for approval. Superseded/skipped work never counts as acceptance.

This is repository-local single-writer coordination, not a storage lock or distributed lease. Keep native S3 locking disabled; a read-then-PUT lock object or expected-revision check is not compare-and-swap. Saved-plan staleness does not make concurrent provider writes safe. All writers must use these groups and scoped credentials. Before a hand run, the owner fences automation and verifies that no running or queued job can overlap; agents never change workflow/environment controls to create that window. A future backend lock is optional and needs separate review and disposable-lab compatibility tests, not a provider move now.

### Durable control records and interrupted writes

Keep applied-input baselines, operation journals and SSH trust in private encrypted versioned Linode Object Storage, with restricted writers, owner-controlled recovery and tested write/readback visibility. Plan reads records without writing. Each mutable current-generation pointer has one designated serialized writer; per-target enrollment cannot update the shared infrastructure baseline.

1. Write each record under a unique operation/generation key and never intentionally overwrite historical records. This is an append-only convention, not storage-enforced immutability. Bind the record to its role/backend, instance or state identity, previous generation, workflow commit/run and relevant plan/input/policy digests. Preserve state lineage/serial evidence with an applied-input baseline.
2. Under the writer's concurrency group, validate the expected previous generation and absence of an incomplete operation. Initial baseline/enrollment establishment is an explicit owner-reviewed operation; missing records do not mean an empty safe baseline or permission to relearn trust.
3. Before provider, trust or DNS mutation, persist an operation intent and its pending-operation reference, and verify both by exact readback. An intent permits only that operation's bound inputs, not arbitrary recovery writes.
4. After successful Apply and infrastructure verification, persist/read back the completed applied-input baseline, advance/read back its current-generation pointer and then mark/read back the operation as complete. Enrollment similarly persists and verifies trust before authentication and records verified SSHFP publication before completion. Downstream promotion waits for complete evidence.
5. Failed or ambiguous writes, stale/conflicting generations, partial Apply and interrupted pointer/completion updates block subsequent mutation and promotion. Never clear an intent in unconditional cleanup, infer that an absent success record means no remote change, or blindly rerun Apply. Owner-authorized reconciliation establishes actual state/trust/DNS outcomes and repairs the journal before work resumes.

Readback verifies persistence, not mutual exclusion. Version history supports recovery, not atomic updates or protection against an unrestricted storage writer. The supported safety boundary is one authorized writer, including during recovery; loss of that boundary stops automation. Restore tests must cover mismatched state/baseline/trust generations rather than accepting whichever object is newest.

## Durable SSH TOFU and DNSSEC SSHFP

### Enrollment

1. Privately obtain provider instance identity/addresses from successfully applied state. Require target A/AAAA resolution to agree, and wait boundedly for DNS/SSH. A hostname is not an instance identity.
2. Under the target writer's concurrency group, resolve the expected trust generation by target role and provider instance identity. Runner caches, fresh `known_hosts` and public artifacts are not trust stores. Use the encrypted, versioned control records and operation journal above; require matching reference/record bindings.
3. Only an explicitly approved, not-yet-enrolled generation may make a first observation. Consistently observe exactly one valid Ed25519 key on reachable expected addresses. Persist/read back the trust record and its generation reference **before** authentication/configuration, with instance/address binding, enrollment generation/time and SHA-256 SSHFP. Missing prior trust, conflicting evidence or failed persistence blocks deployment. Consistency checks do not eliminate the accepted first-use interception risk.
4. With a record, require an exact match. Never use `accept-new`, relearn, fall back to an empty file or overlook a missing record for a previously enrolled instance. Mismatch, lost trust or ambiguous identity stops delivery and alerts the owner.
5. Rebuild/rotation needs a separately approved enrollment generation after fencing the old host. Changed instance/hostname alone cannot authorize forgetting trust. Seeding existing manual pins is owner-authorized migration, not silent pin removal.

### Publication and connection

Publish **`SSHFP 4 2`** (Ed25519/SHA-256) from the persisted key, within the same serialized enrollment operation. The enrollment job is the sole SSHFP writer. Update only the expected record/name/type and retain a private trust-revision journal; never remove unrelated records or publish private keys. Initial enrollment/rotation is outside general safe auto-apply.

Cloudflare DNSSEC enablement alone is insufficient. Verify the parent DS/DNSKEY chain using a pinned local validating resolver, not an untrusted remote AD bit. Test bogus/insecure/missing/stale answers; wait boundedly for authoritative publication and validated resolution.

Connections require strict Ed25519 checking against the durable record, a private explicit `known_hosts`, `UpdateHostKeys=no`, batch mode and no global/agent fallback, **plus** matching DNSSEC-validated SSHFP. Never warn-and-continue on absent/bogus/mismatched DNSSEC. SSHFP cannot authorize replacing durable trust. If inventory uses `HostKeyAlias=target`, validate the real DNS name explicitly rather than querying that alias. Mask names/addresses/keys/fingerprints first; keep diagnostics private or fixed-code only.

Trust recovery is an owner-authorized restore from protected version history or newly authenticated observation, with competing automation fenced. An old record must not accept unintended rotation. Provider identity lookup, serialized encrypted persistence/readback/recovery and the local validating resolver need implementation and rehearsal; conditional storage APIs are not prerequisites.

## Deployment, staging acceptance and recovery

Preserve builtin-only Ansible, enforcing SELinux, one updater, rootless units with no exposed bot port, verified database TLS and runtime Podman secrets. Keep reviewed configuration and release bot commits explicit. Identity/schema/secret/candidate-unit checks precede mutation; one application has exactly one writer.

Quadlet recovery contracts:

- `ops/ansible/bot.yml` now stops the old writer and captures its stop-time boundary before installing/reloading the candidate unit. An existing writer without a captured timestamp is refused. Persist private `~/.config/tarubot/recovery-boundary.json` with previous/candidate image/schema context before candidate migration/start; failure results retain the captured boundary. The previous image's migration head is context, **not** a verified live database schema, and a timestamp is not proof of provider PITR recoverability. Live failure/recovery rehearsal remains pending.
- `.github/workflows/host.yml` no longer suggests blind image rollback on unhealthy results. Require explicit unchanged-schema evidence; otherwise inspect/fence the writer and fix forward or use owner-controlled restore. Missing evidence is not same-schema evidence.
- Unreachable hosts/lost results are `outcome-unknown`, not “nothing changed.” Never blindly rerun, restore, start an old worker or remove state. Inspect/fence the writer and live image/schema first.

Staging acceptance binds **this digest/commit/schema**: readiness/database/Discord/lease, a no-restart stability interval, command registration/readback, backup timer and successful encrypted backup. Use a separate database/role and distinct application. Preflight/synthetic checks cannot replace a healthy live bot. Initial setup and backup/schema/recovery changes need a decrypt/restore drill on scratch PostgreSQL, never a live database. Discord-writing acceptance remains owner-authorized.

Failure stops promotion and retains redacted phase/schema/restore evidence. Image rollback needs unchanged schema and a fresh authorized dispatch; no automatic database rollback. Committed migrations require compatible fix-forward or owner-approved restore/fencing. Production cutover fences/stops Compose before Quadlet, retains the existing cluster/data, verifies one writer and preserves recovery. Do not extend `ops/deploy.sh`'s unused legacy Quadlet modes.

## Implementation milestones and acceptance

Each milestone is a coherent signed commit/version change with tests. Code availability and owner-enabled operation are different states.

| Milestone | Deliverable | Status |
| --- | --- | --- |
| 1. Specification | This document and contributor/deployment links | Documented; no runtime change |
| 2. Safety foundation | Full-plan classifier, adversarial fixtures, plan/backend/input binding; reviewed lane intact | Implemented locally; classification advisory, activation not performed |
| 3. Durable control records | Serialized operation journals, applied-input baselines, verified pointers and interrupted-write fencing | Implemented locally, owner-enabled reviewed path; real backend/plan-shape rehearsal and recovery tooling pending |
| 4. Database adoption | Import-only v2 cluster configuration and independent guards | Implemented locally; private settings, reviewed import and live no-change/readiness evidence remain owner steps |
| 5. Enrollment | Serialized durable TOFU, DNS-only SSHFP writer, local DNSSEC validation | Pending prerequisites/tests |
| 6. Staging delivery | Reusable infrastructure flow, owner-enabled safe lane, recovery fixes, exact-release acceptance | Components implemented locally; code-fenced pending adoption/trust and live acceptance |
| 7. Production cutover | Separate reviewed replacement of frozen Compose path and staging-gated promotion | Pending separate review/owner window |
| 8. Activation | Owner sets credentials/gates, imports cluster, enrolls hosts, rehearses recovery, enables flow | Owner only; not performed |

Offline checks: contributor quality/build/unit/contract checks; synthetic Docker/PostgreSQL suite; shell/workflow checks; OpenTofu fmt/validate/mock plans; Ansible syntax/lint/template checks; site build if user-facing pages change. No root Bun site scripts.

The reviewed Infrastructure workflow adds `operation=adopt`. Establish its durable baseline against unchanged existing configuration first, then add only the exact cluster configuration. The independent guard requires all expected new cluster imports, optional matching access-control imports and no host, ACL, output, drift or other input changes. It rejects cluster creation, update, deletion and replacement even when override switches are set. Apply persists intent and imports the exact encrypted saved plan, then keeps the intent pending. A separate step uses read-only provider tokens to refresh a distinct no-change plan and verifies stable state, original planned values and cluster identity/settings before completing the baseline. Any failure requires reconciliation; it cannot become automatic import authority. This code path has not imported a live cluster or changed an environment.

Policy fixtures cover allowed fields and one-field deviations; import-plus-update; deletes/replaces/deposed; wrong providers/modules/indexes; duplicates; ignored-input/credential changes; database settings/removal/widening/unrelated additions; unknown addresses; exposure/drift/output-only changes; incomplete/error/check-failed plans; stale/wrong plan/backend/release; hostile-value redaction. Run phase tests with stand-ins, never live credentials.

Control-record fixtures cover serialized writer ownership, wrong/stale previous generations, rejected readback, interruption before/after Apply and pointer/completion writes, pending-intent refusal and mismatched version-history recovery. Enrollment fixtures cover first/repeat trust, changed key/instance/address, lost record, concurrency/storage failure, invalid keys, SSHFP publication races, DNSSEC failures and leakage. Delivery tests prove failed/skipped/non-deployed staging blocks production, schema-aware recovery, migration/restart-failure evidence and single-writer fencing.

Owner-authorized disposable-lab rehearsal precedes activation: TLS database/S3, DNSSEC, TOFU persistence/conflict/rebuild, two idempotent Configures, isolated healthy deploy/stability/readback, reboot, backup/restore, migration and partial-failure recovery. Only separate live acceptance proves real staging runs.

### Remaining inputs and prerequisites

The classifier (`scripts/infra-policy.ts`) has no provider/network access or package dependency. The workflow reports its decision but grants no automatic write authority. The owner-enabled control adapter (`scripts/infra-control-cli.ts`) now supplies the independently persisted applied-input baseline. Native Bun S3 writes AES-256-GCM records with a separately domain-derived scrypt key under `tarubot/control/v1/infra/`; it requires neither conditional writes nor package installation. Backend/path binding prevents cross-backend/object replay. Readback and expected-generation checks do not provide mutual exclusion.

The reviewed workflow's `baseline` operation requires existing state, a complete recognized no-change plan and the owner's `infra` approval; it does not invoke provider Apply. Ordinary journaled Apply refuses a missing baseline. After successful Apply, same-lineage advanced state and known planned resource/output values must verify before baseline completion. Decrypted state and plan JSON remain private temporary evidence. Pending references stop subsequent runs, including after a stale-plan failure; there is no automatic journal repair or replay. An orphan intent written before pending publication authorizes no provider mutation.

Activation remains an owner step: verify private versioned storage, scoped permissions and real-provider plan/state shapes before enabling `TOFU_CONTROL_RECORDS_ENABLED` in the required infrastructure environments. The variable defaults off. The handoff binds activation, baseline/state generation, full show JSON, controller code and replacement release identity, and is checked immediately before writes. Run invented-data tests with `bun test tests/unit/infra-control.test.ts tests/unit/infra-policy.test.ts tests/unit/infra.test.ts tests/unit/release-pipeline.test.ts`.

### Replacement components: implemented but activation-fenced

`publish.yml` now scans both runtime child digests before signing, using `scan.yml` and the checksum-pinned scanner in `scripts/release-scan.ts`. It binds raw index bytes to the build-returned digest, rejects missing/duplicate/unsupported platforms, and runs Trivy independently for AMD64 and ARM64. Fixable high/critical vulnerabilities and scanner/registry/database errors stop signing. Repository ignore/config files are not implicitly honored, and no exception path is implemented yet. Candidate version/SHA tags exist before this gate; a failed scan never signs/promotes them. Scanner output remains private and is removed, not uploaded.

The new reusable graph is `release.yml` → `release-infra.yml` → `host.yml`'s acceptance path. Its publisher hook defaults off (`RELEASE_PIPELINE_ENABLED` must be exactly `true`). **A separate code-level failure in admission deliberately blocks activation before any infrastructure/host environment job. Do not set the flag now:** existing-cluster adoption and durable SSH enrollment/DNSSEC are unfinished. Remove that fence only with their reviewed implementations, before owner-authorized disposable-lab/live acceptance. The current host adapter still uses explicit manual pins; that is not the selected durable trust contract. A flag cannot override the fence.

Behind the fence, admission checks exact main publication identity/provenance, the current head and pre-existing main-only `infra-plan`, proposed `infra-auto` and `staging` branch policies (including paginated-policy count). The automatic writer gate must not have an approval reviewer; never repurpose `infra`. Automatic dispatch/re-run authority is refused. Configuration equals the release commit in this lane.

The infrastructure adapter reuses pinned prepare/plan/presentation and encrypted journal components but never the legacy Apply entry point. It holds the existing shared `infra` group over Plan/Apply/completion; full-plan policy, expected state/baseline, plan bytes and keyed handoff are checked again before intent/Apply. A no-change continuation also verifies stable state, known planned values and a completed baseline, without writing. Unsafe/invalid plans stop; there is no reviewed fallback, replace/destroy/access-removal override or automatic reconciliation.

`ops/ansible/accept.yml` runs inside the target host group after a genuine `deployed` result. It checks this candidate's image labels/ID and schema, readiness/database/Discord/writer lease, command inventory using the candidate digest and an enabled active timer. Backup evidence must show a new invocation, later start, completed execution and successful exit; an already running or old successful backup cannot satisfy it. After 60 seconds, the container ID, process start time and restart count must match, and readiness/schema checks run again. The localhost fixture generator exercises the real Ansible assertions against invented success/failure evidence in CI. `scripts/release-acceptance.ts` binds public evidence to version/commit/configuration/index digest/schema/publication run. Configure-only, preflight, absent, failed, skipped or superseded results cannot set `accepted=true`. Lost results remain uncertain; target checks do not prove scratch restore/recovery acceptance.

With the future lane enabled, `latest` requires its exact-release acceptance; manual publication cannot bypass the lane. Successful publication's legacy staging job is suppressed to prevent deploying the same release twice, while explicit owner recovery dispatch stays separate. Frozen production delivery and its approval are unchanged. With the lane off, current staging/production delivery remains as documented in [DEPLOYMENT](DEPLOYMENT.md); production still runs independently of legacy staging. No production cutover is implemented here.

- Owner's private cluster baseline, supported v2 schema/import behavior and state mapping; no agent credential/state retrieval.
- Owner creation/readback of the safe-apply gate and scoped credentials; no environment setup as a code side effect.
- Private versioned Linode control-record storage, scoped readers/writers, tested serialization/readback and owner-fenced recovery; provider identity lookup and pinned validating resolver; no ephemeral-cache substitute or mandatory conditional writes.
- Reviewed production cutover, single-writer/restore window, DevBot token move and scanner exception policy. A docs merge implies none of these operations.

Record acceptance in CI and concise PR/issue evidence, not duplicate handoff diaries. Update [DEPLOYMENT](DEPLOYMENT.md) when a path ships, and public self-hosting pages when behavior changes, using placeholders only.
