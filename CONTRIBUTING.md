# Contributing

## Set up

Use the Bun version pinned in `package.json`, plus Docker Compose for database tests. No Discord token, cloud credential or private database dump is needed for the checks below.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test:unit
bun run test:contract

# Full suite with invented legacy data and disposable PostgreSQL.
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

Run one test file with `bun test tests/unit/NAME.test.ts`. `test:docker` creates and removes its own containers and database volume. Without `LEGACY_FIXTURE_PATH`, it expects the owner's local `tarubot_backup.sql`; never commit that dump. `test:integration` recreates the selected `_test` database's `public` schema: use disposable databases only.

Infrastructure fixtures must supply an explicit S3 signing region alongside their invented bucket/endpoint. Exercise endpoint/region handoff mismatches and region-bound record refusal without real storage/provider credentials. Offline fixtures do not accept the selected OVH service; its private checks remain in the [OpenTofu runbook](ops/tofu/README.md#private-backend-acceptance).

## Make a change

1. Start a feature branch from an up-to-date `main`. Keep unrelated work separate.
2. Follow the existing module boundaries and add tests for changed behavior. Explain consequential invariants in comments, not a running session diary.
3. Update the affected documentation. User-facing behavior belongs in `site/src/content/docs/`; contributor detail belongs in the [internal references](docs/README.md).
4. Keep the application version for ordinary commits, including documentation, tests, CI and pipeline maintenance. Regenerate the relevant lockfile whenever dependencies change. Application changes can accumulate until a release is ready.
5. To release the bot, increment SemVer in `package.json`, add its `CHANGELOG.md` entry and update the current-version sentence. Use a patch for compatible fixes, a minor for compatible features and a major for incompatible changes. Synchronize `test-plans/current.json` with the release, keeping separate human, assistant and bot actions. Update it separately before an authorized development session. Add a member-facing note in `src/domain/release-notes.ts` only when members will notice the release. Do not copy the version into engineering references.
6. Run the applicable checks. Check the version gate with `CI_BASE_SHA=$(git rev-parse origin/main) bun run ci:version`.
7. Inspect status and staged/unstaged diffs; stage only intended files. Make a signed local commit for each coherent, verified milestone. If signing fails, stop rather than create an unsigned commit.
8. Open a PR when authorized. Merge with a merge commit only, after the owner's code-owner review, an up-to-date `CI result`, and the required security checks. A push dismisses stale approvals.

Do not commit credentials, `.env`, dumps, backups, generated output or local coding-tool state. Applied SQL migrations are immutable: add a new migration, then update the Drizzle mapping and `SCHEMA_VERSION` together. See [persistence](docs/PERSISTENCE.md).

## Documentation site

The existing Starlight site is a separate pnpm/Node package. Use the versions pinned in `site/package.json`, and run these commands **from `site/`**, not through a root Bun script:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The build validates site links; `tests/unit/docs-site.test.ts` checks public content against the bot. Do not merge a site change while **Documentation site / Build** is red. Use placeholders, not deployment or member data. Tester names and the maintainer's contact details belong only on the site's Thank you page.

## Live testing and delivery

- [DevBot](docs/DEV_GUILD.md): isolated local development and owner-run acceptance.
- [CI/CD](docs/CI_CD.md): explicit releases, required checks and dependency updates.
- [Deployment](docs/DEPLOYMENT.md): the implemented delivery path, not future pipeline proposals.
- [Threat model](docs/THREAT_MODEL.md): agreed scope and the requirement to prefer simple, standard components.
- [Pipeline specification](docs/PIPELINE.md): intended flow, safety policy and outstanding acceptance.

Building a release does not authorize restarting a shared bot, migrating a live database, writing to Discord, changing a provider/environment, pushing, or dispatching a workflow. Agents must follow [AGENTS.md](AGENTS.md); production deployment approval remains the owner's GitHub action.
