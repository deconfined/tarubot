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

The native Caddy regressions exercise an accepted trailing-slash origin through trusted local HTTPS, fake Discord login and protected dashboard routes, then the offline page once the harness stops (2.41.0: whole for any method and for conditional or range requests, with dotfiles hidden). They run this tree's own web image, the Dockerfile's `web` stage (the pinned stock Caddy image with `ops/Caddyfile` and `ops/offline` built in). Build it locally rather than pulling a published `web-` tag, which may not exist yet and carries another tree's files:

```sh
docker build --target web -t ghcr.io/deconfined/tarubot:web-ci .
CADDY_FIXTURE_IMAGE=ghcr.io/deconfined/tarubot:web-ci bun test tests/unit/web-server.test.ts
# CI's Caddyfile check, under the proxy service's hardening; --pull never keeps a published tag out.
TARUBOT_IMAGE_TAG=ci WEB_PUBLIC_ORIGIN=https://tarubot.example.org docker compose --env-file .env.example \
  run --rm --no-deps --pull never caddy caddy validate --config /etc/caddy/Caddyfile
```

The HTTPS fixture requires Linux, Compose 2.24.4 or newer and IPv6 loopback for its isolated overrides. It uses host networking with ephemeral loopback-only listeners, Caddy's local CA and invented accounts. It mounts readable copies of the checkout's Caddyfile and offline page over the image's, so a checkout made under `umask 077` works too, and removes its own containers, volumes and temporary files. CI builds the same image and enables it. Ordinary unit checks skip this native case unless `CADDY_FIXTURE_IMAGE` is set; the test never builds or downloads an image itself.

The real backup and restore test (`tests/integration/backups.test.ts`) dumps a migrated database through age into in-memory storage and restores it into a second, empty database. `pg_dump` refuses a newer server, so it needs PostgreSQL client tools at least as new as the test server: the image carries Alpine's PostgreSQL 18 client, so `bun run test:docker` runs it; CI's Checks job installs PostgreSQL 18's client from PGDG (`compose-manifests.test.ts` keeps its major equal to the CI service's), so it runs there too; and a machine with older tools skips it. The other backup and restore tests use the doubles in `tests/fixtures/backups.ts` (storage, `pg_dump`, `pg_restore` and the healthchecks.io pings) or, for the S3 adapter, a recording S3 double on loopback, with no bucket or credential.

## Make a change

1. Start a feature branch from an up-to-date `main`. Keep unrelated work separate.
2. Follow the existing module boundaries and add tests for changed behavior. Explain consequential invariants in comments, not a running session diary.
3. Update the affected documentation. User-facing behavior belongs in `site/src/content/docs/`; contributor detail belongs in the [internal references](docs/README.md).
4. Any added or changed application functionality requires a SemVer bump in the same PR. Pure documentation, tests, CI and pipeline maintenance keep the application version unchanged. Regenerate the relevant lockfile whenever dependencies change.
5. Use a patch for compatible fixes, a minor for compatible features and a major for incompatible changes. Increment `package.json`, add the matching `CHANGELOG.md` entry and update its current-version sentence. Synchronize `test-plans/current.json` with the release, keeping separate human, assistant and bot actions. Update it separately before an authorized development session. Give the release one entry in `src/domain/release-notes.ts`: a `RELEASE_NOTES` sentence whenever anyone using TaruBot can notice it (members, guests or officers; in Discord, on the dashboard or on the documentation site), in plain words about what people will see or can now do, or otherwise a `NO_RELEASE_NOTE` entry with a short reason (deployment tooling, CI, infrastructure, internal refactors). Keep a note under about 280 characters, without Markdown characters, mentions, links or technical detail, and add it in the release's own PR: servers move past a release when they first run it, so a note added later is never posted. `tests/unit/changelog.test.ts` fails until the release has one entry. Do not copy the version into engineering references.
6. Run the applicable checks. Check the version gate with `CI_BASE_SHA=$(git rev-parse origin/main) bun run ci:version`.
7. Inspect status and staged/unstaged diffs; stage only intended files. Make a signed local commit for each coherent, verified milestone. If signing fails, stop rather than create an unsigned commit.
8. Open a PR when authorized. Merge with a merge commit only, after the owner's code-owner review, an up-to-date `CI result`, and the required security checks. A push dismisses stale approvals.

Do not commit credentials, `.env`, dumps, backups, generated output or local coding-tool state. Applied SQL migrations are immutable: add a new migration, then update the Drizzle mapping and `SCHEMA_VERSION` together. See [persistence](docs/PERSISTENCE.md).

