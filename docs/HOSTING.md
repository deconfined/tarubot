# Production hosting (Linode)

Production TaruBot has run on a **Linode Docker host with Linode managed PostgreSQL** since 2026-09-24.

The cutover first went live on DigitalOcean App Platform, then moved the same evening, with about 90 seconds of downtime, because **the Lodestone refuses DigitalOcean's addresses**: HTTP 403 at the edge, within milliseconds. From App Platform, Nodestone could not refresh profiles, verify claims or read the roster. Linode's addresses get HTTP 200. [MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover) has the record. [APP_PLATFORM.md](APP_PLATFORM.md) records the App Platform setup, retired in 2.21.0; the owner has since deleted the app and its cluster (recorded 2026-09-26).

## Layout

| Piece | Where |
| --- | --- |
| Host | Linode `tarubot`: us-iad-2, 1 vCPU / 2 GB, Ubuntu 26.04. Reached as `tarubot@<production host>`. The DNS zone carries the host's SSHFP records and is DNSSEC-signed, with its DS record at the parent since 2026-09-26, so validating resolvers set the AD flag on the SSHFP answers. `ssh -o VerifyHostKeyDNS=yes` then trusts a matching key without asking, but only when the machine's own resolver validates and passes the flag on (for example systemd-resolved with DNSSEC on; glibc keeps the flag only with `options trust-ad` in `resolv.conf`). Otherwise OpenSSH only reports the matching fingerprint and asks as usual. The Deploy production workflow never uses DNS: it pins the key in `DEPLOY_KNOWN_HOSTS` (setup step 7). |
| Bot | `~/tarubot` on the host: a clone of this repository, run with [`docker-compose.production.yml`](../docker-compose.production.yml). It has only `tarubot`: no bundled PostgreSQL, no parser sidecar (the Lodestone parser runs inside the bot since 2.21.0), the release pinned by `TARUBOT_IMAGE_TAG`, bounded logs, and since 2.30.3 a read-only root filesystem with no capabilities ([Container hardening](#container-hardening)). |
| Settings | `~/tarubot/.env` on the host, mode 600, never committed: `TARUBOT_IMAGE_TAG`, `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, since 2.18.0 `GITHUB_REPORTS_TOKEN` (the issue reporter's token; empty saves reports without sending them), since 2.22.0 `HEALTHCHECKS_PING_URL` (the heartbeat; see below), and since 2.28.0 `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` (the TaruBot GitHub App behind `/suggest`; the key is a double-quoted multi-line PEM like the CA, and either one empty switches `/suggest` off; see [Public suggestions](#public-suggestions-the-github-app)). Everything else is fixed in the Compose file: the production application ID, `TARUBOT_ENVIRONMENT=production`, effects on, and no test-guild scoping. |
| Database | Linode managed PostgreSQL `tarubot-pgsql`, PostgreSQL 18, us-iad-2. Use the **direct port 27520**, never the 27521 pool, which can't hold the writer lease. The login and database are `tarubot`, and `tarubot` owns the database. The admin login `akmadmin` is for provisioning only; the tool guard refuses it. The allow list holds the host and the operator's address. |
| Settings copy | Encrypted with `age` in `~/tarubot-cutover/env-backups/` on the operator machine (2.23.0; see "Settings copy"). |
| Backups | A daily encrypted dump at 04:30 UTC, and a settings copy, uploaded to Linode Object Storage `tarubot-backups` (2.24.0; see "Backups and recovery"). |
| Deploys | The **Deploy production** workflow deploys each published release over SSH once the owner approves it in GitHub (2.30.0; see [Automated deploys](#automated-deploys-2300)). The manual procedure under [Updating to a release](#updating-to-a-release) stays for work by hand. |
| Operator tools | Run from a clean clone of the deployed release on the operator machine, as `prod dist/scripts/<tool>.js`, with `~/tarubot-cutover/production.env` ([MIGRATION.md](MIGRATION.md#e0-conventions) E0). That file points at the Linode database, with its CA in `DATABASE_CA_CERT`. |

## Everyday checks

```sh
ssh tarubot@<production host>
cd ~/tarubot
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --since 1h tarubot
docker compose -f docker-compose.production.yml exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:3000/health/ready"); console.log(await r.text())'
```

Readiness must report `database`, `writerLease`, `discord` and `effects` as true. Its `lodestone` object is informational (since 2.21.0; the sidecar's `/health` before):

- `cooldownSeconds` above 0 means new Lodestone requests are paused after a 429 (since 2.17.0). Jobs wait it out.
- `selectors` shows the live selector commit (`source: upstream`) or the bundled set.
- `parsing` and `waiting` count parses running and requests waiting for a parse slot.

**Retrying a job.** After fixing what a failed or blocked job needs, retry it from the operator machine with `prod dist/scripts/retry.js GUILD_ID JOB_ID` (`prod` is [MIGRATION.md](MIGRATION.md#e0-conventions) E0). What the tool retries and refuses is on the documentation site's [monitoring page](../site/src/content/docs/deploy/monitoring.md#jobs-that-need-attention).

## Container hardening

Since 2.30.3 ([#51](https://github.com/deconfined/tarubot/issues/51)), both production containers run with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. @deconfined decided on 2026-09-26 to do this on the current host, before the move to AlmaLinux and rootless Podman ([#50](https://github.com/deconfined/tarubot/issues/50)). The settings are in `docker-compose.production.yml`. DevBot gets the same ones for the bot from `docker-compose.yml`, which its overlay leaves alone. Both bots have run with them since the 2.30.3 deploys of 2026-09-26, checked with `docker inspect` and `/proc/1/status` ([DEV_GUILD.md](DEV_GUILD.md#2303-rehearsal-and-rollout--2026-09-26)); the first nightly backup under them is the 04:30 UTC run on 2026-09-27.

| Service | Root filesystem | tmpfs | Capabilities | `no-new-privileges` |
| --- | --- | --- | --- | --- |
| `tarubot` | read-only | none | all dropped | on |
| `backup` | read-only | `/tmp`: 1 MiB, mode 0700 | all dropped | on |

- **Why no tmpfs for the bot.** Tests in throwaway containers showed that the bot writes no files ([VERIFICATION.md](VERIFICATION.md)). Its records are in PostgreSQL, its log goes to stdout, and the Lodestone selectors stay in memory. The base image sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, so Bun keeps no cache on disk. The same holds for the health check, `bun -e`, the Lodestone parse worker, and the tools `ops/deploy.sh` runs in the container.
- **Why `/tmp` for the backup job.** It writes one file: `/tmp/ca.crt`, the cluster CA that `pg_dump` verifies against. Without the tmpfs, the job fails with `can't create /tmp/ca.crt: Read-only file system`. The tmpfs ends with the run, and Docker mounts it `nosuid,nodev,noexec`.
- **What stays the same.** The bot still runs as the image's unprivileged `bun` user. Both containers keep Docker's `docker-default` AppArmor profile, its builtin seccomp filter, and its own `/dev/shm` (which the bot doesn't use). `pg_dump` still runs as the PostgreSQL image's root user, but that user now has no capabilities.
- **For operators.** `docker compose exec` and `run` in the bot's container can't write files. Most tools only print to stdout, so redirect their output on the host. The everyday checks above and the deploy steps work as before. The change takes effect when the container is recreated, which the next deploy does, since the Compose file changed.
- **The two tools that write a file.** `preview.js --output` (the grandfathering plan) and `snapshot.js --output` fail with `EROFS` in the container, after their Discord and database reads. Production runs them from the operator clone ([MIGRATION.md](MIGRATION.md#e0-conventions) E0), not in the container, so nothing changes there. In a container, give that one run a writable bind mount and point `--output` into it, as the site's [maintenance tools page](../site/src/content/docs/deploy/tools.md#previewjs) shows. The host directory must be writable by uid 1000, the image's `bun` user.
- **Rolling back.** The Deploy production workflow's rollback checks out the older release's commit (`git reset --keep` in `ops/deploy.sh`), so it brings back that release's Compose file and Docker's defaults. The manual [rollback](#updating-to-a-release) only re-pins `TARUBOT_IMAGE_TAG`, so it keeps these settings. That is safe for every release it can reach on schema 010 (2.29.0 and later): their runtime code makes no file writes, and 2.30.0 ran unchanged under these settings in throwaway containers.

## Heartbeat

Since 2.22.0 the bot pings a [healthchecks.io](https://healthchecks.io) check every five minutes while its readiness is fully green (database, writer lease, Discord). When the pings stop, healthchecks.io alerts the owner through Pushover and email. This catches what the issue reporter can't, because the reporter runs inside the bot: the host is down, the container is gone, the process hangs, or the bot has stayed unready.

- **The check:** "TaruBot production", simple schedule, period 5 minutes, grace 10 minutes. A deploy restart or a Discord reconnect stays well inside that, so only about 15 minutes of silence alerts.
- **The URL** is `HEALTHCHECKS_PING_URL` in the host's `.env`. Treat it as private: anyone holding it can ping the check and hide an outage. The operator machine keeps a copy in `~/tarubot-cutover/healthchecks-production.url` (mode 600). Issue reports redact it.
- **Each ping** carries one status line for the check's event log: version, pending and blocked work, degraded FCs, the Lodestone cooldown and the live selectors.
- **No failure pings.** An unready bot stays silent, and the grace period decides when that alerts. A failed ping (healthchecks.io unreachable) is retried every minute and logged once as a warning.
- **Planned maintenance** longer than about 10 minutes, such as a long migration: pause the check in healthchecks.io first, and resume it afterwards. The first ping after the restart also resumes it.
- **When it alerts:** SSH to the host and run the everyday checks above. `docker compose ps` shows whether the container is up; readiness shows which part is not ready.

To set or change the URL on the host from the operator machine, without it passing through a terminal or chat:

```sh
tr -d '\r\n' < ~/tarubot-cutover/healthchecks-production.url | ssh tarubot@<production host> \
  'set -e; umask 077; cd ~/tarubot; read -r u || true; [ -n "$u" ]; tmp=$(mktemp .env.XXXXXX)
   grep -v "^HEALTHCHECKS_PING_URL=" .env > "$tmp"; printf "HEALTHCHECKS_PING_URL=%s\n" "$u" >> "$tmp"
   chmod 600 "$tmp"; mv "$tmp" .env
   docker compose -f docker-compose.production.yml up -d --wait'
```

## Public suggestions (the GitHub App)

Since 2.28.0 (REQUIREMENTS.md "Approved public-suggestion amendments"), `/suggest idea:…` opens an issue in the **public** repository `deconfined/tarubot`, as the TaruBot GitHub App. It works only in Woven Souls (production's `deployments.production.guilds`), for holders of the bound Member or Guest role. What goes public, the limits, moderation and the failures members see are on the documentation site's [monitoring page](../site/src/content/docs/deploy/monitoring.md#public-suggestions); this section holds the production-only parts. DevBot needs none of it: with `GITHUB_REPORTS_TOKEN` set it previews suggestions into the private `deconfined/tarubot-reports`, and it ignores the app settings.

- **The app.** App ID 5076273, client ID in `GITHUB_APP_CLIENT_ID`. It has Issues write and Metadata read only, no webhook, and is installed on `deconfined/tarubot` alone. Its issues show the app's bot account as author.
- **Key storage.** The private key lives only in the host's `.env` as `GITHUB_APP_PRIVATE_KEY` (a double-quoted multi-line PEM, like `DATABASE_CA_CERT`), and in the operator's `~/tarubot-cutover/` (mode 600). It is never pasted in chat and never goes into DevBot's `.env` or `docker-compose.yml`. After changing it, refresh the encrypted settings copy (`bun run host:env-backup -- --host tarubot@<production host>`; see "Settings copy").
- **Tokens.** Each post signs a nine-minute JWT with the key, looks up the app's installation on the repository and mints a one-hour installation token narrowed to that repository's issues. Nothing is cached or stored.
- **Deploying it.** 2.28.0 is a restart with no migration. Put both settings in the host's `.env` over SSH stdin (temporary file and rename, mode 600, the PEM double-quoted and multi-line like the CA), refresh the settings copy, deploy, then register the commands with `register.js --global` (21 roots / 46 paths) and read them back. Probe the app (below) before announcing the command. Without the settings, `/suggest` tells members it is switched off.
- **Rotation.** Generate a second key on the app's settings page, put it in the host's `.env`, recreate the bot with `docker compose -f docker-compose.production.yml up -d --wait` (a plain `docker compose restart` keeps the old `.env` values), check one `/suggest` or the probe below, then delete the old key on GitHub. There is no downtime.
- **Probe (no issue created).** Inside the deployed image on the host, mint a token from the container's settings and POST an empty body to `/repos/deconfined/tarubot/issues`, printing only the status:

  ```sh
  docker compose -f docker-compose.production.yml run --rm --no-deps -T tarubot bun -e 'import {GitHubApp} from "./dist/src/infrastructure/github/app.js"; const app = new GitHubApp(process.env.GITHUB_APP_CLIENT_ID, process.env.GITHUB_APP_PRIVATE_KEY, "deconfined/tarubot"); const token = await app.installationToken(); const r = await fetch("https://api.github.com/repos/deconfined/tarubot/issues", {method: "POST", headers: {authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "TaruBot probe"}, body: "{}"}); console.log(r.status);'
  ```

  Expect `422` (the empty issue is rejected after authentication). A `configuration` failure or a 401, 403 or 404 means the key, the client ID or the installation is wrong.
- **Off switch.** Empty `GITHUB_APP_CLIENT_ID` in the host's `.env`, then recreate the bot with `docker compose -f docker-compose.production.yml up -d --wait` in `~/tarubot` (no migration). A plain `docker compose restart` doesn't re-read `.env`, so it would leave `/suggest` on. Confirm with a `/suggest`: members are then told suggestions are switched off, and nothing is reported. On DevBot, `/suggest` is off whenever `GITHUB_REPORTS_TOKEN` is empty.
- **Moderation and finding a sender.** Suggestions go up without review; the maintainers answer, label, close (for example as not planned), lock or delete them on GitHub. No issue names its sender, but each post leaves a private `audit` row. To find who sent issue `#N`, query the managed database from the operator machine with the `pg` helper (MIGRATION.md [E0 conventions](MIGRATION.md#e0-conventions), with the Linode values under [Updating to a release](#updating-to-a-release)). The site's `docker compose exec postgres` form needs the stock Compose file's bundled database, which production doesn't have.

  ```sh
  pg psql -d tarubot -c "SELECT guild_id, actor_id, event_at FROM audit WHERE action = 'suggestion.posted' AND target = '#N'"
  ```

  An attempt GitHub didn't confirm is recorded as `action = 'suggestion.unconfirmed'` with no target; match it by time against the issue's creation. Removing the member's Guest or Member role (a Guest with `/guest revoke`) ends their access to `/suggest`. The rest of the private record and the failures members see are on the site's [monitoring page](../site/src/content/docs/deploy/monitoring.md#public-suggestions).
- **Claude workflow.** `.github/workflows/claude.yml` never starts the agent for an issue whose body contains "Suggested in Discord with TaruBot". An `@claude` comment by a trusted account on a `from-discord` issue still starts it, and hands the member's text to the agent: treat that text as untrusted ([CI_CD.md](CI_CD.md#claude-review-and-assistant)).

## Updating to a release

Releases are published by the repository's `Publish containers` workflow. Try each one on DevBot before production. Since 2.30.0 the **Deploy production** workflow deploys them after your approval in GitHub ([Automated deploys](#automated-deploys-2300)); the procedure below stays for work by hand, and automated runs refuse while you do it.

**A release without a migration:**

```sh
cd ~/tarubot && umask 077 && git pull --ff-only
sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d --wait --remove-orphans
```

`--remove-orphans` removes containers of services the Compose file no longer has, such as the `nodestone` sidecar on the first 2.21.0 deploy; afterwards it does nothing. Compose stops the old container first, which releases the writer lease within its 30-second grace. It then starts the new one, and `--wait` returns once the health check passes. The check allows a 60-second start period. The outage is a few seconds. If the release changes commands, register them from the operator machine: `prod dist/scripts/register.js --global`, then `prod dist/scripts/commands.js list`, which must exit 0. (An automated deploy registers and reads back on every run, inside the container.)

**A release with a migration.** The migration must run in the *new* image, and only after the bot has stopped: `migrate.js` refuses a pending migration while a bot holds the writer lease.

1. On the host, fetch and pin the release first. Nothing restarts until step 5.

   ```sh
   cd ~/tarubot && umask 077 && git pull --ff-only
   sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
   docker compose -f docker-compose.production.yml pull
   ```

2. `docker compose -f docker-compose.production.yml stop tarubot`.
3. From the operator machine, run the writer-lease gate. It must print nothing. Then take an independent backup: `pg pg_dump -d tarubot -Fc -f /work/backups/before-X.Y.Z.dump`. Keep it off the provider, and record its checksum. (An automated deploy takes a fresh `ops/backup.sh` dump on the host instead, the owner's 2026-09-26 decision; this procedure keeps the operator dump.)
4. On the host, run `docker compose -f docker-compose.production.yml run --rm --no-deps -T tarubot bun dist/scripts/migrate.js`. Because of step 1, this runs in the new image. It prints the restore-point line with the files it applied, then `Schema ready.` If it applies nothing, the new image wasn't pinned: recheck step 1 before starting the bot.
5. `docker compose -f docker-compose.production.yml up -d --wait --remove-orphans`, then check readiness.

The `pg` helper and the writer-lease gate are MIGRATION.md's [E0 conventions](MIGRATION.md#e0-conventions), with Linode's values: `PGHOST` is the cluster host, `PGPORT=27520`, `PGUSER=tarubot`, and `PGSSLROOTCERT=/work/linode-ca.crt` (the cluster CA, saved in `~/tarubot-cutover/work/`).

**Rollback** means pinning the previous `TARUBOT_IMAGE_TAG` and running `up -d --wait` again. That only works when no migration lies between the two releases. After a migration, the way back is a fix release or a restore. Rolling back past 2.21.0 also needs the older Compose file, which still has the sidecar: check out that release's commit in `~/tarubot` before `up -d --wait`. Releases carry no Git tags; the commit is the image's `org.opencontainers.image.revision` label (`docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/deconfined/tarubot:X.Y.Z`). The Deploy production workflow rolls back to releases from 2.30.0 on (`rollback=true`), on the same schema only.

## Automated deploys (2.30.0)

Since 2.30.0 (issue #41; REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"), the **Deploy production** workflow (`.github/workflows/deploy.yml`) deploys each published release to this host once @deconfined approves it in GitHub. That approval is the go-ahead for a production deploy. What agents may and may not do around it is REQUIREMENTS.md's "Agent rule" (verbatim in AGENTS.md), which @deconfined confirmed in full on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): among its clauses, Claude sessions never approve, reject or bypass a deployment and never hold the deploy key. The workflow's jobs, environments and settings are in [CI_CD.md](CI_CD.md#deploy-production); this section is the host side and what to do.

### A deploy

1. Merge the release as today. Trying it on DevBot stays manual (GitHub can't reach the dev VM).
2. When "Publish containers" finishes, GitHub asks you to review "Deploy production". A merge that changes only documentation, tests, CI or the version asks nothing; a quiet Pushover message says so.
3. Open the run and read its summary: the version, commit and image digest, the migration files, the host-side changes in this merge (files under `ops/`, the production Compose file, `production.env.example`, which run on the host as a root-equivalent docker-group user), warnings for the Tuesday maintenance window and the daily backup, and the changelog. The migrations and host-side lists cover this merge only. If production is older than the previous release, the releases in between come too: the summary links the history of the host-side files up to the target for that case. GitHub's compare API lists at most 300 files, so a merge (or a rollback's range) of 300 files or more is refused as `compare-too-large` rather than planned from a list that may be cut short: deploy that release by hand ([Updating to a release](#updating-to-a-release)).
4. **Review deployments** → tick `production` → **Approve and deploy**, or **Reject**. Approval comments are public, like the summary.
5. One Pushover message reports the outcome.

**By hand:** **Run workflow** on `main` with a version. The live version is re-verified and its commands registered again (`already-live`), which is also the retry after `commands-failed`. A rollback ticks `rollback` and names the live version in `from`; it goes only to an older release (2.30.0 or later) on the same schema. The same approval follows.

Several requests may wait at once. Approve the newest; an older one approved later ends as `superseded` and changes nothing. Reject stale requests, or let them expire after 30 days.

### What the host does

The deploy key's line in the `tarubot` user's `~/.ssh/authorized_keys` forces every connection to `ops/deploy.sh` (`restrict,command=`): no shell, no file transfer, no forwarding. The script accepts exactly `deploy <version> <commit> <digest> <run>` or `rollback <version> <commit> <digest> <run> <from>` and starts a detached worker for that run, so a dropped connection reconnects to the same run. At most four workers run at once; beyond that a new run is refused `too-many-runs` before it gets a run directory. The worker:

1. **Checks the approval** with GitHub's public API: the run is `deploy.yml` on `main`, in progress, first attempt, titled with this target, with its Deploy job running, and approved by @deconfined (by login and account id) for `production`. A copied key alone deploys nothing. A run refused here (`not-approved`, `approval-unverified`, `missing-tool`, or `worker-not-started`) isn't final: nothing happened in it, so the next request for that run id, from the workflow or anyone else, starts it over. A request sent before your approval therefore can't block the approved run.
2. **Checks that no manual work is in progress** (nothing changes yet): the host lock (another deploy; it waits up to 5 minutes); the clone on `main` with no tracked change; `.env` a regular file, mode 600, with one plain `TARUBOT_IMAGE_TAG` line, no `TARUBOT_IMAGE`, and `LOG_LEVEL` unset or at most `info` (the container logs are the writer-lease evidence); Docker answering and 2 GB free; exactly one `tarubot` container, running or restarting, whose release is the pinned one; no `backup` container running (it waits up to 5 minutes); and the target commit on `main`, carrying the version, at or above 2.30.0.
3. **Chooses the path in Git**, from the live release's commit to the target's: an older target is `superseded`; the live one is `already-live`; a newer one with no migration files added is a **restart**; one with only added migration files takes the **migration** path; an edited or removed applied migration is refused.
4. **Stages the target without pinning it:** pulls it, requires the pulled image to be the digest the plan showed (with the version and commit labels), moves the clone to the target commit with `git reset --keep`, and checks `docker compose config --quiet` against the host's `.env`. Then it asks GitHub again whether the run and its Deploy job are still in progress: a cancel during the waits, the fetch or the pull ends it here, `not-approved`, with the clone put back.
5. **Restart:** `up -d --wait --remove-orphans` with the target tag (Compose stops the old bot first, freeing the lease). The new container must be the approved image and still healthy 60 seconds later. Then it pins `.env`, runs `register.js --global` and `commands.js list` in the container, and reports `deployed`.
6. **Migration:** stops the bot, runs `ops/backup.sh` (an encrypted dump to `daily/`), runs `migrate.js` in the new image (one transaction; the lease time is the restore point), pins `.env` at once, then `up -d --wait --remove-orphans`, the same checks and the commands. In the cluster's Tuesday 19:00-23:00 UTC maintenance window it warns (`warning db-maintenance-window`) and goes ahead (the owner's decision).
7. **Recovers only what is provably safe:** if the new release never got a container, or its one container never took the writer lease (its logs reach "Modules loaded" and show no "Database writer lease acquired", also after it is stopped), or the migration didn't commit, the previous release comes back with the clone and `.env` it had, and with its own Compose file's services (`--remove-orphans`). If Compose shows anything else after a failed start (`ps` or `inspect` failing, two containers, another image), nothing is restored or pinned. Otherwise the new release stays, pinned, and the result asks for you.

Every Docker call is bounded (60 seconds for `docker` itself, and a limit per Compose step), so a hung daemon ends in a result rather than a worker that holds the locks forever.

The deploy never prunes images, so the previous release stays available. Past manual deploys took a few seconds for a restart and about 21-31 seconds for a migration, plus about 6 seconds for the backup: well inside the heartbeat's 15 minutes.

**File modes.** `ops/deploy.sh` has run under `umask 077` since 2.30.0 (the first statement of `main`, which the worker also starts through), so everything a deploy writes, including the files git rewrites in the clone, is private to `tarubot` (600, or 700 for directories and scripts); 2.30.1's tests pin this. A `git pull` by hand follows the session's umask instead: the current host's `tarubot` user has umask 0002, so 2.30.0's hand deploy left `ops/deploy.sh` at mode 775 until a deploy rewrites it. Fix files already there once, as `tarubot`: `chmod -R go-w ~/tarubot` (an owner step, or one with the owner's go-ahead), and run `umask 077` before any later pull by hand. @deconfined ran it on the current host on 2026-09-26; a read-only check then found no group- or world-writable file in the clone outside `.git` ([VERIFICATION.md](VERIFICATION.md)).

### Outcomes

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `deployed` | The release runs, is pinned, and its commands are registered and read back. After a rollback, work only the newer release understood fails as `invalid_job`. | Nothing. After a rollback, check `/sync status` and requeue with `retry.js`. |
| `already-live` | The live release is healthy; its commands were registered again. | Nothing. |
| `superseded` | A newer release is live. Nothing changed. | Nothing. |
| `refused` | Nothing changed; the reason names the check (below). | Fix it, then run the workflow again. |
| `recovered` | The new release never took the writer lease, or the migration didn't commit (`did-not-start`, `backup-failed`, `migration-failed`, `stop-failed`). The previous release is back. | Read `worker.log`, fix, deploy again. |
| `needs-you` | The host is in a state you have to look at (below). | See the reason. |

**`needs-you` reasons:**
- `new-release-took-lease`, `lease-evidence-incomplete`, `unstable`, `image-mismatch`: the new release stays running (or restarting) and pinned. Read its logs. The way back depends on the path, as the message says:
  - after a restart (`path=plain`), run the workflow with `version=<previous> rollback=true from=<new>`: no migration lies between them;
  - after a rollback (`path=rollback`), the release you left is newer: run the workflow with `version=<that release>`, an ordinary deploy (a rollback to it is refused as `rollback-not-older`);
  - after a migration (`path=migration`, only `unstable` or `image-mismatch`), the migration committed, so the host refuses a rollback: a fix release, or a point-in-time fork by hand ("Backups and recovery"), with the restore point and backup object the message names.

  `lease-evidence-incomplete` with `.env` still pinning the previous release means Compose showed no single container of either release after the failed start (a failing `docker compose ps`, two containers, or one it couldn't inspect), so the host guessed nothing. Check `docker compose -f docker-compose.production.yml ps -a` and the logs, then pin `.env` to what runs; until they match, automated runs refuse `manual-change-in-progress`.
- `commands-failed`: the release is live. Run the workflow with the same version to retry.
- `new-release-failed`: the migration committed, and the new release doesn't come up; `.env` pins it and Docker keeps restarting it. The ways forward are a fix release, which the workflow deploys normally, or a point-in-time fork by hand ("Backups and recovery"). The message names the restore point and the backup object.
- `migration-may-have-committed`: the migration failed and the previous release didn't come back; an old image refuses a newer schema before it takes the lease, so it can't write. The clone is back at the old release's commit and `.env` still pins the old release. Read `migrate.js`'s output in `worker.log`:
  - if nothing was applied: `up -d --wait` with the old pin;
  - if it committed: move to the new release first, as manual step 1 would (its image is already pulled): `git reset --keep <new release's commit>` and pin `.env` to the new version. Then manual step 5 (`up -d --wait --remove-orphans`), readiness, and the command registration (run the workflow with the new version, which ends `already-live`).
- `previous-failed`: the previous release didn't come back after a failure that changed nothing on the database. Check `docker compose ps` and the logs, then `up -d --wait`.
- `live-unhealthy`: `already-live` found the live container unhealthy; nothing restarted.
- `pin-failed`: `.env` couldn't be pinned; pin it by hand to the release that runs.
- `worker-died`: see [When the worker dies](#when-the-worker-dies).
- `unexpected-error`: a command failed where the script didn't expect it, after something had changed; read `worker.log`.

**Refusal reasons:** `not-approved` (includes a re-run, and a run cancelled or a Deploy job ended before the first change), `approval-unverified` (GitHub's API didn't answer; anonymous calls are limited to 60 an hour per address, and a run makes five), `busy` (another deploy over 5 minutes, or a backup running over 5 minutes), `too-many-runs` (four workers already running: look for stray requests in `entry.log`), `clone-not-clean`, `env-file`, `log-level`, `host`, `bot-not-running`, `manual-change-in-progress` (the pin isn't the running release), `live-unknown`, `fetch-failed`, `not-on-main`, `version-mismatch`, `below-floor`, `commit-mismatch`, `not-descendant`, `applied-migration-changed`, `live-changed` (a rollback's `from` isn't live), `rollback-not-older`, `rollback-across-migration`, `pull-failed`, `digest-mismatch` (the tag moved after the plan), `label-mismatch`, `clone-reset`, `compose-config` (the host's `.env` lacks a setting the new Compose file requires), `missing-tool` (`jq` or `curl`), `worker-not-started`, and `unexpected-error` when nothing had changed yet (after a change it is `needs-you`). `not-approved`, `approval-unverified`, `missing-tool` and `worker-not-started` start over on the next request for the same run.

**When no result arrives** the workflow reports: `host-key` (the host key changed: check the host before updating `DEPLOY_KNOWN_HOSTS`), `key-rejected`, `known-hosts` or `no-key` (the production environment's settings), `unreachable` (every attempt for 80 minutes failed before sshd answered, so nothing started), `bad-request` (the host refused the command format), or `outcome-unknown` (the host may have been reached, or the run outlasted the reconnect window). With `outcome-unknown`, the host's run directory is authoritative: the worker carries on alone, and `runs/<run id>/public.log` ends with its result.

### Logs on the host

Everything lives under `~/.local/state/tarubot-deploy/`, which the script creates (mode 700):
- `runs/<run id>/`: `public.log` (the lines GitHub showed), `result`, `step` (the last step reached), `request`, `lock`, and `worker.log`, every tool's output (Git, Compose, `backup.sh`, `migrate.js`, `register.js`, `commands.js`). `worker.log` is private: the command read-back names guilds.
- `entry.log`: each run's start, runs that started over, refused requests (sanitized to one line) and entry errors, kept to its last megabyte.
- `lock`: the host lock that runs one deploy at a time.

Finished runs are pruned after 90 days, and runs refused before the approval was confirmed after 10 minutes. `cat ~/.local/state/tarubot-deploy/runs/<run id>/public.log` shows a run's result on the host.

### When the worker dies

A host reboot, the OOM killer or a kill ends the worker without a result. The next connection for that run (the workflow reconnects for up to 80 minutes) reports `needs-you` `worker-died` with the last step. Finish by hand:

| Last step | State | By hand |
| --- | --- | --- |
| `preflight`, `pull` | Nothing changed (the clone may sit at the target commit). | Nothing; deploy again. |
| `up` (restart) | The new release may run while the pin is still the old one; later runs refuse `manual-change-in-progress`. | Check the logs, then pin `.env` to what runs, or put the old release back with the manual rollback. |
| `stop`, `backup` | The bot is stopped on the old schema; later runs refuse `bot-not-running`. | `git reset --keep <old release's commit>`, then `up -d --wait`. |
| `migrate` | The bot is stopped; the schema is unknown. The clone is at the new release's commit, but `.env` still pins the old release. | Read `migrate.js`'s output in `worker.log`. First pin `.env` to the new release (manual step 1; the clone is already there and the image pulled). Then continue from manual step 4 if nothing committed, or from step 5 if it did. |
| `migrated`, `up` | `.env` pins the new release on the new schema. | `up -d --wait --remove-orphans`. |
| `commands` | The new release is live. | Run the workflow with its version. |

### Pause, stop and kill

- **Pause:** delete the repository variable `DEPLOY_ENABLED` (Settings → Secrets and variables → Actions → Variables → Repository variables, or `gh variable delete DEPLOY_ENABLED`). Nothing new plans, and a request already waiting ends `refused` `paused` if you approve it. Setting it back to `true` (`gh variable set DEPLOY_ENABLED --body true`) resumes. This holds only while the `production` environment has no `DEPLOY_ENABLED` of its own: inside the deploy job such a copy overrides the repository variable, so a waiting request would still go ahead ([setup](#setting-it-up-owner) step 12).
- **Stop:** `gh workflow disable deploy.yml`.
- **Kill:** delete the deploy key's line from `authorized_keys`, or the `DEPLOY_SSH_KEY` secret.
- **Cancelling a run in GitHub stops a host run only before its first change,** when the host checks the run again (`refused` `not-approved`, nothing changed). After that it finishes on its own, and its result stays in its run directory.
- **Don't approve while you work by hand.** Automated runs refuse while the bot is stopped or the pin differs from the running release, but not every manual step shows.

### Setting it up (owner)

Each step is the owner's, with the owner's go-ahead; Claude prepares the commands only. **Status (2026-09-26):** steps 1 to 13 are done. Steps 1, 4, 5 (the line names `/opt/tarubot/tarubot/ops/deploy.sh`, and `authorized_keys` is mode 600) and 7 to 11 came before the 2.30.0 merge; after it, the hand deploy (step 2), the prerequisites (step 3), the key probe (step 6), `DEPLOY_ENABLED` (step 12, on the second try) and the first run (step 13). Step 14 followed with 2.30.1 (run 36253924529, `deployed`), and 2.30.2 and 2.30.3 went the same way; no migration release has gone through the workflow yet. Since step 11 the dev VM's `gh` token is read-only, so the `gh secret set` and `gh variable set` commands below need a token with write access; the same settings can be made in the web UI (Settings → Environments → the environment, or Settings → Secrets and variables → Actions → Variables → Repository variables for `DEPLOY_ENABLED`).

1. **Before the 2.30.0 pull request merges,** create the environments in Settings → Environments:
   - `production`: required reviewer `deconfined` only; "Prevent self-review" **off**; "Allow administrators to bypass configured protection rules" **off**; deployment branches "Selected branches and tags" with the branch rule `main` only; no wait timer.
   - `notify`: the branch rule `main` only, no reviewers.

   Leave `DEPLOY_ENABLED` unset: the workflow then runs nothing.
2. **Deploy 2.30.0 to production by hand** (the restart procedure above), so the host has `ops/deploy.sh`.
3. **As root on the host:** `apt-get install -y jq`, and check that `systemd-analyze cat-config systemd/logind.conf | grep -i '^KillUserProcesses'` prints nothing or `no`.
4. **Generate the deploy key in your own terminal,** in memory, straight into the environment (never pasted anywhere):

   ```sh
   d=$(mktemp -d /dev/shm/dk.XXXXXX) && ssh-keygen -q -t ed25519 -N '' -C tarubot-deploy-github -f "$d/k" \
     && gh secret set DEPLOY_SSH_KEY --env production < "$d/k" && cat "$d/k.pub"
   ```

5. **Over your own SSH session,** append the restricted line to the `tarubot` user's `~/.ssh/authorized_keys` (`~tarubot/.ssh/authorized_keys`; your own key stays), and keep that file at mode 600. The forced command is the absolute path of `~/tarubot/ops/deploy.sh` in that user's home: `getent passwd tarubot | cut -d: -f6` prints the home, which is `/opt/tarubot` on the current host and `/home/tarubot` on a host rebuilt from the runbook below. On the current host:

   ```text
   restrict,command="/opt/tarubot/tarubot/ops/deploy.sh" ssh-ed25519 AAAA… tarubot-deploy-github
   ```

   `restrict` turns off forwarding (so no database tunnel), PTYs and `~/.ssh/rc`; `command=` also captures `exec`, `sftp` and `scp`. sshd runs the forced command through `tarubot`'s shell, which reads `~/.bashrc` for SSH sessions: keep Ubuntu's default, which returns at once when non-interactive, and put nothing that prints or changes the environment ahead of that return. There is no `from=`: GitHub's runner addresses can't be listed.

6. **Probe the restriction** with the new key alone. `IdentityAgent=none` keeps your own key, if your agent holds it, out of the probes; otherwise a probe could log in with it and look like a failed restriction:

   ```sh
   o=(-o IdentitiesOnly=yes -o IdentityAgent=none -i "$d/k")
   h=tarubot@<production host>
   ssh "${o[@]}" "$h"; echo "exit $?"      # "PTY allocation request failed", the usage line, exit 64
   ssh "${o[@]}" "$h" id; echo "exit $?"   # the usage line, exit 64
   sftp "${o[@]}" "$h"                     # "Received message too long 1970495847", no listing
   ssh "${o[@]}" -W localhost:22 "$h"      # "administratively prohibited", "stdio forwarding failed"
   ssh "${o[@]}" -N -L "$d/d.sock:/var/run/docker.sock" "$h" & p=$!; sleep 3
   curl --unix-socket "$d/d.sock" http://x/_ping; kill "$p"
   # ssh: "channel N: open failed: connect failed: open failed"; curl: a connection reset or an empty reply, never "OK"
   ```

   None may give a shell, a file listing or an answer from Docker. The sftp client reads the usage line as a packet length, hence its message, and the host's `~/.local/state/tarubot-deploy/entry.log` records each refused request. The forwarding probes matter because the key is root-equivalent through the Docker socket, and only `restrict` blocks forwarding it. The two forwards fail with different messages: OpenSSH reports a refused Unix-socket forward with the generic "connect failed" code, and only TCP forwards, such as `-W`, say "administratively prohibited". Optionally, as a control, repeat the socket forward with your own unrestricted key: `rm -f "$d/d.sock"`, then the `-L` and `curl` lines again, the `ssh` without `"${o[@]}"`. curl then prints Docker's `OK`, which shows that the deploy key's `restrict` is what refused the first one. The probe of 2026-09-26 gave these results, and its control answered `OK`. Then `shred -u "$d/k"; rm -rf "$d"`: a lost key is replaced, not restored. If step 4's private key is already gone, generate a new one (steps 4 to 6 again).
7. **Pin the host and its key** from your SSHFP-verified session. The key file ends with a comment (such as `root@…`), which the workflow refuses, so keep the first two fields:

   ```sh
   h=<production host>
   kh="$h $(ssh -o VerifyHostKeyDNS=yes "tarubot@$h" "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub")"
   gh variable set DEPLOY_HOST --env production --body "$h"
   gh variable set DEPLOY_KNOWN_HOSTS --env production --body "$kh"
   ```

   `DEPLOY_KNOWN_HOSTS` is exactly one line: the `DEPLOY_HOST` name, `ssh-ed25519` and the key, with no comment. The workflow never trusts DNS for the key. Both are variables, so every deploy run's public log shows them (GitHub masks only secrets); the name isn't secret ([CI_CD.md](CI_CD.md#deploy-production)). The agent's read-only token can't read back the values set on 2026-09-26: if the first run stops with `known-hosts`, look for a trailing comment.
8. **Pushover:** create an application "TaruBot deploys", then `gh secret set PUSHOVER_TOKEN --env notify` and `gh secret set PUSHOVER_USER --env notify`.
9. **Check the secrets:** `gh secret list` shows only `CLAUDE_CODE_OAUTH_TOKEN` at repository level; `gh secret list --env production` shows `DEPLOY_SSH_KEY`; `gh secret list --env notify` shows both Pushover secrets.
10. **Firewall:** attach the Cloud Firewall with TCP 22 from all sources, plus ICMP (done 2026-09-26).
11. **Agent guards:** Claude Code deny rules on the dev VM, a read-only GitHub token and pushes over SSH (done 2026-09-26; [CI_CD.md](CI_CD.md#agent-access-to-deployments), which also lists the owner's open decisions).
12. **Turn deploys on:** give the **repository** variable `DEPLOY_ENABLED` the value `true`, exactly and lowercase: Settings → Secrets and variables → Actions → Variables → **Repository variables** → New repository variable, or `gh variable set DEPLOY_ENABLED --body true` (no `--env`). Not under Settings → Environments → `production`: the plan job has no environment and can't see a copy there, so every run is skipped; and inside the deploy job, which runs in `production`, such a copy overrides the repository variable, so pausing by deleting the repository variable would not stop a request already waiting. The first attempt on 2026-09-26 hit the first half (run 36242804814 skipped); @deconfined moved the variable to the repository, and run 36242986952 followed. If a copy exists in `production`, delete it there.
13. **First run:** run the workflow with `version=2.30.0` and approve it. Expect `already-live`, no restart, commands registered with a clean read-back, and one Pushover message. Optionally run it once more and reject it, to see the "not approved" message.
14. **The next real release:** read the plan, approve, and record the run in VERIFICATION.md. Read the first migration release's result closely: downtime, backup object and restore point.

The key is rotated at every host rebuild and on any suspicion: generate a new one (steps 4 to 6) and remove the old line.

## Backups and recovery

There are three layers:
- **Linode's point-in-time recovery.** The managed cluster keeps its own backups. On 2026-09-25 its restore window reached back to the cluster's creation. Restoring forks a new cluster in the Linode console.
- **Daily encrypted dumps (2.24.0),** kept in Linode Object Storage. They're independent of the cluster, so they survive a deleted or broken cluster.
- **A dump before every migration:** on the operator machine for a manual migration (below), and a fresh `ops/backup.sh` dump on the host, taken after the bot stops, for an automated deploy (2.30.0).

The cluster's weekly maintenance runs Tuesdays from 19:00 UTC for up to 4 hours. On this single-node cluster a restart can drop the bot's connection. The bot then exits, Docker restarts it, and it waits for the writer lease again. A long outage trips the heartbeat.

### Daily dumps

`ops/backup.sh` runs at 04:30 UTC from the `tarubot` user's crontab on the host:
1. `pg_dump` runs in the pinned PostgreSQL 18 image, through the production Compose file's `backup` service. The service sits behind a profile, so `up` never starts it. It uses the bot's database URL and CA. Its logging is off, because a logging driver would copy the unencrypted dump on stdout to disk.
2. The dump streams straight into `age`, encrypted for [`ops/age-recipients.txt`](../ops/age-recipients.txt). No unencrypted dump touches the disk, and the host can't decrypt what it wrote.
3. `curl` uploads it with SigV4 signing to `daily/`, and also to `monthly/` on the 1st.
4. The host's `.env` goes to `env/` the same way, so the settings copy stays current without the operator machine.
5. healthchecks.io's "TaruBot backups" check (period 1 day, grace 3 hours) hears the start, then success with the sizes, or a failure naming the step. The script logs one line per run to `~/tarubot-backup.log`.

| Piece | Where |
| --- | --- |
| Bucket | `tarubot-backups` in Linode Object Storage, `us-iad-2`, at `https://tarubot-backups.us-iad-18.linodeobjects.com`. The access key `tarubot-backup-key` is limited to this bucket. Linode offers no write-only keys, so a compromised host could delete copies. The copies are encrypted, and the operator machine can pull its own. |
| Retention | [`ops/bucket-lifecycle.xml`](../ops/bucket-lifecycle.xml): `daily/` and `env/` for 30 days, `monthly/` for 365 days. |
| Settings | In the host's `.env`: `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY`, `BACKUP_STORAGE_REGION` (`us-iad-2`) and `HEALTHCHECKS_BACKUP_URL`. The bot never sees them, because Compose passes it only its own settings. The operator copies are `~/tarubot-cutover/backup-storage.env` and `~/tarubot-cutover/healthchecks-backup.url`. |

**Setting it up** (on a new host, rebuild step 10). A settings copy taken on or after 2026-09-25 already holds the storage settings, so after a restore only the schedule is needed:

```sh
# From the operator machine: the storage settings and the check URL, over SSH stdin.
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
{ printf 'BACKUP_STORAGE_ENDPOINT=%s\nBACKUP_STORAGE_ACCESS_KEY=%s\nBACKUP_STORAGE_SECRET_KEY=%s\nBACKUP_STORAGE_REGION=us-iad-2\n' \
    "$BACKUP_STORAGE_ENDPOINT" "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY"
  printf 'HEALTHCHECKS_BACKUP_URL=%s\n' "$(tr -d '\r\n' < ~/tarubot-cutover/healthchecks-backup.url)"
} | ssh tarubot@<production host> 'set -e; umask 077; cd ~/tarubot; tmp=$(mktemp .env.XXXXXX)
    grep -v -E "^(BACKUP_STORAGE_[A-Z_]+|HEALTHCHECKS_BACKUP_URL)=" .env > "$tmp"; cat >> "$tmp"
    chmod 600 "$tmp"; mv "$tmp" .env'
# On the host, as tarubot: the schedule, then one run to check it.
( crontab -l 2>/dev/null | grep -v ops/backup.sh; echo '30 4 * * * $HOME/tarubot/ops/backup.sh >> $HOME/tarubot-backup.log 2>&1' ) | crontab -
~/tarubot/ops/backup.sh
```

A new bucket also needs its retention rules, set once from the operator machine with the bucket's key:

```sh
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
printf 'user = "%s:%s"\n' "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY" |
  curl --config - -sS --fail --aws-sigv4 "aws:amz:us-iad-2:s3" -X PUT \
    -H "Content-MD5: $(openssl md5 -binary ops/bucket-lifecycle.xml | base64)" \
    --data-binary @ops/bucket-lifecycle.xml "https://${BACKUP_STORAGE_ENDPOINT%/}/?lifecycle"
```

**Restoring a dump.** Restore into a new database, never over the live one. Use a new cluster, or `tarubot_restore` on the same cluster:

```sh
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
base="https://${BACKUP_STORAGE_ENDPOINT%/}"
s3() { printf 'user = "%s:%s"\n' "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY" |
  curl --config - -sS --fail --aws-sigv4 "aws:amz:us-iad-2:s3" "$@"; }
s3 "$base/?list-type=2&prefix=daily/" | grep -o '<Key>[^<]*' | cut -c6-   # the copies, oldest first
s3 -o db.age "$base/daily/tarubot-YYYYMMDDTHHMMSSZ.dump.age"
age --decrypt --identity ~/tarubot-cutover/age/tarubot.key -o db.dump db.age
pg_restore --no-owner --no-privileges --exit-on-error -d "NEW_DATABASE_URL" db.dump
```

Compare the result with `check-restore.js`, then stop the bot and point `DATABASE_URL` at it. Settings copies in `env/` decrypt the same way.

**Before a manual migration** keep taking an independent `pg_dump` on the operator machine, as in the migration procedure above. Running `~/tarubot/ops/backup.sh` on the host right before also puts a fresh copy off-site. An automated deploy runs `ops/backup.sh` on the host after it stops the bot and names the object (`daily/tarubot-<UTC time>.dump.age`) in its result; that extra run also resets the "TaruBot backups" check's daily timer, which the 04:30 run then keeps as usual. The 2026-09-24 cutover left `pre-activation.dump` and `move-to-linode.dump` in `~/tarubot-cutover/work/backups/`.

**Restore checks:** `check-restore.js` compares a restored copy with the source. The production profile accepts `tarubot` on another host, such as a new cluster, or `tarubot_restore` on the same host.

## Settings copy (off the host)

The host's `.env` is the one thing a rebuild can't recreate from Git, so an encrypted copy is kept off the host (since 2.23.0). `scripts/host-env-backup.ts` runs on the operator machine. It reads `~/tarubot/.env` over SSH from the host named by `--host` (required) and encrypts it with [`age`](https://age-encryption.org) for the public keys in [`ops/age-recipients.txt`](../ops/age-recipients.txt). It writes only the encrypted file, to `~/tarubot-cutover/env-backups/tarubot-env-<UTC time>.age` (mode 600). The settings never touch the operator machine's disk or the terminal.

```sh
bun run host:env-backup -- --host tarubot@<production host> --identity ~/tarubot-cutover/age/tarubot.key
```

- **The output** names the settings present and any expected ones that are absent, never their values. With `--identity`, it also decrypts the new copy in memory and confirms it matches what was read.
- **When to run it:** after any change to the host's `.env`, such as a rotated token or a new setting. A release only changes `TARUBOT_IMAGE_TAG`, which a restore sets anyway (step 7 below).
- **The private key** is `~/tarubot-cutover/age/tarubot.key` on the operator machine (mode 600). The owner keeps a second copy offline, in a password manager. Without the key the copies can't be opened, and the daily database backups (2.24.0) use the same key.

## Rebuilding the host

Use this when the host is lost, compromised, or being replaced. The data lives in the managed database, so a rebuild loses nothing: the new bot picks up its state from PostgreSQL. Budget about an hour, most of it waiting for DNS.

You need the latest settings copy and the `age` key (above), access to Linode, the domain's DNS, and the healthchecks.io check.

1. **Stop the old bot**, if the old host is still reachable: `docker compose -f docker-compose.production.yml stop tarubot`. The writer lease would make a second bot wait anyway; stopping it keeps the handover clean. Pause the healthchecks.io check.
2. **Create the Linode:**
   - label `tarubot`, region `us-iad` (the database's region), type Linode 2 GB (`g6-standard-1`), image Ubuntu 26.04 LTS;
   - the owner's SSH key for root, and a root password kept in the password manager;
   - attach the Cloud Firewall (inbound TCP 22 from all sources, plus ICMP; the host publishes no other ports). Port 22 stays open to all because deploys come from GitHub's runners, whose addresses can't be listed; SSH accepts keys only, and the deploy key runs nothing but `ops/deploy.sh`.
3. **Set up the base system as root** (`ssh root@NEW_IP`):

   ```sh
   apt-get update && apt-get -y full-upgrade
   # Docker CE from Docker's repository, as on the first host.
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
     "$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")" > /etc/apt/sources.list.d/docker.sources
   apt-get update
   apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin age jq unattended-upgrades
   # The tarubot user runs Compose; it needs the docker group, not sudo.
   useradd -m -s /bin/bash -G docker tarubot
   install -d -m 700 -o tarubot -g tarubot /home/tarubot/.ssh
   install -m 600 -o tarubot -g tarubot /root/.ssh/authorized_keys /home/tarubot/.ssh/authorized_keys
   # Key-only SSH: no passwords, and root only with a key.
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-tarubot.conf
   sshd -t && systemctl reload ssh
   hostnamectl set-hostname tarubot && timedatectl set-timezone Etc/UTC
   # The deploy worker outlives its SSH session; logind must not kill it. Expect no output, or "no".
   systemd-analyze cat-config systemd/logind.conf | grep -i '^KillUserProcesses'
   ```

   Before closing the root session, confirm that `ssh tarubot@NEW_IP true` works from the operator machine. The deploy key isn't copied: generate a new one and add its restricted line as in [Automated deploys](#setting-it-up-owner) steps 4 to 6 once the bot runs (step 9).
4. **Point DNS at the new host.** Update the production host name's A and AAAA records to the new addresses. Replace its SSHFP records with the output of `ssh-keygen -r <production host>` (as root on the new host). The zone is signed, so the new records validate once published: `dig +dnssec SSHFP <production host>` through a validating resolver shows the `ad` flag. On the operator machine, run `ssh-keygen -R <production host>`. Use the IP address until DNS has updated. The new host has a new host key, so automated deploys fail closed (`host-key`) until you update the production environment's `DEPLOY_KNOWN_HOSTS` (and `DEPLOY_HOST`, if the name changes), as in [Automated deploys](#setting-it-up-owner) step 7.
5. **Let the new host reach the database.** In Linode Cloud Manager → Databases → `tarubot-pgsql` → Access Controls, add the new host's IPv4 address. Remove the old host's address in step 11.
6. **Clone the repository** as `tarubot`: `ssh tarubot@NEW_IP 'umask 077 && git clone https://github.com/deconfined/tarubot.git ~/tarubot'`.
7. **Restore the settings** from the operator machine, then pin the current release:

   ```sh
   latest=$(ls -1 ~/tarubot-cutover/env-backups/tarubot-env-*.age | tail -1)
   age --decrypt --identity ~/tarubot-cutover/age/tarubot.key "$latest" \
     | ssh tarubot@NEW_IP 'umask 077; cat > ~/tarubot/.env'
   ssh tarubot@NEW_IP "sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' ~/tarubot/.env && grep -c = ~/tarubot/.env"
   ```

8. **Start the bot:** `ssh tarubot@NEW_IP 'cd ~/tarubot && docker compose -f docker-compose.production.yml pull && docker compose -f docker-compose.production.yml up -d --wait'`.
9. **Check it** with the everyday checks above. Readiness must be all true, and the logs must show "Database writer lease acquired" and "TaruBot ready". Resume the healthchecks.io check; it should turn green within five minutes. Commands are registered globally and survive a rebuild, so there is nothing to register.
10. **Restore the backup schedule:** add the database's new access-list entry first (step 5), then follow "Setting it up" under Daily dumps. The first run should turn the "TaruBot backups" check green.
11. **Retire the old host.** Delete the old Linode and remove its database access entry. Update the Layout table above, and take a fresh settings copy (`bun run host:env-backup -- --host tarubot@<production host>`).
