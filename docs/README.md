# Internal documentation

Start with [CONTRIBUTING](../CONTRIBUTING.md) for setup and checks. The [documentation site](https://deconfined.github.io/tarubot/) serves members, server managers and self-hosters.

The [threat model](THREAT_MODEL.md) defines engineering scope: minimal complexity and standard components. [REQUIREMENTS](../REQUIREMENTS.md) preserves current constraints; [AGENTS](../AGENTS.md) defines repository and authorization rules.

| Task | Reference |
| --- | --- |
| Add a command, event, component or service | [MODULES](MODULES.md) |
| Write queries or change the schema | [PERSISTENCE](PERSISTENCE.md) |
| Change configuration or maintenance-tool guards | [CONFIGURATION](CONFIGURATION.md) |
| Change Lodestone parsing or selectors | [LODESTONE](LODESTONE.md) |
| Build a Discord reply | [REPLIES](REPLIES.md) |
| Prepare development testing | [DEV_GUILD](DEV_GUILD.md), [TEST_PLANS](TEST_PLANS.md) |
| Change CI or update dependencies | [CI_CD](CI_CD.md) |
| Operate deployment | [DEPLOYMENT](DEPLOYMENT.md) |
| Check health, back up or recover | [HOSTING](HOSTING.md) |
| Operate infrastructure | [OpenTofu runbook](../ops/tofu/README.md) |
| Finish the release pipeline | [PIPELINE](PIPELINE.md) |

Use issues for remaining work and PRs/CI for review and verification. Record important manual acceptance there with version/commit, target role, outcome and unexercised cases. Historical designs and rollout details remain in Git; keep current instructions in one place.
