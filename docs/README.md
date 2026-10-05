# Internal documentation

Start with [CONTRIBUTING](../CONTRIBUTING.md) for setup and checks. The [documentation site](https://deconfined.github.io/tarubot/) serves members, server managers and self-hosters.

The [threat model](THREAT_MODEL.md) defines engineering scope: minimal complexity and standard components. [REQUIREMENTS](../REQUIREMENTS.md) preserves current constraints; [AGENTS](../AGENTS.md) defines repository and authorization rules.

| Task | Reference |
| --- | --- |
| Add a command, event, component, service or web page | [MODULES](MODULES.md) |
| Write queries or change the schema | [PERSISTENCE](PERSISTENCE.md) |
| Change configuration or maintenance-tool guards | [CONFIGURATION](CONFIGURATION.md) |
| Change Lodestone parsing or selectors | [LODESTONE](LODESTONE.md) |
| Build a Discord reply | [REPLIES](REPLIES.md) |
| Prepare development testing and startup plans | [DEV_GUILD](DEV_GUILD.md) |
| Change CI or update dependencies | [CONTRIBUTING](../CONTRIBUTING.md) |
| Release, provision, cut over, back up or recover | [DEPLOYMENT](DEPLOYMENT.md) |

Use issues for remaining work and PRs/CI for review and verification. Record important manual acceptance there with version/commit, target role, outcome and unexercised cases. Historical designs and rollout details remain in Git; keep current instructions in one place.
