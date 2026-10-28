---
title: Maintenance tools
description: The one-shot tools for migrations, command registration, backups, restores, retries and restore checks, run inside the bot's image.
sidebar:
  order: 7
---

TaruBot's maintenance tools are compiled scripts in the bot's image. Run them in a throwaway container from the directory that holds `docker-compose.yml`, so they use the same image, settings and database as the bot:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/<tool>.js [arguments]
```

Always name the tool: a `run` without a command starts a second bot, which waits for the writer lease and takes over as soon as the first one stops. `--no-deps` leaves the running services alone, and `-T` keeps the output plain for scripts and logs. The container's filesystem is [read-only](/tarubot/deploy/install/#the-bots-container). Most tools only print, so to keep their output, redirect it on the host (`… > output.json`). The two that write a file, `preview.js --output` and `snapshot.js`, need [a writable mount](#previewjs) for that run. Each tool checks its settings against its deployment profile before it touches Discord or the database; yours is the unmanaged profile (see [Requirements](/tarubot/deploy/requirements/#maintenance-tools-and-profiles)). A tool that refuses exits without changing anything, and names the setting at fault, never its value.

The upstream deployment runs these same tools as one-off containers of its own Compose project, with its own settings and managed database, not the stock bundled one. Its owner commands are in [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#everyday-operations); do not run generic examples against its managed application/database.

## The tools

### migrate.js

Applies pending database migrations, checksum-verified, in one transaction, and prints `Schema ready.` The bot does the same itself whenever it starts ([what a start does](/tarubot/deploy/operations/#what-a-start-does)), so you need this only to migrate ahead of a start, or as a separate step on a platform that runs one.

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/migrate.js
```

It follows the bot's backup rule: with [backups](/tarubot/deploy/operations/#backups) set up, it takes an encrypted backup under the writer lease before the first file runs, and a failed backup applies nothing; without them it warns and migrates. Stop the bot first: with a migration pending, `migrate.js` waits up to `MIGRATE_WRITER_WAIT_SECONDS` for a running bot to stop, then refuses. See [the migration guard](/tarubot/deploy/operations/#migration-guard).

