---
title: Updates, backups and recovery
description: Update to a new release, roll back, take and restore encrypted backups, and keep a single writer.
sidebar:
  order: 5
---

These procedures assume the stock `docker-compose.yml` with its bundled PostgreSQL, run from the directory that holds it and `.env`. Every decision TaruBot makes, and all the Discord work it still owes, lives in PostgreSQL, so the database is the one thing to protect.

The upstream instance runs the same image with managed PostgreSQL and its own manifests. An owner-approved deploy moves a registry tag there, an updater on its Docker host follows it, and starting the new image is the whole upgrade, as it is here; there's no automatic rollback. Its runbook is [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#how-a-release-reaches-production). The commands below are for your own stock Compose installation, not that managed instance.

## Updating to a release

Starting a newer image is the whole upgrade: the bot backs up, migrates and registers its commands by itself ([what a start does](#what-a-start-does)). To update by hand:

1. Read the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) entries between your release and the new one. Each says whether it adds a **migration**, whether its **commands changed**, and whether its Compose files or settings changed.
2. Make sure there's a backup from just before any migration. With [backups](#backups) set up, the bot takes it itself, immediately before migrating. Without them, take [a dump by hand](#a-dump-by-hand) first: the bot migrates as soon as it starts, and an older release can't run on the migrated database.
3. Fetch the new release's Compose files and settings template from the exact commit that built its image, keeping copies of yours. Nothing restarts yet.

   ```sh
   docker pull ghcr.io/deconfined/tarubot:X.Y.Z
   commit=$(docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z \
     --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
   cp docker-compose.yml docker-compose.yml.previous
   cp docker-compose.web.yml docker-compose.web.yml.previous
   curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.yml"
   curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.web.yml"
   curl -fsSL -o .env.example "https://raw.githubusercontent.com/deconfined/tarubot/$commit/.env.example"
   comm -13 <(grep -oE '^[A-Z][A-Z0-9_]*=' .env | sort) <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | sort)
   ```

   The image's `org.opencontainers.image.revision` label names the commit it was built from, the same commit as its `sha-<commit>` tag. The `comm` line (bash or zsh) lists settings the new template has and your `.env` doesn't: read their comments in `.env.example` and on [Configuration](/tarubot/deploy/configuration/), and add the ones you need. If you edited your Compose file, `diff docker-compose.yml.previous docker-compose.yml` and carry your changes over.

4. Pin the new release and start it:

   ```sh
   sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
   docker compose pull
   docker compose up -d --wait --remove-orphans
   ```

   Compose stops the old bot first (it finishes its work in progress and exits within 30 seconds), then starts the new one. `--remove-orphans` removes the containers of services the new Compose file no longer has. If the new file names a newer PostgreSQL image, Compose recreates that container too; the data stays in its [volume](#volumes).

5. [Check readiness](/tarubot/deploy/monitoring/#health-probes) and the log (`docker compose logs --since 10m tarubot`). After a migration, `Migrations applied` names the files, the `restorePoint` and the key of the backup taken just before; `Commands registered` follows once the bot is ready.

The outage is a few seconds, longer while a migration and its backup run. A new image never touches your database or restarts your bot by itself, unless you turn on [automatic updates](#automatic-updates).

The bot images of signed published releases pass vulnerability scans for both AMD64 and ARM64 before signing and promotion. Fixable high/critical findings block the release unless covered by an exact, reviewed exception with a documented reason and an expiry within 30 days. The default policy allows no exceptions. Scanner errors and expired exceptions block signing and promotion; repository ignore files cannot bypass the checks. A failed scan can leave candidate version tags in the registry without a signed release; do not treat an available tag as verification. The web image is the pinned stock Caddy image with TaruBot's static files added; it is signed like the bot's, not scanned separately. Use the signed digest and provenance checks in [installation](/tarubot/deploy/install/#checking-where-an-image-came-from), not just `latest` or a successful pull.

From 2.35.0, a server whose channels TaruBot could see only through Administrator gets [one officer alert](/tarubot/admin/notices-and-updates/#missing-channel-overrides) about missing channel overrides about six minutes after the update, even while TaruBot still holds Administrator. Its officers follow [the setup window](/tarubot/admin/add-to-server/#the-setup-window); readiness counts the channels in `visibility.missing`. Rolling back to an earlier release leaves TaruBot's channel entries in place, which is harmless. An alert still waiting at the rollback posts anyway, naming `/setup overrides`, which the earlier release doesn't have, and its recovery line follows only after you update again. Before 2.35.0, `/setup` has no dry run: it turns lobby onboarding on at once.

Keep optional web settings in `.env` during routine upgrades; do not overwrite it with the new template. With `COMPOSE_PROFILES=web`, the proxy follows `TARUBOT_IMAGE_TAG` to the same release's web image, keeping its certificate volumes. Recheck [public HTTPS and OAuth](/tarubot/deploy/install/#3-start-the-bot), not only private container health.

### What a start does

Every start of the bot's image, the first one included, runs the same steps:

1. **The deployment guard.** Its settings and database must belong to its deployment profile; yours is the unmanaged one.
2. **Pending migrations,** when there are any, in one transaction that takes the [writer lease](#single-database-writer), so no bot writes meanwhile. A previous bot that is still stopping is waited for, up to 90 seconds. With backups set up, an encrypted backup is taken under that lease, immediately before the first file runs, so nothing can change between the backup and the migration. Without backups, the bot logs a warning and migrates without one. A new database, with nothing in it yet, gets no backup either way.
3. **The writer lease, Discord and readiness,** as described under [single database writer](#single-database-writer).
4. **Command registration,** once ready: the release's commands replace the whole set in one go, globally (in `TEST_GUILD_ID`'s server instead when that's set). If Discord refuses the set, the bot files an [issue report](/tarubot/deploy/monitoring/#issue-reports) and keeps running with the commands Discord already has.

If the backup or a migration fails, nothing is applied: the database stays as the previous release left it, and the bot exits. Docker starts it again, with a pause that grows to a minute, so it keeps retrying until you fix the cause (often a backup setting, which the log names) or [roll back](#rollback). An image older than the database's schema refuses to start with `Schema version/checksum mismatch`.

### Automatic updates

The stock file's optional `updates` profile follows a moving tag for you, with [Watchtower](https://github.com/nicholas-fedor/watchtower) (Nicholas Fedor's maintained fork, pinned by digest). To turn it on, set in `.env`:

```sh
TARUBOT_IMAGE_TAG=latest
COMPOSE_PROFILES=updates
```

With the dashboard, use `COMPOSE_PROFILES=web,updates`. Then run `docker compose up -d --wait`. Every five minutes Watchtower checks the tags of the containers named `tarubot` and `tarubot-web`. When `latest` has moved to a new release, it pulls the new image, stops the old container (the bot within its 30 seconds), starts the new one with the old one's configuration, and removes the old image. The new bot then does what [every start](#what-a-start-does) does.

- **Every release arrives without you,** migrations included, and a migration can't be undone by changing the tag back. Set up [backups](#backups) first, so each migration is preceded by one.
- **Only images change.** A release whose changelog says its Compose files or settings changed still needs steps 3 and 4 of an update by hand.
- **The Docker socket.** Watchtower needs it, and it is root on that Docker host. Only this pinned image gets it.
- **Only the two named containers.** One-off tool runs (`docker compose run`) are named differently and left alone, and a stopped container stays stopped. Because the names are fixed, one Docker host runs one installation from the stock file.
- **A version tag never moves,** so with a version pinned Watchtower has nothing to do. To stop following `latest`, pin a version, or take `updates` out of `COMPOSE_PROFILES` and remove the updater with `docker compose --profile updates rm -sf watchtower`.
- **Not with a local build:** `docker-compose.build.yml` builds images that have no registry tag to follow.

### From a release before 2.46.0

1. Update to 2.46.0 or newer as above. Its Compose files replace the old ones: the proxy's configuration and offline page are now inside its image, so the `ops` folder beside your Compose files is no longer used, and you can delete it once the new release runs.
2. Migrations and command registration are no longer steps of their own: the bot does both whenever it starts. If you registered the commands in one server with `register.js --guild`, remove that server's copy, because the bot now registers them globally and a server with both sees every command twice: run [`commands.js clear-guild`](/tarubot/deploy/tools/#commandsjs) for that server, once as a dry run and again with its `--confirm` fingerprint.
3. The containers now have fixed names, `tarubot` and, with the `web` profile, `tarubot-web`. Compose replaces the old ones, and the volumes stay.
4. A backup job you scheduled yourself keeps working. Once the built-in [backups](#backups) run, you can retire it.

## Dashboard enable, change and disable

For a running stock installation, first prepare DNS/firewalls and register the exact OAuth callback. Set the [web settings](/tarubot/deploy/configuration/#optional-web-dashboard) and `COMPOSE_PROFILES=web` (or `web,updates`) in private `.env`, then recreate the existing bot and start the proxy:

```sh
docker compose pull
docker compose up -d --wait --force-recreate tarubot caddy
```

Use the same command after changing origin, private port or client secret; update the Discord redirect first when the origin changes. `docker compose restart` does not reload environment settings. This is a brief outage of the existing bot, not a second bot instance. No migration or command registration is needed merely to change web settings. Verify private readiness and then public DNS/TLS, redirects and authorized OAuth login as described in Install.

To disable the bundled proxy, explicitly stop and remove its container even after clearing `COMPOSE_PROFILES`:

```sh
docker compose --profile web stop caddy
docker compose --profile web rm -f caddy
```

These commands preserve `caddy_data` and `caddy_config`; never use `down -v` to disable web. To disable the bot's dashboard too, clear `WEB_PUBLIC_ORIGIN` and `DISCORD_CLIENT_SECRET` and run `docker compose up -d --wait --force-recreate tarubot`. For an external proxy, leave the web settings populated, clear the bundled profile and configure that proxy's private upstream instead. Changing a profile alone is not proof an old proxy stopped.

The upstream managed targets change these settings through their own settings copy; see [their runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#optional-dashboard), not this stock database recipe.

## Rollback

To go back, pin the previous `TARUBOT_IMAGE_TAG`, restore the previous Compose files (from the `.previous` copies or the older release's exact source), and run `docker compose up -d --wait --remove-orphans` again. The proxy follows the tag back too. Going back past a Compose change needs that older source set: newer files may lack services or settings the older release expects. A release before 2.46.0 needs its own Compose files, the `ops` folder its proxy reads, and its own instructions.

If the previous release predates the shared web setup, use its original manifest and disable/remove Caddy explicitly as above; that older bot has no dashboard. Retain certificate volumes for a later re-enable instead of grafting new proxy files onto the older source.

That only works when no migration lies between the two releases: an older release refuses to start on a newer schema. A release that failed before migrating, or whose backup or migration failed, changed nothing, so going back always works for it. After a migration, the way back is a fix release, or [restoring](#recovery) the backup taken just before it, whose key `Migrations applied` names: 2.39.0's `012_self_roles.sql`, for example, stops 2.38.1 from starting, and 2.41.0's `013_status_samples.sql` stops 2.40.0. Going back from 2.40.0 to 2.39.0 needs no restore: 2.39.0 has no My roles page, and its scheduler, which runs every 30 seconds, closes every waiting role change as skipped without changing any roles, including one parked by a pause or stuck in a server TaruBot left. After the next update, those members are told their last change wasn't applied. While 2.39.0 runs, people a pass leaves with none of the Member, Guest, Officer and FC Leader roles keep their channel-opening menu roles; the next guild pass after returning to 2.40.0 removes them. The status-post migration, `010_status_notices.sql`, also has a [manual reversal](/tarubot/deploy/monitoring/#status-notices).

With [automatic updates](#automatic-updates) on, pinning the earlier version is also what stops the updater from bringing the newer one back.

## Single database writer

Exactly one bot process may write to a database. TaruBot enforces this with a PostgreSQL session advisory lock, the **writer lease**, key **`714882494`**. Other fixed keys are transaction locks: `714882490` serializes migrations, `714882491` character claims, and `714882492` the legacy import.

- **Startup.** Pending migrations apply first ([what a start does](#what-a-start-does)). After checking the schema, the bot holds one dedicated database connection and tries to take the lease every 5 seconds. It doesn't start its work queue or log in to Discord until it holds the lease. Once it does, it checks the schema again, so a bot that waited while a migration ran exits instead of writing with old code.
- **While waiting.** Each attempt logs `Waiting for the database writer lease…` with the holder's `holderPid`, at info for the first minute and at warn after that. `/health/live` stays 200 and `/health/ready` is 503 with `writerLease: false`, so Compose reports the container unhealthy but doesn't restart it. A second bot started by mistake therefore waits instead of running beside the first.
- **Shutdown.** SIGTERM wakes a waiting process at once. A running writer releases the lease after its workers and Discord client stop, so the next writer takes it within one retry. If a bot is killed, PostgreSQL releases the lease when the session ends: at once for a normal kill, or after about a minute when the network or host is lost.
- **A lost session.** If the lease connection ends (a database restart, a failover, a terminated backend), the bot logs an error and exits with status 1, and Compose restarts it to wait for the lease again. Every 30 seconds the bot also asks the lease connection whether it still holds the lock, with a 10-second deadline, so a silently dropped connection is caught within about 40 seconds the same way.
- **A stale holder.** If a restarted bot keeps logging the same `holderPid` for more than a few minutes while it's the only bot running, check that the holder is an idle session from before the restart, then end it:

  ```sh
  docker compose exec -T postgres psql -U tarubot -d tarubot \
    -c "SELECT pid, state, backend_start, state_change, client_addr FROM pg_stat_activity WHERE pid = 12345"
  docker compose exec -T postgres psql -U tarubot -d tarubot -c "SELECT pg_terminate_backend(12345)"
  ```

  Replace `12345` with the logged `holderPid`. The waiting bot takes the lease on its next attempt.

The lease needs a direct PostgreSQL connection. A transaction-mode pool such as PgBouncer can't hold a session lock.

**Writer gate.** Before a restore or anything else that writes to the database outside the bot, confirm that no bot holds the lease. This read-only query must return no rows:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT l.pid, a.application_name, a.client_addr, a.backend_start
FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.granted
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.classid = 0 AND l.objid = 714882494 AND l.objsubid = 1;"
```

A single bigint advisory key appears in `pg_locks` as `classid` (high 32 bits), `objid` (low 32 bits) and `objsubid = 1`.

### Migration guard

The bot and `migrate.js` apply every pending migration in one transaction and, while anything is pending, take the writer lease for that transaction. A running bot therefore blocks them: a run waits for a stopping bot, retrying every 2 seconds, for up to 90 seconds (`migrate.js`: `MIGRATE_WRITER_WAIT_SECONDS`), then refuses with `busy`, names the holder's database process, and changes nothing. With nothing pending neither touches the lease.

When files apply, the time the lease was taken is the restore point for that migration: no bot wrote after it, and the pre-migration backup captures exactly that state. The bot logs it as `restorePoint` in `Migrations applied`; `migrate.js` prints `Migration writer lease acquired at <time>; applied <files>; committing at <time>.`, both from the database clock.

Compose and the updater stop the old bot before they start the new one, so a start only waits for it to finish stopping. Before running `migrate.js` yourself, stop the bot.

## Shutdown and restart

The Compose stop grace period is 30 seconds. On SIGTERM the bot stops taking new interactions and scheduling work, cancels Lodestone requests, waits up to 20 seconds for its workers, then closes Discord and the database. It exits within 27 seconds in any case. Work in progress is leased in the database: a job a stopped worker held is picked up again after its lease expires, and work superseded by a newer change is recomputed. A backup in progress is abandoned: `pg_dump` is stopped and the upload aborted, so nothing half-written is stored.

## Backups

Once you give it a bucket and a key to encrypt to, the bot takes its own encrypted backups: daily at `BACKUP_TIME_UTC` (03:00 UTC unless you set another time) while it holds the writer lease, and one immediately before it applies a migration. Nothing runs outside its container: no scheduled job and no tool on the host.

### Set up backups

1. **An age key pair.** On a machine you trust, create an [age](https://age-encryption.org) identity: `age-keygen -o backup-identity.txt` writes it and prints its public key, which starts `age1`. The identity is the only way to open your backups, and whoever holds it can read all of them, mod mail included: keep it away from the bot and its settings, with a second copy offline. Several public keys can share the job, for example one per person who may restore.
2. **A bucket.** An S3-compatible bucket that answers at its own HTTPS host name (virtual-hosted style, as most providers' buckets do), and an access key pair that can read and write it: the monthly copy is the daily object read back, and the restore tool lists and reads. Apply [bucket-lifecycle.xml](https://github.com/deconfined/tarubot/blob/main/ops/bucket-lifecycle.xml), or the same rules in your provider's console: `daily/` and `env/` kept for 30 days, `monthly/` for 365, and incomplete uploads aborted after a day. Without them, backups pile up. The key pair can delete what it wrote, so a bucket in the same account as everything else isn't independent disaster recovery: keep another copy elsewhere if that matters to you.
3. **The settings,** in `.env`:

   ```sh
   BACKUP_STORAGE_ENDPOINT=https://your-bucket.s3.example.org
   BACKUP_STORAGE_ACCESS_KEY=YOUR_ACCESS_KEY
   BACKUP_STORAGE_SECRET_KEY=YOUR_SECRET_KEY
   BACKUP_STORAGE_REGION=your-region
   BACKUP_AGE_RECIPIENTS=YOUR_AGE_PUBLIC_KEY
   ```

   [Configuration](/tarubot/deploy/configuration/#backups) gives the rules for each, and the optional `BACKUP_TIME_UTC` and `HEALTHCHECKS_BACKUP_URL`.

4. **Recreate the bot, then take and list the first backup:**

   ```sh
   docker compose up -d --wait
   docker compose run --rm --no-deps -T tarubot bun dist/scripts/backup.js
   docker compose run --rm --no-deps -T tarubot bun dist/scripts/restore.js list
   ```

   The bot logs `Daily backups scheduled (UTC)` with the time. `backup.js` prints the keys it stored and their sizes, and `restore.js list` shows them in the bucket, newest first. Then [rehearse a restore](#restore-rehearsal), to prove they open.

A backup setting that's missing or invalid never stops the bot: it files one [issue report](/tarubot/deploy/monitoring/#issue-reports) naming the settings at fault, never a value, and every backup fails until you fix them. That includes the backup before a migration, so a release with a migration waits, unapplied, until the settings are fixed, or emptied to turn backups off.

### What a backup holds

Each backup stores up to three objects, all encrypted to `BACKUP_AGE_RECIPIENTS`:

- `daily/tarubot-<stamp>.dump.age`: the database, as a `pg_dump` custom-format archive. `<stamp>` is the UTC time, such as `20260101T030000Z`.
- `monthly/tarubot-<stamp>.dump.age`: the same file again, on the 1st of each month (UTC).
- An encrypted copy of the bot's settings under `env/`: every setting the container received, the bot token, the database password and `MODMAIL_KEY` included, as an env file Compose reads back.

The settings copy is what rebuilds a lost installation, and how a lost mod mail key is recovered. It also means that **whoever holds your backups' age identity can read everything in them**: every setting, and every mod mail case in the dumps. That's deliberate; guard the identity as you would the settings themselves.

Each backup streams the dump through the encryption straight into the bucket, so nothing unencrypted touches a disk or a log. A dump that fails part-way, an encrypted dump of 4096 bytes or less, or a stored size that differs from what was sent fails the backup, and an interrupted upload leaves no object. A failed backup files an issue report, and with `HEALTHCHECKS_BACKUP_URL` set it also alerts a [backup check](/tarubot/deploy/monitoring/#backup-check). They're ordinary age files: `age --decrypt -i backup-identity.txt` opens one too.

The upstream instances use these same backups, each with its own bucket, credentials and recipients; see [their runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#backups-and-restore).

### A dump by hand

Without built-in backups, or for an extra copy before a risky change, dump the bundled database in custom format inside the PostgreSQL container, then copy the file out:

```sh
mkdir -p backups
docker compose exec -T postgres pg_dump -U tarubot -d tarubot -Fc -f /tmp/tarubot.dump
docker compose cp postgres:/tmp/tarubot.dump "backups/tarubot-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres rm /tmp/tarubot.dump
```

A dump is consistent even while the bot runs, because `pg_dump` reads one snapshot. It isn't encrypted: keep copies off that machine, encrypted, because the dump holds your members' links and the ledger. Without built-in backups, take one before every update that brings a migration.

## Restore rehearsal

A backup you haven't restored isn't proven. Now and then, restore one into a separate database:

1. Create an empty copy:

   ```sh
   docker compose exec -T postgres createdb -U tarubot tarubot_restore_test
   ```

2. Restore a backup into it. From the built-in backups, with your age identity on standard input (`latest` is the newest daily dump; `restore.js list` shows the others):

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/restore.js database latest' \
     < backup-identity.txt
   ```

   It prints `Restored daily/… into postgres/tarubot_restore_test; schema head <file>.`, then what it closed for a restore ([recovery](#recovery), step 3). From a dump by hand instead:

   ```sh
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot_restore_test --exit-on-error /tmp/restore.dump
   docker compose exec -T postgres rm /tmp/restore.dump
   ```

3. Optionally, compare every row, sequence, trigger and constraint with the live database, using exact checksums:

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/check-restore.js'
   ```

   It only matches when nothing was written since the backup: the bot writes jobs, roster observations and audit entries all the time. Stop the bot (`docker compose stop tarubot`), take the backup (`backup.js` or a dump by hand), restore and compare before you start it again. `restore.js`'s closing statements count as a change too: when its output says it deleted web sessions or closed role changes, `web_sessions` or `jobs` differ, as expected. `check-restore.js` needs both databases at its own release's schema; if you already pinned a newer release whose migration isn't applied yet, add `--schema-version` with the newest migration the database has, which `SELECT max(version) FROM schema_migrations` shows.

4. Before an update with a migration, rehearse the migration on the copy. It must print `Schema ready.`:

   ```sh
   TARUBOT_IMAGE_TAG=X.Y.Z docker compose run --rm --no-deps -T tarubot \
     sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
   ```

   `TARUBOT_IMAGE_TAG=X.Y.Z` in front runs the new release's image for this one run. `--restore-rehearsal` accepts only a database whose name ends in `_restore_test`, so it can't be pointed at the live one by mistake, and it takes no backup of the copy.

5. Drop the copy, because it holds your members' data:

   ```sh
   docker compose exec -T postgres dropdb -U tarubot tarubot_restore_test
   ```

6. If you stopped the bot, start it again: `docker compose up -d --wait`.

The `sh -c` form builds the copy's URL inside the container from the bot's own, so no password is typed or printed.

## Recovery

To recover from a broken or lost database:

1. Stop the bot: `docker compose stop tarubot`, and confirm with the [writer gate](#single-database-writer) that nothing holds the lease. Keep it stopped until step 6; the updater leaves a stopped bot alone.
2. Create an empty database to restore into, so the newest state you have, even a damaged one, stays as it is:

   ```sh
   docker compose exec -T postgres createdb -U tarubot tarubot_restored
   ```

3. Restore the most recent good backup into it. From the built-in backups, choose one with `restore.js list` (`latest` is the newest daily dump; to undo a migration, use the key `Migrations applied` named):

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restored" exec bun dist/scripts/restore.js database latest' \
     < backup-identity.txt
   ```

   `restore.js` refuses a database that already has tables, and restores in one transaction, so a failure leaves it empty. Then, in one more transaction, it does the two things every restored database needs before a bot starts on it: it signs everyone out of the dashboard, so the backup can't revive a session that was signed out after it was taken (everyone signs in again; nothing else is lost), and it closes the role changes members saved on My roles that were still waiting when the backup was taken, so the restored copy never applies older choices over newer ones. The database then clears the roles they named. Members whose change was closed see that it wasn't applied, and save again if they still want it.

   From a dump by hand, restore it and run those two steps yourself:

   ```sh
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot_restored --exit-on-error --single-transaction /tmp/restore.dump
   docker compose exec -T postgres rm /tmp/restore.dump
   docker compose exec -T postgres psql -U tarubot -d tarubot_restored -c "DELETE FROM web_sessions"
   ```

   A dump from before the dashboard has no `web_sessions` table, and that last line then fails harmlessly. Close the waiting role changes:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d tarubot_restored <<'SQL'
   UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
          result='{"skipped":"restored"}'
    WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');
   SQL
   ```

4. Swap the restored database in, keeping the old one under another name:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d postgres \
     -c "ALTER DATABASE tarubot RENAME TO tarubot_before_restore" \
     -c "ALTER DATABASE tarubot_restored RENAME TO tarubot"
   ```

   Decisions acknowledged after that backup, such as new links, ledger entries, guest decisions, role menu changes and pauses, must be recorded again: a restore can't know about them.
5. If the backup predates an [update post](/tarubot/deploy/monitoring/#update-posts) that went out, raise that server's `changelog_version` to the version it announced, or the post goes out again when the bot starts:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d tarubot \
     -c "SELECT id, changelog_channel_id, changelog_version FROM guilds WHERE changelog_channel_id IS NOT NULL"
   ```

6. Start exactly one bot: `docker compose up -d --wait`, and check readiness and `/config validate`. A backup from an older release is migrated as the bot starts, after its own pre-migration backup when backups are set up. Once you're satisfied with the restore, drop `tarubot_before_restore`.

Mod mail cases read only with the same `MODMAIL_KEY` the backup was taken with. If you've lost it, the backup's settings copy holds it: `restore.js settings` writes that copy, every secret included, so create it privately, take what you need and delete it:

```sh
(umask 077 && docker compose run --rm --no-deps -T tarubot \
  bun dist/scripts/restore.js settings latest < backup-identity.txt > recovered-settings.env)
```

The [status page](/tarubot/deploy/monitoring/#public-status-page)'s samples need no step: they hold nothing to replay. Those written after the backup are lost, so the page shows that time as down.

Officers' [pauses](/tarubot/admin/moderation/) need no step either, but the pauses a backup restores can differ from the current ones: a pause lifted since can reappear (unless its own end has passed), and one set since can be missing. Ask an officer to check the Moderation page after the restore and lift or set pauses again as needed.

Discord work the restored database still owes resumes from its durable jobs, apart from the role changes step 3 closed. A restore never undoes Discord changes the bot already made; the next reconciliation brings Discord in line with the restored decisions.

## Volumes

The database lives in the `postgres_data` volume, mounted at `/var/lib/postgresql` as PostgreSQL 18 images expect. Recreating or updating containers keeps it. `docker compose down -v` deletes it, and with it every record: never use `-v` unless you mean to start over.

Optional Caddy keeps certificates and proxy state in `caddy_data` and `caddy_config`. Keep both across recreation, upgrades and proxy disable/re-enable; deleting them discards certificate state and may require issuance again. They do not replace database/settings backups.
