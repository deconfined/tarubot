# Product and operating constraints

This summary preserves product invariants and confirmed live-operation boundaries. The [documentation site](https://deconfined.github.io/tarubot/) describes supported behavior; [CONTRIBUTING](CONTRIBUTING.md) covers source work and [DEPLOYMENT](docs/DEPLOYMENT.md) covers delivery and owner operations. Historical decisions remain in Git and PR history, not a second backlog.

## Product invariants

- Character ownership is verified through a fresh Lodestone biography proof, not a display cache. Links, mains and nicknames remain guild-scoped where required; registered-visitor Guest eligibility is the union over linked characters.
- Accept an FC roster only after identity, pagination, uniqueness and counts establish completeness. An outage, malformed response or partial crawl is never an empty roster and never evidence for removing access.
- Reconciliation computes desired access from durable facts. Configuration revisions, job generations, leases and idempotent delivery fence stale work. Only the database writer may run the bot; one Discord application must never run in two places.
- Money and counters use exact bigint arithmetic. The gil ledger is immutable; state, audit and outbox effects commit together. A member's own self-service role saves, like the `/main` and `/nickname` preferences, commit their state and job without an audit row; Discord is the record of their roles (owner decision, 2026-10-09). Identifiers stay decimal strings.
- Commands, buttons and web forms reauthorize the current actor. Members do not see private diagnostics or other members' records. User text is escaped, bounded and never allowed to ping through a reply.
- The gateway uses Guilds and GuildMembers only. Message intents stay prohibited. Visibility analysis must not let Administrator mask missing permissions; never write channel policy from obfuscated placeholder data.
- Onboarding is opt-in. New/imported guilds start with role layout off; legacy activation uses a checksum-confirmed, once-only grandfathering plan. Production onboarding is not authorized by the import; `/setup overrides` is the separately approved least-privilege path.
- The bot fetches and parses Lodestone in process with its own bounded workers. Selectors follow upstream HEAD live, validated before activation; the bundled set is the fallback.
- Private issue reports stay private. Public suggestions pass cleaning and a final public-data check; trusted workflow triggers must not automatically execute text submitted through Discord.

## Engineering and documentation

- Bun/TypeScript, discoverable feature modules and Drizzle persistence remain the implementation boundaries. Numbered SQL migrations are authoritative and applied migrations are immutable.
- SemVer identifies bot releases. Maintenance commits need no application version or changelog change; an explicit release increments the version and updates the changelog and startup plan. Versions never decrease. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for checks and the signed-commit/PR workflow.
- Reader documentation stays in the existing pnpm/Node Starlight site. Public pages use placeholders; the Thank you page is the sole approved tester-name/contact exception.

## Deployment authority

The original confirmed wording remains binding and is carried verbatim in [AGENTS.md](AGENTS.md). References to retired environments or tooling in these quotations preserve the prohibition; they do not require those systems to exist.

> Confirmed (question 1): the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy; a chat go-ahead doesn't replace it, and Claude sessions never approve a deployment. As before, a deploy by hand still needs the owner's explicit go-ahead, and provider, token, key, firewall and account changes stay separate owner steps.

> Confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents, Claude sessions included, never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run the Deploy production workflow; and dispatch it only when the owner asks in that session.

> Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` or any other environment secret; never approve, reject or re-run a deployment or an Infrastructure run; never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments, their secrets or their variables; and dispatch Deploy or Infrastructure only when the owner asks in that session.

Merged [PR #74](https://github.com/deconfined/tarubot/pull/74) authorizes the repository-only pipeline reset. Previous production source-file byte-identity pins and retirement dates no longer constrain source changes. This grants no permission to operate live workflows, access secrets, change environments, provision infrastructure or mutate the running host/database.

The production baseline is an owner-provisioned Linode Compose host and managed PostgreSQL. Release delivery automates building, publication, deployment and necessary migrations, with exactly one owner's GitHub `production` approval per release. Infrastructure provisioning and the first host cutover remain separate owner operations. Repository implementation and credential-free tests do not establish that a live cutover or recovery drill occurred.