`--restore-rehearsal` migrates a restored copy first, to rehearse a migration before the live database. It accepts only a `DATABASE_URL` whose database name ends in `_restore_test`, and takes no backup of that disposable copy; see [Restore rehearsal](/tarubot/deploy/operations/#restore-rehearsal).

### register.js

Replaces the application's slash commands with the ones this release declares, in exactly one scope:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/register.js --global
docker compose run --rm --no-deps -T tarubot bun dist/scripts/register.js --guild YOUR_GUILD_ID
```

It first confirms that the token belongs to `DISCORD_APPLICATION_ID`. `--global` is refused while `TEST_GUILD_ID` is set. The bot registers its commands globally (or in `TEST_GUILD_ID`'s server) whenever it starts, so you need this only to repair that set between releases. Don't use `--guild` beside the bot's own global registration: a server with both sees every command twice.

### commands.js

Reads command registrations back, and cleans up leftovers. It uses Discord's API only, not the database.

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/commands.js list
docker compose run --rm --no-deps -T tarubot bun dist/scripts/commands.js list --declared-scope YOUR_GUILD_ID
```

`list` reads the global scope and every server's scope, and exits 0 only when the declared scope matches this release exactly and every other scope is empty. The declared scope is global unless you name a server with `--declared-scope`, as you should if you registered with `--guild`. Add `--guild YOUR_GUILD_ID` (repeatable) to read only those servers.

```sh
docker compose run --rm --no-deps -T tarubot \
  bun dist/scripts/commands.js clear-guild YOUR_GUILD_ID --application YOUR_APPLICATION_ID
```

`clear-guild` removes one server's leftover commands, for example after moving from `--guild` to `--global` registration. Without `--confirm` it's a dry run that lists the commands and prints a fingerprint; run it again with `--confirm <fingerprint>` to remove exactly those. Nothing here ever changes the global scope.

### backup.js

Takes one encrypted backup now, the same as the bot's daily one, with the bot's own [backup settings](/tarubot/deploy/configuration/#backups):

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/backup.js
```

It prints what it stored as JSON: the stamp, the `daily` key and size, the `monthly` copy (on the 1st of a month, otherwise `null`) and the settings copy under `env`. It exits non-zero when the backup fails, or when backups aren't set up. It doesn't need the bot stopped: `pg_dump` reads one consistent snapshot whatever the bot writes meanwhile. See [Backups](/tarubot/deploy/operations/#backups).

### restore.js

Lists the backups in the bucket, restores a database from one, or recovers a settings copy. It needs the four `BACKUP_STORAGE_*` settings, and reads the age identity (the file `age-keygen` wrote, as it is: its `#` comment lines are fine) from standard input only, never from an argument or a setting:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/restore.js list
docker compose run --rm --no-deps -T tarubot \
  sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restored" exec bun dist/scripts/restore.js database latest' \
  < backup-identity.txt
docker compose run --rm --no-deps -T tarubot \
  bun dist/scripts/restore.js settings latest < backup-identity.txt > recovered-settings.env
```

- **`list [daily|monthly|env]`** prints each backup's key and size, newest first; without a group, all three.
- **`database KEY|latest`** restores a `daily/` or `monthly/` dump (`latest` is the newest daily one) into the database `RESTORE_DATABASE_URL` names, which must exist, be empty and differ from `DATABASE_URL`. It runs `pg_restore` as one transaction, so a failure leaves the target empty. Then, in one more transaction, it signs everyone out of the dashboard and closes the role changes the backup caught waiting, the two steps every restored database needs before a bot starts on it. It prints the restored key, the target's host and database, the schema's newest migration, and what it closed.
- **`settings KEY|latest`** writes a settings copy (`latest` is the newest) to standard output. It holds every secret: write it only to a private file, and delete it once you've taken what you need.

Bad arguments print the usage and exit 2. [Recovery](/tarubot/deploy/operations/#recovery) and [Restore rehearsal](/tarubot/deploy/operations/#restore-rehearsal) show it in use.

### retry.js

Puts one blocked, failed or paused job back in the queue, clearing its diagnostic:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/retry.js YOUR_GUILD_ID JOB_ID
```

The job must belong to that server. It refuses, changing nothing, when a newer job for the same work is already queued, running or blocked, and prints that job's ID instead. The retry is audited. See [Jobs that need attention](/tarubot/deploy/monitoring/#jobs-that-need-attention).

### check-restore.js

Compares the database with a restored copy: every application row by exact checksum, plus sequences, triggers and constraints. It's read-only, and meant for a stopped bot.

```sh
docker compose run --rm --no-deps -T tarubot \
  sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/check-restore.js'
```

Both databases must be at this release's schema. `--schema-version <file>.sql` names an earlier migration instead, for a check before migrating. A copy `restore.js` made differs in `web_sessions` or `jobs` whenever its closing steps changed something there; its output says. See [Restore rehearsal](/tarubot/deploy/operations/#restore-rehearsal).

### preview.js

An optional, read-only look at what reconciliation would do in one server right now: each member's role and nickname changes, departures waiting for confirmation, and the guest-application, onboarding and role-layout switches, including what turning the layout on would move.

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/preview.js YOUR_GUILD_ID
```

It needs a recent accepted roster, and it reads the member list from Discord.

`--output PLAN.json` also saves the first-activation grandfathering plan that `activate.js --grandfather-plan-file` confirms. Only a server imported from the previous bot and not yet activated has one; for any other server, the tool saves nothing and exits 1. The container can't write the file, so give that one run a writable mount and point `--output` into it:

```sh
mkdir -p work
docker compose run --rm --no-deps -T -v "$PWD/work:/work" tarubot \
  bun dist/scripts/preview.js YOUR_GUILD_ID --output /work/plan.json
```

The directory must be writable by uid 1000, the image's `bun` user. Without the mount, the tool fails with `EROFS` after its Discord and database reads, and saves nothing. `snapshot.js` always writes its `--output` file, so it needs the same kind of mount. A tool that only reads a file, such as `activate.js --grandfather-plan-file`, can use a read-only one (`-v "$PWD/work:/work:ro"`).

## Tools you won't need

The image also carries `import.js`, `snapshot.js`, `acquire.js` and `activate.js`, which moved the upstream project's server from its previous bot to TaruBot, and `discord-inspect.js` and `discord-smoke.js`, which check the upstream project's own deployments and refuse to run under the unmanaged profile. New servers need none of them: a server goes live with its first `/config` change or `/setup onboarding confirm:true`.

## Tools outside the container

The same tools can run from a source checkout with Bun, against the loopback database port that `docker-compose.tools.yml` publishes. That's a development setup: it reads `DATABASE_URL` from `.env`, and a `bun run` child loads the checkout's `.env` automatically. Follow [CONTRIBUTING](https://github.com/deconfined/tarubot/blob/main/CONTRIBUTING.md) for the toolchain/checks and run `bun run build` before `bun dist/scripts/<tool>.js`. [CONFIGURATION](https://github.com/deconfined/tarubot/blob/main/docs/CONFIGURATION.md#maintenance-tool-profiles) describes the guard every tool applies before connecting.
