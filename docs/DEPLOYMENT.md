# Release delivery and owner operations

TaruBot is delivered by moving registry tags (owner decision, 2026-10-28). An approved Deploy moves the `production` tags to one release's signed images, the production runtime's updater follows those tags, and starting the new image is the whole upgrade. GitHub never connects to the runtime, and the operator needs access to the containers only: no SSH, no host scripts, no host files, no cron and no host tools. The owner accepted the price: GitHub can't watch the result or roll back by itself, so a bad release is rolled back by deploying the earlier version again. The image carries its own tools, and one-off containers of the same image run them.

This runbook describes what the repository implements. It is **not evidence that any step happened live**. Provisioning, credentials, GitHub settings, the cutover and every live operation are owner steps under [AGENTS](../AGENTS.md); agents run none of them. Self-hosters use the site's [Compose installation](../site/src/content/docs/deploy/install.md) and [operations guide](../site/src/content/docs/deploy/operations.md) instead. See also [configuration](CONFIGURATION.md) and the [threat model](THREAT_MODEL.md).

## How a release reaches production

1. **Review.** Protected `main`, current CI and security checks and the owner's code-owner approval; merge commits only. An explicit version increase declares a release ([CONTRIBUTING](../CONTRIBUTING.md)); maintenance merges keep the version and publish nothing.
2. **Publish.** `publish.yml`'s release gate validates the version and proves the merged commit carries a pull-request head tree whose CI passed, the in-image suite on native AMD64 and ARM64 included; for any other tree it runs `ci.yml` in full. It then publishes two images, each tagged only while its tag is absent, so a published version is never overwritten and a re-run resumes only with this commit's own images:
   - `ghcr.io/deconfined/tarubot:X.Y.Z` (also `sha-<commit>`): the bot and every tool, built on each platform's native runner, both platforms scanned by `scan.yml`;
   - `ghcr.io/deconfined/tarubot:web-X.Y.Z`: the stock Caddy image, pinned by digest, plus TaruBot's Caddyfile and offline page (the Dockerfile's `web` stage).
