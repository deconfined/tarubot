# Internal documentation

Start with [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, tests and the change checklist. The [documentation site](https://deconfined.github.io/tarubot/) remains the guide for members, server managers and self-hosters.

## Engineering references

| Task | Reference |
| --- | --- |
| Add a command, event, component or service | [MODULES](MODULES.md) |
| Write queries or change the schema | [PERSISTENCE](PERSISTENCE.md) |
| Change configuration or maintenance-tool guards | [CONFIGURATION](CONFIGURATION.md) |
| Change Lodestone parsing or selectors | [LODESTONE](LODESTONE.md) |
| Build and test a Discord reply | [REPLIES](REPLIES.md) |
| Prepare a development session | [DEV_GUILD](DEV_GUILD.md), [TEST_PLANS](TEST_PLANS.md) |
| Change CI or update dependencies | [CI_CD](CI_CD.md) |

## Maintainer runbooks

- [DEPLOYMENT](DEPLOYMENT.md): release delivery and first-host setup.
- [HOSTING](HOSTING.md): everyday checks, backups and recovery.
- [OpenTofu](../ops/tofu/README.md): infrastructure inputs, adoption, checks and rebuilds.
- [REQUIREMENTS](../REQUIREMENTS.md): current constraints and links to the original approvals.
- [AGENTS](../AGENTS.md): authorization and agent-specific repository rules.

## Tracking work and evidence

Use GitHub issues for backlog and PRs for implementation/review. Record automated evidence in CI and important manual acceptance in a short dated issue or PR comment: version/commit, environment role, checks performed, outcome and anything not exercised. Never treat a published image, a green skipped job or a session note as proof that a bot is running.

Outstanding acceptance from the previous records includes live visibility/override checks and the staging pipeline's healthy deploy, command-registration, timer and restore-drill paths. See [#46](https://github.com/deconfined/tarubot/issues/46) and [#62](https://github.com/deconfined/tarubot/issues/62); the [archived verification record](archive/README.md#verification-and-acceptance) preserves what was and was not exercised. These checks are not declared complete by this cleanup.

The next pipeline work is separate: adoption of the existing PostgreSQL cluster, release-integrated infrastructure planning, narrowly gated safe auto-apply, and genuinely tested staging before production approval. Automated SSH trust/SSHFP remains design work. None of those changes is implemented by the documentation cleanup.

Historical rollout plans and verification diaries are in the [archive](archive/README.md), not the onboarding path. Current instructions should live in one place; link to them rather than copying them into handoff files.
