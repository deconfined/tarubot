# Product and operating constraints

This is a current constraint summary, not a second command reference or release diary. The original specification and approved amendments are preserved in [the requirements record](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md). Where detail matters, consult the linked approval; this cleanup does not revoke or alter it. The [documentation site](https://deconfined.github.io/tarubot/) describes supported behavior, and tests pin the executable contracts.

## Product invariants

- Character ownership is verified through a fresh Lodestone biography proof, not a display cache. Links, mains and nicknames remain guild-scoped where required; registered-visitor Guest eligibility is the union over linked characters.
- Accept an FC roster only after identity, pagination, uniqueness and counts establish completeness. An outage, malformed response or partial crawl is never an empty roster and never evidence for removing access.
- Reconciliation computes desired access from durable facts. Configuration revisions, job generations, leases and idempotent delivery fence stale work. Only the database writer may run the bot; one Discord application must never run in two places.
- Money and counters use exact bigint arithmetic. The gil ledger is immutable; state, audit and outbox effects commit together. Identifiers stay decimal strings.
- Commands and buttons reauthorize the current actor. Members do not see private diagnostics or other members' records. User text is escaped, bounded and never allowed to ping through a reply.
- The gateway uses Guilds and GuildMembers only. Message intents stay prohibited. Visibility analysis must not let Administrator mask missing permissions; never write channel policy from obfuscated placeholder data.
- Onboarding is opt-in. New/imported guilds start with role layout off; legacy activation uses a checksum-confirmed, once-only grandfathering plan. Production onboarding is not authorized by the import; `/setup overrides` is the separately approved least-privilege path.
- The bot fetches and parses Lodestone in process with its own bounded workers. Selectors follow upstream HEAD live, validated before activation; the bundled set is the fallback.
- Private issue reports stay private. Public suggestions pass cleaning and a final public-data check; trusted workflow triggers must not automatically execute text submitted through Discord.

## Engineering and documentation

- Bun/TypeScript, discoverable feature modules and Drizzle persistence remain the implementation boundaries. Numbered SQL migrations are authoritative and applied migrations are immutable.
- Every coherent change increments SemVer and updates the changelog. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and signed-commit/PR workflow.
- Reader documentation stays in the existing pnpm/Node Starlight site. Public pages use placeholders; the Thank you page is the sole approved tester-name/contact exception.

## Deployment authority

The agent rule was confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and widened by the [pipeline amendments](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-pipeline-amendments-2026-09-29). The original confirmed wording remains binding and is carried verbatim in [AGENTS.md](AGENTS.md):

> Confirmed (question 1): the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy; a chat go-ahead doesn't replace it, and Claude sessions never approve a deployment. As before, a deploy by hand still needs the owner's explicit go-ahead, and provider, token, key, firewall and account changes stay separate owner steps.

> Confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents, Claude sessions included, never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run the Deploy production workflow; and dispatch it only when the owner asks in that session.

> Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` or any other environment secret; never approve, reject or re-run a deployment or an Infrastructure run; never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments, their secrets or their variables; and dispatch Deploy or Infrastructure only when the owner asks in that session.

The implemented pipeline still requires owner approval for infrastructure Apply and production deployment. Production's Compose path remains frozen until its separately reviewed move. The existing managed database cluster is not replaced or newly provisioned by the current module. The [release-integrated safe-auto-apply specification](docs/PIPELINE.md) records future work, not permission to bypass today's gates.

## Approval references

| Area | Original decision |
| --- | --- |
| Import, activation and access | [Launch](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-launch-amendments-2026-09-23) |
| Replies and test sessions | [Reply sessions](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-reply-session-amendments-2026-09-24) |
| Parser and selectors | [Lodestone](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-lodestone-amendments-2026-09-24) |
| Private diagnostics and public input | [Issue reporting](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-issue-reporting-amendments-2026-09-24), [suggestions](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-public-suggestion-amendments-2026-09-25) |
| Officer notices and update posts | [Lodestone notices](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-officer-notice-amendments-2026-09-25), [changelog](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-changelog-amendments-2026-09-25), [status](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-status-notice-amendments-2026-09-25) |
| Documentation and privacy | [Site](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-documentation-site-amendments-2026-09-25) |
| Deployment and infrastructure | [SSH deployment](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-ssh-deploy-amendments-2026-09-26), [staging](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-staging-amendments-2026-09-26), [pipeline](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-pipeline-amendments-2026-09-29) |
| Least-privilege visibility | [Visibility](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/REQUIREMENTS.md#approved-visibility-amendments-2026-09-28) |