3. **Attest.** Both index digests get GitHub build provenance from `publish.yml` on `main`. Fixable high or critical findings, scanner or registry errors and expired exceptions stop it. The default exception policy is empty; an exception needs the exact reviewed finding, a reason or issue and an expiry within 30 days. `latest` and `web-latest` move only after attestation, and only while `main` still names this commit.
4. **Approve.** When the repository variable `DEPLOY_ENABLED` is exactly `true`, publication calls `deploy.yml` with `target: production` and the version. Its one job, shown as **Production release / Deploy production**, waits for the owner's approval of the `production` environment, the routine go-ahead ([AGENTS](../AGENTS.md)). A skipped Deploy proves nothing about the runtime.
5. **Verify.** Deploy uses no environment secret, only the workflow's own token. In order, it checks the target's switch and the version's shape; that this attempt was held for the approval (the owner's rule of 2026-10-08: an approval given to an earlier attempt is never reused); that `X.Y.Z` and `web-X.Y.Z` both exist; that the bot image's source commit (its `org.opencontainers.image.revision` label) is on `main` and its `package.json` says `X.Y.Z`; and that both digests carry that commit's [provenance](#signed-build-provenance). Every refusal ends with "No tag was moved."
6. **Move the tags.** `web-production`, then `production`, are set to exactly those digests and read back. Web first, so a failure between the two leaves the bot, and so the database, on the previous release. The run's summary lists both digests before and after, the commit and the version the channel named before.
7. **Follow.** On the runtime, Watchtower notices the moved tags within its 300-second poll, pulls them, stops the old container and starts the new one with the same configuration ([what runs](#what-runs-on-a-docker-host)). GitHub sees none of this: `/version`, the heartbeat and the container say which release runs.

**Starting the image is the whole upgrade.** Before it takes the writer lease, the bot runs the deployment guard and applies its own pending migrations. Immediately before the first one, holding the writer lease's lock so no bot can write in between, it takes an encrypted pre-migration backup; a failed backup applies nothing. Production and staging refuse to migrate without backups configured. Once ready, the bot registers its commands in its profile's scope (global for production, DevBot's guild for staging) with one bulk request. A refusal or a Discord error there is filed as an issue report (`command registration`), and the bot keeps running with the set Discord already holds, so 2.45.0's outage, a registration failure after the migration with the bot stopped, can't recur. PR CI's command-registration test still checks Discord's rules before merge. The info lines `Modules loaded` and `Database writer lease acquired` keep their exact text.

Re-running a failed Deploy really retries, and asks for the approval again. A Deploy of the version the channel already names changes nothing and says so. Deploy accepts stable `X.Y.Z` only, at most four digits per component; prereleases are never published or deployed. Downgrades are allowed: deploying an earlier version is the rollback ([when a release doesn't come up](#when-a-release-doesnt-come-up)).

## Signed build provenance

For owner verification of an exact image, the bot's or the web image, substitute its index digest and full source commit (Deploy's summary lists both):

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@sha256:<digest> \
  --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

`docker buildx imagetools inspect ghcr.io/deconfined/tarubot:production` shows the digest a tag names now. Keep the exact `--cert-identity`; a broader signer-workflow pattern is insufficient. Image labels are read in addition to, never instead of, provenance. Deploy runs this check for both digests before it moves a tag. Actions use SHA-pinned tools and checkouts; only attestation gets the OIDC permissions it needs.

## What runs on a Docker host

Any Docker host with Compose v2 serves, and so does a platform that runs the same containers. Compose can run on the owner's own machine against the host's Docker (a Docker context): nothing of TaruBot's lives on the host's filesystem but Docker's own images, volumes and logs. Production and staging each have their **own Docker host**: two projects on one rootful daemon aren't isolated from each other, and both manifests use the project name `tarubot`.

| Service | Container | Image | Role |
| --- | --- | --- | --- |
| `tarubot` | `tarubot` | `ghcr.io/deconfined/tarubot:${TARUBOT_IMAGE_TAG}` | The bot. One-off tool runs of this service are named `tarubot-tarubot-run-<id>` |
| `watchtower` | `tarubot-watchtower-1` | `ghcr.io/nicholas-fedor/watchtower`, pinned by digest | Follows the tags of the two named containers |
| `caddy` (profile `web`) | `tarubot-web` | `ghcr.io/deconfined/tarubot:web-${TARUBOT_IMAGE_TAG}` | The optional HTTPS proxy ([optional dashboard](#optional-dashboard)) |

- **Settings** are the Compose project's environment: a private copy of `production.env.example` (or `staging.env.example`), mode 600, kept wherever you run Compose and passed with `--env-file`. `TARUBOT_IMAGE_TAG=production` is required. Containers keep the settings they were created with, and Watchtower copies them onto the new container, so after changing a setting run `up -d` again. A variable exported in your shell overrides the file, so run Compose from a shell without TaruBot's settings exported. Never copy production's settings to staging.
- **Manifests** are read where Compose runs: `docker-compose.production.yml` beside the `docker-compose.web.yml` it includes, from the release you run. Watchtower keeps a container's configuration, so a release that changes a manifest or adds a setting says so in its changelog entry, and that change takes effect only once you update your copy and run `up -d`.
- **The database** is the owner's managed PostgreSQL: the direct TLS endpoint with its verified CA, never a transaction-mode pool (the writer lease needs a session connection), with the names the [tool profile](CONFIGURATION.md#maintenance-tool-profiles) requires. A new host's address must be able to reach the Lodestone.
- **Hardening.** The bot's root filesystem is read-only, and its only writable path is a 1 MiB `/tmp` tmpfs, which holds the database CA's private file while `pg_dump` or `pg_restore` runs. No capabilities, no new privileges, bounded local logs. Its health port is never published; only the proxy's 80 and 443 are, with the `web` profile. A new bot has 300 seconds to become healthy, for a migration plus its backup.
- **Watchtower**, Nicholas Fedor's maintained fork (the original is archived), runs with `--interval 300 --stop-timeout 40s --include-restarting --cleanup` and the container names `tarubot` and `tarubot-web`. When a tag has moved, it pulls it, stops the old container (the bot within its own 30-second stop grace period), starts the new one with the old one's configuration and removes the old image; the swap takes seconds. It follows names, not labels, because `docker compose run` copies a service's labels onto one-off tool runs, which a label-following updater would stop and start again on a tag move. A missing name (no `web` profile) is skipped, and a stopped container is left alone. `--include-restarting` also replaces a bot that crash-loops, so deploying the earlier version rolls back even a release that never stays up. Watchtower needs the Docker socket, which is **root on that Docker host**; only this pinned image gets it. It pulls anonymously, so the GHCR package must stay public.
- **The proxy** doesn't depend on the bot: it keeps serving the offline page while the bot is swapped, and follows `web-production` the same way.

Every command below uses this shell function; replace the placeholder, and for staging use staging's own copy and `docker-compose.staging.yml`:

```sh
tb() { docker compose --env-file <private settings copy> -f docker-compose.production.yml "$@"; }
```

## First start and the one-time cutover

### A new runtime

1. Prepare the managed database, a backup bucket with [the lifecycle](#backups-and-restore) applied, an age key pair (the public key in `BACKUP_AGE_RECIPIENTS`; the private key with the owner, plus one offline copy) and the settings copy. The `production` tags must exist, which the first Deploy creates.
2. `tb up -d --pull always`. On an empty database the bot applies every migration without a pre-migration backup (there is nothing to back up yet, and it logs that at info), takes the writer lease, registers its commands and becomes ready. Production refuses to migrate at all without backup settings.
3. Check `tb ps` (the bot healthy, Watchtower running, `tarubot-web` healthy with the web profile), `/version` in Discord, and the log lines `Database writer lease acquired` and `Commands registered`. Take the first backup with `tb run --rm -T tarubot bun dist/scripts/backup.js`; `tb run --rm -T tarubot bun dist/scripts/restore.js list` then shows it.

### From the host-installed entry (2.45.x)

Publishing 2.46.0 and approving its Deploy only moves `production` and `web-production`, which nothing follows yet: the running 2.45.x is untouched. Then, once, away from the old daily backup's time:

1. **Prepare the settings copy** from the host's `.env`. Add `TARUBOT_IMAGE_TAG=production` and `BACKUP_AGE_RECIPIENTS` (the key in [age-recipients.txt](../ops/age-recipients.txt)); remove `TARUBOT_IMAGE_DIGEST` and `TARUBOT_RESTART_POLICY`. Keep the storage settings, with two checks the old script didn't need: `BACKUP_STORAGE_REGION` is now required (the old script fell back to a default region when it was empty), and `BACKUP_STORAGE_ENDPOINT` must be the bucket's own host, `<bucket>.<region host>` (virtual-hosted style; a path is now a key prefix).
2. **Stop the old project**, bot and proxy: `docker stop --time 40 $(docker ps -q --filter label=com.docker.compose.project=tarubot)`.
3. **Start the new one** with the 2.46.0 manifests: `tb up -d --pull always`. Compose replaces the stopped containers (same project, so the proxy keeps its volumes and certificates); the bot starts from `:production`, with Watchtower beside it. 2.46.0 adds no migration, so nothing migrates.
4. **Check** as for a new runtime, the first `Backup stored` (or one `backup.js` run) and `restore.js list` included.
5. **Clean up** once it runs: remove the host-installed `tarubot-deploy` and `tarubot-backup` entries, their cron entry and the deploy key's `authorized_keys` forced command, then the unused `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` values in GitHub. The old daily backup keeps working until it's removed. The old release worktrees and host state can go too.

Until step 5, going back is stopping the new project (`tb down`, which keeps the proxy's volumes) and starting 2.45.x from its recorded worktree with the [previous runbook's command](https://github.com/deconfined/tarubot/blob/672a755a1b06874e6dd87f9b4ed02cd9568469dc/docs/DEPLOYMENT.md#everyday-observation-and-outcomes). Staging moves the same way, with `staging`.

## Everyday operations

- **What runs:** `/version` in Discord, the heartbeat, `tb ps`, and `docker inspect tarubot --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`.
- **Logs:** `tb logs tarubot` and `tb logs watchtower`. The bot logs `Migrations applied` (the files; `restorePoint`, a moment after the previous bot's last write and before the migration, for point-in-time recovery; and `backup`, the pre-migration dump's key), `Backup stored`, `Commands registered`, `Modules loaded` and `Database writer lease acquired`. A `LOG_LEVEL` above `info` hides them without anything being wrong.
- **Readiness:** the container's health is `/health/ready` (database, writer lease and Discord); in Discord, `/sync status` and `/config validate`. Effects may stay paused on staging. Lodestone and visibility diagnostics are informational; an incomplete upstream roster is never an empty roster.
- **Deploy a release:** publication asks for it. Any published version can also be dispatched: **Actions → Deploy → Run workflow**, branch `main`, the target and the version, then approve. Agents dispatch only when the owner asks in that session.
- **Change a setting:** edit the copy, then `tb up -d`. Never `restart` to reload settings: a restarted container keeps its old environment.
- **Run a tool** as a one-off container of the bot's service, always naming the tool, because a `run` without a command starts a second bot: for example `tb run --rm -T tarubot bun dist/scripts/commands.js list`. The tools (`migrate.js`, `register.js`, `commands.js`, `backup.js`, `restore.js`, `check-restore.js` and the rest of the site's [tools page](../site/src/content/docs/deploy/tools.md)) obey the [tool profiles](CONFIGURATION.md#maintenance-tool-profiles). `register.js --global` is needed only to repair production's command set between releases.

## When a release doesn't come up

A successful Deploy means only that the tags moved. Look at `/version` and `tb ps` about five minutes later. A bot that exits is restarted by Docker, with a back-off of up to a minute, so a failing start repeats until it's fixed or rolled back.

**Rolling back** is running Deploy with the earlier version; Watchtower replaces the failing container, crash-looping or not. That works whenever the failing release changed nothing in the database: it failed before migrating, its backup or migration failed (nothing applied), or it has no migration. A release that **did** migrate can't be rolled back that way, because the previous release refuses the newer schema by itself. Then fix forward with a new release, or restore the pre-migration backup (`Migrations applied` names it) into an empty database and point the bot at it ([backups and restore](#backups-and-restore)).

| Sign (in `tb logs tarubot` unless noted) | Meaning | Do |
| --- | --- | --- |
| The tags moved, but `/version` shows the old release after 5 minutes | Watchtower isn't running, can't pull, or follows another tag | `tb logs watchtower`; check `TARUBOT_IMAGE_TAG`, the container names and that the package is public |
| The bot exits at startup naming a setting | A setting the bot validates is wrong; the database is untouched | Fix the setting and `tb up -d`, or roll back |
| `Backups aren't configured (BACKUP_STORAGE_ENDPOINT is empty), and the production profile never migrates without a pre-migration backup, …` | A migration is pending and backups are off: nothing applied | Set the backup settings and `tb up -d` |
| `Backup failed at: <stage>` before any `Migrations applied` | The pre-migration backup failed (at `settings`, the message names the settings at fault): nothing applied | Fix the storage settings, credentials or recipients, or roll back |
| A migration error or a statement timeout | The migration failed and rolled back: nothing applied | Roll back; a migration statement past the 15-second limit is a release defect |
| `A TaruBot writer (database process N) holds the writer lease, so … migration(s) were not applied` | Another bot holds the lease: a second runtime, or a `run` without a tool command | Find and stop it (`docker ps -a`); never run two |
| Readiness stays unready with `writerLease: false` | A previous writer still holds the lease | As above; the lease frees when its process exits |
| `Schema version/checksum mismatch. Use matching versioned migrations and application image.` | An older image met a database migrated past it | Deploy the release whose migrations the database has, or a newer one, never an older one |
| An issue report for `command registration` | Discord refused the command set; the bot runs with the previous one | Fix it in the next release; `commands.js list` shows what Discord holds |

## Backups and restore

The bot takes its own backups (2.46.0): daily at `BACKUP_TIME_UTC` (default `03:00`, UTC) while it holds the writer lease, and one immediately before it applies migrations. `tb run --rm -T tarubot bun dist/scripts/backup.js` takes one now, prints its keys and sizes as JSON and exits non-zero on failure; it doesn't take the writer lease, since `pg_dump` reads one consistent snapshot. The settings are in [configuration](CONFIGURATION.md#backup-settings).

Each backup streams `pg_dump` (the PostgreSQL 18 client, custom format, `--no-owner --no-privileges`) through age encryption straight into a multipart upload; no plaintext touches a disk or a log. A failed dump, an encrypted dump of 4096 bytes or less, or a stored size that differs from the bytes sent fails the backup. The layout is the one the lifecycle rules and the owner's age identity already work with:

- `daily/tarubot-<YYYYMMDDTHHMMSSZ>.dump.age`: the encrypted dump;
- `monthly/tarubot-<stamp>.dump.age`: the same ciphertext, on the 1st of the month (UTC);
- `env/tarubot-env-<stamp>.age`: an encrypted copy of the bot's settings.

The settings copy holds every variable the container received (`*_FILE` secrets resolved, runtime variables such as `PATH` and `HOME` left out), `MODMAIL_KEY` included, as a Compose-compatible env file. It rebuilds a lost runtime and recovers a lost mod mail key, and so **whoever holds the backups' age identity can read every mod mail case in them**: the owner's deliberate trade-off (2026-10-11).

Every file is encrypted to `BACKUP_AGE_RECIPIENTS`. Production's public key is published in [age-recipients.txt](../ops/age-recipients.txt); the private key stays with the owner, with an offline second copy. Backups are ordinary age files, which the `age` command line opens too. [bucket-lifecycle.xml](../ops/bucket-lifecycle.xml) keeps `daily/` and `env/` for 30 days and `monthly/` for 365, and aborts incomplete multipart uploads (a backup cut off part-way) after a day; the owner applies it to each bucket. Production and staging each have their own bucket, credentials and recipients; never point both at one bucket. The key pair needs read and write on its bucket (the monthly copy is the daily object read back, and `restore.js` lists and reads), so it can delete too: keep independent copies, since a bucket in the same provider account isn't independent disaster recovery. These files don't prove the live configuration; the owner checks the lifecycle and the first backups.

With `HEALTHCHECKS_BACKUP_URL` set, a backup pings `<url>/start` with `backup starting`, then `<url>` with `<daily key>: <n> bytes; <env key>: <m> bytes`, or `<url>/fail` with `backup failed at: <stage>`, the stage being `settings`, `dump`, `settings-copy` or `upload`. Pings are best effort and never fail a backup. A failed daily backup also files an issue report. A stop abandons a running backup (`pg_dump` killed, upload aborted) and leaves no object.

### Restore a database

Restore is `restore.js`, a one-off container of the same image, which needs the backup storage settings and, for a database, an empty target. The age identity (`AGE-SECRET-KEY-1…` lines; `#` comments are fine) goes on standard input only, never in an argument or a setting.

1. **Choose the source.** `tb run --rm -T tarubot bun dist/scripts/restore.js list` lists the `daily/`, `monthly/` and `env/` objects with their sizes, newest first. To undo a migration, the dump `Migrations applied` names is the last state the previous release wrote. Managed point-in-time recovery to its `restorePoint` is the other way back, where configured and proven: a timestamp alone doesn't prove usable PITR, and a fork needs fresh address, CA and access checks.
2. **Prepare an empty target.** Production restores into `tarubot_restore` on the primary's cluster, or `tarubot` on another cluster; the tool's guard refuses anything else, and staging has no restore target. Never restore over the live database: `restore.js` refuses a target whose `public` schema has tables. Keep unrelated clients out (revoke `PUBLIC` `CONNECT` and `TEMPORARY` as appropriate) and keep the provider's monitoring access.
3. **Restore.** Put `RESTORE_DATABASE_URL` (and `RESTORE_DATABASE_CA_CERT`, when its CA differs from the primary's) in a second private file for this run only, then:

   ```sh
   docker compose --env-file <private settings copy> --env-file <private restore settings> \
     -f docker-compose.production.yml run --rm -T tarubot \
     bun dist/scripts/restore.js database <daily/… key, monthly/… key or latest> < <age identity file>
   ```

   `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` loads it, so a failure leaves the target empty. It prints `Restored <key> into <host>/<database>; schema head <file>.` and what it closed.

Before any bot starts on a restored database, two things must happen, and `restore.js` does both in one transaction: it signs everyone out of the dashboard with `DELETE FROM web_sessions`, since the backup would otherwise revive sessions ended since it was taken ([persistence](PERSISTENCE.md#web-sessions)), and it closes the members' role changes the backup caught waiting, so the restored copy never replays older choices over newer ones; the database then clears the role IDs they held ([persistence](PERSISTENCE.md#self-service-role-menus)). Members save again if they still want them. After a restore made any other way, such as a point-in-time fork, run both yourself before any bot starts: `DELETE FROM web_sessions`, then

```sql
UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
       result='{"skipped":"restored"}'
 WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');
```

4. **Fence the old writer:** `tb stop tarubot`. Watchtower leaves a stopped container alone. One application runs in one place, so no bot may run against the old database once one runs against the restored one.
5. **Point the bot at it.** Set `DATABASE_URL` in the settings copy to the restored database (`tarubot_restore` is a database name the production profile accepts). If you restored because a release failed, first deploy one that works on the restored schema, usually the previous one. Then `tb up -d --pull always`. An image newer than the dump migrates it, after its own pre-migration backup.
6. **Check what a restore can't bring back.** Mod mail reads only with the same `MODMAIL_KEY` (`restore.js settings` recovers it), and cases that expired since the backup come back until the next retention pass deletes them ([persistence](PERSISTENCE.md#mod-mail)). The restored pauses can differ from the current ones, so officers check the Moderation page ([persistence](PERSISTENCE.md#pauses)). The status page's samples need nothing ([persistence](PERSISTENCE.md#status-samples)). Discord effects already sent can't be undone, and update-post baselines may need the owner's correction to avoid repeat announcements. Verify readiness, the command inventory and the data, and keep the source database until the restore is accepted.

`check-restore.js` still compares two databases row for row, for a drill against a source nothing has written to since the dump. Its exact comparison fails on `jobs` or `web_sessions` once the closing statements changed them: after `restore.js`, its output says whether they changed anything; after a manual restore, run the check before the closing statements. Record a drill's release, commit, outcome and anything skipped in an issue, not here.

### Recover the settings

`tb run --rm -T tarubot bun dist/scripts/restore.js settings <env/… key or latest> < <age identity file> > <new settings copy>` writes a decrypted settings copy, ready for `--env-file`. It holds every secret: create it with `umask 077`, keep it at mode 600 and never in a checkout. When the runtime and its settings copy are both gone, the image alone runs it, with only the four `BACKUP_STORAGE_*` settings in a private file (one `NAME=value` per line, no quotes):

```sh
umask 077
docker run --rm -i --env-file <private storage settings> ghcr.io/deconfined/tarubot:production \
  bun dist/scripts/restore.js settings latest < <age identity file> > <new settings copy>
```

## Optional dashboard

The [site installation guide](../site/src/content/docs/deploy/install.md#optional-https-dashboard) owns the DNS, OAuth, port and public verification recipe. In the settings copy, `COMPOSE_PROFILES=web` selects the bundled proxy, `WEB_PUBLIC_ORIGIN` is shared by the bot and the proxy, `WEB_PORT` (default `8080`) stays private, and `DISCORD_CLIENT_SECRET` belongs to the existing application. The proxy is the release's own web image, so its Caddyfile and offline page come with the release and nothing is mounted. It publishes ports 80 and 443. An external HTTPS proxy, with the profile off, routes privately to the bot's web port instead.

- **Enable or change** the origin, secret or port: prepare DNS, the firewall and the exact `/auth/callback` redirect in Discord, edit the copy and `tb up -d`, which recreates the bot and the proxy with the new settings.
- **Disable** the bundled proxy: clear the profile, then `tb --profile web stop caddy` and `tb --profile web rm -f caddy`. Keep the `caddy_data` and `caddy_config` volumes; never `down -v`. To turn the dashboard off as well, clear its origin and secret and `tb up -d`.
- The proxy's health checks its own admin endpoint and the bot's private web readiness. It doesn't prove public DNS, certificate issuance, HTTPS redirects or OAuth: check the public origin with trusted TLS and an authorized Discord sign-in, following the site's recipe.

Every member and guest of a served server can sign in, for My roles and Mod mail. Before production members use it, the owner confirms (owner decision Q1, 2026-10-09; agents run none of these steps):

- the web is enabled in production: the origin, the bundled or external HTTPS proxy, the exact `/auth/callback` redirect in Discord, and AAAA as well as A records;
- TaruBot no longer holds Administrator in the server: `/config validate` says it's no longer needed after `/setup overrides`, and the owner removes it. The code refuses members and guests until then;
- on staging, an account that never authorized the application signs in with `prompt=none`. If Discord refuses it, a consent fallback is built and passes the same check first;
- Discord changes are live, TaruBot's role sits as the [officer guide](../site/src/content/docs/admin/roles.md#where-tarubots-role-sits) says, the "Role menu" health check is clean, and the restore steps above carry their sign-out and role-choice steps.

## Rotation and host loss

If GitHub is unavailable, the runtime keeps running the release it has. A deploy by hand still needs the owner's explicit go-ahead: verify the release's [provenance](#signed-build-provenance), set `TARUBOT_IMAGE_TAG` to its exact version (an `X.Y.Z` tag never moves, and the proxy follows `web-X.Y.Z`), `tb up -d --pull always`, and set it back to `production` once Deploy works again.

- **Runtime credentials:** update the copy, `tb up -d`, verify, then revoke the old credential. Change a database password in one window.
- **Backup credentials:** the same; check the next backup.
- **The age key:** add the new public key to `BACKUP_AGE_RECIPIENTS` (for production also to [age-recipients.txt](../ops/age-recipients.txt), through a reviewed change), `tb up -d`, check that the new identity opens the next backup, then remove the old key from both and `tb up -d` again. Earlier backups stay encrypted to the old key, so keep its identity until they have expired (a year for monthly copies) or re-encrypt them.
- **Mod mail key:** `MODMAIL_KEY` has no rotation in 2.43.0. A different key makes every existing case unreadable (the pages say so and file one issue report), so never replace it while cases matter, and recreate the container with the same value after any settings change. Keep it in the settings copy and one more copy outside the runtime; losing every copy loses every case. Each backup's encrypted settings copy carries it next to the dump, to the same age recipients, so that copy is how a lost key is recovered, and **whoever holds the backups' age identity can read every mod mail case in them**. That's the owner's deliberate trade-off (2026-10-11): a lost host restores fully, cases included. Guard the age identity accordingly. Production and staging each have their own.
- **Suggestion App:** production only; verify settings and recreation before revoking its old key. An empty client ID disables suggestions without blocking startup.
- **Discord token:** one application runs in one place. Stop the old runtime before a token moves or a replacement starts.
- **Host loss:** the managed database outlives a lost Docker host, and nothing else of TaruBot's was on it. Make sure the old host can't start the bot again (remove its containers if you still can, or revoke its database access), then start the same project on a new host from the settings copy, or one [recovered from a backup](#recover-the-settings). Losing a host doesn't authorize replacing the database.

## Owner settings in GitHub

The owner maintains these; agents change none of them ([AGENTS](../AGENTS.md)).

- **`main`:** the owner's code-owner review, required current checks, merge commits, signed commits and dismissal of stale approvals.
- **Environments `production` and `staging`:** the sole required reviewer `User: deconfined`, `prevent_self_review=false` so the owner can approve their own release, `can_admins_bypass=false`, and a custom deployment branch policy holding only `main`. GitHub enforces them. Deploy refuses unless its job was held for that approval in the same attempt, so an environment without a required reviewer can't deploy. The environments need no secrets or variables; after the cutover, remove `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.
- **Repository variables** `DEPLOY_ENABLED` (production) and `STAGING_DEPLOY_ENABLED` (staging): only the value `true` lets Deploy run. A run takes their values when it starts, so turning one off doesn't stop a run already waiting or approved; reject that deployment instead. Keep a target off until its runtime is ready.
- **The package** `ghcr.io/deconfined/tarubot`: public, since Watchtower pulls anonymously, with this repository's workflows allowed to write to it (publication and Deploy tag with the workflow's own token).
- **Code scanning:** the deleted SSHFP lab held the repository's only Python files. If a ruleset requires a Python analysis, update it.

## Staging

Staging rehearses the same path on its own Docker host, with DevBot's application and declared test guild (from `src/config/deployment.ts`), the managed `tarubot_staging` database and user, its own bucket and age recipients, and settings from `staging.env.example`, never production's. Keep `ENABLE_EFFECTS=false` until an effects test is approved, and leave production's suggestion App credentials out. DevBot runs in one place only: fence any other copy before starting the staging runtime or moving its token ([DevBot](DEV_GUILD.md)).

- **Deploy:** the owner dispatches **Actions → Deploy → Run workflow**, branch `main`, `target: staging` and a published version, then approves the `staging` environment; `STAGING_DEPLOY_ENABLED` must be `true`. Publication never dispatches staging. Staging's Watchtower follows the `staging` tags.
- The bot registers commands only in DevBot's guild, so staging never touches production's global set. Like production, it refuses to migrate without its own backup settings.
- Staging has no restore target: `restore.js database` and `check-restore.js` refuse there, and resetting staging is an owner step. Perform any isolated staging restore drill with the provider's own tools, never by relabelling the bot as unmanaged.
- Test plans come with the image ([startup test-session plans](DEV_GUILD.md#startup-test-session-plans)).
- Staging success doesn't authorize a production Deploy or prove production's settings, backups or readiness; a waiting production approval stays unapproved until production is ready.
