# Repository rules for agents

Use [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the change checklist, and [docs/README.md](docs/README.md) for task references. These rules constrain authorization; documentation or a test plan never grants permission to operate a live system.

## Implementation

- Follow the agreed [threat model](docs/THREAT_MODEL.md): minimal complexity, minimal bespoke design; use standard components wherever possible.
- Work within this repository. Use Bun for installation, scripts, tests and builds. The sole exception is `site/`: use its pinned pnpm/Node from that directory; add no root site scripts.
- Keep commands, gateway events and components in their discoverable modules. Add explanatory comments to first-party code, tooling and tests.
- Use Drizzle and `src/infrastructure/postgres/schema.ts`. Bind transaction work with `orm(client)`; state, audit and outbox writes use that client. Applied numbered SQL migrations are immutable. Raw SQL is for migration/control, session locks, probes and catalog-based restore verification. See [PERSISTENCE](docs/PERSISTENCE.md).
- Lodestone parsing runs in process with TaruBot's own parser; no Nodestone/sidecar. Selectors follow upstream HEAD live. A bundled refresh must commit verified `bun.lock` and `upstream-revisions.json` together.
- Use checks appropriate to the change: typecheck, lint, format:check, build, unit and contract suites; `test:docker` adds disposable PostgreSQL. The contributor guide shows the credential-free synthetic fixture path. Use the supplied private fixture when relevant and available, never commit it.
- Normal Compose deployments pull GHCR images. Local DevBot adds `docker-compose.devbot.yml` and uses `tarubot_dev`; source testing also adds `docker-compose.build.yml`. Update `test-plans/current.json` before a new session. Ask before restarting shared DevBot, migrating it, editing its `.env` or writing to Discord. Never run one application in two places.
- Update affected site pages with user-facing behavior. Pages use placeholders, not production/DevBot IDs, member/character data, the FC's name, infrastructure identifiers, secrets or ping URLs. The sole approved exception is the Thank you page's tester names and maintainer contacts. Name testers nowhere else: records use roles, tests invented names. Do not merge a site change with a red Documentation site / Build.

## Deployment boundaries

The agent rule, confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)), remains verbatim from [REQUIREMENTS.md](REQUIREMENTS.md). “Deploy production workflow” means `.github/workflows/deploy.yml`, for both targets:

- Confirmed (question 1): the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy; a chat go-ahead doesn't replace it, and Claude sessions never approve a deployment. As before, a deploy by hand still needs the owner's explicit go-ahead, and provider, token, key, firewall and account changes stay separate owner steps.
- Confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents, Claude sessions included, never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run the Deploy production workflow; and dispatch it only when the owner asks in that session.

The confirmed 2026-09-29 extension also remains verbatim:

- Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` or any other environment secret; never approve, reject or re-run a deployment or an Infrastructure run; never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments, their secrets or their variables; and dispatch Deploy or Infrastructure only when the owner asks in that session.

Agents hold no host-access key, state, saved plan or state passphrase. Never enable, disable or cancel Deploy or Infrastructure. Never operate real infrastructure with `tofu plan`, `apply`, `import` or state edits, or run playbooks on a real host. Permitted checks are fmt/validate/mock tests, offline playbook checks, public run evidence and authorized throwaway-lab rehearsals. Do not retry a refused real-infrastructure action in another form. Environment changes, host rebuilds and DevBot's token move are owner steps.

## Current operational contracts

- Production still runs Compose against the owner-provisioned Linode managed database. Staging's implementation uses AlmaLinux 10, SELinux enforcing and rootless Quadlet. [DEPLOYMENT](docs/DEPLOYMENT.md) distinguishes implemented paths from proposals; nothing authorizes replacing/provisioning a cluster or changing cloud resources.
- Infrastructure is currently dispatch-only: read-only `infra-plan` Plan, then owner-approved `infra` Apply. cloud-init sets public access keys and an optional console hash, never a host key. Configure runs reviewed `main`'s `site.yml` as root; bot deploy runs the release's `bot.yml`. Playbooks use `ansible.builtin` only, no Galaxy.
- Preserve production's byte-identical Compose path until its separately reviewed 2.37.0 move: `ops/deploy.sh`, `ops/backup.sh`, `docker-compose.production.yml`, `production.env.example`, `scripts/host-env-backup.ts` and deploy.yml's `deploy`/`notify` jobs are SHA-256-pinned in tests. Compose keeps its `FLOOR`. The unused legacy Quadlet modes in `deploy.sh` remain until 2.38.0 cleanup: do not extend, fix or rely on them.
- Keep “Modules loaded” (`src/main.ts`) and “Database writer lease acquired” (`src/application/lifecycle.ts`) at info, with their exact existing text. The live Compose deploy script relies on them to judge a new release.
- Name no host, address, zone, account or cluster ID in new repository content or public workflow output. Values remain in environments; examples use `example.org` and documentation addresses. Historic evidence stays in Git, not copied into new examples.

## Versioning and Git

- Every coherent change, including docs/tests/maintenance, increments SemVer in `package.json` and updates `CHANGELOG.md` and the current startup plan. Regenerate affected lockfiles. Group related edits under one increment; build/deploy only when authorized to update a running bot.
- Use feature branches and PRs, never commit directly to `main`. Merges require an up-to-date CI/security gate and the owner's code-owner approval; merge commits only. A later push dismisses that approval. Runtime merges can immediately configure staging as root.
- Make frequent local commits for coherent, verified milestones. Inspect status, staged/unstaged diffs and recent history; explicitly stage intended files. Preserve chronology. Sign with configured SSH key `~/.ssh/id_git` (`gpg.format=ssh`); signing failure means stop and ask, never silently commit unsigned.
- Keep credentials, `.env`, dumps, backups, generated output and local tool state out of Git. Tracked env examples are safe templates.
- Do not push, rewrite history, discard others' changes, skip hooks or change Git configuration without explicit authorization.
