# TaruBot threat model

**Agreed engineering scope.**

TaruBot is a Discord bot, not a high-security facility. Protect its users, data and operation against realistic abuse, mistakes and failures. **Minimal complexity, minimal bespoke design; use standard components wherever possible.**

This document governs future work. Operational authorization remains subject to the [agent and deployment rules](../AGENTS.md).

## Scope and assets

Cover the bot, its release pipeline and the infrastructure needed to run it:

- Discord permissions, community access and messages.
- Private member/character associations, verification data and reports.
- PostgreSQL ledger, configuration, audit and pending work.
- Credentials, backups, infrastructure state, SSH trust and release identity.
- Availability and recovery, including one active bot/database writer.

## Realistic threats

| Threat or failure | Required protection; preferred approach |
| --- | --- |
| Unauthorized commands, forged character claims or effects in another guild | Existing authorization and character verification; guild-scoped persistence and least-privilege Discord permissions. No routine Administrator access. |
| Malicious text, upstream pages or excessive requests | Validate and escape input; parameterize queries; restrict upstream destinations and bound requests. Incomplete roster data must not trigger broad access removal. |
| Credentials or member data leak through logs, reports, suggestions, artifacts or backups | Environment secrets, private files, Ansible `no_log`, restricted secret files, encrypted private storage and existing public-output checks. Do not expose arbitrary upstream/error payloads. |
| Unreviewed code, a vulnerable dependency or a substituted release reaches deployment | Protected `main`, code-owner review, CI/security checks, pinned tools/actions, scanning, standard GitHub attestations and exact image digests. Untrusted CI gets no deployment credentials. |
| Wrong target, mixed staging/production settings or an unsafe infrastructure change | Separate target settings; classify the complete plan; auto-apply only a narrow safe allowlist. Apply the exact encrypted saved plan with native stale-state checks. Sensitive changes and existing-cluster adoption remain owner-controlled. |
| SSH reaches the wrong machine or encounters changed/missing trust | Bind enrollment to the applied instance/addresses; persist the first key before authentication. Use strict OpenSSH `known_hosts` and matching locally validated DNSSEC SSHFP. Reenrollment/recovery must be explicit. |
| Duplicate writers, interrupted migrations or remote writes with lost acknowledgements | PostgreSQL transactions/writer lease, Actions concurrency, small encrypted operation records and persistence readback. Stop on unresolved outcomes and reconcile before another mutation. |
| An unhealthy release, incompatible rollback, outage or failed recovery | Exact-release staging acceptance, schema checks, monitoring, bounded safe retries and tested encrypted backups/restores. Production requires owner approval. No blind rollback, restore or retry of uncertain writes. |

Staging needs its own Discord application and database credentials. Never run one application in two places. A database restore must account for Discord effects already delivered. A green build, skipped job or configure-only result does not prove a healthy deployment.

## Trusted boundaries

Discord input, Lodestone responses, public submissions, unreviewed PRs and unverified artifacts are untrusted. Network identity requires the appropriate TLS, SSH or DNSSEC checks.

We trust the owner's account, protected `main` and code-owner review, GitHub Actions and correctly configured environments, reviewed workflow/playbook code, selected pinned tools, provider control planes and authorized private-storage writers. Give credentials the smallest practical scope.

**Command-authority boundary:** a reviewed job in the intended protected environment may run reviewed Ansible playbooks. Configure has root on its target by design. Perform release, target and trust checks at meaningful deployment boundaries; ordinary Ansible/OpenSSH then enforce the connection. A second custom authorization system and a GitHub check for every module, file transfer or command are unnecessary.

Existing approved deployment-level checks can remain. The original decision against infrastructure-environment settings self-checks does not abolish the shipped Deploy Plan's target-gate checks. The owner maintains environment/ruleset configuration.

Trusting deployment code does not grant Discord users privileges or make public input executable.

## Accepted risks and limits

- **GitHub is the deployment root of trust.** A compromised owner account, protected runner or deployment credential can reach host root. Use standard account protection and review; do not promise containment after a trusted component is fully compromised.
- **TOFU accepts first-observation interception.** Instance/address checks reduce mistakes, not this fundamental risk. DNSSEC cannot authenticate enrollment retroactively or authorize replacing the stored key.
- **Root defeats host-local controls.** SELinux and rootless containers reduce exposure; they cannot make a compromised root trustworthy.
- **Serialization depends on cooperating writers.** Manual work and recovery must fence competing automation. Encryption, version history and readback are not a distributed lock or protection against unrestricted authorized deletion.
- **Cancellation is not undo.** An accepted command/write may finish after a runner dies. Inspect unknown outcomes rather than assuming nothing changed.
- **Recovery is bounded.** Test restoration. A restore can lose recent data or replay external effects; backups in the same provider account are not independent disaster recovery. No zero-loss or continuous-availability guarantee is assumed.
- **Keep explicitly approved exposure.** Root's optional console password hash may enter cloud-init and encrypted OpenTofu state. Host private keys are never seeded.

A confirmed compromise still requires owner response: fence writers, revoke/rotate credentials, assess damage and recover from verified evidence. Accepted limits do not excuse leaks or known vulnerabilities.

## Engineering policy

1. Prefer existing GitHub controls, native OpenTofu encryption/plans, ordinary Ansible/OpenSSH, a standard validating DNS resolver, PostgreSQL transactions and established backup tools.
2. Custom code must address a specific in-scope requirement those facilities cannot meet. Prefer small domain checks/adapters; explain the need and maintenance cost. Custom OCI measurement, worker brokers, per-command JWTs and repeated proof chains are not requirements of this model.
3. Test practical failures and the complete staging path early. Preserve authorization, secrecy, safe changes, durable TOFU/DNSSEC, recovery and production approval. Keep the current production path until its reviewed cutover.

Use this model to assess the [pipeline design](PIPELINE.md) and implementation. Introduce a stronger threat model only for a concrete new requirement agreed with the owner.

References: [requirements](../REQUIREMENTS.md), [original approved pipeline decisions](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-pipeline-amendments-2026-09-29), [implemented deployment](DEPLOYMENT.md) and [persistence](PERSISTENCE.md).
