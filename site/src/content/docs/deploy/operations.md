---
title: Updates, backups and recovery
description: Update to a new release, roll back, back up and restore the database, and keep a single writer.
sidebar:
  order: 5
---

These procedures assume the stock `docker-compose.yml` with its bundled PostgreSQL, run from the directory that holds it and `.env`. Every decision TaruBot makes, and all the Discord work it still owes, lives in PostgreSQL, so the database is the one thing to protect.

The upstream instance uses the same Compose runtime with managed PostgreSQL, rather than this guide's `postgres` service. Its automated release stops the writer, backs up, migrates and registers commands from the exact signed image before starting and observing it. Automatic restart stays disabled until sustained observation and durable acceptance. Pending failures require owner reconciliation, with no automatic rollback; see [the deployment runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md). Commands below are for your own stock Compose installation, not that managed instance.

## Updating to a release

Read the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) entries between your release and the new one first. Each says whether it adds a **migration** and whether its **commands changed**.

Signed published releases pass vulnerability scans for both AMD64 and ARM64 before signing and promotion. Fixable high/critical findings block the release unless covered by an exact, reviewed exception with a documented reason and an expiry within 30 days. The default policy allows no exceptions. Scanner errors and expired exceptions block signing and promotion; repository ignore files cannot bypass the checks. A failed scan can leave candidate version tags in the registry without a signed release; do not treat an available tag as verification. Use the signed digest and provenance checks in [installation](/tarubot/deploy/install/), not just `latest` or a successful pull.

1. Fetch the new release's Compose files, Caddy configuration and settings template from the exact commit that built the new image. A release can change settings and services, so keep this whole source set matched even with the web profile off. Nothing restarts yet.

   ```sh
   docker pull ghcr.io/deconfined/tarubot:X.Y.Z
   commit=$(docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z \
     --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
   cp docker-compose.yml docker-compose.yml.previous
   test ! -f docker-compose.web.yml || cp docker-compose.web.yml docker-compose.web.yml.previous
   test ! -f ops/Caddyfile || cp ops/Caddyfile ops/Caddyfile.previous
   curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.yml"
   curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.web.yml"
   mkdir -p ops
   curl -fsSL -o ops/Caddyfile "https://raw.githubusercontent.com/deconfined/tarubot/$commit/ops/Caddyfile"
   chmod 644 ops/Caddyfile
   curl -fsSL -o .env.example "https://raw.githubusercontent.com/deconfined/tarubot/$commit/.env.example"
   comm -13 <(grep -oE '^[A-Z][A-Z0-9_]*=' .env | sort) <(grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | sort)
   ```

   The image's `org.opencontainers.image.revision` label names the commit it was built from, the same commit as its `sha-<commit>` tag. The `comm` line (bash or zsh) lists settings the new template has and your `.env` doesn't: read their comments in `.env.example` and on [Configuration](/tarubot/deploy/configuration/), and add the ones you need. If you edited your Compose file, `diff docker-compose.yml.previous docker-compose.yml` and carry your changes over.

2. Pin the new release in `.env` and pull the images the new Compose file names:

   ```sh
   sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
   docker compose pull
   ```

