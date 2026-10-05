# TaruBot threat model

TaruBot is a Discord bot, not a high-security facility. Protect users, data and operation against realistic abuse, mistakes and failures. **Minimal complexity, minimal bespoke design; prefer standard components.** Operational authorization remains subject to [AGENTS](../AGENTS.md).

## Assets and realistic threats

Protect Discord permissions/messages, private member and character associations, PostgreSQL's ledger/configuration/audit/pending work, credentials, encrypted backups, SSH trust and release identity.

| Threat or failure | Protection |
| --- | --- |
| Unauthorized commands, forged claims or cross-guild effects | Reauthorize actors; fresh character ownership proofs; guild-scoped persistence and least-privilege Discord permissions. No routine Administrator access. |
| Malicious text, upstream responses or excessive requests | Escape and bound input, parameterize queries, restrict upstream destinations and bound requests/workers. Incomplete rosters never justify access removal. |
| Private data or credentials leak | Host-only runtime settings, restricted files, redacted logs/reports, cleaned suggestions and encrypted offsite backups. Public Actions output contains fixed status tokens, not private diagnostics. |
| Unreviewed code, vulnerable dependency or substituted release | Protected reviewed `main`, required CI/security checks, pinned Actions/tools, AMD64/ARM64 scans and standard GitHub provenance for the exact digest, source SHA/ref and publisher identity. Untrusted PRs receive no deployment credentials. |
| Wrong SSH target or changed host key | The owner verifies and pins the host key out of band. Strict OpenSSH known_hosts checking; refuse missing or changed pins. Never auto-accept or scan a key during delivery. |
| Unsafe deployment, duplicate writers or interrupted migration | Exactly one production approval, validated forced-command requests, workflow concurrency and host flock, immutable transactional migrations and the database writer lease. Durable pending state is written before stopping the writer. |
| Unhealthy release, lost acknowledgement or failed recovery | Exact-image readiness/schema/writer observations, encrypted pre-migration backup, private operation logs and owner reconciliation of pending/uncertain outcomes. No automatic rollback or blind mutation retry. |
| Host/database loss or unsafe provisioning | Owner-operated provisioning and cutover, managed PostgreSQL access controls/verified TLS, scheduled encrypted offsite backups and owner-run restore drills. |
| Browser sessions, forged requests, injected text and exploited web code | Opaque server-side sessions in `__Host-` cookies; Fetch Metadata/Origin on every POST; escaped templates under a script-free CSP; OAuth `state` + PKCE, with `state` checked before any Discord call; time-limited Discord calls (sign-in rate limits arrive at 3.0.0); same-origin return paths. The pages run inside the bot process: a web code-execution bug exposes the bot token and database login. The owner accepted this (#43 W1, 2026-10-04); it's revisited on a confirmed web vulnerability, anonymous pages, a client application or the owner's request. |

One Discord application must never run in two places. A database restore must account for Discord effects already delivered. A green build or skipped deployment does not prove a healthy live bot.

## Trust and authority

Discord input, Lodestone responses, member suggestions, unreviewed PRs and unverified artifacts are untrusted. Network connections require appropriate TLS or pinned SSH verification.

We trust the owner account, protected `main` and code-owner review, GitHub-hosted Actions and correctly configured production protections, reviewed release/host scripts, selected pinned tools and the provider control plane. Scope credentials narrowly. The deployment key reaches only the reviewed forced command; the runner receives no database URL or Discord token. Runtime and backup credentials stay on the host.

The owner maintains branch/environment protections, SSH pins, credentials and infrastructure. The repository pipeline automates delivery, not provisioning. A reviewed protected workflow plus the owner's production approval authorizes delivery; no additional bespoke command broker, enrollment service or repeated proof chain is needed.

Trusting deployment code never grants Discord users privileges or makes their text executable.

## Accepted limits

- **Trusted-component compromise is not contained by these controls.** Compromised owner/runner/deploy credentials or reviewed host code can affect production. Docker access is effectively host-root access. Standard account protection and review remain essential.
- **Host root defeats host-local controls.** A read-only unprivileged container reduces exposure but cannot make a compromised host trustworthy.
- **Serialization needs cooperation.** Manual work must fence automation and other writers; flock and workflow concurrency cannot stop an unrestricted operator.
- **Cancellation is not undo.** A remote command may finish after the runner loses its connection. Inspect the durable host state before another mutation.
- **Recovery is bounded.** Restores can lose recent decisions or repeat external effects. Backups in the same provider account are not independent disaster recovery; keep independent copies. No zero-loss or continuous-availability guarantee is assumed.

A confirmed compromise requires owner response: fence writers, revoke/rotate credentials, assess damage and recover from verified evidence. These limits do not excuse leaks or known vulnerabilities.

## Engineering policy

Prefer GitHub controls, strict OpenSSH, Docker Compose, PostgreSQL transactions/advisory locks and established encrypted backup tools. Custom code must address a concrete requirement these facilities do not meet. Test practical failure behavior with invented data and disposable resources; record owner-run live acceptance separately. Introduce a stronger threat model only for a concrete requirement agreed with the owner.

References: [requirements](../REQUIREMENTS.md), [deployment](DEPLOYMENT.md), [persistence](PERSISTENCE.md).
