# TaruBot — working guide for Claude Code

@AGENTS.md

AGENTS.md holds the repository rules: branching, SemVer, signing, Drizzle, migrations. This file adds what a Claude session needs to work here. For current state, start with docs/SESSION_HANDOFF.md. The backlog is in docs/OPEN_ITEMS.md, and the owner's policy decisions are in REQUIREMENTS.md, including its "Approved launch amendments (2026-09-23)", "Approved reply-session amendments (2026-09-24)", "Approved hosting amendment (2026-09-24)" (with its 2026-09-25 follow-up), "Approved Lodestone amendments (2026-09-24)", "Approved issue-reporting amendments (2026-09-24)", "Approved officer-notice amendments (2026-09-25)", "Approved changelog amendments (2026-09-25)", "Approved documentation-site amendments (2026-09-25)", "Approved public-suggestion amendments (2026-09-25)", "Approved status-notice amendments (2026-09-25)", and "Approved SSH-deploy amendments (2026-09-26)" (whose agent rule the owner confirmed in full on 2026-09-26; see "Production deploys" below).

## Project map

- `src/main.ts`: composition root. It wires the database, Discord gateway, Lodestone adapter, services, and job queue.
- `src/bot/`: module contracts, recursive discovery, the service registry, and the router. The router handles actor resolution, authorization, acknowledgement, and the optional pre-modal check a modal command can declare with `beforeModal`. `shape.ts` refuses a subcommand or option the release doesn't declare (another release's registration) with the stale card.
- `src/commands/<feature>/*.command.ts` (one root command per file), `src/events/*.event.ts`, and `src/components/*.component.ts`: all discovered automatically. See docs/MODULES.md.
- `src/application/`: durable business operations.
  - `service.ts`: facade covering claims, ledger, guests, and config, including `/config role_layout` and `adopt_holders`.
  - `synchronization.ts`: roster acquisition and per-user reconciliation.
  - `guild-access.ts`: channel policy.
  - `role-administration.ts`: `/setup` and officers.
  - `access-facts.ts` and `rank-policy.ts`: eligibility inputs.
  - `lifecycle.ts`: readiness, startup, and the database writer lease.
  - `activation.ts` and `grandfathering.ts`: imported-guild activation and first-activation grandfathering.
  - `heartbeat.ts`: the healthchecks.io dead-man's switch (2.22.0), pinged every five minutes while ready (`HEALTHCHECKS_PING_URL`; empty is off).
  - `status-notices.ts`: the officer status posts (2.29.0, #31): recording decisive changes after each role update and confirmed departures in the roster transaction, and the `officer.status` job (resume a frozen batch, the two-minute window, budget-sized batches, send, mark). The pure rules are in `src/domain/status.ts`, and the post in `src/discord/presenters/officer.ts`.
  - `issue-reports.ts` and `recent-logs.ts`: issue reports to the private GitHub repository (`/issue`, unexpected errors, failed jobs, repeated trouble). Pure helpers such as redaction and fingerprints live in `src/domain/reports.ts`, and the client in `src/infrastructure/github/issues.ts`.
  - `suggestions.ts`: `/suggest` (2.28.0), public feature suggestions posted at once to `deconfined/tarubot` as the TaruBot GitHub App (`src/infrastructure/github/app.ts` signs the JWT and mints an installation token per post), with limits counted from the audit table. The pure cleaning, public format and final check live in `src/domain/suggestions.ts`.
- `src/domain/`: pure logic.
  - `policy.ts` computes desired access (the multi-character union, ROLE-07).
  - `grandfathering.ts` holds the plan and checksum, and `role-layout.ts` the layout planner.
  - `values.ts` holds `Failure`, `json`, and ID parsing.
  - `changelog.ts` decides update posts (2.25.0): the release range and what one `changelog.post` job does. `release-notes.ts` is the member-note map it reads.
  - `status.ts` holds the status-post state (2.29.0): its zod schemas, recording a pass (`observe`), departures, entries, the mark and the reasons. `policy.ts` `accessDecisive` and `rank-policy.ts` `rankDecisive` say which decisions don't depend on held roles.
- `src/config/`: `env.ts` validates runtime configuration. `deployment.ts` is the maintenance tools' deployment-identity guard; since 2.28.0 its production guild list also gates `/suggest` at runtime.
- `src/discord/`: the gateway adapter, option builders, and replies. `inspection.ts` holds pure helpers over raw REST payloads. `obfuscation.ts` (2.30.2, #47) holds the shared channel-obfuscation helpers: the `CHANNEL_OBFUSCATED` flag check, `cachedAsHidden` (a cached entry obfuscated or denying TaruBot View Channel) and the 50001/10003 answers, used by `guild-access.ts`, `gateway.ts` `validateChannel`, `/channel` and the inspector.
- `src/jobs/`: `queue.ts` (leases, generation fences, `jobOutcome` log levels) and `dispatch.ts` (job kinds, and the authoritative role-layout gate).
- `src/infrastructure/postgres/`: `schema.ts` holds the Drizzle mappings. `database.ts` handles migrations, the startup schema check (`SCHEMA_VERSION`), and `orm(client)`.
- `src/import/`: the legacy MariaDB importer. Imports keep the legacy review channel with the guest-application switch off, and start with layout off and grandfathering pending.
- `scripts/`: one-shot operator tools: migrate, register, commands (scope read-back and cleanup), snapshot, import, acquire, preview, activate, retry, check-restore, discord-inspect, discord-smoke, selectors-update (the bundled selector set), and host-env-backup (the encrypted off-host copy of the production `.env`, run on the operator machine). Host-side files live in `ops/`: `backup.sh` (the daily encrypted dump to Linode Object Storage, 04:30 UTC from `tarubot`'s crontab), `deploy.sh` (2.30.0: the deploy key's forced command, run by `.github/workflows/deploy.yml` after the owner approves a production deploy; docs/HOSTING.md "Automated deploys"), `bucket-lifecycle.xml` and `age-recipients.txt`. `deploy.sh`'s command format and run-directory layout are a versioned contract: changing either raises its `FLOOR` to that release, because after a rollback an older copy answers the current workflow. It also judges a new release by the bot's "Modules loaded" and "Database writer lease acquired" messages at info, which are frozen (AGENTS.md).
- `src/infrastructure/lodestone/`: the Lodestone adapter, in the bot process since 2.21.0 (there is no sidecar and no Nodestone).
  - `client.ts` (`Lodestone`): parse slots (`LODESTONE_CONCURRENCY`, waiting rather than refusing), retries, reachability, and validation of every parsed field.
  - `runner.ts` fetches under the network policy (region, `gate.ts` spacing and 429 cooldown, body bound, private-profile detection), then parses in a fresh worker (`worker.ts`), terminated at the deadline.
  - `parser.ts` is TaruBot's own parser: it applies `lodestone-css-selectors` definitions with linkedom and matched Nodestone's output on live pages. `pages.ts` says which page, files and keys each operation reads.
  - Selectors follow upstream HEAD live, in memory: `selectors.ts` downloads and validates them, and `upstreams.ts` checks HEAD. `bundled.ts` is the set shipped with the release (`bun run selectors:update` refreshes it).
- `site/`: the public documentation site (Astro Starlight, published to GitHub Pages at https://deconfined.github.io/tarubot/ by `.github/workflows/pages.yml`). It is a standalone **pnpm** package on Node, the one exception to Bun. Pages are hand-written Markdown in `site/src/content/docs/` (`use/`, `admin/`, `deploy/`, `architecture/`, `reference/`, `project/`), with placeholders only. They hold the former docs/ setup, operations and roadmap guides and the README's usage sections. `tests/unit/docs-site.test.ts` checks the command reference, settings, reply codes, the add-to-server permissions table and repository links against the code, and guards public content (including no Discord invite or authorization URL).
- `docs/`: contributor detail (MODULES, PERSISTENCE, LODESTONE, CONFIGURATION, CI_CD, REPLIES, TEST_PLANS) and maintainer records (SESSION_HANDOFF, OPEN_ITEMS, HOSTING, MIGRATION, DEV_GUILD, VERIFICATION, APP_PLATFORM). Not published.
- `migrations/NNN_*.sql`: the schema authority. Never edit an applied migration. `SCHEMA_VERSION` must name the newest file (currently `010_status_notices.sql`; 2.25.0 to 2.28.x required `009_changelog_channel.sql`, 2.24.x `008_issue_reports.sql`).

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run format:check && bun run build
bun run test:unit && bun run test:contract          # fast, no database
bun run test:docker                                  # full suite: disposable PostgreSQL + supplied tarubot_backup.sql
bun run test:fixture && LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker   # synthetic CI input
CI_BASE_SHA=$(git rev-parse origin/main) bun run ci:version                           # the gate CI runs last
(cd site && pnpm install --frozen-lockfile && pnpm run build)                       # the site, with its link validator
```

Run a single file with `bun test tests/unit/<name>.test.ts`. Integration tests need PostgreSQL, so run them through `test:docker`.

## Every change set

1. Branch from `origin/main`. Local `main` may lag.
2. Bump `package.json`. Add `## X.Y.Z — Title` to CHANGELOG.md and update its current-version sentence. If the release changes something members notice, add a one-sentence note to `src/domain/release-notes.ts`.
3. Sync the version everywhere it appears:
   - `test-plans/current.json`;
   - the current-version sentences in docs/CONFIGURATION.md and docs/PERSISTENCE.md.

   Record the evidence in docs/VERIFICATION.md, and state changes in docs/OPEN_ITEMS.md and docs/DEV_GUILD.md.

   Update the site page the change affects (`site/src/content/docs/`) in the same change set: a new or changed command, option, setting, reply code or behavior.
4. In `test-plans/current.json`, each actor's list must fit in one 1,024-character embed field (`tests/unit/test-session.test.ts`).
5. Run the checks above, then commit with the configured SSH signing key (`~/.ssh/id_git`, `gpg.format=ssh`; see docs/SESSION_HANDOFF.md). If signing fails, ask the owner; never create an unsigned commit. Push or open PRs only when the owner asks.
6. Merging to `main` requires a PR, a strict up-to-date `CI result`, signed commits, and the CodeQL gate (no new high-severity security alerts or error-level results). Only merge and squash are allowed. Actions must be pinned to full commit SHAs.

## DevBot operations

- Always pass both Compose files: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml …`. That targets the `tarubot_dev` database and test guild `1040379370159743139`. Pin releases with `TARUBOT_IMAGE_TAG=X.Y.Z`.
- Docker on this Linux machine needs the `docker` group. When the session predates the group change, run Compose through `sg docker -c '…'`; don't change group membership yourself.
- The tool guard's DevBot profile requires local tools to name `…/tarubot_dev`, on loopback or `postgres`, with an empty CA. The one exception is `migrate.js --restore-rehearsal`, which requires a `*_restore_test` copy instead. If the owner's `.env` still says `…/tarubot`, local tools are refused. Changing it is the owner's action; never edit `.env` yourself.
- Updating DevBot (see docs/DEV_GUILD.md and the site's `site/src/content/docs/deploy/operations.md`):
  1. Stop `tarubot`.
  2. `pg_dump` to `.cache/backups/tarubot_dev-before-X.Y.Z-<sha>.dump`.
  3. Restore it into `tarubot_dev_restore_test` and run `dist/scripts/check-restore.js`. Use the currently deployed build, or the new build with `--schema-version <current head>.sql`, because both databases are still on the old schema.
  4. If there is a migration, rehearse it on the restore first: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml run --rm --no-deps -T tarubot sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'` must print `Schema ready.` Then run a plain `dist/scripts/migrate.js` against `tarubot_dev`.
  5. `up -d --wait --remove-orphans tarubot` (`--remove-orphans` clears a pre-2.21.0 sidecar container).
  6. Register guild commands, then confirm with `dist/scripts/commands.js list`.
  7. Check readiness (including `writerLease`), logs, and the plan posted in #chat.
- Run one-off tools inside the image: `… run --rm --no-deps -T tarubot bun dist/scripts/<tool>.js`. For other database names, derive the URL inside the container (`${DATABASE_URL%/*}/<db>`) instead of printing credentials.
- Ask the owner before stopping or restarting DevBot, running migrations, or writing to Discord. Read-only checks don't need approval.
- `.env` belongs to DevBot (app `943291473477128243`). Never put production credentials in it.

## Production and cutover

- Production went live on 2026-09-24. Since that evening it runs on a Linode Docker host, reached as `tarubot@<production host>` (`~/tarubot`, `docker-compose.production.yml`, a mode-600 `.env`), attached to Linode managed PostgreSQL `tarubot-pgsql` (database and user `tarubot`, direct port 27520, never the 27521 pool). See docs/HOSTING.md. App Platform is retired (2.21.0): the Lodestone returns 403 to DigitalOcean's addresses, and with the parser inside the bot it could not serve as a fallback. docs/APP_PLATFORM.md stays as the record; its spec and tooling were removed.
- Production tools never run from this checkout or its `.env`. They run from a clean clone of the deployed release as `env -i HOME="$HOME" PATH="$PATH" bun --env-file="$HOME/tarubot-cutover/production.env" dist/scripts/<tool>.js`, never `bun run`. The file is a copy of `production.env.example`. Before the window, token use is limited to read-only REST inspection and rehearsal logins against `tarubot_rehearsal`, under `TARUBOT_ENVIRONMENT=rehearsal`, which the guard keeps read-only on Discord. See docs/MIGRATION.md E0–E2. The automated deploy (2.30.0) runs `migrate.js`, `register.js --global` and `commands.js list` inside the deployed container on the host instead, so the token and database URL never leave the host's `.env`.
- The production application `965294750741692416` must not be installed in the dev guild; the owner removes it before cutover.
- Production registers commands only with `register.js --global`; the guard refuses a production `--guild` registration, which would show every command twice.
- Cutover rules live in the REQUIREMENTS.md launch and reply-session amendments and docs/MIGRATION.md. Read them before touching import, activation, access policy, or tooling:
  - registered-user Guest applies in every guild, as the union over linked characters;
  - first activation writes one-time `grandfathered` grants from a checksum-confirmed preview;
  - the role layout is off for imported guilds;
  - guest applications and onboarding are off, and `/setup` is not run in production. The import keeps the legacy review channel with the guest-application switch off; `activate.js` changes the switch only with `--guest-applications open|closed`, and reopening after launch is `/config guest_applications enabled:true`;
  - officers come from the in-game rank, with the legacy role bound `adopt_holders:false`. At W15 the order is `/config officer_rank`, then `/officer grant` for each approved exception (recorded while no role is bound), then the binding, whose repair pass would otherwise strip exceptions;
  - the order is acquire twice → preview → activate → register → full deploy;
  - the cutover used release 2.16.0 (2.14.0 added the reply embeds; 2.15.0 the reply-session fixes and features, with migration 006; 2.16.0 the deployment safeguards: the migration guard, the schema re-check after the writer lease, and the stale card for undeclared command shapes). After launch: 2.16.1 moved the docs and tooling to the Linode host, 2.17.0 hardened Lodestone handling (migration 007), 2.18.0 added the issue reporter, 2.19.0 live selectors, 2.20.0 TaruBot's own parser, 2.21.0 moved the parser into the bot (no sidecar), and 2.22.0 adds the healthchecks.io heartbeat; then OPS-10/OPS-11. Since then: 2.24.3 officer Lodestone notices, 2.25.0 update posts (migration 009), 2.27.0 the documentation site (docs only; 2.26.0 was skipped because the site merged first), and 2.28.0 `/suggest`; 2.29.0 (#31) posts member status changes to officers (migration 010), and 2.30.0 (#41) adds owner-approved production deploys over SSH (`.github/workflows/deploy.yml`, `ops/deploy.sh`; no bot change). 2.30.2 (#47) keeps onboarding correct under Discord's channel obfuscation (no migration).
- Nothing here authorizes provider actions. Cluster, app, trusted-source, token, and registration changes each need the owner's explicit go-ahead.
- Production deploys (2.30.0, REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"): the owner's approval of the `production` environment in GitHub is the go-ahead for a Deploy production run and what its plan lists (the restart or migration path, the automatic restore, command registration). The agent rule is in AGENTS.md, verbatim from REQUIREMENTS.md. The owner confirmed all of it: its first part with question 1 (that approval is the go-ahead, and Claude sessions never approve), and the other clauses, proposed in PR #44, on 2026-09-26 ("Agreed on the agent rule." on #41). For a Claude session the two parts together mean: no `…/pending_deployments` call and no GraphQL `approveDeployments` or `rejectDeployments`; no `gh workflow enable` or `disable` of `deploy.yml`; no `gh run cancel` or `rerun` of its runs; no `gh secret` or `gh variable` for the environments or `DEPLOY_ENABLED`; never the deploy key's private half; and `gh workflow run deploy.yml` only when the owner asks in that session. The user-level deny rules refuse the first three strings in any shell command, greps and commit messages included. Setting up the key, the environments, Pushover and the firewall are the owner's steps; Claude only prepares the commands (docs/HOSTING.md "Setting it up").

## Gotchas

- The shell is zsh:
  - A variable holding a command doesn't word-split; wrap the command in a function instead.
  - `$var:l…` and `$var:s…` are parsed as modifiers, so write `${var}:latest`.
- pnpm refuses to run in the repository root (`ERR_PNPM_OTHER_PM_EXPECTED`, because the root `package.json` pins Bun). Use pnpm only in `site/`, and add no root scripts for the site: a `bun run` child would load the root `.env` into Astro's environment.
- Bun auto-loads `.env` for every `bun` command run in this directory.
  - A `bun run` child reloads it even when the parent used `--env-file`.
  - Shell exports override an env file.
  - The tool guard refuses production and rehearsal runs that could merge these values.
- One bot process writes to a database. It holds the writer lease (PostgreSQL advisory lock `714882494`) from before login until shutdown, and checks the lease session every 30 seconds, exiting with status 1 if it errors, goes silent or no longer holds the lock (also when shutdown then hangs, through the 27-second deadline). Every lease statement, including each wait attempt, has a 10-second client-side deadline; a waiting process whose session goes silent exits with status 1 too. A second instance logs `Waiting for the database writer lease…`, stays unready (readiness 503) and does nothing until the lease frees, then checks the schema again before logging in. Since 2.16.0 `migrate.js` takes the same lease (transaction-scoped) whenever a migration is pending, waits up to `MIGRATE_WRITER_WAIT_SECONDS` (90) for a stopping bot and then refuses, so stop the bot before migrating; with nothing pending it ignores the lease. Before migrate, import, activate, or restore, still check `pg_locks` for that key (the writer gate in `site/src/content/docs/deploy/operations.md`).
- Queue waits (`busy`, `ordered`, `cooldown`, `superseded`, and since 2.17.0 the Lodestone's `rate_limited`) are expected and log at debug. `lease_lost` logs at warn, and only terminal failures log at error. Throttling shows instead as one bot log line per Lodestone 429 ("The Lodestone throttled TaruBot") and in `/health/ready` (`lodestone.cooldownSeconds`).
- Profile refreshes (2.17.0):
  - The scheduler uses `scheduleJob`, which never touches an active job; `enqueue` pulls one forward. It stamps `characters.profile_retry_at` an hour ahead for each character it queues.
  - A private profile (`private_profile`) completes the job as `{status: "private"}` and waits for the profile interval.
  - A 404 follows the two-404 rule (`Service.profileMissing`). The first is recorded in `profile_missing_at`. One at least an hour later ends every active link through the same `endLink` path as `/unclaim`, audited with a null actor, with an `officer.notify` per link.
- Guild configuration changes (`/config` fields, officer rank, FC unlink, `/setup`, activation) bump `guilds.revision` and queue a full repair pass (`reconcile.guild`). A repeat that matches what is saved is a no-op (no revision bump, audit or repair pass) for `/config officer_rank` (the saved rank, or `unset_rank` with none set), `/config guest_applications`, `/config fc link` naming the linked FC, and an `activate.js` rerun on a live guild without `--requeue`. Role and channel fields save again even when unchanged. The exception is `/config role_layout`: it bumps the revision (fencing in-flight work) but queues no repair pass. Enabling queues one `roles.layout` pass, disabling queues nothing, and repeating the current value changes nothing (no revision bump and no audit).
- `/config guest_applications` saves `enabled`, `channel` and `unset_channel` in one revision with one repair pass, auditing each changed setting. It validates the channel that will take applications (a named one, or the stored one, such as an imported legacy channel, when the call switches applications on), never when switching off or unsetting, and refuses with the "Server settings changed" conflict if, under the row lock, the change would leave applications on with a channel other than the one it validated. No `/config` option is named `clear`: unsetting uses `unset_channel`, `unset_role` or `unset_rank`.
- Member overrides (`/officer grant|revoke|reset`, `/guest grant|revoke|reset`) leave the revision alone and queue `reconcile.user` for that member. The `/officer` trio needs a server manager (Manage Server and Manage Roles), and while an Officer role is bound each first runs `validateRole` on it: the bot must manage it and the manager's highest role must be above it (the server owner is exempt). The `/guest` trio needs bot officer access. `/officer reset` deletes the officer override so the rank decides, and like a revoke it works for a member who left. `/guest reset` lifts the revocation and ends every active grant of any provenance (kept as history); grandfathering still counts ended grants (basis `existing_grant`), so a reset before first activation stands. A reset with nothing to remove audits and queues nothing.
- Issue reports (2.18.0):
  - The composition root wraps the reporter: every error-level report also calls `IssueReports.error`, and every job that ends failed at error level calls `jobFailed`. Both never reject; `issue.report` failures never report themselves.
  - Reports are saved in `issue_reports` first and delivered by `issue.report` jobs. Repeats of a fingerprint count occurrences, and context is re-collected at most once a minute. Delivery opens the issue, comments on repeats at most hourly, and opens a new issue after a close. Daily caps (10 issues, 50 comments) apply to automatic reports only.
  - The lifecycle's `tick` option runs the trouble checks every five minutes. `GITHUB_REPORTS_TOKEN` empty means saved, not sent. DevBot's `.env` and the production host's both hold it (rotated on 2026-09-25).
- Public suggestions (2.28.0):
  - Text reaches the public repository only through `normalise`, `clean` (the shared `PUBLIC_PATTERNS`, repeated until nothing changes) and `assertPublic`, never through `IssueReports`. A change to the rules changes both the cleaner and the check.
  - `/suggest` needs the bound Member or Guest role in an allowlisted server (production's `deployments.production.guilds`, or DevBot's test guild). Officer access alone doesn't qualify.
  - `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` are production-only: they go in `docker-compose.production.yml` and the host's `.env`, never in `docker-compose.yml` or DevBot's `.env`. DevBot previews into the reports repository with `GITHUB_REPORTS_TOKEN`. Either app setting empty switches `/suggest` off.
  - Nothing is saved first. Limits come from `audit` rows (`suggestion.posted`, `suggestion.unconfirmed`); any GitHub error other than `rate_limited`, `invalid_data` or `configuration`, at the app's sign-in or the post, writes `suggestion.unconfirmed`. Submissions run one at a time, and the lifecycle's `drain` option waits for the one in progress before releasing the writer lease; later ones are refused as `stopping`.
  - Any new workflow gated on the OWNER, MEMBER or COLLABORATOR association must also skip issues carrying `SUGGESTION_MARKER` ("Suggested in Discord with TaruBot"), as `claude.yml` does. A trusted `@claude` comment on a `from-discord` issue still hands the member's text to the agent.
- With `role_layout_enabled` off, `roles.layout` jobs complete as `skipped: layout disabled`. That is intended, not a failure.
- Officer Lodestone notices (2.24.3, #29):
  - "FC roster accepted" posts only in the test guild (`guild.id === TEST_GUILD_ID`), on `officer:<guild>`. Production posts no roster line.
  - The degraded notice has its own key, `officer:<guild>:degraded:<fc>`, and is held 300 s. A non-waiting roster failure queues it unless a row on that key is pending (`queued`, `running`, `blocked` or `disabled`, of any age), or one created after the FC's `last_successful_roster_at` finished (or, unfinished, was created) within 24 h: `coalesce(completed_at, created_at)`.
  - An accepted roster with `last_error` set closes the key's unstarted rows as `{skipped: "recovered before posting"}` in every guild linked to the FC, active or not (the queue never claims an inactive guild's rows). For active guilds only, it queues `officer:<guild>:recovered:<fc>` (5 s) if a degraded row created after the previous boundary has a `message_id` or is `running`. `/config fc unlink` closes the old FC's unstarted row as `{skipped: "FC unlinked"}`.
  - Accepted edge case: a `running` degraded row is left alone at recovery and at unlink; if its send fails and is retried, it can post after the recovery line or the unlink. `dispatch.ts` is unchanged and doesn't know a notice's FC.
  - The boundary (`observedAt`, the bot's clock) is compared with `jobs.created_at` (the database's), so the two clocks must agree to within a few seconds (a fetch); NTP keeps them to milliseconds.
  - The `jobs` rows are the notice history, read by exact `dedupe_key`: never prune `officer.notify` rows (docs/PERSISTENCE.md).
- Update posts (2.25.0):
  - `guilds.changelog_version` is the newest version a guild was told about. Setting `/config changelog` where no channel was sets it to the running version (or keeps a higher one), so nothing posts until the next release with a member note. Moving or unsetting the channel keeps it, and the bot never lowers it: restarts and rollbacks on the same schema post nothing.
  - Startup queues one `changelog.post` (`changelog:<guild>`, payload `{}`) per present guild with a channel and an older baseline; a pending one merges. The job reads the range when it runs. `changelog unconfigured`, `already announced` and `nothing for members` complete before the effects gate, like `layout disabled`; only a post parks or blocks. The nonce key is `changelog:<guild>:<running version>`, and a compare-and-set moves the baseline.
- Officer status posts (2.29.0, #31):
  - `Synchronization.user` records Member, Guest, Officer and FC Leader on `guild_users.status_state` after a successful role write, only when the decision doesn't depend on held roles (`accessDecisive`, `rankDecisive`); a first decisive value, an unbound role and a new join time are silent. The roster records confirmed departures in its snapshot transaction. With no officer channel, a pass takes its change as announced and queues nothing, and the roster records no departure.
  - Lock order: the guild row, then its `guild_users` rows in `(guild_id, user_id)` order (`COLLATE "C"`), then job rows. `sync.guild`, recording a pass, and the status job's freeze, mark and no-channel drop take the guild row `FOR SHARE` first (the freeze, mark and drop take no jobs-row lock); `/config` adoption, `/setup` and activation take it `FOR UPDATE` first, so each side queues on the guild row. The roster share-locks its guilds, then locks departing owners' rows in that order before any `characters` row; `sync.guild` locks all its guild's rows up front. Member-row locks are `FOR NO KEY UPDATE`, never `FOR UPDATE`, so they don't block foreign-key checks (a `membership_history`, link or grant insert).
  - One `officer.status` job per guild (`officer:<guild>:status`, payload `{}`) resends a frozen batch first (only marking it when its `delivered` attempt, keyed by the nonce, shows Discord took it), then waits `ordered` (debug) until the oldest change is 2 minutes old, then posts budget-sized batches under `status:<batch>` nonces, recording `delivered` and then marking each before the lease check. Each freeze re-checks the guild's channel, effects and presence, and stops the drain with `superseded` if they moved. No officer channel completes `officer notifications unconfigured` before the effects gate and drops what waits. Recovery after a terminal failure is `retry.js` or the next change.
  - A successful run requeued for a newer generation now gets `attempts` reset (every kind).
- `/setup` enables onboarding, switches guest applications on (adopting the officer room as the review channel when none is set, and validating a kept one first), and adopts every Officer-role holder.
- Channel obfuscation (2.30.2, #47). From 2026-11-16 Discord leaves every channel TaruBot can't view out of `GET /guilds/{id}/channels` and sends it over the gateway as `___hidden___`, flagged `CHANNEL_OBFUSCATED`, with one synthetic @everyone deny (only id, type, position and parent_id real). `src/discord/obfuscation.ts` holds the rules.
  - Fail closed on hidden managed channels and saved rooms (ACCESS-01, @deconfined's decision on #47): the pass refuses with the `channel_permissions` fix naming `<#id>`, and `/setup` refuses a hidden saved room rather than create a second one.
  - Absence from this pass's REST list is the authority on what TaruBot can read. The flag is secondary, because a slash-command channel option can clear it on the cached entry while the synthetic deny stays.
  - Each channel the gateway has and the list left out gets one `GET /channels/{id}`. A 10003 counts as hidden when the cached entry is obfuscated or its cached overwrites deny TaruBot View Channel (`cachedAsHidden`); otherwise it is a deleted channel's stale entry. `validateChannel` reads a 10003 the same way.
  - A hidden Community Updates channel or category (excluded by ID) keeps @everyone's View Channel default (ACCESS-05's fallback) rather than refusing.
  - Nothing is ever planned or written from placeholder data: overwrites come from the forced read, and an obfuscated or unlisted channel is never written.
  - DevBot keeps the Developer Portal's obfuscation test toggle on until 2026-11-16; its checks are in docs/DEV_GUILD.md.
- Leave the old `feat/lobby-access` stash alone. It has been superseded. It exists only in the original Mac clone; this Linux clone has no stashes.