3. Stop the bot: `docker compose stop tarubot`. It finishes its work in progress and exits within 30 seconds.
4. [Back up](#backup) the database.
5. Migrate, in the new image:

   ```sh
   docker compose run --rm --no-deps tarubot bun dist/scripts/migrate.js
   ```

   With a migration pending, it prints the files it applied and the restore point, then `Schema ready.` With nothing pending, it only prints `Schema ready.`
6. Start the bot: `docker compose up -d --wait --remove-orphans`, then [check readiness](/tarubot/deploy/monitoring/#health-probes). `--remove-orphans` removes the containers of services the new Compose file no longer has. If the new file names a newer PostgreSQL image, Compose recreates that container too; the data stays in its [volume](#volumes).
7. If the changelog says the commands changed, register them again with the same scope you used at install (`register.js --global` or `--guild YOUR_GUILD_ID`), and check with `commands.js list`; see [Maintenance tools](/tarubot/deploy/tools/). Registering after the new release is up keeps the old one from receiving a command it doesn't have.

For a release without a migration, steps 3 to 5 are optional: `docker compose up -d --wait --remove-orphans` after the pull replaces the container, and Compose stops the old one first. The outage is a few seconds either way.

A new image never touches your database or restarts your bot by itself: updates happen only when you pull and recreate.

From 2.35.0, a server whose channels TaruBot could see only through Administrator gets [one officer alert](/tarubot/admin/notices-and-updates/#missing-channel-overrides) about missing channel overrides about six minutes after the update, even while TaruBot still holds Administrator. Its officers follow [the setup window](/tarubot/admin/add-to-server/#the-setup-window); readiness counts the channels in `visibility.missing`. Rolling back to an earlier release leaves TaruBot's channel entries in place, which is harmless. An alert still waiting at the rollback posts anyway, naming `/setup overrides`, which the earlier release doesn't have, and its recovery line follows only after you update again. Before 2.35.0, `/setup` has no dry run: it turns lobby onboarding on at once.

Keep optional web settings in `.env` during routine upgrades; do not overwrite it with the new template. With `COMPOSE_PROFILES=web`, the normal pull/up sequence also updates Caddy from the new exact source, retaining its certificate volumes. Recheck [public HTTPS and OAuth](/tarubot/deploy/install/#5-start-the-bot), not only private container health.

## Dashboard enable, change and disable

For a running stock installation, first download the matching shared files as in [Install](/tarubot/deploy/install/#1-get-the-compose-file-and-settings-template), prepare DNS/firewalls and register the exact OAuth callback. Set the [web settings](/tarubot/deploy/configuration/#optional-web-dashboard) and `COMPOSE_PROFILES=web` in private `.env`, then recreate the existing bot and proxy:

```sh
docker compose pull
docker compose up -d --wait --force-recreate tarubot caddy
```

Use the same command after changing origin, private port or client secret; update the Discord redirect first when the origin changes. `docker compose restart` does not reload environment settings. This is a brief outage of the existing bot, not a second bot instance. No migration or command re-registration is needed merely to change web settings; release changes still follow the update procedure above. Verify private readiness and then public DNS/TLS, redirects and authorized OAuth login as described in Install.

To disable the bundled proxy, explicitly stop and remove its container even after clearing `COMPOSE_PROFILES`:

```sh
docker compose --profile web stop caddy
docker compose --profile web rm -f caddy
```

These commands preserve `caddy_data` and `caddy_config`; never use `down -v` to disable web. To disable the bot's dashboard too, clear `WEB_PUBLIC_ORIGIN` and `DISCORD_CLIENT_SECRET` and run `docker compose up -d --wait --force-recreate tarubot`. For an external proxy, leave the web settings populated, clear the bundled profile and configure that proxy's private upstream instead. Changing a profile alone is not proof an old proxy stopped.

Managed production/staging targets require owner-reviewed stable deploy and backup entry reinstallation before using this source's web lifecycle. Source releases never self-update those entries. Settings enable/bootstrap/change is a separate owner-approved recreation of the current exact digest in its recorded worktree; `already-live` is observation, not settings reconciliation. See [owner operations](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#optional-dashboard-owner-lifecycle), not this stock database recipe.

For bundled Caddy on managed targets, install the reviewed **2.37.1 or newer deploy entry** before approving delivery. It makes only the public `ops/Caddyfile` readable (`0644`) before validation while central `.env` stays private (`0600`). Older entries can refuse with `/etc/caddy/Caddyfile: permission denied` after a successful image pull; rebuilding the image alone does not update the installed entry.

## Rollback

To go back, pin the previous `TARUBOT_IMAGE_TAG`, restore the matching main manifest, shared `docker-compose.web.yml` and `ops/Caddyfile` (from the `.previous` copies or the older image's exact source), and run `docker compose up -d --wait --remove-orphans` again. Going back past a Compose change needs that older source set: newer files may lack services or settings the older release expects.

If the previous release predates the shared web setup, use its original manifest and disable/remove Caddy explicitly as above; that older bot has no dashboard. Retain certificate volumes for a later re-enable instead of grafting new proxy files onto the older source.

That only works when no migration lies between the two releases: an older release refuses to start on a newer schema. After a migration, the way back is a fix release, or restoring the backup you took before migrating: 2.39.0's `012_self_roles.sql`, for example, stops 2.38.1 from starting. Going back from 2.40.0 to 2.39.0 needs no restore: 2.39.0 has no My roles page, and completes members' waiting role choices as skipped without changing any roles. After the next update, those members are told their last change wasn't applied. While 2.39.0 runs, people a pass leaves with none of the Member, Guest, Officer and FC Leader roles keep their channel-opening menu roles (the next guild pass after returning to 2.40.0 removes them), and a change parked by a pause, or stuck in a server TaruBot left, isn't expired until 2.40.0 is back. The status-post migration, `010_status_notices.sql`, also has a [manual reversal](/tarubot/deploy/monitoring/#status-notices).

## Single database writer

Exactly one bot process may write to a database. TaruBot enforces this with a PostgreSQL session advisory lock, the **writer lease**, key **`714882494`**. Other fixed keys are transaction locks: `714882490` serializes migrations, `714882491` character claims, and `714882492` the legacy import.

- **Startup.** After checking the schema, the bot holds one dedicated database connection and tries to take the lease every 5 seconds. It doesn't start its work queue or log in to Discord until it holds the lease. Once it does, it checks the schema again, so a bot that waited while a migration ran exits instead of writing with old code.
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

**Writer gate.** Before a migration, a restore or anything else that writes to the database outside the bot, confirm that no bot holds the lease. This read-only query must return no rows:

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

`migrate.js` applies every pending migration in one transaction and, while anything is pending, takes the writer lease for that transaction. A running bot therefore blocks it: the run waits up to `MIGRATE_WRITER_WAIT_SECONDS` (90 by default) for a stopping bot, retrying every 2 seconds, then refuses with `busy`, names the holder's database process, and changes nothing. With nothing pending it never touches the lease.

When it applies files, it prints `Migration writer lease acquired at <time>; applied <files>; committing at <time>.` from the database clock. No bot wrote after the first time, so it is the restore point for that migration.

The guard is a safety net. Stop the bot before migrating anyway.

## Shutdown and restart

The Compose stop grace period is 30 seconds. On SIGTERM the bot stops taking new interactions and scheduling work, cancels Lodestone requests, waits up to 20 seconds for its workers, then closes Discord and the database. It exits within 27 seconds in any case. Work in progress is leased in the database: a job a stopped worker held is picked up again after its lease expires, and work superseded by a newer change is recomputed.

## Backup

`pg_dump` in custom format inside the PostgreSQL container, then copy the file out:

```sh
mkdir -p backups
docker compose exec -T postgres pg_dump -U tarubot -d tarubot -Fc -f /tmp/tarubot.dump
docker compose cp postgres:/tmp/tarubot.dump "backups/tarubot-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres rm /tmp/tarubot.dump
```

A dump is consistent even while the bot runs, because `pg_dump` reads one snapshot. Back up on a schedule (a daily `cron` job is plenty) and before every update, and keep copies **off the host**, encrypted: the dump holds your members' links and the ledger. A backup you haven't restored isn't proven; [rehearse a restore](#restore-rehearsal) now and then, with a dump taken while the bot is stopped.

The upstream Linode deployment's `ops/backup.sh` also encrypts the database and host settings and uploads offsite. Production and staging have separate backup buckets and credentials; each uses `daily/` and `env/` with 30-day retention and `monthly/` with 365-day retention. Private storage settings and age recipients belong to each instance. Do not copy its credentials or assume its backups are proven. Its [owner runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#backups-and-restore) covers configuration, pending recovery and restore drills.

The managed-host scripts explicitly include the otherwise inactive `backup` profile in their configuration checks; inspection does not start its dump client. The deployment caller also selects that profile for the release-specific backup subprocess, including published payloads whose own configuration check does not select it. Installing the stable backup entry alone does not change those payloads.

## Restore rehearsal

Restore a backup into a separate database, then compare the copy with the live one. The comparison checks every row, so it only matches a dump taken while the bot was stopped, with nothing written since: the bot writes jobs, roster observations and audit entries all the time, and a scheduled backup taken while it ran always reports a mismatch. Rehearse with a fresh dump, such as the one step 4 of an [update](#updating-to-a-release) takes.

1. Stop the bot and take a fresh backup:

   ```sh
   docker compose stop tarubot
   ```

   Then run the three [backup](#backup) commands. If you're in the middle of an update, the bot is already stopped and step 4's backup is the one to use.

2. Create the copy and restore that dump into it:

   ```sh
   docker compose exec -T postgres createdb -U tarubot tarubot_restore_test
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot_restore_test --exit-on-error /tmp/restore.dump
   ```

3. Compare every row, sequence, trigger and constraint with the live database, using exact checksums:

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/check-restore.js'
   ```

   `check-restore.js` needs both databases at its own release's schema. If you already pinned a newer release whose migration isn't applied yet, add `--schema-version` with the newest migration the database has, which `SELECT max(version) FROM schema_migrations` shows.

4. Before an update with a migration, rehearse the migration on the copy. It must print `Schema ready.`:

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
   ```

   `--restore-rehearsal` accepts only a database whose name ends in `_restore_test`, so it can't be pointed at the live one by mistake.

5. Drop the copy, and remove the dump from the PostgreSQL container, because it holds your members' data:

   ```sh
   docker compose exec -T postgres dropdb -U tarubot tarubot_restore_test
   docker compose exec -T postgres rm /tmp/restore.dump
   ```

6. Unless you're in the middle of an update, start the bot again: `docker compose up -d --wait`.

The `sh -c` form builds the copy's URL inside the container from the bot's own, so no password is typed or printed.

## Recovery

To recover from a broken or lost database:

1. Stop the bot: `docker compose stop tarubot`, and confirm with the [writer gate](#single-database-writer) that nothing holds the lease.
2. Keep the newest state you have, even a damaged one: rename the database instead of dropping it.
3. Restore the most recent good backup into a new `tarubot` database, then remove the dump from the container:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d postgres -c "ALTER DATABASE tarubot RENAME TO tarubot_before_restore"
   docker compose exec -T postgres createdb -U tarubot tarubot
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot --exit-on-error /tmp/restore.dump
   docker compose exec -T postgres rm /tmp/restore.dump
   ```

   Decisions acknowledged after that backup, such as new links, ledger entries, guest decisions and role menu changes, must be recorded again: a restore can't know about them.
4. If the backup is from an older release, run `migrate.js` as in an update.
5. If the backup predates an [update post](/tarubot/deploy/monitoring/#update-posts) that went out, raise that server's `changelog_version` to the version it announced, or the post goes out again when the bot starts:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d tarubot \
     -c "SELECT id, changelog_channel_id, changelog_version FROM guilds WHERE changelog_channel_id IS NOT NULL"
   ```

6. Sign everyone out of the dashboard, so the backup can't revive a session that was signed out after it was taken:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d tarubot -c "DELETE FROM web_sessions"
   ```

   Everyone has to sign in again; nothing else is lost.
7. Close the role changes members saved on My roles that were still waiting when the backup was taken, so the restored copy never applies older choices over newer ones. The database then clears the roles they named:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d tarubot <<'SQL'
   UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
          result='{"skipped":"restored"}'
    WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');
   SQL
   ```

   Members whose change was closed see that it wasn't applied, and save again if they still want it.
8. Start exactly one bot: `docker compose up -d --wait`, and check readiness and `/config validate`.

Discord work the restored database still owes resumes from its durable jobs, apart from the role changes step 7 closed. A restore never undoes Discord changes the bot already made; the next reconciliation brings Discord in line with the restored decisions.

## Volumes

The database lives in the `postgres_data` volume, mounted at `/var/lib/postgresql` as PostgreSQL 18 images expect. Recreating or updating containers keeps it. `docker compose down -v` deletes it, and with it every record: never use `-v` unless you mean to start over.

Optional Caddy keeps certificates and proxy state in `caddy_data` and `caddy_config`. Keep both across recreation, upgrades and proxy disable/re-enable; deleting them discards certificate state and may require issuance again. They do not replace database/settings backups.
