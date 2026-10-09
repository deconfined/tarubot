# Repository rules for agents

Use [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and releases, and [docs/README.md](docs/README.md) for task references. A requested source change includes the credential-free local checks needed to verify it; no separate approval is needed for each ordinary edit or check. Source work does not authorize live operations.

## Implementation

- Prefer standard components and minimal bespoke design; follow the [threat model](docs/THREAT_MODEL.md).
- Work within this repository. Use Bun, except in `site/`, which uses its pinned pnpm/Node. Add no root site scripts.
- Keep commands, events and components discoverable, and explain consequential invariants in comments.
- Use Drizzle, `src/infrastructure/postgres/schema.ts` and `orm(client)` for transaction-bound state, audit and outbox writes. Applied SQL migrations are immutable; follow [PERSISTENCE](docs/PERSISTENCE.md) for SQL and restore checks.
- Parse Lodestone in process, with selectors following upstream HEAD live. Commit verified `bun.lock` and `upstream-revisions.json` together for bundled refreshes.
- Run checks appropriate to the changed behavior using the contributor guide's credential-free fixtures. Keep private fixtures out of Git.
- Update affected user-facing site pages. Use placeholders, not private member or infrastructure data, secrets or ping URLs. Tester names and maintainer contacts belong only on Thank you. Site changes require a green Documentation site / Build.

## Deployment boundaries

The agent rule, confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)), remains verbatim from [REQUIREMENTS.md](REQUIREMENTS.md). “Deploy production workflow” means `.github/workflows/deploy.yml`, for both targets:

- Confirmed (question 1): the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy; a chat go-ahead doesn't replace it, and Claude sessions never approve a deployment. As before, a deploy by hand still needs the owner's explicit go-ahead, and provider, token, key, firewall and account changes stay separate owner steps.
- Confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents, Claude sessions included, never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run the Deploy production workflow; and dispatch it only when the owner asks in that session.

The confirmed 2026-09-29 extension also remains verbatim:

- Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` or any other environment secret; never approve, reject or re-run a deployment or an Infrastructure run; never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments, their secrets or their variables; and dispatch Deploy or Infrastructure only when the owner asks in that session.

Agents hold no host-access key, state, saved plan or state passphrase, and never enable, disable or cancel live Deploy or Infrastructure workflows. Real provider operations, host playbooks, environment changes, host rebuilds and DevBot's token move remain owner steps. Use offline validation, mock tests, public evidence or authorized throwaway labs; never retry a refused live operation in another form. Ask before restarting shared DevBot, migrating it, editing its `.env` or writing to Discord. Never run one application in two places.

## Current operational contracts

- Production currently uses Compose and the owner-provisioned Linode managed database. Existing staging and infrastructure implementation details are in [DEPLOYMENT](docs/DEPLOYMENT.md), not requirements to reproduce in the replacement. No source change authorizes a live cutover, new cluster or cloud-resource change.
- Until the pipeline-reset authorization below is approved and merged to `main`, preserve the byte-identical production files and jobs: `ops/deploy.sh`, `ops/backup.sh`, `docker-compose.production.yml`, `production.env.example`, `scripts/host-env-backup.ts` and deploy.yml's `deploy`/`notify` jobs. Keep Compose's `FLOOR` and leave unused legacy Quadlet modes untouched.
- Keep “Modules loaded” (`src/main.ts`) and “Database writer lease acquired” (`src/application/lifecycle.ts`) at info, with their exact existing text. The live Compose deploy script relies on them to judge a new release.
- Host names and their addresses are web-facing, not secret: they may appear in repository content and public workflow output (@deconfined, 2026-10-08). Name no account, zone or cluster ID there; those values remain in environments. Generic documentation and examples still use `example.org` and documentation addresses.

## Pipeline reset proposal

**Effective only after the owner's approval and merge to `main`.**

- Authorize a repository-only replacement or removal of build/deployment workflow definitions, supporting tooling, obsolete tests and redundant internal documentation.
- For this reset, previous production source-file byte-identity pins and version-based retirement dates no longer constrain source changes. Product invariants, immutable applied migrations and live-operation boundaries remain binding.
- Editing or removing Deploy and Infrastructure workflow definitions through reviewed source changes is permitted. This is distinct from enabling, disabling, cancelling or re-running live workflows through GitHub, which remains prohibited for agents.
- Automate release building, publication, deployment and necessary database migrations. Retain the owner's GitHub `production` environment approval as the routine deployment gate; infrastructure provisioning may remain owner-operated.
- This authorizes no live deployment, provisioning, host/database mutation, secret access, environment/protection-rule change, workflow dispatch or push. Preserve the running production system until a separately owner-approved cutover.

## Versioning and Git

- Any added or changed application functionality requires a SemVer bump in the same PR: patch for compatible fixes, minor for compatible features, major for incompatible changes. Update `CHANGELOG.md`, the startup plan and `src/domain/release-notes.ts` with the release: a plain-words note when members, guests or officers can notice it (Discord, dashboard or docs site), otherwise a short `NO_RELEASE_NOTE` reason; versions never decrease. Pure documentation, tests, CI and pipeline maintenance need no bot version bump.
- Regenerate affected lockfiles for dependency changes. Apart from release metadata updates, update `test-plans/current.json` before authorized live development testing, not ordinary documentation or source-only sessions.
- Use feature branches and PRs. Merge commits require current CI/security checks and the owner's code-owner approval; later pushes dismiss that approval.
- Make signed local commits for coherent, verified milestones, staging only intended files after reviewing status and diffs. Use configured SSH signing with `~/.ssh/id_git`; signing failure means stop, never commit unsigned.
- Keep credentials, `.env`, dumps, backups, generated output and local tool state out of Git. Do not push, rewrite history, discard others' changes, skip hooks or change Git configuration without explicit authorization.
