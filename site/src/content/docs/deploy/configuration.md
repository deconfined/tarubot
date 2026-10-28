---
title: Configuration
description: Every setting in .env, what reads it, and its default.
sidebar:
  order: 4
---

Settings live in `.env` next to `docker-compose.yml`, copied from your release's [`.env.example`](https://github.com/deconfined/tarubot/blob/main/.env.example) as [Install](/tarubot/deploy/install/#1-get-the-compose-file-and-settings-template) shows. Keep it private (`chmod 600 .env`) and out of Git: it holds the bot token and the database password.

The bot validates its settings at startup and refuses to start with an invalid one, naming the setting but never its value. The web, mod mail and backup settings are the exception: a bad one only leaves its feature off or failing, and is reported by name. Compose passes the bot container only the settings `docker-compose.yml` lists; a one-off `docker compose run` can add others with `-e NAME=value`. Settings removed in earlier releases are ignored; the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) records each removal.

These settings describe the stock self-hosting Compose path. The upstream instance's settings are its own Compose project's environment, kept privately by its owner; its GitHub deploy workflow holds none of them, no database or Discord credentials included. See [the owner deployment runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#what-runs-on-a-docker-host).

## Runtime

Read by the running bot.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | (required) | The bot token from the Developer Portal. Secret. |
| `DISCORD_APPLICATION_ID` | (required) | The application's ID. The bot checks that the token belongs to it. |
| `COMMAND_REGISTRATION` | (empty) | Where the bot registers its slash commands each time it starts (2.46.0): `global`, one server's ID, or `off`. Empty or unset is off, so an installation upgraded from an earlier release keeps registering by hand until you choose; the template sets `global`, so a new installation registers by itself. Use a server ID only where you registered with `register.js --guild` before: a server with both scopes shows every command twice. `global` is refused while `TEST_GUILD_ID` is set; use that server's ID. A bad value files an [issue report](/tarubot/deploy/monitoring/#issue-reports) and skips registration, and never stops the bot. See [what a start does](/tarubot/deploy/operations/#what-a-start-does). |
| `ENABLE_EFFECTS` | `false` | The deployment-wide switch for Discord changes. With `false`, decisions are saved and Discord changes wait as paused work; a restart with `true` requeues them. Set `true` for a working deployment. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Logs are structured JSON; tokens and option values are never logged. |
| `ROSTER_INTERVAL_SECONDS` | `21600` | How often each linked FC's roster is read (at least 60), and how old a roster may be before it counts as stale. |
| `VERIFICATION_SECONDS` | `1800` | How long a `/claim` token stays valid, from 60 to 86,400. |
| `GUEST_COOLDOWN_SECONDS` | `86400` | How long a denied applicant waits before applying again (0 or more). |
| `HEALTH_PORT` | `3000` | The port of `/health/live` and `/health/ready` inside the container. |
| `DATABASE_CA_CERT` | (empty) | A PEM root certificate for an external PostgreSQL over TLS. With it set, certificate and hostname checks are enforced, whatever the URL's SSL options say. Not needed for the bundled database. Without it, the URL's own TLS options apply, to [backups and restores](#backups) too. |
| `GITHUB_REPORTS_TOKEN` | (empty) | A fine-grained GitHub token with read and write access to the issues of one repository, for [issue reports](/tarubot/deploy/monitoring/#issue-reports). Empty saves reports in the database without sending them. Secret. |
| `GITHUB_REPORTS_REPO` | `deconfined/tarubot-reports` | The `owner/name` repository reports open issues in. The default is the upstream project's own private repository, so **set your own whenever you set the token**, or leave the token empty. It may never name TaruBot's public repository, `deconfined/tarubot`, in any letter case: the bot refuses to start, so private reports can't go public. |
| `HEALTHCHECKS_PING_URL` | (empty) | The private ping URL of your [healthchecks.io](https://healthchecks.io) check, which the ready bot pings every five minutes. Empty turns the [heartbeat](/tarubot/deploy/monitoring/#heartbeat) off. Never publish the URL: anyone with it can ping your check. |

## Optional web dashboard

The stock, production and staging manifests pass these settings to the bot. [Installation](/tarubot/deploy/install/#optional-https-dashboard) explains the optional Caddy profile and external-proxy alternative.

| Setting | Default | Purpose |
| --- | --- | --- |
| `WEB_PUBLIC_ORIGIN` | (empty) | Enables web when set to the public HTTPS origin, for example `https://tarubot.example.org`. Shared with Caddy; also determines application URLs and the exact OAuth redirect `https://tarubot.example.org/auth/callback`. From 2.42.0, while the web settings are valid, `/dashboard` links to it and TaruBot's Discord status reads `Dashboard: https://tarubot.example.org`. |
| `WEB_PORT` | `8080` | Private web listener and Caddy upstream port. Not published on the host; distinct from `HEALTH_PORT`. |
| `DISCORD_CLIENT_SECRET` | (empty) | The existing Discord application's OAuth client secret, required with web enabled. Plain environment only; no `DISCORD_CLIENT_SECRET_FILE` form. |

`DISCORD_APPLICATION_ID` is also the OAuth client ID; do not create a second application for the dashboard. Keep secrets private in `.env`. Setting `WEB_PUBLIC_ORIGIN` enables the bot listener, not the bundled proxy: that additionally needs `COMPOSE_PROFILES=web`. The standard Caddy recipe publishes TCP 80/443; a custom public origin port needs a matching Caddy ports override.

Apply environment changes by recreating containers, not `docker compose restart`, which retains their old environment. Follow [enable, change and disable](/tarubot/deploy/operations/#dashboard-enable-change-and-disable) without starting a second writer.

## Optional mod mail

The stock, production and staging manifests pass this setting to the bot. [Mod mail](/tarubot/admin/mod-mail/) needs it, the dashboard and an officer notifications channel.

| Setting | Default | Purpose |
| --- | --- | --- |
| `MODMAIL_KEY` | (empty) | The key that encrypts every mod mail topic and message: base64 for exactly 32 bytes. Generate one with `openssl rand -base64 32`. Empty, or a value that isn't base64 for 32 bytes, leaves mod mail unavailable (an invalid value is reported by name, never shown) without stopping the bot; `/health/ready` reports only `modmail: true` or `false`. Secret; plain environment only, with no `MODMAIL_KEY_FILE` form. |

The key never enters the database, so a database dump, the provider's point-in-time recovery and anyone who can only read the database see the text encrypted. It doesn't help against someone who can write to the database (they could delete cases, or make themselves an officer and read them on the dashboard) or who controls the bot's container or its settings.

**Losing the key loses every case**, for good. Keep it in `.env` and one more copy somewhere else, such as in a password manager. With [backups](#backups) set up, each backup carries an encrypted copy of the bot's settings, key included, next to the database dump and to the same recipients: that copy is how a lost key is recovered, and it means **whoever holds your backups' age identity can read every mod mail case in them**. That's deliberate, so a lost installation restores fully, cases included; guard the age identity as you would the key. A database restore needs the same key to read its cases.

Don't change the key while cases matter: 2.43.0 has no key rotation, so a different key makes every existing case unreadable (the pages say so, and TaruBot files one issue report). Give each deployment its own key, as you would its other secrets. Apply a change by recreating the container, not restarting it.

## Backups

The stock, production and staging manifests pass these settings to the bot, which takes its own encrypted backups with them: daily, and immediately before it applies a migration. [Backups](/tarubot/deploy/operations/#backups) walks through setting them up. They're plain environment settings with no `_FILE` form.

| Setting | Default | Purpose |
| --- | --- | --- |
| `BACKUP_STORAGE_ENDPOINT` | (empty) | The bucket's own HTTPS address (virtual-hosted style), such as `https://your-bucket.s3.example.org`. `https://` may be left off, and a port is allowed. A path after the host, such as `/tarubot`, becomes a prefix of every key, so lifecycle rules must include it too. Empty turns backups off. |
| `BACKUP_STORAGE_ACCESS_KEY` | (empty) | The access key ID of a key pair that can read and write the bucket. Required with an endpoint. |
| `BACKUP_STORAGE_SECRET_KEY` | (empty) | That key pair's secret. Required with an endpoint. Secret. |
| `BACKUP_STORAGE_REGION` | (empty) | The bucket's signing region, as your provider names it: lowercase letters, digits and `-`. Required with an endpoint; there's no default, because a wrong region fails every request. |
| `BACKUP_AGE_RECIPIENTS` | (empty) | The [age](https://age-encryption.org) public keys every backup is encrypted to, each starting `age1`, separated by spaces or commas. Each must be a real age key: a mistyped character fails its checksum, and the setting counts as invalid. Required with an endpoint. Not secret: only the matching identities can open a backup. |
| `BACKUP_TIME_UTC` | `03:00` | When the daily backup runs, as `HH:MM` in UTC. Only the process holding the writer lease takes it. |
| `HEALTHCHECKS_BACKUP_URL` | (empty) | The private ping URL of a [healthchecks.io](https://healthchecks.io) check for backups (a [backup check](/tarubot/deploy/monitoring/#backup-check)), separate from the heartbeat's. Empty sends no pings. Never publish it. |

A missing or invalid backup setting never stops the bot. Once it holds the writer lease, it files one [issue report](/tarubot/deploy/monitoring/#issue-reports) naming the settings at fault, never their values, and every backup then fails, the one before a migration included, so that migration waits until they're fixed. With the endpoint empty, there are no daily backups (the bot logs that once), and migrations apply after a warning, without a backup first. Issue reports remove the two keys and the ping URL.

A backup reads the database through `DATABASE_URL` and `DATABASE_CA_CERT`, like the bot. Without a CA, `pg_dump` and `pg_restore` follow the URL's TLS options the way the bot does: `sslrootcert`, `sslcert` and `sslkey` name files inside the container, `sslmode=no-verify` encrypts without verifying, and `sslmode=verify-full` without `sslrootcert` checks against the image's system certificates. `sslmode=verify-ca` without `sslrootcert` is refused: set `DATABASE_CA_CERT`, or name `sslrootcert`. [`restore.js`](/tarubot/deploy/tools/#restorejs) needs the four `BACKUP_STORAGE_*` settings, and for a database restore `RESTORE_DATABASE_URL` too ([maintenance tools only](#maintenance-tools-only)), on PostgreSQL 17 or newer.

## Lodestone

Read by the bot's Lodestone adapter, which fetches and parses Lodestone pages in the bot process. The defaults suit almost every deployment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LODESTONE_REGION` | `na` | `na`, `eu`, `fr`, `de` or `jp`: which regional Lodestone the bot reads. |
| `LODESTONE_CONCURRENCY` | `2` | Pages parsed at once, 1 to 4. More requests wait for a slot. |
| `LODESTONE_START_MS` | `1000` | The minimum spacing between request starts, process-wide, 1,000 to 60,000. |
| `LODESTONE_TIMEOUT_MS` | `15000` | The deadline for one page fetch, 1,000 to 60,000. |
| `LODESTONE_BODY_BYTES` | `2000000` | The largest page accepted, 1,024 to 8,000,000 bytes. |
| `LODESTONE_REQUEST_TIMEOUT_MS` | `35000` | The deadline for one attempt: waiting for a slot and the gate, fetching and parsing; 1,000 to 120,000. |
| `LODESTONE_JOB_TIMEOUT_MS` | `300000` | The deadline for a whole search or roster read, retries included; 35,000 to 900,000, and no less than the request deadline. |
| `LODESTONE_ATTEMPTS` | `3` | Attempts for a temporary outage, 1 to 3. |
| `LODESTONE_MAX_PAGES` | `100` | The most pages a search or roster may span, 1 to 100. |
| `LODESTONE_SELECTOR_CHECK_SECONDS` | `900` | How often to check the selector repository for a new version: at least 300, or 0 to keep the set bundled with the release (for offline use). See [live selectors](/tarubot/deploy/monitoring/#live-selectors). |

After a Lodestone "429 Too Many Requests", the bot pauses every Lodestone request for a shared cooldown: 15 seconds, doubling on each 429 in a row up to 5 minutes, or a longer Retry-After of up to 15 minutes. Background work waits it out without using up attempts. The contributor notes in [docs/LODESTONE.md](https://github.com/deconfined/tarubot/blob/main/docs/LODESTONE.md) cover the adapter in depth.

## Compose only

Read by `docker-compose.yml`, not by the bot. Since 2.46.0 the stock file also passes them to the bot, which ignores them, so that each backup's settings copy works as `.env` again ([what a backup holds](/tarubot/deploy/operations/#what-a-backup-holds)). Set profiles here rather than with `--profile` on the command line, which never reaches that copy.

| Setting | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (required) | The bundled database's password, set when its volume is first created. Use letters, digits, `-` and `_`, because Compose builds the bot's connection URL from it. Changing it later doesn't change the existing database's password. Secret. |
| `TARUBOT_IMAGE_TAG` | `latest` | The release to run: a published version (recommended), `latest`, or `sha-<commit>`. The bundled proxy runs the same release's `web-<tag>` image, which exists for versions and `latest` only, so with the `web` profile don't use `sha-<commit>`. |
| `TARUBOT_IMAGE_REPOSITORY` | (empty) | The repository both images come from, without a tag; empty is `ghcr.io/deconfined/tarubot`. Set it only to another repository that carries the same tags, such as your own mirror. The upstream instance's manifests set it to the separate package only its approved deploy writes. |
| `TARUBOT_IMAGE` | (empty) | A complete image reference that overrides `TARUBOT_IMAGE_REPOSITORY` and `TARUBOT_IMAGE_TAG` for the bot only, for example one pinned by `@sha256:` digest. Keep `TARUBOT_IMAGE_TAG` at the same version for the proxy. |
| `COMPOSE_PROFILES` | (empty) | Optional services, separated by commas: `web` starts bundled Caddy, and `updates` starts the updater that follows `TARUBOT_IMAGE_TAG` ([automatic updates](/tarubot/deploy/operations/#automatic-updates)). Empty keeps the bot-only default or allows an external proxy. The included web file is still required when its profile is off. |

## Maintenance tools only

Read by the [one-shot tools](/tarubot/deploy/tools/), not by the running bot. `docker-compose.yml` passes the bot's container only the two `RESTORE_*` settings, empty unless set, so any other value in `.env` reaches only tools run outside the container. For a tool in the container, pass the setting with that run:

```sh
docker compose run --rm --no-deps -e MIGRATE_WRITER_WAIT_SECONDS=300 tarubot bun dist/scripts/migrate.js
```

A setting derived from the bot's own connection, such as `RESTORE_DATABASE_URL`, uses the `sh -c` form in the [restore rehearsal](/tarubot/deploy/operations/#restore-rehearsal), so no password is typed.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (template value) | The connection string for tools run **outside** the container, for example with the loopback port override. Under the stock Compose file the bot and the tools in its container get their own URL to the bundled database, and this line is unused. |
| `TARUBOT_ENVIRONMENT` | (empty) | The tools' deployment profile. Leave it empty: your deployment uses the unmanaged profile. The other values belong to the upstream project's own instances. |
| `RESTORE_DATABASE_URL` | (not set) | The empty database `restore.js database` restores into, or the restored copy `check-restore.js` compares with `DATABASE_URL`; it must be a different database from `DATABASE_URL`. Set it only for that run, never in `.env`. |
| `RESTORE_DATABASE_CA_CERT` | (empty) | A CA for `RESTORE_DATABASE_URL` when it differs from the primary's; empty reuses `DATABASE_CA_CERT`. |
| `MIGRATE_WRITER_WAIT_SECONDS` | `90` | How long `migrate.js` waits for a stopping bot to release the database before refusing a pending migration, 0 to 600. In the container, pass it with `-e` as above. The bot's own migration at startup always waits 90 seconds. |

## Upstream production only

The TaruBot project's own production deployment posts [`/suggest`](/tarubot/admin/suggestions/) ideas to TaruBot's public repository as its GitHub App. `/suggest` posts publicly only from the FC server that deployment serves, so every other deployment refuses it in every server, whatever these say. The one exception is a development deployment's test server ([`TEST_GUILD_ID`](#development-only)), where `/suggest` ignores these settings and previews privately into `GITHUB_REPORTS_REPO` when `GITHUB_REPORTS_TOKEN` is set. Leave them unset: the stock `docker-compose.yml` doesn't pass them to the bot, and they are never needed for a development deployment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | (empty) | The client ID of the GitHub App that opens `/suggest` issues. Not a secret. Empty switches `/suggest` off: members are told suggestions are switched off. |
| `GITHUB_APP_PRIVATE_KEY` | (empty) | That app's private key, the PEM file GitHub downloads, written as a double-quoted multi-line value like `DATABASE_CA_CERT`. Empty also switches `/suggest` off. It isn't read at startup, so a bad key fails only `/suggest`, with an issue report naming these settings. Secret. |

A change to either takes effect when the bot's container is recreated (`docker compose up -d --wait`); a plain `docker compose restart` keeps the old values.

## Secrets from files

Since 2.33.0 the bot and its maintenance tools can read six secrets from files instead of from variables: `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_REPORTS_TOKEN` and `HEALTHCHECKS_PING_URL`. A secret read from a file never enters the process's environment, which every dependency and child process can read.

| Setting | Default | Purpose |
| --- | --- | --- |
| `NAME_FILE` | (empty) | For each of the six, such as `DISCORD_TOKEN_FILE`: the path of a file inside the container that holds the value. The bot reads it as UTF-8 and removes one final newline. Empty counts as unset. |

- **One form per secret.** Set `NAME` or `NAME_FILE`, never both: the bot refuses to start, and the tools refuse to run, naming both settings but never a value or a path. A file that can't be read is refused the same way, naming `NAME_FILE`.
- **With the stock Compose file.** `docker-compose.yml` passes the plain variables only. To use a file, add your own Compose override that mounts it and passes `NAME_FILE`, and leave `NAME` empty in `.env`. Compose's `secrets:` element mounts a file read-only at `/run/secrets/<name>`, which suits the bot's read-only container. The file must be readable by uid 1000, the image's `bun` user that the bot runs as.
- **`DATABASE_URL` with the bundled database** stays as it is: the stock file builds that URL itself, so a `DATABASE_URL_FILE` there would be refused as both forms.
- **Maintenance tools** in the container read the same `NAME_FILE` settings, so they need nothing extra. `RESTORE_DATABASE_URL`, `RESTORE_DATABASE_CA_CERT` and the [backup settings](#backups) have no file form.
- **Backups' settings copy** holds each such secret's value under `NAME`, not the `NAME_FILE` path, so a copy restored from a backup works without the files.

## Development only

For a development deployment attached to one test server. Leave them at these values on a real deployment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `TEST_GUILD_ID` | (empty) | Confines the bot to one test server: it ignores every other server, posts the test-session plan there at startup, labels issue reports as development ones, and refuses global command registration, `COMMAND_REGISTRATION=global` included: set `COMMAND_REGISTRATION` to this server's ID. `/suggest` then works in that server and posts its previews into `GITHUB_REPORTS_REPO` with `GITHUB_REPORTS_TOKEN` (never publicly); without the token it is off. |
| `PUBLIC_TEST_RESPONSES` | `false` | With `true`, replies in the test server are visible to everyone there, so testers can watch a session. |
| `TEST_PLAN_CHANNEL_ID` | (empty) | Where the test-session plan is posted; empty looks for the test server's `#chat`. |
| `TEST_PLAN_FILE` | `test-plans/current.json` | The plan file posted at startup. |