## CI and dependencies

`ci.yml` checks source, migration immutability, the application build, unit/contract tests, disposable PostgreSQL fixtures, the native Caddy fixture against this tree's web image, pinned actionlint for workflows (with ShellCheck for their `run:` blocks), and credential-free Compose validation of the stock, production and staging manifests and this tree's Caddyfile. PRs need no live credentials. `publish.yml` reuses the pull-request CI result for the identical merged tree (running `ci.yml` when it can't prove that), builds AMD64/ARM64 bot images on native runners and the `web` image for an explicit stable release, calls `scan.yml` for the bot image, attests both index digests and calls `deploy.yml` with `target=production`. Routine deployment uses one owner-approved `production` job, which only copies the verified release to the `production` and `web-production` tags of `ghcr.io/deconfined/tarubot-release`, with the environment's own token (no workflow's own token writes that package); the runtime's Watchtower follows them. Optional owner-dispatched staging rehearsal has its own activation, environment and approval; it is not a second production gate. Neither publication nor a moved tag is evidence of a live deploy: `/version` says what runs. See [deployment](docs/DEPLOYMENT.md).

For local workflow validation, put ShellCheck on `PATH` before running the pinned actionlint. Check `command -v shellcheck` first: actionlint skips unavailable external linters, so a YAML-only pass is not CI parity. `actionlint -verbose` reports disabled integrations.

CI builds the Dockerfile's `test` stage (type check and unit/contract suites) and then the runtime image on matching standard GitHub-hosted runners (`ubuntu-24.04` and `ubuntu-24.04-arm`), so both suites run on each native architecture before merge. The runtime image depends only on compilation, so release publication builds each platform natively without running the suites again. Per-architecture caches avoid concurrent overwrites, and `CI result` still requires both builds. Real Git/Bun CLI fixtures keep their explicit time budgets without raising the ordinary test timeout.

Actions use full-SHA pins; checkouts do not persist credentials. `pages.yml` builds the separate site, `dependency-audit.yml` audits locked Bun dependencies, and CodeQL uses GitHub default setup. The owner maintains required checks and branch/environment protections.

| Dependency | Update method / paired pins |
| --- | --- |
| Bun | Dependabot Docker PR; synchronize runtime, `@types/bun`, lockfile and README |
| Alpine base, Caddy (web image) | Dependabot Docker PR, tag and digest together; synchronize README |
| PostgreSQL | Dependabot Compose minor PR; synchronize CI and README; majors need a migration plan, the image's `postgresqlNN-client` at least as new (`pg_dump` refuses a newer server), and CI's PGDG `postgresql-client-NN` of the service's major (`compose-manifests.test.ts`) |
| Watchtower | Dependabot Compose PR, tag and digest; one pin in every manifest (`compose-manifests.test.ts`); synchronize README |
| Actions | Dependabot SHA-pin PR; retain full pins and version comments |
| Site | Dependabot pnpm PR; install/build from `site/` and check peer compatibility |
| Bun packages | Manual Bun update and frozen install; Dependabot cannot read the current lockfile format |
| Selectors | `bun run selectors:update`; commit lockfile and revision metadata together |

Dependency PRs use normal CI without a mandatory release bump. Publish runtime dependency changes in the next explicit bot release. Do not add `[dependabot skip]`: it permits force-pushing over maintainer edits. After a maintainer push, merge newer `main` if necessary; `@dependabot recreate` discards those commits. The owner manages security alerts and automated security-update settings.

## Documentation site

The existing Starlight site is a separate pnpm/Node package. Use the versions pinned in `site/package.json`, and run these commands **from `site/`**, not through a root Bun script:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The build validates site links; `tests/unit/docs-site.test.ts` checks public content against the bot. Do not merge a site change while **Documentation site / Build** is red. Use placeholders, not deployment or member data. Tester names and the maintainer's contact details belong only on the site's Thank you page.

## Live testing and delivery

- [DevBot](docs/DEV_GUILD.md): DevBot on the staging host, isolated local development and owner-run acceptance.
- [Deployment](docs/DEPLOYMENT.md): release delivery, signed provenance, the runtime, owner provisioning, cutover, backups and recovery.
- [Threat model](docs/THREAT_MODEL.md): agreed scope and the requirement to prefer simple, standard components.

Building a release does not authorize restarting a shared bot, migrating a live database, writing to Discord, changing a provider/environment, pushing, or dispatching a workflow. Agents must follow [AGENTS.md](AGENTS.md); production deployment approval remains the owner's GitHub action.
