# Production hosting (Linode)

Production TaruBot has run on a **Linode Docker host with Linode managed PostgreSQL** since 2026-09-24.

The cutover first went live on DigitalOcean App Platform, then moved the same evening, with about 90 seconds of downtime, because **the Lodestone refuses DigitalOcean's addresses**: HTTP 403 at the edge, within milliseconds. From App Platform, Nodestone could not refresh profiles, verify claims or read the roster. Linode's addresses get HTTP 200. [MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover) has the record. [APP_PLATFORM.md](APP_PLATFORM.md) records the App Platform setup, retired in 2.21.0; the owner has since deleted the app and its cluster (recorded 2026-09-26).

A second Linode, the [staging host](#staging-host-50) (#50), is being built beside it on AlmaLinux with rootless Podman, from the Ansible playbook production will be rebuilt from. Since 2.33.0 the same Deploy workflow can deploy to it, with no approval, once the owner turns staging deploys on after the DevBot move ([Staging deploys](#staging-deploys-2330)). Since 2.34.0 a Podman host can also keep its own host configuration current with the [pull unit](#the-pull-unit-2340), once @deconfined installs it there.

## Layout

| Piece | Where |
| --- | --- |
| Host | Linode `tarubot`: us-iad-2, 1 vCPU / 2 GB, Ubuntu 26.04. Reached as `tarubot@<production host>`. The DNS zone carries the host's SSHFP records and is DNSSEC-signed, with its DS record at the parent since 2026-09-26, so validating resolvers set the AD flag on the SSHFP answers. `ssh -o VerifyHostKeyDNS=yes` then trusts a matching key without asking, but only when the machine's own resolver validates and passes the flag on (for example systemd-resolved with DNSSEC on; glibc keeps the flag only with `options trust-ad` in `resolv.conf`). Otherwise OpenSSH only reports the matching fingerprint and asks as usual. The Deploy workflow never uses DNS: it pins the key in `DEPLOY_KNOWN_HOSTS` (setup step 7). |
| Bot | `~/tarubot` on the host: a clone of this repository, run with [`docker-compose.production.yml`](../docker-compose.production.yml). It has only `tarubot`: no bundled PostgreSQL, no parser sidecar (the Lodestone parser runs inside the bot since 2.21.0), the release pinned by `TARUBOT_IMAGE_TAG`, bounded logs, and since 2.30.3 a read-only root filesystem with no capabilities ([Container hardening](#container-hardening)). |
| Settings | `~/tarubot/.env` on the host, mode 600, never committed: `TARUBOT_IMAGE_TAG`, `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, since 2.18.0 `GITHUB_REPORTS_TOKEN` (the issue reporter's token; empty saves reports without sending them), since 2.22.0 `HEALTHCHECKS_PING_URL` (the heartbeat; see below), and since 2.28.0 `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` (the TaruBot GitHub App behind `/suggest`; the key is a double-quoted multi-line PEM like the CA, and either one empty switches `/suggest` off; see [Public suggestions](#public-suggestions-the-github-app)). Everything else is fixed in the Compose file: the production application ID, `TARUBOT_ENVIRONMENT=production`, effects on, and no test-guild scoping. |
| Database | Linode managed PostgreSQL `tarubot-pgsql`, PostgreSQL 18, us-iad-2. Use the **direct port 27520**, never the 27521 pool, which can't hold the writer lease. The login and database are `tarubot`, and `tarubot` owns the database. The admin login `akmadmin` is for provisioning only; the tool guard refuses it. The allow list holds the host and the operator's address. |
| Settings copy | Encrypted with `age` in `~/tarubot-cutover/env-backups/` on the operator machine (2.23.0; see "Settings copy"). |
| Backups | A daily encrypted dump at 04:30 UTC, and a settings copy, uploaded to Linode Object Storage `tarubot-backups` (2.24.0; see "Backups and recovery"). |
| Deploys | The **Deploy** workflow's production job (the workflow was named "Deploy production" until 2.33.0) deploys each published release over SSH once the owner approves it in GitHub (2.30.0; see [Automated deploys](#automated-deploys-2300)). Since 2.33.0 its plan first verifies the image's signed build provenance ([Provenance check](#provenance-check-2330)). The manual procedure under [Updating to a release](#updating-to-a-release) stays for work by hand. |
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
- **Rolling back.** The Deploy workflow's rollback checks out the older release's commit (`git reset --keep` in `ops/deploy.sh`), so it brings back that release's Compose file and Docker's defaults. The manual [rollback](#updating-to-a-release) only re-pins `TARUBOT_IMAGE_TAG`, so it keeps these settings. That is safe for every release it can reach on schema 010 (2.29.0 and later): their runtime code makes no file writes, and 2.30.0 ran unchanged under these settings in throwaway containers.

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

Releases are published by the repository's `Publish containers` workflow. Try each one on DevBot before production. Since 2.30.0 the **Deploy** workflow deploys them after your approval in GitHub ([Automated deploys](#automated-deploys-2300)); the procedure below stays for work by hand, and automated runs refuse while you do it. A deploy by hand still needs the owner's explicit go-ahead.

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

**Rollback** means pinning the previous `TARUBOT_IMAGE_TAG` and running `up -d --wait` again. That only works when no migration lies between the two releases. After a migration, the way back is a fix release or a restore. Rolling back past 2.21.0 also needs the older Compose file, which still has the sidecar: check out that release's commit in `~/tarubot` before `up -d --wait`. Releases carry no Git tags; the commit is the image's `org.opencontainers.image.revision` label (`docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/deconfined/tarubot:X.Y.Z`). The Deploy workflow rolls back (`rollback=true`) on the same schema only, and since 2.33.0 only to releases with signed build provenance, 2.32.0 and later: an older one (2.30.x) is refused `unattested` and goes back by hand, below.

### Rolling back to a release without provenance (before 2.32.0)

`publish.yml` signs build provenance from 2.32.0 on, and a signature can't be made honestly for an older image afterwards, so since 2.33.0 the Deploy plan refuses every release before 2.32.0 (`unattested`), for a rollback and for an `already-live` re-check alike. Of the releases the workflow could roll back to before (2.30.0 and later, on schema 010), that leaves 2.30.0 to 2.30.4 (2.31.0 was skipped) to this procedure. Staging never needs it: its floor is 2.33.0. It is a deploy by hand, so it needs the owner's explicit go-ahead, and only on the same schema (no migration file between the two releases).

The plan's check stood in for trusting the registry: any workflow in this repository could move a version tag. By hand, the digest comes from a record made when the release was published instead:

1. **Find the recorded digest and commit.** The release's own Deploy run summary shows them (its **Image** row, `ghcr.io/deconfined/tarubot@sha256:…`, and its **Commit**); for a release that never needed a deploy, such as 2.30.4, its Publish containers run's log does. [VERIFICATION.md](VERIFICATION.md) records some too. Don't take them from the registry now.
2. **Check that the registry still agrees,** from the operator machine: both tags must name the recorded digest, or stop, because a tag moved.

   ```sh
   for t in X.Y.Z sha-<commit>; do
     docker buildx imagetools inspect "ghcr.io/deconfined/tarubot:$t" --format '{{json .Manifest}}' | jq -r .digest
   done
   ```

3. **On the host,** move the clone and the pin, and pull, without restarting yet: `cd ~/tarubot && umask 077 && git reset --keep <commit>`, then `sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env` and `docker compose -f docker-compose.production.yml pull`.
4. **Check what was pulled:** `docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z --format '{{json .RepoDigests}}'` must include `ghcr.io/deconfined/tarubot@<recorded digest>`, and the image's labels must name X.Y.Z and the commit. Otherwise put the clone and the pin back and stop.
5. **Start it:** `docker compose -f docker-compose.production.yml up -d --wait --remove-orphans`, then check readiness, and register and read back the commands as after any manual deploy: `docker compose -f docker-compose.production.yml exec -T tarubot bun dist/scripts/register.js --global`, then `commands.js list` the same way, which must exit 0.

Afterwards the workflow deploys forward as usual: the older release's `ops/deploy.sh` speaks the same command contract, and it checks that the pin names the running release. Re-registering that release's commands through the workflow is refused `unattested` too, so repeat step 5's registration by hand if needed.

## Automated deploys (2.30.0)

Since 2.30.0 (issue #41; REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"), the **Deploy** workflow (`.github/workflows/deploy.yml`, named "Deploy production" until 2.33.0) deploys each published release to this host once @deconfined approves it in GitHub. That approval is the go-ahead for a production deploy. What agents may and may not do around it is REQUIREMENTS.md's "Agent rule" (verbatim in AGENTS.md), which @deconfined confirmed in full on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): among its clauses, Claude sessions never approve, reject or bypass a deployment and never hold the deploy key. The rule's "Deploy production workflow" is this file, whatever its display name. The workflow's jobs, environments and settings are in [CI_CD.md](CI_CD.md#deploy-workflow); this section is the host side and what to do. Since 2.33.0 the same workflow also has a staging job, which needs no approval; [Staging deploys](#staging-deploys-2330) covers it, and production's path described here doesn't change, apart from the [provenance check](#provenance-check-2330) in the plan.

### A deploy

1. Merge the release as today. Trying it on DevBot stays manual (GitHub can't reach the dev VM).
2. When "Publish containers" finishes, a Deploy run plans the release, and GitHub asks you to review its `production` deployment. A merge that changes only documentation, tests, CI, the version, the settings templates or the Ansible pip pins (`ops/ansible/requirements*.txt`, used only by CI and the operator's venv) asks nothing; a quiet Pushover message says so. The plan first verifies the image's signed provenance, and an image that fails it is never planned ([Provenance check](#provenance-check-2330)).
3. Open the run and read its summary: the targets (production, and staging beside it once staging deploys are on), the version, commit and image digest, the "Provenance verified" line, the migration files, the host-side changes in this merge (files under `ops/`, the production Compose file, `production.env.example` and `staging.env.example`: on this Docker host they run as a docker-group user, which is root-equivalent here; on the staging host as the unprivileged `tarubot` user under rootless Podman; `ops/ansible/` runs as root when the playbook is applied, which a host with the [pull unit](#the-pull-unit-2340) does by itself: staging within minutes of the merge, and production, once it runs the unit after its rebuild, about 10 minutes after the deploy you approve), warnings for the Tuesday maintenance window and the daily backup, and the changelog. The migrations and host-side lists cover this merge only. If production is older than the previous release, the releases in between come too: the summary links the history of the host-side files up to the target for that case. GitHub's compare API lists at most 300 files, so a merge (or a rollback's range) of 300 files or more is refused as `compare-too-large` rather than planned from a list that may be cut short: deploy that release by hand ([Updating to a release](#updating-to-a-release)).
4. **Review deployments** → tick `production` → **Approve and deploy**, or **Reject**. Approval comments are public, like the summary.
5. One Pushover message reports the outcome.

**By hand:** **Run workflow** on `main` with a version, and `target` left at `production`. The live version is re-verified and its commands registered again (`already-live`), which is also the retry after `commands-failed`. A rollback ticks `rollback` and names the live version in `from`; it goes only to an older release (2.32.0 or later, which carry provenance; older ones [by hand](#rolling-back-to-a-release-without-provenance-before-2320)) on the same schema. The same approval follows. The run is titled `Deploy <version>` (or `… rollback from <from>`), and the production host refuses every title that ends in ` to staging`.

Several requests may wait at once. Approve the newest; an older one approved later ends as `superseded` and changes nothing. Reject stale requests, or let them expire after 30 days.

### Provenance check (2.33.0)

Since 2.32.0, `publish.yml` signs each image's build provenance ([CI_CD.md](CI_CD.md#signed-build-provenance)), and since 2.33.0 the plan verifies it before anything else can use the digest: before the "nothing to deploy" exit and before either deploy job. It runs, anonymously except for the job's own token (the package is public, so there is no registry login):

```sh
gh attestation verify "oci://ghcr.io/deconfined/tarubot@<digest>" --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners --format json
```

It must exit 0 with at least one verified attestation. The summary then says `Provenance verified: publish.yml on refs/heads/main, commit <commit>`. Otherwise the plan fails `unattested`, and no environment is touched. The check proves that `main`'s own `publish.yml` built exactly this digest from this commit on a GitHub-hosted runner. Any workflow in the repository can move a GHCR tag, but none but that one can make this signature, so an approval no longer trusts the digest a tag names. The signer is named by the certificate's exact identity (`--cert-identity`), never by `--signer-workflow`: gh turns that flag into a pattern anchored only at its start, so a workflow named, say, `publish.yml-canary.yml` on `main` would pass it too (checked on 2.32.1's image with a truncated name).

- **A temporary failure.** gh also exits 1 on a network or signature-root (TUF) error, so `unattested` may be temporary. Re-runs are refused, so retry with a new dispatch of the same version.
- **Releases before 2.32.0** carry no attestation and are always refused: roll back to them [by hand](#rolling-back-to-a-release-without-provenance-before-2320).
- **By hand.** The same command, without `--format json`, checks any later image from a workstation with a `gh` login (gh asks for a token even for a public repository); it prints nothing on success without a terminal. The first start on a Quadlet host takes a digest checked this way ([The first start](#the-first-start-the-start-tag)).

### What the host does

The deploy key's line in the `tarubot` user's `~/.ssh/authorized_keys` forces every connection to `ops/deploy.sh` (`restrict,command=`): no shell, no file transfer, no forwarding. The script accepts exactly `deploy <version> <commit> <digest> <run>` or `rollback <version> <commit> <digest> <run> <from>` and starts a detached worker for that run, so a dropped connection reconnects to the same run. At most four workers run at once; beyond that a new run is refused `too-many-runs` before it gets a run directory. On this host the forced command has no arguments, which selects the Compose mode described here; since 2.33.0 a Quadlet host's line adds `quadlet` or `quadlet staging` ([Quadlet mode](#the-quadlet-mode-of-opsdeploysh)), and any other words print the usage line and exit 64. The worker:

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

**Refusal reasons:** `not-approved` (includes a re-run, and a run cancelled or a Deploy job ended before the first change), `approval-unverified` (GitHub's API didn't answer; anonymous calls are limited to 60 an hour per address, and a run makes five), `busy` (another deploy over 5 minutes, or a backup running over 5 minutes), `too-many-runs` (four workers already running: look for stray requests in `entry.log`), `clone-not-clean`, `env-file`, `log-level`, `host`, `bot-not-running`, `manual-change-in-progress` (the pin isn't the running release), `live-unknown`, `fetch-failed`, `not-on-main`, `version-mismatch`, `below-floor`, `commit-mismatch`, `not-descendant`, `applied-migration-changed`, `live-changed` (a rollback's `from` isn't live), `rollback-not-older`, `rollback-across-migration`, `pull-failed`, `digest-mismatch` (the tag moved after the plan), `label-mismatch`, `clone-reset`, `compose-config` (the host's `.env` lacks a setting the new Compose file requires), `missing-tool` (`jq` or `curl`), `worker-not-started`, and `unexpected-error` when nothing had changed yet (after a change it is `needs-you`). `not-approved`, `approval-unverified`, `missing-tool` and `worker-not-started` start over on the next request for the same run. A Quadlet host adds `quadlet-config`, `settings-missing`, `hardening-mismatch` and `pin-failed` (the pin failed before anything restarted), and `needs-you` `hardening-mismatch` after a start ([Quadlet mode](#the-quadlet-mode-of-opsdeploysh)).

**Plan refusals** reach no host: the plan job fails with an error that names the check, and for a production run the Pushover message names the reason. `unattested` (the [provenance check](#provenance-check-2330)), `gate` (no requested target's environment passed its gate), `dispatcher` (a staging dispatch by anyone but @deconfined), `below-floor` (a staging-only run whose release doesn't declare Quadlet staging deploys), `target`, `version`, `version-mismatch`, `from`, `image`, `digest-mismatch` (the version and `sha-` tags name different images), `not-on-main`, `compare`, `compare-too-large`, `applied-migration-changed`, `rollback-not-older` and `rollback-across-migration`. `paused` isn't a failure: the requested target's switch is off, so nothing is planned.

**When no result arrives** the workflow reports: `host-key` (the host key changed: check the host before updating `DEPLOY_KNOWN_HOSTS`), `key-rejected`, `known-hosts` or `no-key` (the deploy environment's settings), `unreachable` (every attempt for 80 minutes, 5 on staging, failed before sshd answered, so nothing started), `bad-request` (the host refused the command format), or `outcome-unknown` (the host may have been reached, or the run outlasted the reconnect window). With `outcome-unknown`, the host's run directory is authoritative: the worker carries on alone, and `runs/<run id>/public.log` ends with its result.

### Logs on the host

Everything lives under `~/.local/state/tarubot-deploy/`, which the script creates (mode 700):
- `runs/<run id>/`: `public.log` (the lines GitHub showed), `result`, `step` (the last step reached), `request`, `lock`, and `worker.log`, every tool's output (Git, Compose, `backup.sh`, `migrate.js`, `register.js`, `commands.js`). `worker.log` is private: the command read-back names guilds.
- `entry.log`: each run's start, runs that started over, refused requests (sanitized to one line) and entry errors, kept to its last megabyte.
- `lock`: the host lock that runs one deploy at a time. A Quadlet host holds `/run/tarubot/host.lock` instead ([The host lock](#the-host-lock)).

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

On a Quadlet host the same steps apply with `systemctl --user` in place of Compose, with one difference: a restart moves the pin (`TARUBOT_IMAGE_TAG` and `TARUBOT_IMAGE_DIGEST`) before it restarts, so after `up` `.env` already names the target, and systemd starts whatever `.env` names, at a reboot too. To go back there, put the clone and both pin lines back to the previous release (`git reset --keep <commit>`, the tag and the index digest), then `systemctl --user daemon-reload && systemctl --user restart tarubot.service`. A migration moves the pin only after "Schema ready.", as on Compose.

### Pause, stop and kill

- **Pause:** delete the repository variable `DEPLOY_ENABLED` (Settings → Secrets and variables → Actions → Variables → Repository variables, or `gh variable delete DEPLOY_ENABLED`). Nothing new plans, and a request already waiting ends `refused` `paused` if you approve it. Pushover still reports that, and any other outcome of a run that planned while the switch was on: the plan decides whether a run gets a message when it starts, never when notify runs. Setting it back to `true` (`gh variable set DEPLOY_ENABLED --body true`) resumes. This holds only while the `production` environment has no `DEPLOY_ENABLED` of its own: inside the deploy job such a copy overrides the repository variable, so a waiting request would still go ahead ([setup](#setting-it-up-owner) step 12).
- **Pause staging only:** delete the repository variable `STAGING_DEPLOY_ENABLED` the same way. Production's switch is separate, so this never touches production, and pausing production leaves staging running. With both unset, the plan doesn't run at all.
- **Stop:** `gh workflow disable deploy.yml` (both targets).
- **Kill:** delete the deploy key's line from `authorized_keys`, or the `DEPLOY_SSH_KEY` secret of the environment concerned (`production` or `staging`; each host has its own key).
- **Cancelling a run in GitHub stops a host run only before its first change,** when the host checks the run again (`refused` `not-approved`, nothing changed). After that it finishes on its own, and its result stays in its run directory.
- **Don't approve while you work by hand.** Automated runs refuse while the bot is stopped or the pin differs from the running release, but not every manual step shows.

### Setting it up (owner)

Each step is the owner's, with the owner's go-ahead; Claude prepares the commands only. **Status (2026-09-26):** steps 1 to 13 are done. Steps 1, 4, 5 (the line names `/opt/tarubot/tarubot/ops/deploy.sh`, and `authorized_keys` is mode 600) and 7 to 11 came before the 2.30.0 merge; after it, the hand deploy (step 2), the prerequisites (step 3), the key probe (step 6), `DEPLOY_ENABLED` (step 12, on the second try) and the first run (step 13). Step 14 followed with 2.30.1 (run 36253924529, `deployed`), and 2.30.2, 2.30.3 and 2.32.0 went the same way; no migration release has gone through the workflow yet. These steps are production's; staging's environment, key and switch are in [Owner steps before the move](#owner-steps-before-the-move). Since step 11 the dev VM's `gh` token is read-only, so the `gh secret set` and `gh variable set` commands below need a token with write access; the same settings can be made in the web UI (Settings → Environments → the environment, or Settings → Secrets and variables → Actions → Variables → Repository variables for `DEPLOY_ENABLED`).

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

   `DEPLOY_KNOWN_HOSTS` is exactly one line: the `DEPLOY_HOST` name, `ssh-ed25519` and the key, with no comment. The workflow never trusts DNS for the key. Both are variables, so every deploy run's public log shows them (GitHub masks only secrets); the name isn't secret ([CI_CD.md](CI_CD.md#deploy-workflow)). The agent's read-only token can't read back the values set on 2026-09-26: if the first run stops with `known-hosts`, look for a trailing comment.
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

`ops/backup.sh` runs at 04:30 UTC from the `tarubot` user's crontab on this host (a Quadlet host runs `ops/backup.sh quadlet` from a systemd user timer instead: [below](#backups-on-a-quadlet-host-2330)):
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

**Restoring a dump.** Restore into a new database, never over the live one. Use a new cluster, or `tarubot_restore` on the same cluster. Lock `tarubot_restore` down before anything is restored into it: a new database lets PUBLIC connect, and the staging role shares the cluster (#50). As the admin role, in `defaultdb`:

```sql
CREATE DATABASE tarubot_restore OWNER tarubot TEMPLATE template0;
-- As its owning role (SET ROLE tarubot if the admin can, or connect as tarubot):
REVOKE CONNECT, TEMPORARY ON DATABASE tarubot_restore FROM PUBLIC;
GRANT CONNECT ON DATABASE tarubot_restore TO akmadmin;
```

The owner, `tarubot`, keeps its own `CONNECT`. Confirm with `has_database_privilege` that PUBLIC and `tarubot_staging` can't connect.

Then fetch, decrypt and restore:

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

**Before a manual migration** keep taking an independent `pg_dump` on the operator machine, as in the migration procedure above. Running `~/tarubot/ops/backup.sh` on the host right before also puts a fresh copy off-site. An automated deploy runs `ops/backup.sh` on the host after it stops the bot and names the object (`daily/tarubot-<UTC time>.dump.age`) in its result; that extra run also resets the "TaruBot backups" check's daily timer, which the 04:30 run then keeps as usual. The 2026-09-24 cutover left `pre-activation.dump` and `move-to-linode.dump` in `~/tarubot-cutover/work/backups/`; @deconfined had them and the other plaintext pre-deploy dumps there deleted on 2026-09-27, since the encrypted daily copies supersede them.

**Restore checks:** `check-restore.js` compares a restored copy with the source. The production profile accepts `tarubot` on another host, such as a new cluster, or `tarubot_restore` on the same host.

### Backups on a Quadlet host (2.33.0)

On a Quadlet host (staging now, production after its rebuild) the same script runs as `ops/backup.sh quadlet`, from a systemd user timer that belongs to the release, never from a crontab and never as a Quadlet unit: Quadlet runs its containers detached with their output in a log, which would keep the plaintext dump (question 11 of the staging amendments).

- **The units.** `ops/systemd/tarubot-backup.timer` starts `ops/systemd/tarubot-backup.service` at 04:30 UTC every day (`Persistent=true`, so a run missed while the host was down starts when it's back). The service is a one-shot that runs `%h/tarubot/ops/backup.sh quadlet` with a 15-minute limit, after Podman's network-online wait, and sets no environment. The playbook links both into `~/.config/systemd/user` from the clone, so a deploy's `daemon-reload` picks up a release's change to them, and enables the timer once the bot's unit is linked ([The first start](#the-first-start-the-start-tag)).
- **The dump.** `ops/quadlet/secrets.sh sync` copies only `DATABASE_URL` and `DATABASE_CA_CERT` from `.env` into their Podman secrets, so a blank Discord token never stops a backup. A one-off `podman run` of `docker.io/library/postgres:18.4-alpine`, Compose's backup image fully qualified and pinned by its image index digest (the container reads the database secrets and can reach the network, so a moved tag must not reach it; a new image is a release's change to `ops/backup.sh`), then runs `pg_dump` as hardened as Compose's service: a read-only root with no tmpfs, no capabilities, `no-new-privileges`, no environment from the host, stdin closed, and the two secrets mounted read-only as files, with `PGSSLMODE=verify-full` against the mounted CA. It writes no file, so it needs no `/tmp`. Its output streams straight into `age`, as on Compose.
- **No log of the dump.** The container runs with `--log-driver=none`: Podman keeps nothing, while an attached run still streams stdout. 2.33.0's check on Podman 5.8.2 found the stream byte-exact and a failing `pg_dump`'s exit status returned by `podman run` ([VERIFICATION.md](VERIFICATION.md)).
- **Labels.** The dump container is `tarubot-backup-<stamp>`, labelled `io.tarubot.role=backup`. A deploy waits up to 5 minutes while that container runs or `tarubot-backup.service` is active, as it waits for Compose's `backup` container.
- **The rest is unchanged:** the size guard, the encrypted `.env` copy to `env/`, the uploads to `daily/` and `monthly/`, the healthchecks.io pings and the last line, `<time> backup ok: tarubot-<stamp> (<n> bytes, settings <m> bytes)`, which a deploy's migration path reads.
- **Settings.** The same five names in the host's `.env`. Staging's name its own bucket, key and backup check, never production's (question 3). The bot's unit unsets all five, so the bot never sees them.
- **By hand:** `systemctl --user start tarubot-backup.service` (as `tarubot`, which waits until the run ends). **Logs:** `journalctl --user -u tarubot-backup`; there is no `~/tarubot-backup.log` on a Quadlet host. **Next run:** `systemctl --user list-timers tarubot-backup.timer`.
- **Not locked.** The backup doesn't take the host lock. A nightly dump that starts after a deploy's 5-minute wait can overlap a migration, as on Compose. Making the timer's service wait on the lock is a later option ([OPEN_ITEMS.md](OPEN_ITEMS.md)).

`pg_dump` still takes the connection string as its argument inside the container while it runs, on both runtimes, as before.

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

## Staging host (#50)

The staging host is a second Linode. It will run DevBot the way production will run after its rebuild: AlmaLinux 10 with SELinux enforcing, the bot as a rootless Quadlet unit under `tarubot`'s systemd, no Docker, and its own database and role on the same managed cluster. @deconfined's decisions are in REQUIREMENTS.md "Approved staging amendments (2026-09-26)". The host is online on AlmaLinux 10.2, reached as `root@<staging host>` with a staging-only Ansible key from the operator machine (and @deconfined's FIDO2 break-glass key since 2026-09-27), and the playbook configured it on 2026-09-26 ([VERIFICATION.md](VERIFICATION.md)). Its owner steps before the DevBot move are done ([below](#owner-steps-before-the-move)).

**No bot runs there yet.** The staging host holds no DevBot token: its `.env`, written on 2026-09-27, keeps `DISCORD_TOKEN` at its placeholder. 2.33.0 brings everything a bot there needs (the deploy path, the staging target, Podman secrets, the backup timer and the first start), but nobody starts it before the DevBot move: the move comes after 2.34.0's pull unit and the rebuild from cloud-init and OpenTofu, with a new token, and until then DevBot stays on the development machine ([DEV_GUILD.md](DEV_GUILD.md)). One Discord application must never run in two places.

### What 2.32.0 delivers (#50 part 1)

| Piece | What it is |
| --- | --- |
| `ops/ansible/` | The host playbook (`site.yml`), its `ansible.cfg`, the files and templates it installs, examples of the inventory and host settings, and the pinned requirements ([CONFIGURATION.md](CONFIGURATION.md#host-playbook-and-quadlet-unit)). It prepares the host and never starts the bot. |
| `ops/quadlet/` | The release's unit, its production and staging targets, and `check-env.sh` ([README](../ops/quadlet/README.md)). No host links it yet. |
| The staging tool profile | `TARUBOT_ENVIRONMENT=staging`: DevBot's application, the test guild and `tarubot_staging` ([CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles)). `staging.env.example` is the template for the host's `.env` ([CONFIGURATION.md](CONFIGURATION.md#runtime-configuration)). |
| Signed build provenance | `publish.yml` signs each image `main` publishes ([CI_CD.md](CI_CD.md#signed-build-provenance)). The deploy plan verifies the signature from 2.33.0. |
| CI | The **Host playbook** job: a syntax check with the example inventory and host settings, ansible-lint (pinned and offline), and ShellCheck on the playbook's scripts. `CI result` requires it. The Checks job also runs Podman 5.8.2's own generator over the unit for both targets and compares the result in `tests/unit/quadlet.test.ts`, and `tests/unit/playbook.test.ts` pins the playbook's rules (below). |

### What 2.33.0 delivers (#50 part 2a)

#50's second part was split: 2.33.0 is the runtime half, and the pull unit followed in 2.34.0 ([below](#what-2340-delivers-50-part-2b)). Production's Compose path, its forced command and `ops/backup.sh` without an argument don't change.

| Piece | What it is |
| --- | --- |
| `ops/deploy.sh` Quadlet modes | `deploy.sh quadlet` (production after its rebuild) and `deploy.sh quadlet staging` (staging now), chosen by the deploy key's forced command. They deploy the release's Quadlet unit with `systemctl --user` and Podman, under their own contract level ([Quadlet mode](#the-quadlet-mode-of-opsdeploysh)). |
| The staging deploy target | The Deploy workflow's **Deploy staging** job, in a `staging` environment with no reviewers, behind its own switch `STAGING_DEPLOY_ENABLED`; a staging dispatch must come from @deconfined ([Staging deploys](#staging-deploys-2330)). |
| The provenance check | The plan verifies each image's signed build provenance before anything else, for both targets ([Provenance check](#provenance-check-2330)). |
| Podman secrets | `.env` stays the only place the secrets are kept. `ops/quadlet/secrets.sh` copies the six secrets into Podman secrets before every start, the unit mounts them read-only as files, and the bot and its tools read `NAME_FILE` ([CONFIGURATION.md](CONFIGURATION.md#secrets-from-files); [Quadlet README](../ops/quadlet/README.md#secrets)). The unit's `[Service]` unsets them, so they never reach Podman, conmon or pasta. |
| One-off tools | `ops/quadlet/run-tool.sh` runs a maintenance tool, such as a deploy's `migrate.js`, in a one-off container with the target's own settings, secrets and hardening ([Quadlet README](../ops/quadlet/README.md#run-toolsh)). |
| The backup | `ops/backup.sh quadlet`, run by the release's systemd user timer `ops/systemd/tarubot-backup.timer` ([Backups on a Quadlet host](#backups-on-a-quadlet-host-2330)). |
| The host lock | `/run/tarubot/host.lock`, root-owned, from a tmpfiles line the playbook installs; deploys and the playbook's user-manager commands hold it, and since 2.34.0 the pull unit does ([The host lock](#the-host-lock)). |
| The `start` tag | The playbook's first start of the bot on a host, from a release and digest verified on the workstation ([The first start](#the-first-start-the-start-tag)). It exists and is tested, but nobody runs it in this release. |

### What 2.34.0 delivers (#50 part 2b)

The pull unit, and what the playbook needs for it. `ops/deploy.sh`, the Deploy workflow and production's Compose path don't change, and no bot code changes.

| Piece | What it is |
| --- | --- |
| The pull unit | `ops/ansible/files/host-config/`: the root-owned script `tarubot-host-config`, its oneshot service and timer, and production's 10-minute drop-in. The playbook installs them; the timer runs only once `bootstrap` has run on the host ([The pull unit](#the-pull-unit-2340)). |
| Allowed signers | `tarubot_allowed_signers` in the host settings, for the signature rule on merged heads that change `ops/ansible/` (question 14). The pull unit reads the list from `host.yml` itself at every run; `templates/allowed_signers.j2` also renders it to `/etc/tarubot/allowed_signers` for people, and the playbook checks that its reading and the unit's agree. |
| ansible-core on the hosts | From AlmaLinux's AppStream, at least `1:2.16.16-2.el10_2.1`, the build with the CVE-2026-11332 backport. The playbook compares the installed build with that floor by RPM's own ordering and installs only when it is missing or older. Production's automatic updates skip it (since 2.33.0), so it moves there only when a commit raises the floor (question 18). |
| Quiet no-op runs | The three dnf tasks run only when `package_facts` shows a package missing or too old, so a run with nothing to do never loads repository metadata (ansible-core 2.16's dnf module loads it on every call). |
| The run marker | Every real run writes `/var/lib/tarubot-config/last-run.json`: who ran the playbook (`manual`, `pull`, `bootstrap` or `emergency`), the commit and the run id. The pull unit compares it with its own record to notice a hand run, or one of its own runs that died. |
| The hand-run guard | On a host with pull state (`/var/lib/tarubot-config/state.json`), a real hand run, the start tag's included, is refused unless the pull unit is paused. Check mode is allowed. |
| Other playbook changes | `force_handlers: true` on the root play, so a later failure doesn't skip the reloads of what already changed; the pull unit's run variables checked before anything changes, including that the role and the signers the script read equal the playbook's own reading; the host settings files checked as root-only. |
| CI | ShellCheck on the script in the **Host playbook** job, and `tests/unit/host-config.test.ts` in the Checks job ([CI_CD.md](CI_CD.md)). |

### What the playbook does

It runs as root on AlmaLinux 10 (x86_64) with SELinux enforcing, and stops on anything else, including `selinux=0` or `enforcing=0` on the kernel command line. Never lower SELinux to make it pass. It also stops on missing or malformed host settings. Then:

- **Base system.** It sets the hostname and UTC, and tells cloud-init to keep the hostname (`preserve_hostname`), since cloud-init would otherwise reset it at every boot.
  - It installs Podman, crun, passt, container-selinux, acl, chrony, dnf-automatic, git, gnupg2, jq and sudo from AlmaLinux's repositories.
  - Since 2.34.0 it also installs ansible-core from AppStream, which the pull unit runs, at least the build with the CVE-2026-11332 backport (`tb_ansible_core_floor`, compared by RPM's own ordering).
  - `age` comes from EPEL, limited to that one package. EPEL's key ships with the playbook and is trusted only at its pinned fingerprint.
  - Each install runs only when `package_facts` shows something missing (or ansible-core below its floor), so a run with nothing to install never loads repository metadata.
  - It refuses Docker and the Docker shims (`podman-docker`, `podman-compose`) before it installs anything, so a host that has them is left as it was. After installing, it refuses a Podman older than 5.8.2, the version the unit was checked with.
- **Updates.** dnf-automatic applies security updates daily, at 06:00 UTC plus up to an hour. Staging reboots itself when an update needs it (`shutdown -r +5`). Production never does, and its automatic updates skip the container stack and ansible-core.
- **Kernel and services.**
  - `kernel.yama.ptrace_scope=1`, and `dev.tty.legacy_tiocsti=0`, so only root can push input into a terminal.
  - No temporary IPv6 addresses, so outbound IPv6 comes from the stable address on the database's access list.
  - It masks rpcbind, which listens on port 111 on Linode's image.
  - It masks the units that would generate RSA and ECDSA host keys.
  - It masks Podman's API socket, API service and auto-update for the system, and by default for every user. The user masks in `/etc/systemd/user` are a default, not a barrier: `tarubot`'s own `~/.config/systemd/user` comes first, and `tarubot` can run Podman directly anyway. Each run checks that `tarubot`'s user manager still loads all four as masked.
- **Journal and boot.**
  - The journal is persistent, capped at 1 GB, with one file per user. The bot logs to it, and deploys will read it.
  - Every boot reaches `network-online.target`. `tarubot-ipv6-online.service` holds that target until the host has a global IPv6 address and a default route, so the bot's first start sees IPv6. It waits at most 60 seconds and never fails.
  - logind's `KillUserProcesses` must stay off (EL's default).
- **The host lock (2.33.0).** It installs `files/tmpfiles-tarubot.conf` as `/etc/tmpfiles.d/tarubot.conf` and runs `systemd-tmpfiles --create` on it, then checks that `/run/tarubot` is root's directory (0755) and `host.lock` root's plain file (0644), neither a link ([The host lock](#the-host-lock)). A check run before the first real one skips those checks, since nothing is there yet.
- **The pull unit (2.34.0).** Before anything changes, it checks the run variables the pull unit passes (a hand run passes none), and refuses a real hand run on a host with pull state unless the unit is paused. Right after the lock checks it creates `/var/lib/tarubot-config` and its `home/` (root, 0700) and writes the run marker: never in check mode, and never counted as a change, so a second real run still reports `changed=0`. Among the run variables it checks that the role and the signers the pull unit read from `host.yml` equal its own reading. Later it installs the script (after `bash -n` accepts it), the service and the timer, production's drop-in (removed on other hosts), and `/etc/tarubot/allowed_signers` from the host settings (for people: the pull unit reads `host.yml` itself), and checks that `/etc/tarubot/host.yml` and `/etc/tarubot/host-config.env`, when present, are root's regular files at mode 600. Once `state.json` exists it keeps the timer enabled and started. It never starts, stops, restarts, disables or masks the pull unit's service or timer, and never writes the unit's clone, state or flags ([The pull unit](#the-pull-unit-2340)).
- **The `tarubot` account.**
  - No groups, no sudo (each run checks `sudo -l -U tarubot`) and a locked password.
  - Umask 0022, through the `umask=` field in its GECOS.
  - Shell files that return at once for non-interactive shells, such as the deploy key's forced command.
  - A UID of 1000 or higher, and one 65,536-ID subordinate UID and GID range each.
  - Lingering, so its systemd runs without a login.
- **SSH.** The drop-in `00-tarubot.conf` replaces `10-tarubot.conf`, the one applied by hand. It sets keys only, no GSSAPI, root by key only, no forwarding of any kind (`DisableForwarding`), no `~/.ssh/rc` (`PermitUserRC no`), and one Ed25519 host key.
  - `tarubot`'s keys live in the root-owned `/etc/ssh/authorized_keys/tarubot`, written from the host settings: the deploy key's restricted line, then the operator keys. `tarubot` can't grant itself access through `~/.ssh`.
  - Root's break-glass keys go in a managed block in `/root/.ssh/authorized_keys`, and a FIDO key gets `verify-required`. Keys outside the block stay.
  - sshd reloads only after `sshd -t` accepts the whole configuration. The run then checks the effective settings for root and `tarubot` with `sshd -T`, including `UsePAM yes`.
- **No root password** (question 20). After the `sshd -T` check, the run locks root's password. Key logins still work, because sshd leaves a locked account to PAM, and PAM doesn't refuse one. Linode's Reset Root Password with the Lish console is the break-glass, and `su -` has no password left to guess.
- **As `tarubot`, in the last play:**
  - It clones the repository into `~/tarubot` once, under umask 077. Deploys move the clone after that.
  - It refuses a user `containers.conf`, runtime Quadlet units, a Podman API socket, an event logger other than journald, a Podman unit that `tarubot`'s user manager doesn't load as masked, and anything in `~/.config/containers/systemd` except the release's two links. Only the start tag makes those links; no host has them yet.
  - It links the backup's two user units into `~/.config/systemd/user` from the clone's `ops/systemd/`, when the clone has them (2.33.0 and later; staging's clone, still at 2.30.4, has none until its first start). Once the bot's unit and both backup units are linked, it enables `tarubot-backup.timer` if it isn't enabled; it never disables it.
  - Its user-manager commands (`daemon-reload`, `enable`, `start`) run under the host lock, waiting up to 5 minutes for a deploy.
  - It runs Quadlet's generator as a dry run, twice. Over the real search path, it must find no unit before the links exist. Over the clone's unit and this host's target, it must produce exactly `tarubot.service`. A clone from before 2.32.0 has no `ops/quadlet/`, and the second run is skipped.
  - If `~/tarubot/.env` is there, it must be a regular file of `tarubot`'s at mode 600, and pass `check-env.sh --syntax`. It needs exactly one `TARUBOT_IMAGE_TAG`, no `TARUBOT_IMAGE_DIGEST` before the links, no `TARUBOT_IMAGE`, and on staging no `GITHUB_APP_*` value. Since 2.33.0, when the clone has `ops/quadlet/secrets.sh`, it also runs `secrets.sh check`, which requires `DATABASE_URL`, `DATABASE_CA_CERT` and `DISCORD_TOKEN`. The checks print names and counts, never values.

Outside the start tag it never links, starts, stops or restarts the bot; its handlers only reload systemd, sshd, journald's configuration and sysctl. The start tag (2.33.0) is the one exception, run once per host ([The first start](#the-first-start-the-start-tag)). The deploy key's forced command is `ops/deploy.sh quadlet staging` on staging and `ops/deploy.sh quadlet` on production. `ops/deploy.sh` up to 2.32.x exits 64 on any argument, so the line fails closed until the first start moves the clone to 2.33.0 or later; staging's clone is still at 2.30.4.

**Code running as `tarubot` never steers root.** `tests/unit/playbook.test.ts` pins the checkable parts.
- The first play runs as root and writes only system paths. It looks at `tarubot`'s home without following links, so a planted link stops the run.
- The second and last play runs every task as `tarubot`, so no root task reads what a `tarubot` task returned. That rule is the boundary. Code running as `tarubot` can change what a `tarubot` task does, and even with pipelining a module run as `tarubot` unpacks itself into a directory `tarubot` owns. `PYTHONNOUSERSITE=1`, `ptrace_scope=1` and `legacy_tiocsti=0` are defence in depth.
- Facts are gathered once and stay under `ansible_facts`, and settings arrive only as extra vars. `ops/ansible/` has no `group_vars`, `host_vars`, roles, `library` or plugin directories, which Ansible would load from beside the playbook.
- `ansible.cfg` loads nothing but `ansible.builtin`, and the playbook uses no lookups or delegation and reads nothing from outside `ops/ansible/`. It assumes nothing about the machine that runs it, so a host can apply it to itself (`-c local`), as the pull unit does since 2.34.0, but only from a checkout `tarubot` can't write (below).

### Running it from the operator machine

Once, create a virtual environment with the hosts' ansible-core:

```sh
python3.12 -m venv ~/tarubot-ansible
~/tarubot-ansible/bin/pip install --require-hashes --no-deps -r ops/ansible/requirements.txt
```

The repository names no host, so the inventory and the host settings live outside it (mode 600). Never copy them into a checkout.
- **The inventory**, from `ops/ansible/inventory.example.yml`, says how to reach the host: its address, `root`, the staging-only key, `IdentitiesOnly=yes` and `StrictHostKeyChecking=yes`.
- **The host settings**, from `ops/ansible/host.example.yml`: `tarubot_role: staging`, the hostname, and the public key lines.
- **The host key** must already be in `known_hosts`, confirmed through the console or the host's SSHFP records.

From a checkout of the release (or, while building, the branch), check first, then apply:

```sh
cd ops/ansible
export ANSIBLE_CONFIG="$PWD/ansible.cfg" LC_ALL=C.UTF-8
inventory=/path/outside/any/checkout/inventory.yml
settings=/path/outside/any/checkout/host.yml
~/tarubot-ansible/bin/ansible-playbook -i "$inventory" -e "@$settings" site.yml --syntax-check
~/tarubot-ansible/bin/ansible-playbook -i "$inventory" -e "@$settings" site.yml --check --diff --skip-tags start
~/tarubot-ansible/bin/ansible-playbook -i "$inventory" -e "@$settings" site.yml --skip-tags start
```

- **Check mode first, every time.** `--check --diff` changes nothing. Before the first real run it lists every change a fresh host needs, and its second play stops early, because `tarubot` doesn't exist yet. A few checks run only for real: sshd's effective settings and the ptrace and terminal-injection settings.
- **Then apply.** A second real run must report `changed=0`. Anything else is drift to explain.
- **`--skip-tags start`** keeps the start tag out, even by mistake. Its tasks also need the start variables, so a run without them skips them anyway, but the flag stays in every normal command. That tag links the release's unit, which from then on starts at every boot, and starts it for the first time, so it runs only at the DevBot move on staging and at the rebuild on production ([The first start](#the-first-start-the-start-tag)).
- **Configuration and locale.** Ansible reads `ansible.cfg` from the working directory only when that directory isn't world-writable, so the example sets `ANSIBLE_CONFIG`. ansible-core 2.16 refuses to start under `LC_ALL=C`.
- **On a host with the pull unit** (2.34.0), pause it first: `tarubot-host-config pause "<reason>"` as root on the host, wait for it to return 0, run the playbook, then `tarubot-host-config resume`. The playbook refuses a real run there otherwise ("Refuse a hand run while the pull unit is active"); check mode needs no pause. Use the same settings as the host's `/etc/tarubot/host.yml`, or the next poll after `resume` undoes the difference ([Operating it](#operating-it)).
- **For Claude sessions:**
  - Ansible refuses non-blocking standard streams in Claude Code's shell, so run every ansible command as `<command> < /dev/null 2>&1 | cat`.
  - Claude may run check mode against staging freely, and apply to staging under @deconfined's standing go-ahead for the build phase (question 5 of the amendments).
  - Starting the bot (the start tag), stopping DevBot, reboots and the move each need @deconfined's go-ahead. The start tag never runs on staging before the DevBot move.
  - A real apply that the session's permission check refuses isn't retried in any form; it goes to @deconfined (2.33.0's apply of the host lock was one: it went ahead only after @deconfined's go-ahead in chat, [VERIFICATION.md](VERIFICATION.md)).
  - The pull unit (2.34.0): a session may run `tarubot-host-config status` on staging and read its journal. Installing it on staging (the owner steps under [Installing it](#installing-it-owner)), `bootstrap`, `pause`, `resume`, `apply-now` and the emergency apply each need @deconfined's go-ahead, and nothing touches it on production.
  - Production runs are @deconfined's alone, and the production inventory and root key stay off the operator machine.

**Applying it on the host itself** (`-c local`) is how the pull unit runs it since 2.34.0. The script takes the host lock first and holds it around the whole run, then runs, under a clean environment with its own `HOME` and umask 022 (`playbook()` in the script):

```sh
ansible-playbook -c local -i localhost, site.yml -e @/etc/tarubot/host.yml \
  -e tarubot_host_lock_held=true -e tarubot_source=pull -e tarubot_commit=<commit> \
  -e tarubot_run=<run id> -e tarubot_pull_role=<role> -e tarubot_pull_signers=<digest> \
  --skip-tags start --diff
```

Run that only from a root-owned checkout that `tarubot` can't write, such as the pull unit's own clone in `/var/lib/tarubot-config/repo`. Never run it from `~tarubot/tarubot`, or from anything else under `/home`. Ansible runs the playbook, reads `ansible.cfg` from its directory, and loads the files beside it, so running from a checkout `tarubot` can write hands root to `tarubot`. The playbook can't check this itself, because a changed copy would leave the check out. In practice the pull unit is the only local runner; people apply from the operator machine as above, without the lock flag, and with the unit paused where it is installed.

### After the first apply

- **SSH as `tarubot`** works only with keys the host settings list: the deploy key and `tarubot_operator_keys`. With none listed, add your operator key there and apply again before restoring `.env`.
- **The clone has mode 700,** so git run as root refuses it ("dubious ownership"). Run git as `tarubot`, and never set `safe.directory` for root: root would then read the clone's `.git/config`, whose hooks, pager and fsmonitor `tarubot` controls.
- **Acting as `tarubot`.** Use `ssh tarubot@<staging host>` with an operator key, `run0 --user=tarubot` as root on the host, or `sudo -u tarubot -i` (EL10's sudo runs commands in their own pseudo-terminal). Each gives `tarubot` a terminal of its own. Never use plain `su` or `runuser` from a root terminal: they hand `tarubot`'s code root's terminal. `legacy_tiocsti=0` stops that code from typing into it, but a process left behind could still read what root types next.
- **sshd offers only the Ed25519 host key.** The RSA and ECDSA key files stay on disk, unused. Their SSHFP records and `known_hosts` lines no longer match anything sshd offers, so remove them (an owner step at the DNS provider).
- **Staging may reboot itself** after a daily security update that needs it.
- **The unit a start would run:** see "What Podman generates" in the [Quadlet README](../ops/quadlet/README.md#what-podman-generates). As `tarubot`, set `XDG_RUNTIME_DIR=/run/user/$(id -u)` first.

### The host lock

On a Quadlet host one lock keeps deploys, the playbook's user-manager commands and, since 2.34.0, the pull unit from overlapping: `/run/tarubot/host.lock`.

- **Root's file.** The playbook's tmpfiles line creates `/run/tarubot` (root, 0755) and `host.lock` (root, 0644) at every boot and on every apply. The pull unit runs as root, and root must never open a file `tarubot` could replace, so the lock isn't under `tarubot`'s home. Everyone opens it read-only: `flock` needs no write access.
- **`ops/deploy.sh`** refuses `host` unless the lock is a plain file owned by root, not a link, then waits up to 5 minutes for it (`busy`). It closes the lock on the calls that can leave a process behind (`backup.sh quadlet` and `run-tool.sh`, whose containers leave a conmon), so a stray process never holds it.
- **The playbook** runs each `systemctl --user daemon-reload`, `enable` and `start` of the `tarubot` play under `flock -w 300`, so a deploy never sees a reload half way. Link and file tasks aren't locked.
- **The held-lock protocol.** A `flock` lock belongs to one open file, so a task that opened the file again would wait on its own caller. A caller that already holds the lock, as the pull unit does, passes `-e tarubot_host_lock_held=true`, and the play's commands then don't lock again. The first play then checks with `flock --nonblock --conflict-exit-code 75` that something really holds the lock, so the flag can never skip a lock nobody holds, and the start tag refuses the flag. Manual runs never pass it.
- **The pull unit** (2.34.0) takes it without waiting, only for a full run, and never waits for a deploy; a deploy waits up to 5 minutes for a pull run ([The host lock and deploys](#the-host-lock-and-deploys)).
- **Compose** (production today) keeps its own lock in `~/.local/state/tarubot-deploy/lock`.

The lock's path, owner and protocol are part of `ops/deploy.sh`'s `quadlet` contract ([below](#the-quadlet-mode-of-opsdeploysh)).

### The first start (the `start` tag)

The `start` tag links the release's unit on a host and starts the bot for the first time. It exists and is tested (`tests/unit/playbook.test.ts`, and a rehearsal on a throwaway systemd host; [VERIFICATION.md](VERIFICATION.md)), but **nobody runs it in 2.33.0**. On staging it runs at the DevBot move and never before it; on production, at its rebuild. It needs @deconfined's go-ahead, and on production it is @deconfined's own run.

1. **Verify the release on the workstation** (question 26; for staging, an agent may do this) with the plan's own check:

   ```sh
   gh attestation verify oci://ghcr.io/deconfined/tarubot@<digest> --repo deconfined/tarubot \
     --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
     --source-ref refs/heads/main --source-digest <commit> \
     --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
   ```

   The host can't run this itself: it holds no GitHub token, and the playbook uses no lookups or delegation.
2. **Run the whole playbook** with the start variables, without `--skip-tags start` and without `tarubot_host_lock_held`. Check mode first; a check run stops after the start's own checks:

   ```sh
   ~/tarubot-ansible/bin/ansible-playbook -i "$inventory" -e "@$settings" site.yml \
     -e tarubot_start_version=X.Y.Z -e tarubot_start_digest=sha256:<digest> --check --diff
   ~/tarubot-ansible/bin/ansible-playbook -i "$inventory" -e "@$settings" site.yml \
     -e tarubot_start_version=X.Y.Z -e tarubot_start_digest=sha256:<digest>
   ```

   Never keep the start variables in the host settings file: every run reads it, the pull unit's included. On a host with the pull unit, pause it before the start and resume it afterwards: the start is a hand run, and the playbook refuses it otherwise.

After the whole host layer, the lock included, the start runs as `tarubot`:

1. It refuses unless this is the whole playbook without the lock flag, no unit is linked, no `tarubot` container exists, `.env` exists with one `TARUBOT_IMAGE_TAG` line and no `TARUBOT_IMAGE_DIGEST`, the host lock is free, and the clone is on `main` with no tracked change. So it runs once per host, and later releases arrive through deploys.
2. It fetches `main` and pulls the image by the verified digest.
3. The image's RepoDigests must include `ghcr.io/deconfined/tarubot@<digest>`, its version label must be the requested version, and its revision label must name a commit.
4. That commit must be on `main`, its `package.json` must say the version, and its `ops/deploy.sh` must declare `quadlet`, and on staging `staging`, on its `CAPABILITIES` line.
5. It resets the clone to the commit (`git reset --keep`, under `umask 077`).
6. It runs that commit's `check-env.sh --syntax` and `secrets.sh check` on `.env`.
7. It pins the release in `.env`: `TARUBOT_IMAGE_TAG` replaced and `TARUBOT_IMAGE_DIGEST` added (mode 600; neither logged nor shown in a diff).
8. It checks the settings the unit will see, through `systemd-run` with the unit's `EnvironmentFile=` and 14-name `UnsetEnvironment=`, as a deploy does.
9. It links the unit's two Quadlet links and both backup units from the commit, and refuses a commit without the backup units.
10. Quadlet's generator must then produce exactly `tarubot.service`, running the pinned digest.
11. It reloads the user manager and starts `tarubot.service`, both under the host lock.
12. It waits up to 3 minutes for the bot to turn healthy, or to log "Waiting for the database writer lease" (`src/application/lifecycle.ts`): a new production host's bot waits there while the old host still runs, in the rebuild by overlap.
13. It enables `tarubot-backup.timer`.

It never touches Discord. The first staging dispatch of the same version, which ends `already-live`, registers the commands in the test guild. Production's global registration survives its rebuild.

**The database must already be at the start release's schema.** The start never migrates. The bot's startup check refuses a database whose newest applied migration isn't the release's own `SCHEMA_VERSION`, and systemd then restarts it until the wait in step 12 gives up. So start the release whose schema the restored dump already has. At the DevBot move that means: update DevBot to the release you will start first (its update procedure migrates `tarubot_dev`, [DEV_GUILD.md](DEV_GUILD.md)), then dump it, and start that same version. A dump one or more migrations behind can still be migrated after a failed start (below). A dump from a newer release can't be started by an older one at all.

**If the first start fails.** The run stops at the step that failed, usually the wait in step 12. Whatever it had done by then stays: the clone at the commit, the digest pin, and from step 9 on the links. The backup timer isn't enabled yet, and running the start again is refused, because `.env` has a digest (and the unit may be linked). As `tarubot` (`XDG_RUNTIME_DIR=/run/user/$(id -u)` set), read `journalctl --user -u tarubot.service` first. Deploys don't reach the host before its first start has succeeded (staging's switch goes on only then), so nothing else takes the host lock now, and these commands don't take it either. On production, use `production` where these say `staging`.

- **The schema is behind** (the journal says "Schema version/checksum mismatch" or "Run db:migrate", and the dump came from an older release; the same mismatch from a newer one can't be fixed this way): stop the bot, migrate in the release's own image with the host's settings and secrets, and start it again. `migrate.js` must print "Schema ready.":

  ```sh
  systemctl --user stop tarubot.service
  ~/tarubot/ops/quadlet/run-tool.sh staging sha256:<digest> tarubot-migrate bun dist/scripts/migrate.js
  systemctl --user start tarubot.service
  systemctl --user enable --now tarubot-backup.timer
  ```

- **Anything else:** fix the cause, usually a setting in `.env`, then `systemctl --user restart tarubot.service`, and `systemctl --user enable --now tarubot-backup.timer` once the bot is healthy. The next playbook run would also enable the timer, since the unit is linked.
- **To undo the start completely,** so that it can run again from the beginning:

  ```sh
  systemctl --user stop tarubot.service
  systemctl --user disable --now tarubot-backup.timer
  rm -f ~/.config/containers/systemd/tarubot ~/.config/containers/systemd/tarubot-target
  rm -f ~/.config/systemd/user/tarubot-backup.service ~/.config/systemd/user/tarubot-backup.timer
  sed -i '/^TARUBOT_IMAGE_DIGEST=/d' ~/tarubot/.env
  systemctl --user daemon-reload
  podman ps -a
  ```

  `podman ps -a` must list no `tarubot` container (the unit's stop removes it). `.env` keeps its mode 600 and its `TARUBOT_IMAGE_TAG` line. The clone stays at the commit, on `main`: the next start fetches and resets it again. If `disable` reports the timer's unit missing, the start failed before it linked the backup units, and there is nothing to disable.

### Staging deploys (2.33.0)

The Deploy workflow deploys staging beside production, from the same plan, with no approval ("If it breaks, who cares?", @deconfined's answer on #50). [CI_CD.md](CI_CD.md#deploy-workflow) has the workflow's side.

- **Which releases.** An automatic run after a publish of `main` asks for both targets, so staging takes exactly the merges production is asked about, at once, beside production's approval request. A dispatch asks for the one its `target` input names. A staging dispatch is titled `Deploy <version> to staging`, or `Deploy <version> rollback from <from> to staging`.
- **The switch.** The repository variable `STAGING_DEPLOY_ENABLED`, exactly `true`, turns staging on; production's `DEPLOY_ENABLED` is separate. Like production's, it belongs at repository level only, never in the `staging` environment, whose copy would override it inside the job. While it's off, staging is left out of every run, and a staging dispatch ends `paused`.
- **The environment.** `staging` has no required reviewers and accepts only `main`, through one branch rule. The plan checks both, and turns staging off in a run whose gate fails. The environment holds staging's own `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`, under the same names as production's.
- **Who may dispatch.** Only @deconfined. The plan and the host both require the run's actor and its triggering actor to be @deconfined, by login and account id. That refuses a dispatch by a GitHub App or a workflow's `GITHUB_TOKEN` on purpose, since staging has no approval to stop one; an automatic run needs no dispatcher. Agents dispatch the workflow, for either target, only when @deconfined asks in that session (question 5 of the staging amendments, as amended on 2026-09-27), and for staging only through a credential of @deconfined's own.
- **What the release must declare.** The plan reads the target commit's `ops/deploy.sh` and requires `quadlet` and `staging` on its `CAPABILITIES` line. Without them staging is left out of the run, and a staging-only run fails `below-floor`. Only 2.33.0 and later declare them.
- **The job.** **Deploy staging** has a 30-minute limit and reconnects for 5 minutes, the accepted plan's limits, so a dead staging host never holds a runner for 90 minutes. The trade-off: a long migration trial, or a connection lost for more than 5 minutes, outlives the job. The host run then goes on by itself, the job ends cancelled or `outcome-unknown`, `~/.local/state/tarubot-deploy/runs/<run>/result` on the staging host keeps the result, and the next staging run waits up to 5 minutes for the host lock.
- **No Pushover message.** The messages are about production only. A failed staging job shows as a failed job in the run.
- **Production's result is its own job's.** The two deploy jobs run side by side, and production never waits for staging, so a run can fail on its staging job while production deployed. Whether production deployed a run is the **Deploy** job's conclusion together with the production approval, never the run's conclusion. Notify reads it that way, and so does the pull unit (2.34.0).
- **The host's checks.** In staging mode `ops/deploy.sh` requires the **Deploy staging** job running, the ` to staging` title for a dispatch, and @deconfined as the dispatcher. It queries no approval. It accepts the run status `waiting` as well as `in_progress`: production's job may wait for its approval while staging's runs, and how GitHub then reports the whole run is confirmed only by the first real staging run. The job, path, branch, repository, attempt and title checks decide. Production refuses every staging title, a `waiting` run, and a run where only **Deploy staging** runs, even with a production approval.
- **Commands** are registered in the test guild (`register.js --guild` with the target's `TEST_GUILD_ID`) and read back, on every run that starts or verifies a release.

**Everyday checks on the staging host,** once a bot runs there, as `tarubot`:

```sh
ssh tarubot@<staging host>
systemctl --user status tarubot.service
journalctl --user -u tarubot.service --since -1h
podman exec tarubot bun -e 'const r = await fetch("http://127.0.0.1:3000/health/ready"); console.log(await r.text())'
systemctl --user list-timers tarubot-backup.timer
```

### The Quadlet mode of `ops/deploy.sh`

The forced command's words choose the mode; nothing is detected. `ops/deploy.sh quadlet` is production after its rebuild, and `ops/deploy.sh quadlet staging` the staging host. The request forms, the run directory, the result line and the outcomes are Compose's ([Automated deploys](#automated-deploys-2300)). What differs:

- **Its own contract level.** Compose keeps `FLOOR=2.30.0`. A Quadlet host runs whichever release's copy is live, so every target there must speak the Quadlet contract: at or above `QUADLET_FLOOR` (2.33.0), with the mode's words on the target's own `readonly CAPABILITIES="…"` line (`quadlet`, plus `staging` on staging). Otherwise the run refuses `below-floor`. The header of `ops/deploy.sh` lists what the contract covers: the mode words, the host layout and the pin, the host lock and its protocol, the CLIs of `check-env.sh`, `secrets.sh`, `run-tool.sh` and `backup.sh quadlet`, the secret names, the unset list, what Quadlet's generator must make of the links (exactly `tarubot.service`, both settings lists in order, the pinned digest, nothing loaded from outside the clone), the hardening read-back and the health check, the registration commands run in the container (on staging with the container's own `TEST_GUILD_ID`), the labels, the backup unit and the journald evidence. `tests/unit/deploy-script.test.ts` ties the list to the functions that make those checks. An incompatible change to any of them replaces the word `quadlet` with a new one, so older copies refuse such a target exactly. The plan and the start tag read the same line, so no floor number is copied anywhere.
- **The session.** The worker derives `tarubot`'s runtime directory (`/run/user/<uid>`, which must be its own, mode 700) and exports `XDG_RUNTIME_DIR` and the user bus, so Podman, `systemctl --user` and the release's scripts reach the user manager. Every `podman`, `systemctl --user`, `journalctl --user` and `systemd-run --user` call is bounded by `timeout`, and nothing talks to a Podman API socket.
- **Preflight** (refusing `host` unless noted):
  - the host lock ([above](#the-host-lock));
  - `.env` a private regular file with one `TARUBOT_IMAGE_TAG` and one `TARUBOT_IMAGE_DIGEST` (the image index digest), no `TARUBOT_IMAGE`, no `NAME_FILE` line (`env-file`: the release fixes where the bot reads its secrets), and a log level of at most `info`;
  - Podman answering, with journald as its event logger; the user manager running (or degraded) and lingering; no Podman API socket; the user journal readable; 2 GB free where Podman keeps images; and exactly the mode's two links;
  - the live release: `tarubot.service` active, or activating between restarts, with the pinned image's labels matching the tag pin (`manual-change-in-progress` otherwise), and its one container running the pinned image with the unit's hardening (`hardening-mismatch`);
  - a backup running (the labelled dump container, or `tarubot-backup.service` active) delays it up to 5 minutes.
- **Staging the target,** before anything stops: `podman pull` by the approved digest, with RepoDigests and labels checked, and `git reset --keep` to the target. Then the target's own configuration must hold on this host. Quadlet's generator must turn the links into exactly `tarubot.service`, with both of the mode's settings lists and the pinned digest, loading nothing from outside the clone (`quadlet-config`). The target's `check-env.sh --syntax`, its `check-env.sh` run through `systemd-run` with the unit's `EnvironmentFile=` and `UnsetEnvironment=`, and `secrets.sh check` must pass (`settings-missing`). Either refusal puts the clone back.
- **Restart.** The pin moves first, both lines in one rename at mode 600; a pin that fails before anything restarted is `refused` `pin-failed`. Then `daemon-reload` and `systemctl --user restart tarubot.service`, whose `ExecStartPre=` checks the settings and syncs the secrets. The new container must turn healthy within 3 minutes, and a minute later still be the same container (systemd's `NRestarts` unchanged) on the approved image, with the hardening read back. Then the commands.
- **Migration.** `systemctl --user stop`, then `ops/backup.sh quadlet`, then `migrate.js` through the target's own `ops/quadlet/run-tool.sh`: a one-off container with the target's settings, secrets and hardening, labelled `io.tarubot.role=tool`. The pin moves only after "Schema ready.", then the reload, the start, the checks and the commands. A failed migration first stops the tool's container, which rolls its transaction back, then the previous release returns.
- **The writer-lease evidence** comes from Podman's journald events since the change (the live container's `died` event as the positive control, then the target's `start` events) and each container's own journal lines, read by container ID. The frozen "Modules loaded" and "Database writer lease acquired" markers decide, as on Compose.
- **The one difference in recovery.** A restart pinned the target before it started, so a target left for you stays pinned. When Podman's log gives no clear account of the target, nothing is restored, and `needs-you` `lease-evidence-incomplete` leaves `.env` naming the target (on Compose it still names the previous release). Read `journalctl --user -u tarubot.service` and `podman ps -a`, then pin what should run.
- **The hardening read-back,** at preflight and after every start: a read-only root, no added or effective capabilities, `no-new-privileges`, no bind or volume mount at all, and none of the unset names in the container's environment. It catches a `containers.conf` default that the generator's output can't show. Podman lists the secrets only under `.Config.Secrets`, never as mounts, so any mount, even one at `/run/secrets/<name>`, is refused: a host file or volume there could stand in for a secret's value.

### The pull unit (2.34.0)

Since 2.34.0 (#50 part 2b; REQUIREMENTS.md "Approved staging amendments (2026-09-26)", questions 14 to 18 and 20, and its "Implementation notes (2.34.0)"), a Podman host keeps its own host configuration current. A root-owned systemd timer runs `tarubot-host-config`, a script the playbook installs outside any clone. The script keeps its own root-owned clone of `main` and applies `ops/ansible/site.yml` to its host (`-c local`) while it holds the host lock. It never reads or runs anything the `tarubot` user can write. The pull unit itself needs no off-host credential; the root keys that exist off the host are the operator's staging-only Ansible key, until question 20's step removes it ([Installing it](#installing-it-owner), step 4), and the FIDO2 break-glass key.

**It runs nowhere yet.** Staging gets it after the merge, on @deconfined's go-ahead ([Installing it](#installing-it-owner)), and production at its rebuild. Production's Docker host never runs it.

The script and its units live in `ops/ansible/files/host-config/`: `tarubot-host-config`, `tarubot-host-config.service`, `tarubot-host-config.timer` and `timer-production.conf`. They sit under `ops/ansible/` on purpose. The playbook reads nothing outside that tree, and the signature rule below then covers the code root runs, the script included. `tests/unit/host-config.test.ts` runs every path of the script against a sandbox with real git, `ssh-keygen`, `jq` and `flock`, and `tests/unit/playbook.test.ts` pins the playbook's side.

#### What each host applies

- **Staging** takes the head of `main`. It polls every 5 minutes, plus up to a minute of random delay.
- **Production** takes the newest commit named by a Deploy run that production actually deployed, and polls every 10 minutes. It reads GitHub's public API anonymously. A run counts only when all of these hold:
  - it is `.github/workflows/deploy.yml` on `main` in `deconfined/tarubot`, first attempt, completed;
  - its title (`display_title`) is `Deploy <commit>` (an automatic run) or `Deploy <version>` (a dispatch, which maps to the one first-parent commit that carries that version). Titles that end in ` to staging`, and rollbacks (` rollback from `), never count;
  - exactly one job named `Deploy` concluded `success`. "Deploy staging" never counts, and neither does the run's own conclusion, which a staging job can fail;
  - @deconfined approved it for `production`, by login and account id (71469756), as `ops/deploy.sh` judges the same run.

  So approving a release also approves its host configuration, which production applies about 10 minutes after the deploy (question 15). Some details:
  - A Deploy job that succeeded without that approval should be impossible, because `ops/deploy.sh` checks the approval itself, so the unit always pages it as `needs-you approval-mismatch`. When its commit is newer than every approved candidate, the host stops there at every poll, checked again each time, until a newer approved release or an emergency apply passes it. When an approved candidate is newer, the first poll that sees the mismatch still ends `needs-you` and pages, and records the run as reported; the next poll goes on to the candidate.
  - The listing covers runs created in the last 31 days: a request can wait up to 30 days for @deconfined's approval, and a release approved late is still listed. The newest approved commit is kept in the unit's state until it is applied, so a host that stays paused or failed for longer doesn't lose it either.
  - Nothing `tarubot` wrote is read.
- **Forward only,** along `main`'s first-parent history. A commit before the applied one is never a target. A `main` that no longer contains the applied commit stops the host (`needs-you history-rewritten`).
- **Runtime-only commits** are only recorded (`recorded runtime-only`): nothing under `ops/ansible/` changed since the last full run, so there is no lock and no playbook.
- **A full run** applies the target when `ops/ansible/` changed since the last full run (`newer`). The current commit is also re-applied:
  - once a day, at the first poll after 05:00 UTC (`drift`): after the 04:30 backup and before dnf-automatic's 06:00 to 07:00 window. After downtime that spans 05:00, it comes at the first poll back;
  - after a hand run (`hand-run`), or after one of the unit's own runs was killed or failed (`interrupted`). The playbook writes a run marker on every real run, and the unit compares it with its record of the last full run. So after a failed commit, a fix whose `ops/ansible/` equals the last good commit's also applies, as `interrupted`;
  - when someone runs `apply-now` (reason `apply-now`);
  - hourly while a failed commit is retried (`retry`).
- **Host settings first.** When `/etc/tarubot/host.yml` changed since the last full run, the poll re-applies the commit it already runs (`settings-changed`). It picks no target and makes no API call or signature check, and it looks for a newer commit at the next poll. So a settings edit applies even while a newer commit is blocked, and a rotated or newly added signer counts from the next poll: the signature check reads the list from `host.yml` itself.

#### The signature rule (question 14)

The rule applies when `ops/ansible/` differs between the applied commit and the target. Every first-parent merge in between that changes `ops/ansible/` must meet four conditions:
1. it has exactly two parents: a merge commit, not a squash or a single commit;
2. its tree equals its pull request head's tree, so the merge adds nothing of its own;
3. its head already contains the previous `main`, so the branch was up to date;
4. its head carries a good SSH signature (`G`, trust `fully`) by a key listed in `tarubot_allowed_signers`.

The signers come from the host's own settings, never from the repository. The unit reads them from `/etc/tarubot/host.yml` at every run, in its plain form ([below](#files-and-settings-on-a-host)), into a file of its own for that run, so no file a playbook run rendered, from whatever copy of the settings, ever decides a signature. The playbook renders the same list to `/etc/tarubot/allowed_signers` for people, and refuses a pull run whose reading of the list differs from the unit's (the unit passes a digest, `tarubot_pull_signers`). At the first merge that fails, the host stops (`needs-you unsigned-host-change`, or `no-signers` when the list is empty). It pages on every poll and applies nothing, and a later signed merge can't carry the change past that merge. There are two ways past: an emergency apply by @deconfined as root, or, for `no-signers` and a rotated key, a `host.yml` edit. Merges that don't touch `ops/ansible/` pass unsigned, whatever made their head: Dependabot, a web edit or "Update branch". A change that a later merge reverts to no net difference is only recorded.

- **Why squash and rebase merging are off.** A squash or rebase merge is a commit GitHub writes and signs with its own key. It has no signed head to check, so every such merge that touches `ops/ansible/` would stop the hosts. @deconfined turned both off in the repository's settings on 2026-09-28, leaving merge commits only. The **Protect Main** ruleset still lists `merge` and `squash` as allowed merge methods (read on 2026-09-28), so today the repository toggle is the only guard: re-enabling squash there would pass the ruleset. Setting the ruleset to `merge` only makes both enforce it ([Installing it](#installing-it-owner), step 1). Keep "Require branches to be up to date before merging" on. Don't enable a merge queue or "Require linear history": both break the merge shape the hosts check.
- **"Update branch" and web edits.** On a pull request that changes `ops/ansible/`, GitHub's "Update branch" button and web edits make the head a commit GitHub signed, which reads `N` here. Push a signed commit on top before merging. Otherwise the hosts stop at that merge until an emergency apply.
- **What the signature proves.** The key listed today is the `id_git` key (ed25519 `SHA256:Y7SmEUtV87C2xwDvDSYNS/f/BV3gT3yt2tkxCKkJTcc`). It signs @deconfined's commits and the agents' on the operator machine, so the check proves that a head was signed there, not that @deconfined approved it. It stops content an attacker wrote: a stolen GitHub session can't sign, so it can't bring its own change to `ops/ansible/` to root through a merge (question 14's threat). It doesn't stop the early merge of a head that is already signed and contains the current `main`. A stolen session, or anyone with merge rights, could merge a pending, unreviewed agent pull request that changes `ops/ansible/`, and staging would apply it as root within about 5 minutes (production after its next approved deploy). Until an owner-only key is the only allowed signer, keep agent pull requests that change `ops/ansible/` unpushed or in draft until they are reviewed. For the check to mean @deconfined's own approval, list only a key he alone holds, such as a hardware `sk-ssh-ed25519` key, which the playbook accepts; agent pull requests that change `ops/ansible/` would then need a signed commit of his on top. A CI warning for heads without one of his GitHub-registered signing keys is deferred ([OPEN_ITEMS.md](OPEN_ITEMS.md#staging-follow-ups-50)).
- **What it doesn't cover.** Runtime code reaches the bot through deploys, never root, so nothing outside `ops/ansible/` is checked. The emergency apply and `bootstrap` check no signature: @deconfined naming the commit as root is the trust anchor.
- **Rotation.** Edit `tarubot_allowed_signers` in `/etc/tarubot/host.yml` as root on each host. The next poll re-applies the current commit with the edited settings, and a merge signed with the new key applies at the poll after that; a key removed from the list counts for no check after the edit. No commit is needed.

#### Files and settings on a host

| Path | Owner, mode | What |
| --- | --- | --- |
| `/usr/local/sbin/tarubot-host-config` | root, 0755 (`bin_t`) | The script, copied by the playbook once `bash -n` accepts it. It runs as `unconfined_service_t`. A new version arrives only this way, from a commit the checks accepted. The running copy isn't disturbed: bash has read the whole file before it runs, and the copy's rename keeps the old file open. |
| `/etc/systemd/system/tarubot-host-config.service` and `.timer` | root, 0644 | A oneshot that runs `tarubot-host-config run`, and its timer (`*:0/5`, `RandomizedDelaySec=60`). Only the timer has an `[Install]` section. |
| `/etc/systemd/system/tarubot-host-config.timer.d/10-production.conf` | root, 0644 | Production only: every 10 minutes. The playbook removes it on other hosts. |
| `/etc/tarubot/host.yml` | root, 0600 | The playbook's settings (`-e @`), written by @deconfined as root. cloud-init will write it in a later release. |
| `/etc/tarubot/host-config.env` | root, 0600 | One setting line, `HEALTHCHECKS_HOST_CONFIG_URL=<ping URL>`, besides comments and blank lines, written by @deconfined only. It is matched, never sourced. When it is missing or the value is empty, no pings go out (logged as a warning). |
| `/etc/tarubot/allowed_signers` | root, 0644 | Rendered from `host.yml` as `deconfined namespaces="git" <type> <key>` lines, for people and tools on the host. The unit never reads it: it builds the same lines from `host.yml` at each run. Never edit it by hand. |
| `/var/lib/tarubot-config/` | root, 0700 | The unit's own directory. It holds `repo/` (the clone), `home/` (`HOME` and `TMPDIR` for git, curl, jq and Ansible, so nothing goes to `/root`, and each run's own temporary directory with its signers file), `state.json` (the unit's record), `last-run.json` (the run marker the playbook writes), and the flags `pause` and `now`. The files are 0600. |
| `/run/tarubot/host.lock` | root, 0644 | The host lock ([above](#the-host-lock)). |

- **The layout.** Every directory from `/` down to the unit's directory, `/etc/tarubot` and `/run/tarubot` must be root's and writable by nobody else, or nothing runs (`needs-you layout`).
- **The clone.** It fetches `main` only, from a fixed HTTPS URL. Hooks, fsmonitor, submodules, redirects, credential helpers, and the system and global git settings are all off, and no remote is configured. The script runs nothing from the clone. The playbook runs from it after a checkout, as root, and that is what the signature rule protects.
  - The signature rule checks git's objects, so the files on disk must be exactly those objects. A `.gitattributes` anywhere in a commit, which a runtime-only merge could add unsigned, could otherwise re-encode or rewrite `ops/ansible/` at checkout (`working-tree-encoding`, `eol`, `ident`). git reads attributes from the empty tree instead (`attr.tree`, git 2.43 and later; the hosts have 2.52), and after every checkout the unit compares each file under `ops/ansible/` with its blob, byte for byte (`hash-object --no-filters`).
  - A file that differs anyway, for example one git's index still records as current after it changed on disk, is repaired once: the unit drops the index entries under `ops/ansible/`, checks out again and compares again, logging `warning clone-repaired`. If the files still differ, the run stops at `failed git-local checkout` before the playbook ([Recovery by hand](#recovery-by-hand)).
- **`host.yml`'s plain form.** The script reads `host.yml` without a YAML library, before Ansible does, to learn the role and the signers and to notice changes. Keep it in the form `host.example.yml` shows, or the unit stops (`needs-you settings`):
  - printable ASCII and line feeds only: no tabs, carriage returns or other bytes, so none of the other line breaks YAML knows (NEL, LS, PS) can hide a line from the script that Ansible would read;
  - only its keys, each once, in one document;
  - after a key's colon: nothing (a list follows), `[]`, a quoted string or one word, then an optional comment. Quote values with spaces, and never continue a value on the next line;
  - lists in block form, one `- "…"` line each, never `["…"]`. Each signer is a quoted `ssh-ed25519` or `sk-ssh-ed25519@openssh.com` key line, with one space between type and key and an optional comment;
  - no anchors, aliases, tags, merge keys, block scalars or flow mappings.

  The playbook also checks that the role and the signers the script read equal its own reading (`tarubot_pull_role`, and `tarubot_pull_signers`, the sha256 of the signers' `<type> <key>` joined by commas), and refuses the run otherwise.
- **A new setting.** The installed script judges the `host.yml` its successor's playbook needs, and refuses keys it doesn't know. So a release that adds a `host.yml` key, or a line to `host-config.env`, adds it to the script's allowlist and gives it a default in the playbook in that same release; only a later release may require it. Write the new key into `host.yml` only once the host runs the release that knows it, or the unit stops at `needs-you settings` until the key is removed. (A release that required a new key at once would leave the old script refusing `host.yml` as soon as the key was added, with the emergency apply refused too, and only a hand run could get out.) `tests/unit/playbook.test.ts` and `host-config.test.ts` keep the playbook's settings, `host.example.yml` and the script's allowlist equal.
- **No sandboxing options.** The service has no `PrivateTmp` and no other mount-namespace or sandboxing option. The `tarubot` play runs `podman info` on every full run, and when no rootless pause process exists, that call starts one. Inside a private `/tmp` and `/var/tmp` the pause process would keep them; systemd would delete them when the unit stops; and every later rootless Podman call, the bot's and `ops/deploy.sh`'s included, would join that namespace. The playbook also needs sudo, dnf's own SELinux domain, and writes to `/etc` and `/usr`. The unit runs at `Nice=10` with low CPU and IO weights, and `UMask=0022` gives its runs the modes a hand run gets.

#### Commands

All of them run as root on the host.

| Command | What it does |
| --- | --- |
| `tarubot-host-config status` | Read-only, with no lock. It prints `key=value` lines: the role; the applied commit with its version, source and time; the last full run; any failure; `busy_since`; production's saved target; the last result; the pause; a waiting `apply-now`; the service and the timer; the next poll; the number of signers; and `ping=yes` or `no`. It never prints the URL. |
| `tarubot-host-config pause REASON` | Writes the pause flag (printable text, up to 200 characters), then waits up to an hour for a run in progress to end. It prints `active=none` and exits 0 when no run is left, or `active=still-running` and exits 75. With `--no-wait` it returns at once. Later polls end `paused` before fetching. |
| `tarubot-host-config resume` | Removes the flag. The next poll carries on, and after a hand run it re-applies (`hand-run`). |
| `tarubot-host-config apply-now` | A full run of the current target now, past the hourly backoff. It starts the service (joining a run already in progress), then prints `status`. It is refused while paused (`paused <reason>`, exit 75). If a deploy holds the lock, the request waits for the next poll that can run the playbook, and the command says so. |
| `tarubot-host-config apply COMMIT --emergency [--ignore-lock]` | The emergency apply. COMMIT is 40 hex digits, strictly after the applied commit on `main`'s first-parent chain. It skips the approval and signature checks and the backoff, and it also runs while paused (the pause stays). It waits up to 5 minutes for the host lock; `--ignore-lock` goes on without the lock and logs who holds it. It always pages `/fail emergency-apply`. Run it detached from the SSH session ([below](#operating-it)). |
| `tarubot-host-config bootstrap COMMIT` | Once per host. It creates the clone and applies COMMIT, which must be on `main`'s first-parent chain and carry the script. Then it writes the first state and enables the timer. It checks no signature, because naming the commit as root is the trust anchor. It is refused once state exists. Run it detached from the SSH session too. |
| `tarubot-host-config run` | One poll: the service's `ExecStart`. |

- **The private lock.** `run`, `apply` and `bootstrap` take the unit's private lock. A second `run` ends `waiting already-running`, and `apply` and `bootstrap` wait up to 60 seconds for it. `status`, `pause`, `resume` and `apply-now` never take it, so a pause works while a run is in progress.
- **The result line.** `run`, `apply` and `bootstrap` each end with one line on standard output, `result outcome=<outcome> commit=<12 hex> version=<X.Y.Z> changed=<n> reason=<reason>`, which the journal keeps.

#### Results and pages

Each host has one healthchecks.io check. Its ping URL is in `/etc/tarubot/host-config.env`: root-only, never in the repository, and not in the `.env` settings copy.
- A routine result pings success.
- A `/start` ping goes out before every playbook run.
- A result that needs someone pings `/fail` on every poll while it lasts. healthchecks.io notifies only when the state changes.
- Silence past the check's grace means the unit didn't run or didn't reach GitHub: the timer stopped, the host is down, or GitHub stayed unreachable for over an hour.

| Result | Exit | Ping | Meaning |
| --- | --- | --- | --- |
| `applied` (`newer`, `settings-changed`, `retry`, `interrupted`, `hand-run`, `drift`, `apply-now`, `bootstrap`) | 0 | success | The playbook ran; `changed=` counts its changes. |
| `applied emergency` | 0 | `/fail emergency-apply` | An emergency apply went through. It pages on purpose. |
| `recorded runtime-only` | 0 | success | A newer commit changed nothing under `ops/ansible/`. |
| `current` | 0 | success | Nothing to do. |
| `paused` | 0 | `/fail paused <reason>` | Paused. The check goes down at the next poll and stays down until `resume`. |
| `waiting deploy-running` | 75 | success, or while a failure is open its `/fail apply-failed` again | A deploy holds the host lock; the next poll tries again. A failed commit's retry delayed this way keeps the check down instead of flapping it up. |
| `waiting lock-held` | 75 | `/fail lock-held <n>h` | The lock has been busy for 3 hours or more ([below](#the-host-lock-and-deploys)). |
| `waiting github-unreachable`, `rate-limited`, `bootstrap`, `already-running` | 75 | none | Temporary, or not bootstrapped yet. A long outage shows as missed pings. |
| `failed apply-failed`, `retry-later`, `marker-mismatch` | 1 | `/fail apply-failed <commit> task=<task>` | The playbook failed; the record stays on the last good commit. It is retried hourly, and a newer commit or changed settings at once. |
| `failed git-local` | 1 | `/fail git-local <step>` | A local git step failed: the disk, a corrupt object or permissions. |
| `needs-you` `history-rewritten`, `unsigned-host-change`, `no-signers`, `host-config-link`, `missing-pull-unit`, `ambiguous-version`, `approval-mismatch` | 1 | `/fail needs-you <reason> <commit>` | The host stops before the named commit ([Recovery by hand](#recovery-by-hand)). An `approval-mismatch` behind a newer approved release pages for one poll only ([What each host applies](#what-each-host-applies)). |
| `needs-you` `layout`, `settings`, `state-schema` | 78 | `/fail`, if the ping file could be read | The host's own files are wrong. |
| `needs-you` `not-root`, `already-bootstrapped`, `bad-commit` | 78 or 64 | none | Refused at the command line. |

`SuccessExitStatus=75` keeps a waiting poll from counting as a failure. Exit 1 or 78 leaves the service `failed` in `systemctl --failed` until the next successful poll.

The check's suggested settings are a period equal to the timer's (5 minutes on staging, 10 on production), 60 minutes of grace, and Pushover when it goes down.

#### Operating it

```sh
tarubot-host-config status
journalctl -u tarubot-host-config --since -1d      # the script's lines, Ansible's --diff output, the result lines
systemctl list-timers tarubot-host-config.timer
```

- **Hand runs.** Before any hand run, the start tag's included, run `tarubot-host-config pause "<reason>"` and wait for it to return 0. Then run the playbook, and `tarubot-host-config resume` afterwards. A hand run from the operator machine holds no lock on the host, so the pause is what keeps a pull run from interleaving with it. The playbook refuses a real hand run on a host with pull state unless the pause flag is there; check mode needs no pause.
- **The host's own settings.** Hand runs pass the same file the host has, with `-e @host.yml` from one flat copy outside any checkout ([Installing it](#installing-it-owner), step 3.1), never settings kept as inventory host variables. A run with a different copy is undone at the first poll after `resume`, which re-applies the unit's commit (`hand-run`). Whatever a hand run rendered, the unit's signature checks read the signers from `/etc/tarubot/host.yml` itself, never from `/etc/tarubot/allowed_signers`.
- **A pause pages, by design.** Each poll while paused sends `/fail paused <reason>`, so a planned pause, every hand run's included, sends a Pushover message, and `resume` brings the check back up at the next poll. Pausing the check in healthchecks.io doesn't prevent that: a paused check leaves its paused state at the next ping, and the next `/fail` marks it down. The one way to keep a planned pause quiet is a check with healthchecks.io's "manual resume" on, which ignores every ping while paused: pause the check in the dashboard before `tarubot-host-config pause`, and resume it in the dashboard after `tarubot-host-config resume`. Forget that last step and the unit runs unmonitored, since even its success pings are ignored; so the default here is the plain check, and the page.
- **Pause, never disable.** Don't stop, disable or mask the timer. The playbook enables and starts it again on every run while pull state exists, so `pause` is the switch.
- **An emergency.** Pause, then the emergency apply, then resume. The commit must be newer than the applied one. To re-apply the applied commit instead, resume and run `apply-now`. Run the apply, like `bootstrap`, detached from your SSH session, with its output in the journal: a dropped connection would otherwise kill it partway (SIGHUP, or a failed write to the gone terminal), leaving the host half-applied at the emergency commit while the unit's record stays on the old one, and the very merge that needed the emergency would keep every later poll at `needs-you`:

  ```sh
  systemd-run --unit=tarubot-host-config-manual --collect --wait -p SyslogIdentifier=tarubot-host-config \
    /usr/local/sbin/tarubot-host-config apply <commit> --emergency
  journalctl -u tarubot-host-config-manual      # its output and its result line, also after a disconnect
  ```

  The unit keeps running if the session drops; `systemctl status tarubot-host-config-manual` shows whether it still is. For `bootstrap`, put `bootstrap <commit>` in place of `apply <commit> --emergency`.
- **systemd's start limit.** systemd refuses a sixth start of the service within 10 seconds, which starting polls or `apply-now` by hand in quick succession can reach. `systemctl reset-failed tarubot-host-config.service` clears it. The timer isn't affected.
- **Network.** The clone fetches over HTTPS, and the API calls are anonymous HTTPS. `github.com` and `api.github.com` have no AAAA records, so the hosts need IPv4 egress to GitHub. GitHub allows 60 anonymous API calls an hour per address, shared with `ops/deploy.sh`'s approval checks (five per run). Production's unit makes one listing per poll, 6 an hour, plus at most two calls for each new run. It stops calling when fewer than 20 remain (`waiting rate-limited`), leaving room for the deploys. Staging's unit calls no API.

#### The host lock and deploys

- **Never at once.** The pull unit and `ops/deploy.sh`'s Quadlet modes share `/run/tarubot/host.lock` ([The host lock](#the-host-lock)), so they never run at the same time.
  - The unit takes the lock only for a full run. It holds it around the checkout, the playbook and the record, and passes `-e tarubot_host_lock_held=true` so the play's own commands don't take it again.
  - It never waits for a deploy. A poll that finds the lock busy ends `waiting deploy-running` (with a success ping) and tries again at the next poll. After 3 hours of that it pages `lock-held`.
  - No command it starts inherits the lock, so nothing it leaves behind can keep holding it. In the 2.34.0 rehearsal, only the script had the lock file open during its runs.
- **The busy collision.** A deploy waits up to 5 minutes for a pull run, then refuses `busy`, and nothing retries that on its own. On production a new dispatch and a new approval follow, and on staging a new dispatch by @deconfined. Three things keep it rare:
  - a full run with nothing to change loads no package metadata: about 25 seconds on one vCPU in the 2.34.0 rehearsal;
  - the daily re-apply sits at 05:00 UTC, clear of the 04:30 backup and dnf-automatic's 06:00 to 07:00 window;
  - host changes land away from deploys. Staging applies within about 5 minutes of the merge, while the publish run that starts staging's deploy takes about 9. Production applies only after its deploy has finished, since the finished deploy is what makes the commit a target.

  A run that installs packages takes longer. If a deploy refuses `busy`, dispatch again once `status` shows `service=inactive`.
- **Holding the lock.** `tarubot` can open the lock read-only and hold it too. That blocks host configuration, not dnf-automatic's security updates, and pages `lock-held` after 3 hours.
  - To find who has it open, as root: `find /proc/[0-9]*/fd -lname /run/tarubot/host.lock 2>/dev/null`.
  - The emergency apply's `--ignore-lock` log names the process that took the lock, which may have exited since.
- **The backup** still doesn't take the lock ([OPEN_ITEMS.md](OPEN_ITEMS.md#staging-follow-ups-50)).

#### Recovery by hand

- **A failed apply** (`failed apply-failed task=<task>`). The record stays on the last good commit, and the unit retries hourly. A newer commit or a changed `host.yml` is tried at once, and the journal has the task and its error.
  - The check stays down until an apply succeeds: a poll that a deploy's lock delays (`waiting deploy-running`) sends the failure's `/fail` again rather than a success ping.
  - A failure whose commit or settings are no longer wanted, such as a failed `host.yml` edit you then undid before the playbook changed anything, is dropped at the next poll that ends `current` or `recorded`, and `status` shows `failure=none` again. An edit that failed after the playbook started changing things is re-applied instead (`interrupted`), because its run marker no longer matches.
  - Ansible isn't transactional: tasks before the failed one stay applied, and `force_handlers` still runs their reloads.
  - Fix forward: a new merge on staging, an approved release on production, or an emergency apply.
  - The playbook never stops or restarts the bot, so the bot is untouched either way.
- **`unsigned-host-change` or `no-signers`.** The result names the merge. Check who pushed its head and why it isn't signed; usually it is an "Update branch" or a web edit. If the change is legitimate, pause, emergency-apply the target, and resume. For `no-signers` or a new key, fix `host.yml` instead.
- **`approval-mismatch`** (production). GitHub reports a Deploy job that succeeded without @deconfined's approval for `production`. Treat it as a security event: read that run's approvals and the production host's deploy logs, even when it paged only once because a newer approved release was already waiting. When it stops the host, a newer approved release, or an emergency apply at or past that commit, clears it.
- **`host-config-link` or `missing-pull-unit`.** A link or submodule under `ops/ansible/`, or a target without the script. Neither is ever legitimate; fix it in a new merge.
- **`layout`.** Something on the unit's paths is owned by someone other than root, writable by group or others, or a link. Treat it as tampering until explained, and `stat` each directory from `/` down.
- **`settings`.** `host.yml` isn't in the plain form, or `host-config.env` isn't a root-only file with one URL line. A bad ping file sends no ping.
- **`git-local`.** git's message is in the journal. Stale lock files that a killed run left in the clone are removed at the next poll (`warning stale-git-lock`).
  - **`git-local checkout`** with no git message means the files under `ops/ansible/` still differ from their blobs after the unit's own repair ([Files and settings](#files-and-settings-on-a-host)). Treat it as tampering with root's clone until explained. To repair it by hand, as root, pause, then drop the index entries and check out the applied commit again, and resume; the next poll compares the files again:

    ```sh
    tarubot-host-config pause "clone repair"
    g() { git -C /var/lib/tarubot-config/repo -c core.hooksPath=/dev/null -c attr.tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904 "$@"; }
    g rm -r -q --cached -- ops/ansible
    g checkout -q --force --detach <applied commit>      # tarubot-host-config status names it
    tarubot-host-config resume
    ```

    If it recurs, reset the unit (below).
- **A broken script** that blocks every later update: the installed script judges its successor, as `ops/deploy.sh`'s live copy does.
  1. Pause it. If the script won't run at all, write the flag by hand as root: `sh -c 'umask 077; printf "%s %s\n" "$(date +%s)" "script broken" > /var/lib/tarubot-config/pause'`.
  2. Merge the fix to `main` first; on production, also get its Deploy approved and completed. Then, from the operator machine, hand-run exactly that merged commit, with the host's own settings, to install the fixed script.
  3. Resume only once `main`'s head (on production, the newest approved Deploy target) carries the fix. Until then stay paused: otherwise the first poll re-applies the applied commit (`hand-run`), whose playbook puts the broken script back. A fix hand-run from a branch is undone the same way.
- **Resetting the unit** for rewritten history, an unreadable `state.json` (`state-schema`, for example from a newer schema after an older script came back) or a clone beyond repair. As root:

  ```sh
  tarubot-host-config pause "reset"      # waits for a run in progress
  mv /var/lib/tarubot-config "/var/lib/tarubot-config.old-$(date -u +%Y%m%dT%H%M%SZ)"
  systemd-run --unit=tarubot-host-config-manual --collect --wait -p SyslogIdentifier=tarubot-host-config \
    /usr/local/sbin/tarubot-host-config bootstrap <commit>      # detached, as under "Operating it"
  ```

  - Polls wait silently while the directory is gone (`waiting bootstrap`), and the old one stays for inspection.
  - Choose the commit as for a first bootstrap: one on `main`'s first-parent chain that you have checked, such as the applied commit if `main` still has it.
  - The pause went with the old directory, so polling starts again at once.

#### Installing it (owner)

In this order, each @deconfined's step or one he gives the go-ahead for. Agents never install, bootstrap, pause, resume or emergency-apply the unit without that go-ahead, and never touch it on production.

1. **Merge settings (question 14).** Done on 2026-09-28 in the repository's settings: squash and rebase merging are off, and merge commits stay on. Keep "Require branches to be up to date before merging" on, and add no merge queue or "Require linear history".
   - **Still to do:** the **Protect Main** ruleset's pull-request rule still allows `merge` and `squash` (read on 2026-09-28). Set its allowed merge methods to `merge` only (Settings → Rules → Rulesets → Protect Main → "Require a pull request before merging" → Allowed merge methods), so the ruleset enforces merge commits as well as the repository toggle. Until then the toggle is the only guard, and re-enabling squash would stop every host at the next squash that touches `ops/ansible/` (`needs-you unsigned-host-change`).
2. **A healthchecks.io check** for staging's pull unit: period 5 minutes, grace 60 minutes, Pushover when it goes down, and "manual resume" off (the default; [Operating it](#operating-it) says why a pause pages). Keep its ping URL with the others in `~/tarubot-cutover/` (mode 600).
3. **After 2.34.0 merges, on staging:**
   1. **`/etc/tarubot/host.yml`**, as root, mode 600: one flat file that feeds both the host and your hand runs.
      - Staging's operator settings live today as `tarubot_*` host variables in your out-of-repository inventory (the 2.34.0 check run rendered no signers for that reason). Copy them into one flat `host.yml` outside any checkout, in `host.example.yml`'s plain form: every key at the top level, lists in block form, values with spaces quoted. Add the signing key's public line (`~/.ssh/id_git.pub`) in block form; a flow list (`["…"]`) is refused:

        ```yaml
        tarubot_allowed_signers:
          - "ssh-ed25519 AAAA… <comment>"
        ```

      - Send that file to the host over SSH stdin:

        ```sh
        ssh root@<staging host> 'set -e; umask 077; t=$(mktemp /etc/tarubot/.host.yml.XXXXXX)
          cat > "$t"; chmod 600 "$t"; mv "$t" /etc/tarubot/host.yml' < /path/outside/any/checkout/host.yml
        ```

      - Then remove the `tarubot_*` variables from the inventory, leaving only how to reach the host, as `inventory.example.yml` shows, and pass `-e @/path/outside/any/checkout/host.yml` on every later hand run ([Running it](#running-it-from-the-operator-machine)). One file then feeds both, and a hand run can't render different keys than the host's.

   2. **`/etc/tarubot/host-config.env`**, as root, mode 600, with the check's ping URL, which never passes through a terminal:

      ```sh
      tr -d '\r\n' < ~/tarubot-cutover/<the check's URL file> | ssh root@<staging host> \
        'set -e; umask 077; read -r u || true; [ -n "$u" ]; t=$(mktemp /etc/tarubot/.host-config.env.XXXXXX)
         printf "HEALTHCHECKS_HOST_CONFIG_URL=%s\n" "$u" > "$t"; chmod 600 "$t"; mv "$t" /etc/tarubot/host-config.env'
      ```

   3. **Apply 2.34.0 from the operator machine** with `--skip-tags start`, check mode first ([Running it](#running-it-from-the-operator-machine)). It installs ansible-core (`1:2.16.16-2.el10_2.1` or later), the script, the units and the signers file. The timer stays off until the bootstrap.
   4. **Bootstrap,** as root on staging, with the full commit of the 2.34.0 merge on `main`, detached from the SSH session so a dropped connection can't kill it partway ([Operating it](#operating-it)):

      ```sh
      systemd-run --unit=tarubot-host-config-manual --collect --wait -p SyslogIdentifier=tarubot-host-config \
        /usr/local/sbin/tarubot-host-config bootstrap <commit>
      journalctl -u tarubot-host-config-manual
      ```

      Expect `result outcome=applied … reason=bootstrap`, a `/start` and a success ping, and the timer enabled. Then check `tarubot-host-config status` and `journalctl -u tarubot-host-config`.
   5. **Watch the next merges.** A runtime-only one should read `recorded`, and one whose signed head changes `ops/ansible/` should read `applied`.
4. **Staging's Ansible root key (question 20).** Once the unit has proven itself, remove the staging-only Ansible key from the operator machine and from root's `authorized_keys` on staging, outside the playbook's block.
   - A reasonable bar: one runtime-only merge recorded, one `ops/ansible/` merge applied, one reboot with the timer running again afterwards, and one pause and resume.
   - **Before removing it, prove the way out without it.** After the removal, hand runs are the only way past a broken script ([Recovery by hand](#recovery-by-hand)). From the machine the FIDO2 key is plugged into, with the pinned virtual environment and an inventory that points at that key alone (`IdentitiesOnly=yes`; each SSH connection asks for the PIN and a touch), run a check-mode apply against staging (`--check --diff --skip-tags start`) and confirm it completes. Linode's Lish console, with a password reset, stays the fallback.
   - After that, root on staging means the FIDO2 break-glass key: pause, the emergency apply and hand runs are @deconfined's.
   - Agents lose root there too, including check-mode runs and `status`.
5. **Production, at its rebuild** (not in 2.34.0): its own check (period 10 minutes), `host.yml` with the signers, `host-config.env`, then `bootstrap` at the commit of the approved release it runs.

#### Limits

- **Order.** Staging applies host configuration before its bot deploy, and production after, so staging never rehearses production's order. A host change and a runtime change that depend on each other must work in either order: expand first, contract later.
- **Resources.** A playbook run shares the host's one vCPU and 2 GB with the bot.
- **Hand edits don't last.** The next full run reverts an emergency edit made by hand on the host, by the next day at the latest, unless the unit is paused.
- **The ping URL on a rebuild.** It lives outside the settings copy. A host rebuilt without it stays silent, and its check then pages as down, which is the safe direction.
- **Not yet:**
  - a public `status.json` and `ops/deploy.sh`'s host-level gate;
  - the Deploy plan's wording for production approvals that also move host configuration;
  - reporting `reboot_required` ([OPEN_ITEMS.md](OPEN_ITEMS.md#staging-follow-ups-50)).

### Not yet automated

| When | What |
| --- | --- |
| Next | cloud-init user data and OpenTofu (the Linodes, their firewalls, the database access list and DNS), proven by rebuilding staging from scratch; user data then writes `host.yml` and bootstraps the pull unit. The hand-built host is deleted after that. |
| The move | DevBot moves: stop local DevBot, dump and restore into `tarubot_staging`, reset DevBot's token into staging's `.env` only, pause the pull unit, run the start tag, resume, turn staging deploys on, then retire the local copy in a patch. |
| Numbered when it lands | PR images on staging, dispatched by @deconfined: `preview.yml`, a separate `tarubot-pr` package, a `pr` input and `ops/deploy.sh`'s `preview` word. |
| Numbered when it lands | Production rebuilt onto AlmaLinux, rootless Podman and Quadlet, by overlap: its forced command becomes `ops/deploy.sh quadlet`, the start tag runs at the handover (which also links the backup units and enables their timer), and the old host is fenced. The new host bootstraps the pull unit with its own check. Production's workflow rollbacks then reach 2.33.0 and later only. Before it, the playbook needs the path that moves production's container stack, which its automatic updates skip, after a week on staging (REQUIREMENTS.md question 2): pinned versions, or a deliberate update run. The packages are `state: present`, so on a rebuilt production host nothing would upgrade them yet. |
| After that | The Compose-path cleanup: the Compose twins leave `ops/deploy.sh` and `ops/backup.sh`, and `docker-compose.production.yml` goes (question 12). |

### Owner steps before the move

In this order. **Status (2026-09-28):** steps 1 to 10 are done, on 2026-09-27 and the early hours of 2026-09-28, each checked read-only by the agent where it could be ([VERIFICATION.md](VERIFICATION.md)); steps 11 and 12 wait for the move. Agents never create or change the GitHub environments, never read their secrets or variables, never touch either switch, and never hold a deploy key (the agent rule @deconfined confirmed on 2026-09-26, in AGENTS.md, and question 5); a read-only look at an environment's protection rules, as in step 5's check, is allowed.

1. **Merge 2.33.0 with `STAGING_DEPLOY_ENABLED` unset.** Production's Deploy run for it asks for your approval as usual, and approving restarts production onto 2.33.0 under Compose. Its plan is the first to run `gh attestation verify`: check the summary's "Provenance verified" line.
2. **The database and role,** before any staging credential exists. As the admin role, in `defaultdb`, first read `SHOW max_connections` and the current use, and check whether any provider role relies on PUBLIC's CONNECT. On this cluster the provider's monitoring role, `_akmadmin_monitor`, did, so it gets its own grant before PUBLIC loses it. Connect with `sslmode=verify-full` and the cluster CA from `production.env`'s `DATABASE_CA_CERT`: `~/tarubot-cutover/work/ca-certificate.crt` is an older, different CA and fails verification. On this cluster (`max_connections` 50, 3 reserved) `<n>` was 16: staging's pool of 12, the writer lease and a few tools. Then:

   ```sql
   CREATE ROLE tarubot_staging LOGIN CONNECTION LIMIT <n>;
   \password tarubot_staging
   GRANT tarubot_staging TO akmadmin WITH INHERIT FALSE, SET TRUE;
   CREATE DATABASE tarubot_staging OWNER tarubot_staging TEMPLATE template0;
   SET ROLE tarubot_staging;
   GRANT CONNECT, TEMPORARY ON DATABASE tarubot_staging TO _akmadmin_monitor;
   GRANT CONNECT ON DATABASE tarubot_staging TO akmadmin;
   REVOKE CONNECT, TEMPORARY ON DATABASE tarubot_staging FROM PUBLIC;
   RESET ROLE;
   -- Production's database, as its owning role (SET ROLE tarubot if the admin can, or connect as tarubot):
   GRANT CONNECT, TEMPORARY ON DATABASE tarubot TO _akmadmin_monitor;
   GRANT CONNECT ON DATABASE tarubot TO akmadmin;
   REVOKE CONNECT, TEMPORARY ON DATABASE tarubot FROM PUBLIC;
   ```

   Afterwards each database's access list names only its owner (`CTc`), `akmadmin` (`c`) and `_akmadmin_monitor` (`Tc`). `\password` keeps the password out of the statement text. Check production's readiness right after the second part. Then confirm with `has_database_privilege` that `tarubot_staging` can't connect to `tarubot`, that `tarubot` can't connect to `tarubot_staging`, and that PUBLIC holds neither. The staging tool profile accepts exactly these names.

   **The same rule for every later database on the cluster:** revoke PUBLIC's `CONNECT` and `TEMPORARY` as soon as it is created, and grant `CONNECT` only to the roles that need it. That includes `tarubot_restore` ("Restoring a dump" above). The tool guard checks only the maintenance tools. The bot process itself, which on staging runs pull-request code, is held back only by these grants: a database it can connect to is one where it can take the writer-lease lock (advisory locks belong to one database), and a staging bot holding it in a database production is repointed at would keep production unready.
3. **The access list:** add the staging host's IPv6 /128 and IPv4 address to the managed database's access list, IPv6 first, before its first start.
4. **Staging's own services,** never production's (they are listed empty in `staging.env.example`):
   - a reports token limited to the reports repository's issues, because staging runs PR code;
   - a heartbeat check without alerts;
   - a separate Linode Object Storage bucket with `ops/bucket-lifecycle.xml`'s rules (set as under [Daily dumps](#daily-dumps)), an access key limited to it, and its own healthchecks.io backup check.
5. **The `staging` GitHub environment** (Settings → Environments → New environment):
   - no required reviewers and no wait timer;
   - deployment branches "Selected branches and tags" with the branch rule `main` only;
   - the variable `DEPLOY_HOST`, staging's DNS name;
   - the variable `DEPLOY_KNOWN_HOSTS`, one line: that name, `ssh-ed25519` and the host key read from the Lish console, as in the host-key step (REQUIREMENTS.md);
   - the secret `DEPLOY_SSH_KEY` (the next step).
6. **The staging deploy key,** a new Ed25519 key of its own, never production's. Generate it in your own terminal as in production's [step 4](#setting-it-up-owner), with `gh secret set DEPLOY_SSH_KEY --env staging`, so the private half goes straight into the environment. Put the public line in `tarubot_deploy_key_public` in staging's host settings (outside the repository) and apply with `--skip-tags start`: the playbook writes `restrict,command="/home/tarubot/tarubot/ops/deploy.sh quadlet staging"` into `/etc/ssh/authorized_keys/tarubot`. Then delete the local copy.

   This apply is the first real apply of 2.33.0's host layer on staging: besides the key, it installs the root-owned host lock from tmpfiles. The clone stays at 2.30.4, so no backup link, timer, start or container follows. Check afterwards, as root, that `stat -c '%U %a %F' /run/tarubot /run/tarubot/host.lock` prints `root 755 directory` and `root 644 regular empty file`, and that a second apply reports `changed=0`. Steps 7 and 8 apply again for their keys. On staging this layer is already in place: @deconfined gave the go-ahead on 2026-09-27 and the agent applied it, so this apply only adds the key ([VERIFICATION.md](VERIFICATION.md)).

   **Probe it** with the new key alone (`IdentitiesOnly=yes`, `IdentityAgent=none`): until the first start moves the clone to 2.33.0 or later, 2.30.4's `deploy.sh` exits 64 without a word on the mode words; after it, any command but a request prints the usage line and exits 64. None may give a shell or a file listing, and sshd's `DisableForwarding` refuses every forward.
7. **`.env`:** add your operator key to `tarubot_operator_keys` and apply. Then write `~/tarubot/.env` from `staging.env.example` over SSH stdin (mode 600), with staging's own bucket, key and check values, and `DISCORD_TOKEN` left as its placeholder until the move. Take a settings copy. `.env` stays the only place the secrets are kept; the unit refreshes the Podman secrets from it at every start. It holds no `NAME_FILE` line and no `TARUBOT_IMAGE_DIGEST`: the unit sets the files, and the first start writes the digest.
8. **The break-glass key:** add the FIDO2 key's public line to `tarubot_root_keys` and apply. Try it on staging; it asks for the PIN on every use. Then remove your personal keys from root's `authorized_keys`, outside the playbook's block, as the plan asks. The staging-only Ansible key stays until the pull unit is proven ([Installing it](#installing-it-owner), step 4).
9. **Stale host keys:** remove staging's RSA and ECDSA SSHFP records and `known_hosts` lines whenever convenient (above); they are left over from part 1.
10. **Before 2.34.0's pull unit:** turn off squash merging, and rebase merging with it (question 14; done on 2026-09-28, merge commits only). The pull unit's own install follows the 2.34.0 merge ([Installing it](#installing-it-owner)).
11. **At the DevBot move** (not in this release):
    1. update local DevBot to the release you will start (2.33.0 or later; its update procedure applies any migration), stop it, then dump its database and restore the dump into `tarubot_staging`. The start never migrates, so the restored database must be at that release's schema: start exactly the version DevBot ran when it was dumped ([The first start](#the-first-start-the-start-tag), which also says how to recover from a failed start);
    2. reset DevBot's token in the Developer Portal and put the new one only in staging's `.env`;
    3. verify the release's index digest with `gh attestation verify` ([The first start](#the-first-start-the-start-tag)); an agent may do this for staging;
    4. pause the pull unit (`tarubot-host-config pause "DevBot move"` as root, waiting for it to return 0), then run, or give the go-ahead for, the playbook with `-e tarubot_start_version=<version> -e tarubot_start_digest=<digest>`, without `--skip-tags start` and without `tarubot_host_lock_held`. It applies the host layer (the lock included), resets the clone to the verified commit, links the unit and the backup units from it, starts the bot and enables the backup timer. Then `tarubot-host-config resume`.
12. **Then staging deploys.** Set the repository variable `STAGING_DEPLOY_ENABLED` to `true`, at repository level, never in an environment. Then run the Deploy workflow yourself with `target=staging` and the live version: expect `already-live`, which checks the live release and registers its commands in the test guild. If it fails, deleting the switch pauses staging again without touching production. The dispatcher rule refuses a dispatch by a GitHub App or `GITHUB_TOKEN`, so an agent could start one only with a credential of your own account that can dispatch, which you would have to grant, and only when you ask in that session.
13. **Older rollback targets on production:** the plan now refuses releases before 2.32.0, so a rollback to one of them follows [the manual procedure](#rolling-back-to-a-release-without-provenance-before-2320).
