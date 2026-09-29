# Production hosting (Linode)

Production TaruBot has run on a **Linode Docker host with Linode managed PostgreSQL** since 2026-09-24.

2.37.0 adds the unified **Build and deploy** workflow for either environment: image build, OpenTofu, Ansible configuration and rootless Podman on AlmaLinux 10, with one production environment approval. [DEPLOYMENT.md](DEPLOYMENT.md) is its setup and operating guide, including automated initial SSH pinning and preparation without starting the bot. Production remains on the Compose path described here until the owner completes that cutover; the earlier pipeline sections below record the transition path.

The cutover first went live on DigitalOcean App Platform, then moved the same evening, with about 90 seconds of downtime, because **the Lodestone refuses DigitalOcean's addresses**: HTTP 403 at the edge, within milliseconds. From App Platform, Nodestone could not refresh profiles, verify claims or read the roster. Linode's addresses get HTTP 200. [MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover) has the record. [APP_PLATFORM.md](APP_PLATFORM.md) records the App Platform setup, retired in 2.21.0; the owner has since deleted the app and its cluster (recorded 2026-09-26).

A second Linode, the [staging host](#staging-host-50) (#50), runs on AlmaLinux with rootless Podman. Since 2.36.0 ([#62](https://github.com/deconfined/tarubot/issues/62)) it is built and run by [the simple pipeline](#the-simple-pipeline-2360): OpenTofu builds it, cloud-init sets its credentials, the Deploy workflow configures it and deploys the bot with Ansible from a GitHub runner, and every secret lives in a GitHub environment. Production moves to the same pipeline in 2.37.0; until then, the sections before "Staging host" describe it as it runs.

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

`publish.yml` signs build provenance from 2.32.0 on, and a signature can't be made honestly for an older image afterwards, so since 2.33.0 the Deploy plan refuses every release before 2.32.0 (`unattested`), for a rollback and for an `already-live` re-check alike. Of the releases the workflow could roll back to before (2.30.0 and later, on schema 010), that leaves 2.30.0 to 2.30.4 (2.31.0 was skipped) to this procedure. Staging never needs it: its floor is 2.36.0. It is a deploy by hand, so it needs the owner's explicit go-ahead, and only on the same schema (no migration file between the two releases).

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

Since 2.30.0 (issue #41; REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"), the **Deploy** workflow (`.github/workflows/deploy.yml`, named "Deploy production" until 2.33.0) deploys each published release to this host once @deconfined approves it in GitHub. That approval is the go-ahead for a production deploy. What agents may and may not do around it is REQUIREMENTS.md's "Agent rule" (verbatim in AGENTS.md), which @deconfined confirmed in full on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): among its clauses, Claude sessions never approve, reject or bypass a deployment and never hold the deploy key. The rule's "Deploy production workflow" is this file, whatever its display name. The workflow's jobs, environments and settings are in [CI_CD.md](CI_CD.md#deploy-workflow); this section is the host side and what to do. Since 2.33.0 the same workflow also has a staging job, which needs no approval; since 2.36.0 it calls `host.yml` ([The simple pipeline](#the-simple-pipeline-2360)). Production's path described here doesn't change until 2.37.0, apart from the [provenance check](#provenance-check-2330) in the plan.

### A deploy

1. Merge the release as today. Try it on staging before you approve production (#62 answer 6): the same run's **Deploy staging** job deploys it there at once, and after the DevBot move DevBot runs it there. Until then, trying it on local DevBot stays manual.
2. When "Publish containers" finishes, a Deploy run plans the release, and GitHub asks you to review its `production` deployment. A merge that changes only documentation, tests, CI, the version, the settings templates, `ops/tofu/` (which reaches the hosts only through the Infrastructure workflow) or ansible-lint's pins (`ops/ansible/requirements-lint.txt`) asks nothing; a quiet Pushover message says so. Since 2.36.0 `ops/ansible/requirements.txt` counts as runtime: it is staging's Ansible. The plan first verifies the image's signed provenance, and an image that fails it is never planned ([Provenance check](#provenance-check-2330)).
3. Open the run and read its summary: the targets (production, and staging beside it), the version, commit and image digest, the "Provenance verified" line, the migration files, the host-side changes in this merge (files under `ops/`, the production Compose file and `production.env.example`: on this Docker host they run as a docker-group user, which is root-equivalent here; on the staging host, Configure runs `ops/ansible/site.yml` as root and the release's `ops/ansible/bot.yml` runs the bot as the unprivileged `tarubot` user, at once, beside your approval request), warnings for the Tuesday maintenance window and the daily backup, and the changelog. The migrations and host-side lists cover this merge only. If production is older than the previous release, the releases in between come too: the summary links the history of the host-side files up to the target for that case. GitHub's compare API lists at most 300 files, so a merge (or a rollback's range) of 300 files or more is refused as `compare-too-large` rather than planned from a list that may be cut short: deploy that release by hand ([Updating to a release](#updating-to-a-release)).
4. **Review deployments** → tick `production` → **Approve and deploy**, or **Reject**. Approval comments are public, like the summary.
5. One Pushover message reports the outcome.

**By hand:** **Run workflow** on `main` with a version, and `target` left at `production`. The live version is re-verified and its commands registered again (`already-live`), which is also the retry after `commands-failed`. A rollback ticks `rollback` and names the live version in `from`; it goes only to an older release (2.32.0 or later, which carry provenance; older ones [by hand](#rolling-back-to-a-release-without-provenance-before-2320)) on the same schema. The same approval follows. The run is titled `Deploy <version>` (or `… rollback from <from>`), and the production host refuses every title that ends in ` to staging`. Leave `action` at `deploy`: its other values are staging's until 2.37.0, and a production dispatch with one fails the plan as `action`.

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
- **By hand.** The same command, without `--format json`, checks any later image from a workstation with a `gh` login (gh asks for a token even for a public repository); it prints nothing on success without a terminal. Since 2.36.0 no host needs a digest checked by hand: a host's first start is an ordinary run, whose plan makes this check.

### What the host does

The deploy key's line in the `tarubot` user's `~/.ssh/authorized_keys` forces every connection to `ops/deploy.sh` (`restrict,command=`): no shell, no file transfer, no forwarding. The script accepts exactly `deploy <version> <commit> <digest> <run>` or `rollback <version> <commit> <digest> <run> <from>` and starts a detached worker for that run, so a dropped connection reconnects to the same run. At most four workers run at once; beyond that a new run is refused `too-many-runs` before it gets a run directory. On this host the forced command has no arguments, which selects the Compose mode described here. The script also keeps 2.33.0's Quadlet modes (the words `quadlet` and `quadlet staging`), which no host uses since 2.36.0 and which leave with the script in 2.38.0; any other words print the usage line and exit 64. The worker:

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

**Plan refusals** reach no host: the plan job fails with an error that names the check, and for a production run the Pushover message names the reason. `unattested` (the [provenance check](#provenance-check-2330)), `gate` (no requested target's environment passed its gate), `action` (a production dispatch with an action other than `deploy`), `staging-rollback` (a staging dispatch with `rollback` or `from`), `below-floor` (a staging run below 2.36.0, the first release whose own `bot.yml` deploys staging), `target`, `version`, `version-mismatch`, `from`, `image`, `digest-mismatch` (the version and `sha-` tags name different images), `not-on-main`, `compare`, `compare-too-large`, `applied-migration-changed`, `rollback-not-older` and `rollback-across-migration`. `paused` isn't a failure: production's switch is off, so nothing is planned for it. Staging has no switch since 2.36.0.

**When no result arrives** the workflow reports: `host-key` (the host key changed: check the host before updating `DEPLOY_KNOWN_HOSTS`), `key-rejected`, `known-hosts` or `no-key` (the deploy environment's settings), `unreachable` (every attempt for 80 minutes failed before sshd answered, so nothing started), `bad-request` (the host refused the command format), or `outcome-unknown` (the host may have been reached, or the run outlasted the reconnect window). With `outcome-unknown`, the host's run directory is authoritative: the worker carries on alone, and `runs/<run id>/public.log` ends with its result.

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

- **Pause:** delete the repository variable `DEPLOY_ENABLED` (Settings → Secrets and variables → Actions → Variables → Repository variables, or `gh variable delete DEPLOY_ENABLED`). Nothing new plans, and a request already waiting ends `refused` `paused` if you approve it. Pushover still reports that, and any other outcome of a run that planned while the switch was on: the plan decides whether a run gets a message when it starts, never when notify runs. Setting it back to `true` (`gh variable set DEPLOY_ENABLED --body true`) resumes. This holds only while the `production` environment has no `DEPLOY_ENABLED` of its own: inside the deploy job such a copy overrides the repository variable, so a waiting request would still go ahead ([setup](#setting-it-up-owner) step 12).
- **Pause staging:** since 2.36.0 staging has no switch. Add a required reviewer to the `staging` environment; its runs then wait for that reviewer. Pausing production leaves staging running, and the plan runs either way.
- **Stop:** `gh workflow disable deploy.yml` (both targets; an owner step).
- **Kill:** delete the deploy key's line from `authorized_keys`, or the `production` environment's `DEPLOY_SSH_KEY` secret. On staging, delete the `staging` environment's `ANSIBLE_SSH_KEY`, or its key line in root's `authorized_keys`.
- **Cancelling a run in GitHub stops a host run only before its first change,** when the host checks the run again (`refused` `not-approved`, nothing changed). After that it finishes on its own, and its result stays in its run directory.
- **Don't approve while you work by hand.** Automated runs refuse while the bot is stopped or the pin differs from the running release, but not every manual step shows.

### Setting it up (owner)

Each step is the owner's, with the owner's go-ahead; Claude prepares the commands only. **Status (2026-09-26):** steps 1 to 13 are done. Steps 1, 4, 5 (the line names `/opt/tarubot/tarubot/ops/deploy.sh`, and `authorized_keys` is mode 600) and 7 to 11 came before the 2.30.0 merge; after it, the hand deploy (step 2), the prerequisites (step 3), the key probe (step 6), `DEPLOY_ENABLED` (step 12, on the second try) and the first run (step 13). Step 14 followed with 2.30.1 (run 36253924529, `deployed`), and 2.30.2, 2.30.3 and 2.32.0 went the same way; no migration release has gone through the workflow yet. These steps are production's; staging's environment and secrets are in [Owner steps for 2.36.0](#owner-steps-for-2360). Since step 11 the dev VM's `gh` token is read-only, so the `gh secret set` and `gh variable set` commands below need a token with write access; the same settings can be made in the web UI (Settings → Environments → the environment, or Settings → Secrets and variables → Actions → Variables → Repository variables for `DEPLOY_ENABLED`).

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
- **A dump before every migration** on production's Compose path: on the operator machine for a manual migration (below), and a fresh `ops/backup.sh` dump on the host, taken after the bot stops, for an automated deploy (2.30.0). On the new pipeline (staging since 2.36.0) each run reports its restore point instead, the moment the old instance stopped, for point-in-time recovery.

The cluster's weekly maintenance runs Tuesdays from 19:00 UTC for up to 4 hours. On this single-node cluster a restart can drop the bot's connection. The bot then exits, Docker restarts it, and it waits for the writer lease again. A long outage trips the heartbeat.

### Daily dumps

`ops/backup.sh` runs at 04:30 UTC from the `tarubot` user's crontab on this host (staging runs its own `tarubot-backup` from a systemd user timer: [Backups on staging](#backups-on-staging)):
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

## Settings copy (off the host)

The production host's `.env` is the one thing a rebuild can't recreate from Git, so an encrypted copy is kept off the host (since 2.23.0). Staging has no `.env` since 2.36.0: its secrets are in the `staging` environment and its settings in `ops/ansible/vars/targets/staging.yml`. The copy goes with production's `.env` at the cleanup release (2.38.0). `scripts/host-env-backup.ts` runs on the operator machine. It reads `~/tarubot/.env` over SSH from the host named by `--host` (required) and encrypts it with [`age`](https://age-encryption.org) for the public keys in [`ops/age-recipients.txt`](../ops/age-recipients.txt). It writes only the encrypted file, to `~/tarubot-cutover/env-backups/tarubot-env-<UTC time>.age` (mode 600). The settings never touch the operator machine's disk or the terminal.

```sh
bun run host:env-backup -- --host tarubot@<production host> --identity ~/tarubot-cutover/age/tarubot.key
```

- **The output** names the settings present and any expected ones that are absent, never their values. With `--identity`, it also decrypts the new copy in memory and confirms it matches what was read.
- **When to run it:** after any change to the host's `.env`, such as a rotated token or a new setting. A release only changes `TARUBOT_IMAGE_TAG`, which a restore sets anyway (step 7 below).
- **The private key** is `~/tarubot-cutover/age/tarubot.key` on the operator machine (mode 600). The owner keeps a second copy offline, in a password manager. Without the key the copies can't be opened, and the daily database backups (2.24.0) use the same key.

## Rebuilding the host

This is production's Compose runbook, until 2.37.0 moves production to the new pipeline (staging's is [Rebuilding staging](#rebuilding-staging)). Use it when the host is lost, compromised, or being replaced. The data lives in the managed database, so a rebuild loses nothing: the new bot picks up its state from PostgreSQL. Budget about an hour, most of it waiting for DNS.

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

The staging host is a second Linode. It runs AlmaLinux 10 with SELinux enforcing, the bot as a rootless Quadlet unit under the `tarubot` account, no Docker, and its own database and role on the managed cluster.

Since 2.36.0 ([#62](https://github.com/deconfined/tarubot/issues/62)) the simple pipeline below builds and runs it. @deconfined's decisions are in REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)", which replace much of "Approved staging amendments (2026-09-26)". Production moves to the same pipeline in 2.37.0; until then everything above this section still describes it.

**State at 2.36.0.** @deconfined retires the hand-built staging host of 2.32.0 to 2.34.0, with its pull unit, before 2.36.0 merges ([Owner steps for 2.36.0](#owner-steps-for-2360)); the Infrastructure workflow builds its replacement. **No bot runs on staging until the DevBot move** (2.36.2): the `staging` environment holds no `DISCORD_TOKEN`, so a `deploy` there only configures the host. One Discord application must never run in two places.

### The simple pipeline (2.36.0)

[DEPLOYMENT.md](DEPLOYMENT.md) walks the whole process as step tables, what @deconfined does against what runs by itself, from building a host to a deployed release. Four layers, each with one owner:

| Layer | What it does | Where |
| --- | --- | --- |
| OpenTofu | Builds the Linode (disk encryption), its Cloud Firewall, its DNS A and AAAA records, and each database cluster's whole access list. | `ops/tofu/`, planned by `.github/workflows/infra.yml` in the read-only `infra-plan` environment and applied in `infra` after @deconfined's approval ([Infrastructure](#infrastructure-opentofu)) |
| cloud-init | At first boot only: the hostname, root's public keys, root's optional console password hash (locked without one), password SSH off, `python3-libselinux`, and a one-line sshd drop-in that enforces `verify-required`. | `ops/tofu/cloud-init.yaml.tftpl`, rendered into the Linode's user data |
| Ansible | **Configure:** `ops/ansible/site.yml` from `main`'s head, as root. **Bot:** the release's own `ops/ansible/bot.yml`, which deploys the bot as the `tarubot` user. | `.github/workflows/host.yml`, on a GitHub-hosted runner over SSH |
| GitHub environments | Every secret and every approval. | `staging`, `production`, `infra-plan`, `infra` and `notify` |

```
merge to main ─► Publish containers (build, push, sign provenance)
               └─► Deploy (re-runs refused)
                    Plan            public data only: version, commit, digest, provenance, the staging action,
                                    main's head (config_commit), the schema head
                    Deploy staging  host.yml in `staging`: Configure (main's site.yml), then Bot (the release's bot.yml)
                                    at once, no approval
                    Deploy          production's Compose job (ops/deploy.sh), after @deconfined's approval (until 2.37.0)
                    Notify          Pushover, about production only
```

Nothing on a host pulls, polls or judges releases. systemd starts the bot and runs `migrate.js` before each start. [CI_CD.md](CI_CD.md#deploy-workflow) has the workflows' side: jobs, inputs, environments and CI.

**Actions.** Every automatic run is a `deploy`. A dispatch names an `action`, which is staging's alone in 2.36.0 (a production dispatch with anything but `deploy` fails the plan as `action`):

| `action` | Configure | What `bot.yml` does | Requires | Version rule |
| --- | --- | --- | --- | --- |
| `deploy` | yes | everything ([below](#bot-deploys-and-the-result)) | the five bot secrets and the five backup settings; without `DISCORD_TOKEN`, on a host that runs no bot, it ends `configured` | older than the live release: `superseded`, nothing changed |
| `bot` | no | everything | the same, with no exception | any release at or above 2.36.0; refused across a migration |
| `configure` | yes | nothing | nothing | none: the version is ignored |
| `preflight` | yes | the database and backup secrets, `migrate.js` and one backup; no bot | `DATABASE_URL`, `DATABASE_CA_CERT` and the backup settings | refused where a bot unit exists |

**By hand** (@deconfined, or an agent only when @deconfined asks in that session): **Run workflow** on `main` with `target` = `staging`, a version and an action. The run is titled `Deploy <version> to staging`, or `Deploy <version> <action> to staging` for any action but `deploy`. The plan refuses:
- `rollback` and `from` for staging, as `staging-rollback`: staging goes back with `action=bot` and the older version;
- a staging release below 2.36.0, the first whose own `bot.yml` deploys staging, as `below-floor`.

**Pausing staging.** There is no switch. @deconfined adds a required reviewer to the `staging` environment, and staging runs then wait there.

**One run at a time.** The host job holds one concurrency group per target (`host-staging`) with `queue: max`: a newer run waits for the one on the host, and every waiting run keeps its place in order. Without `queue: max`, GitHub keeps only one waiting run per group and cancels it when another arrives, which could drop a dispatched rollback. Re-runs are refused (first attempts only), so a retry is a new dispatch. A run whose staging job fails never holds production up, and production's result is always its own **Deploy** job's.

**What reaches the public log.** The host's name, its pinned key and root's Configure key are secrets of the environment, so Actions masks them. The host job's first step masks every address the name resolves to before anything else prints, and ssh runs with `LogLevel=FATAL`, so a host key other than the pinned one ends in "Host key verification failed." without ssh printing that key's fingerprint. Nothing runs with `-v` or `--diff`, and every task that touches a secret or runs a bot tool is `no_log`. The run's summary shows only the result's public fields.

### Infrastructure (OpenTofu)

[ops/tofu/README.md](../ops/tofu/README.md) is the runbook: what the module builds, the `infra-plan` and `infra` environments and `TOFU_VARS`, the first apply, rebuilds, hand runs and upgrades. In short:

- **What it builds.** For each entry in `hosts` (keyed `staging` or `production`), a Linode on `linode/almalinux10` with disk encryption, its Cloud Firewall (inbound SSH and ICMP from anywhere, everything else dropped) and unproxied A and AAAA records. For each database cluster, the cluster's whole access list: every host's IPv6 `/128` and IPv4 `/32`, then `db_allow_extra`, with `prevent_destroy`. It never builds host keys, SSHFP records or the clusters themselves.
- **One dispatch, one approval** (REQUIREMENTS.md, confirmed item 4). Dispatch **Infrastructure** from `main` with `operation=apply`. Its Plan job runs in `infra-plan`, with read-only tokens, a read-only state key and no approval; its summary lists each change as `ACTION ADDRESS`, with `+N -M` on access lists. If that is what you meant, approve the Apply job in `infra`; if not, reject it. Apply never plans: it fetches the Plan job's saved plan (a one-day artifact, encrypted by OpenTofu), refuses unless its SHA-256 and change list are the Plan job's and it was planned with `infra`'s own `TOFU_VARS`, and applies exactly that plan, which OpenTofu refuses as stale if the state changed since. `operation=plan` stops after the Plan job. A delete or replace needs `allow_destroy`, and an access-list removal `allow_access_removal`.
- **After any apply that touches an access list,** check production's readiness: the heartbeat check and `/sync status`.
- **State** lives in a private Object Storage bucket, encrypted by OpenTofu with a passphrase only the `infra-plan` and `infra` environments and @deconfined hold; the same passphrase encrypts the saved plan, which anyone signed in to GitHub can download from the public repository while its artifact is kept. There is no state lock, so a hand run must never overlap a workflow run; the Plan job plans with `-lock=false`, since its state key is read-only.
- **User data applies only when a Linode is created.** A new root key, Configure key or hash reaches a host only through a rebuild ([Rebuilding staging](#rebuilding-staging)).

**Pinning a new host key (trust on first use).** Nothing prints a host's key: scanners index host keys by address. After every build or rebuild, @deconfined pins it from their own machine, once the name resolves to the new addresses:

```sh
ssh-keyscan -q -t ed25519 <name> 2>/dev/null | cut -d' ' -f2- | gh secret set TARGET_HOST_KEY --env staging
```

`-q` keeps `ssh-keyscan`'s banner line out of the secret. To check the key first, compare `ssh-keyscan -q -t ed25519 <name> 2>/dev/null | ssh-keygen -lf -` with the Ed25519 fingerprint cloud-init printed on the Lish console. Until the new key is pinned, every run for that host fails at its first connection with "Host key verification failed.". At `LogLevel=FATAL` a host that is down, or has port 22 closed, ends UNREACHABLE with no reason either, so check that it is up first.

### Configure

`ops/ansible/site.yml` is plain host configuration: one play, run by the host job as root over SSH from `main`'s head (the plan's `config_commit`), with one input, `-e tarubot_role=staging` or `production`. It reads no secret. cloud-init owns the hostname, root's keys and root's password, and the playbook never writes them. Every automatic run and every `deploy`, `configure` and `preflight` dispatch runs it; `bot` skips it.

In order, it:
1. waits for `cloud-init status --wait` (done, or degraded);
2. refuses anything but AlmaLinux 10 on x86_64 with SELinux enforcing, or an unknown role;
3. **on a new host** (no `tarubot` account yet), upgrades every package and reboots once;
4. installs Podman, crun, passt, container-selinux, acl, chrony, dnf-automatic, dnf-plugins-core, polkit, `python3-libselinux` and sudo, then EPEL and `age` from it (`state: present`: Configure never upgrades after a host's first run);
5. configures dnf-automatic as the hosts' only updater: all updates (`upgrade_type = default`), applied daily, with a reboot when one needs it (`shutdown -r +5`). Staging keeps the timer's default, 06:00 UTC plus up to an hour; production's drop-in moves it to 10:00 UTC;
6. sets UTC and chrony; the sysctl drop-in (`kernel.yama.ptrace_scope=1`, `dev.tty.legacy_tiocsti=0`, and no temporary IPv6 addresses, so the address on the access list stays the one in use); rpcbind stopped and masked; a persistent journal with one file per user; and the IPv6 boot wait, which holds `network-online.target` until the host has a global IPv6 address and a default route (60 s at most, never failing);
7. installs sshd's drop-in `00-tarubot.conf` over cloud-init's seed, checked on its own and then with the whole configuration before a reload, and asserts the effective settings with `sshd -T`: passwords, keyboard-interactive and GSSAPI off, root by key only, `AllowUsers root`, `PubkeyAuthOptions verify-required`, no forwarding of any kind, no `~/.ssh/rc`, and the one Ed25519 host key (the key `TARGET_HOST_KEY` pins);
8. limits `su` to the wheel group (`pam_wheel.so use_uid` in `/etc/pam.d/su`), and installs a polkit rule that refuses every request from any subject but root. The wheel group has no members on these hosts, so root's console password, if cloud-init set one, works only at the Lish console: not for `su`, `pkexec` or `run0` from another account, and never over SSH;
9. creates the `tarubot` account (umask 0022 through its GECOS, no groups, password locked, no SSH login) and enables lingering, so its user manager runs the bot and the backup timer with nobody logged in.

A second run reports `changed=0`. A failure fails the host job before the bot step, and the next run applies again.

**Acting on the host.** Log in as root with the FIDO2 key (it asks for the PIN and a touch) or the operator key, if `root_keys` holds one, then use `run0 --user=tarubot`. `tarubot` has no SSH login. Under SELinux a `run0` service can't execute a file in a home directory (status 203/EXEC), so wrap commands in a shell: `run0 --user=tarubot sh -c '…'`. Never use plain `su` or `runuser` from a root terminal: they hand `tarubot`'s code root's terminal.

**A hand run while Actions is down.** From @deconfined's own machine, never an agent's, with the pinned ansible-core (`pip install --no-deps --require-hashes -r ops/ansible/requirements.txt` in a virtual environment) and the FIDO2 key. `inventory.example.yml` shows the inventory (the one host is `target`, reached as root with `HostKeyAlias=target`, and its known-hosts line is `target <TARGET_HOST_KEY>`), and `host.example.yml` holds the role:

```sh
cd ops/ansible
export ANSIBLE_CONFIG="$PWD/ansible.cfg" LC_ALL=C.UTF-8
ansible-playbook -i /path/outside/any/checkout/inventory.yml site.yml -e @host.example.yml
```

### Bot deploys and the result

The host job's Bot step runs **the release's own** `ops/ansible/bot.yml`, from a checkout of the commit named by the image's own revision label, which must equal the plan's commit. It uses `main`'s `ansible.cfg` and ansible-core, and gets the eleven secret names of `vars/bot.yml`'s `tb_secret_env` from the environment, in this step only (two of them from secrets named otherwise, `tb_secret_source`: `REPORTS_GITHUB_TOKEN` and, for production from 2.37.0, `SUGGEST_APP_PRIVATE_KEY`). So a rollback deploys with that release's own playbook, unit template and settings (question 7).

`bot.yml` runs as root only to find the `tarubot` account, then as `tarubot` through these phases. Any phase can end the run:

| Phase | What it does |
| --- | --- |
| checks | The inputs; the target's declared settings; each required secret, present and well formed (a single-line value must be one run of non-whitespace characters, and only the two PEMs may span lines); and `DATABASE_URL`, which must be `postgresql://tarubot_staging:<password>@<host>[:<port>]/tarubot_staging`, the password percent-encoded and the host a DNS name (or an IPv4 address: the database driver can't use an IPv6 literal). That check is one regular-expression match: a URL parser can raise on a malformed value, and the exception's text, which quotes it, reaches the public log even from a `no_log` task. Refusals name settings, never values. |
| live | The installed unit's `Image=` line and that image's version: the live release, or none. |
| decide | `configured` (a `deploy` without `DISCORD_TOKEN` on a host with no bot unit; nothing is written), or a refusal: `missing-secret`, `malformed-secret`, `database-not-this-target`, `bot-exists` (a preflight where a unit exists), or `superseded` (a `deploy` older than live). |
| image | Pulls `ghcr.io/deconfined/tarubot@<digest>` and requires its version and revision labels to be the plan's (`image-mismatch`). |
| migrations | Lists `/app/migrations` in the live and the target image, with no network. A file the live image has and the target lacks is a rollback across a migration (`rollback-across-migration`). It names the files the start will apply, and warns (`db-maintenance-window`) in the cluster's Tuesday 19:00-23:00 UTC maintenance. |
| identity | Asks the release image for the target's application and test guild (`resolveDeployment`, no network, no secret), and checks that `DISCORD_TOKEN` belongs to that application (`token-application-mismatch`). |
| secrets | Writes each required value into its Podman secret, `tarubot-<name>`, with `podman secret create --replace` and the value on standard input. Nothing ever deletes a Podman secret. |
| files | `tarubot-tool`, `tarubot-backup`, the backup's two units and `age-recipients.txt`. |
| preflight | Only for `preflight`: the settings file and the image file, `migrate.js` (it must print `Schema ready.`, or `schema-not-ready`), then one backup (`backup-failed`), then the nightly backup timer, so the backup check keeps hearing from the host. Ends `preflight-ok`. |
| unit | Renders the unit as a candidate and runs Quadlet's own dry run over it (`unit-invalid`). Then, back to back, it writes the settings file, the unit and the image file, and reloads the user manager, so a bot that restarts meanwhile never meets another release's settings. |
| restart | `systemctl --user restart tarubot.service`, always: systemd stops the old container (freeing the writer lease), runs `migrate.js` in the new image as `ExecStartPre`, then starts the bot (`restart-failed`). The **restore point** is when the old instance stopped (`InactiveEnterTimestamp`), before any migration committed. |
| health | Healthy within 3 minutes (36 checks, 5 s apart), then 60 s later still healthy, as the same container on the release's image (`not-healthy`, `image-mismatch`). |
| timer | Enables and starts `tarubot-backup.timer`. |
| commands | `register.js --guild <test guild>` for staging, then `commands.js list` (`register-failed`). |
| tidy | Removes TaruBot release images (those with the repository's `org.opencontainers.image.source` label) older than a week that no container uses; the backup's pinned PostgreSQL image stays. Ends `deployed`. |

Before the secrets phase nothing is written to the host but image pulls. Nothing is ever put back: a release that doesn't turn healthy stays, and the run fails. A task that can fail with a named outcome or reason (the codes below) declares them in its own `vars`, and the play's rescue reads them from the failed task; any other failure is `failed` with reason `-`.

**The result.** The last play writes a result file on the runner, and the job's summary prints it: `outcome`, `action`, `version`, `previous`, `restore_point`, `migrations`, `schema_head`, `step`, `reason` and `warnings`, each as plain characters. When the host becomes unreachable while `bot.yml` runs, Ansible stops before that play, and the summary says there is no result file: the phase shows only in the run's log. The summary decides nothing; the job is green when its steps are, which `bot.yml`'s last play arranges only for these:

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `deployed` | The release runs, healthy, with its commands registered. | Nothing. |
| `superseded` | A newer release is live. Nothing changed. | Nothing. |
| `configured` | Configure ran; for `deploy`, no bot runs here and the environment has no `DISCORD_TOKEN`. | Nothing, before the DevBot move. |
| `preflight-ok` | The database answered `Schema ready.`, and one backup reached the bucket. | Nothing. |
| `no-host` | An automatic run, and the environment has no `TARGET_HOST`. A dispatch fails instead. | Nothing, before staging is built. |

And red for these:

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `refused` | A check failed before anything was written; `reason` names it: `no-account` (Configure never ran), `missing-secret`, `malformed-secret`, `database-not-this-target`, `token-application-mismatch`, `image-mismatch`, `bot-exists` or `rollback-across-migration`. | Fix the secret or the request, then dispatch again. |
| `unhealthy` | The release was installed and restarted, but isn't healthy. It stays in place; the summary names the rollback. | Read the journal, then [roll back](#rolling-back) or fix forward. |
| `failed` | A step failed; `step` and `reason` say which (`unit-invalid`, `restart-failed`, `register-failed`, `schema-not-ready`, `backup-failed`, or `-` for an unexpected error). | Read the step's log in the run, then the host's journal. |

**Files on the host,** all owned by `tarubot`:

| Path | What |
| --- | --- |
| `~/.config/containers/systemd/tarubot.container` (0644) | The Quadlet unit: the image by digest, `Pull=never`, the settings file, one `Secret=` mount per secret (`/run/secrets/<name>`, uid 1000, mode 0400), a read-only root with no capabilities and `no-new-privileges`, the health check, and `ExecStartPre` running `migrate.js` through `tarubot-tool` with the unit's own image. `TimeoutStartSec=15min`, `Restart=always`. |
| `~/.config/tarubot/tarubot.env` (0600) | The plain settings (`TARUBOT_ENVIRONMENT=staging`, public test replies, `/suggest` off, the application and test guild the image reported) and one `NAME_FILE=/run/secrets/<name>` line per secret. No secret value. |
| `~/.config/tarubot/image` (0600) | The live image reference, for `tarubot-tool` without `--image`. |
| `~/.config/tarubot/candidate/` (0700) | Where the unit is dry-run before it is installed. |
| `~/.config/tarubot/age-recipients.txt` | The release's `ops/age-recipients.txt`, for the backup. |
| `~/.local/bin/tarubot-tool`, `~/.local/bin/tarubot-backup` | The one-off tool wrapper and the backup script. |
| `~/.config/systemd/user/tarubot-backup.service`, `.timer` | The nightly backup. |

The secrets live in Podman's store in `tarubot`'s rootless storage, on disk, so crash restarts, reboots and the nightly backup work without GitHub. That store is as sensitive as a `.env` was.

**Everyday checks,** as root on the host:

```sh
run0 --user=tarubot sh -c 'systemctl --user status tarubot.service'
run0 --user=tarubot sh -c 'journalctl --user -u tarubot.service --since -1h'
run0 --user=tarubot sh -c "podman inspect --format '{{.State.Health.Status}}' tarubot"
run0 --user=tarubot sh -c 'systemctl --user list-timers tarubot-backup.timer'
```

If `systemctl --user` can't reach the user manager from that session, set `XDG_RUNTIME_DIR=/run/user/$(id -u)` in the command first. Never print the container's full `inspect` output or its environment: it names the secret files and the Discord IDs.

### Rolling back

Dispatch **Deploy** with `target=staging`, `action=bot` and the previous version. `bot` skips Configure, so a rollback needs no package mirror. That release's own `bot.yml` checks the migrations before anything stops: across a migration it is refused `rollback-across-migration`, and the way back is a fix release, or a restore ([Backups on staging](#backups-on-staging)). An `unhealthy` run's summary names the exact dispatch.

Production rolls back through its Compose path until 2.37.0 ([Updating to a release](#updating-to-a-release)).

### Rotating a secret

@deconfined sets the new value in the `staging` environment, then dispatches the live version with `action=bot`:
- **A value that can coexist with the old one** (a token or a key): set it, dispatch, and revoke the old one once the run is `deployed`.
- **The database password** can't coexist: set the secret, change the password, then dispatch at once.
- **One secret per dispatch,** so a failure names its cause.
- **Single-line values** must carry no stray whitespace, or the run refuses them as `malformed-secret`. `gh secret set NAME --env staging < file` keeps a file's final newline, so strip it first, for example with `tr -d '\n' < file | gh secret set NAME --env staging`.
- **`DATABASE_URL`'s password is percent-encoded**, as in any URL: a `@`, `/`, `?`, `#`, `:` or `%` in it is written `%40`, `%2F`, `%3F`, `%23`, `%3A` or `%25`. The run refuses a URL with a raw `@`, `/`, `?` or `#` in the password as `database-not-this-target`, naming only the setting.
- **The Configure key or root's keys** live in user data too, so they change through a rebuild (`TOFU_VARS`, then [Rebuilding staging](#rebuilding-staging)). Until then, root's `authorized_keys` can be edited by hand, logged in with the FIDO2 key; then set the new `ANSIBLE_SSH_KEY`. Make a new Configure key as owner step 5 does: without a passphrase (ssh runs in batch mode and could never unlock one; the host job refuses such a key), straight into the environment.

### Backups on staging

Staging backs up to its own bucket with its own key and its own healthchecks.io check, never production's (question 3 of the staging amendments).

- **The script.** `~/.local/bin/tarubot-backup` is `ops/backup.sh`'s Quadlet path without a `.env`. It reads the bucket's endpoint, region and key, and the check's URL, from their Podman secrets (`podman secret inspect --showsecret`), never into an argument or an environment variable. A one-off `podman run` of the pinned PostgreSQL 18 image runs `pg_dump`, as hardened as Compose's backup service, with only the database's URL and CA mounted and `--log-driver=none`, so Podman keeps no copy of the plaintext. The container's shell hands the URL's parts (host, port, user, the decoded password, database) to `pg_dump` as libpq's `PG*` environment, so the password never sits in its arguments, which every user on the host can read. The dump streams into `age` for `age-recipients.txt`, then `curl` uploads it with SigV4 to `daily/`, and to `monthly/` on the 1st. A result of 4096 bytes or less is refused. There is no `env/` copy: staging has no `.env`.
- **The schedule.** `tarubot-backup.timer`, 04:30 UTC daily, `Persistent=true`. The first healthy deploy enables it, and so does a preflight, after its one backup: the new backup check then keeps hearing from the host every night, before the DevBot move as after it, and never goes down unnoticed.
- **The check** hears `/start`, then success with the size, or `/fail` naming the step. The script's last line is `<time> backup ok: tarubot-<stamp> (<n> bytes)`.
- **By hand:** `run0 --user=tarubot sh -c 'systemctl --user start tarubot-backup.service'`, which waits for the run. Logs: `journalctl --user -u tarubot-backup`.
- **Restore drill,** on @deconfined's machine: fetch the newest `daily/` object from staging's bucket, decrypt it with the `age` key, `pg_restore` it into a scratch local PostgreSQL, and count rows. The staging tool profile refuses a restore target, so there is no `check-restore.js` on staging.
- **Retention:** the bucket's lifecycle rules from `ops/bucket-lifecycle.xml`, as production's.
- **Point-in-time recovery** of the managed cluster covers staging's database too. A run's restore point is the moment the old instance stopped.

### tarubot-tool

`~/.local/bin/tarubot-tool` runs one maintenance tool in a one-off container, with the unit's settings file, the same secrets mounted the same way, and the unit's hardening:

```
tarubot-tool [--image ghcr.io/deconfined/tarubot@sha256:<digest>] TOOL.js [ARG...]
```

- **The image.** Without `--image`, the live one from `~/.config/tarubot/image`. The unit's `ExecStartPre` always passes its own `Image=`, so a crash restart never runs another release's `migrate.js`. Only `ghcr.io/deconfined/tarubot` by digest is accepted.
- **The tool** is a script in the image's `dist/scripts/`, such as `migrate.js` or `commands.js`. The container is `--read-only`, with no capabilities, `no-new-privileges`, no host environment and no name, so it never collides with the unit's own run. Its output streams through, and its exit status is the tool's. The wrapper prints names and paths, never a value.
- **As root on the host:** `run0 --user=tarubot sh -c '~/.local/bin/tarubot-tool migrate.js'` prints `Schema ready.` when the schema is current; `commands.js list` reads the registrations back. The tool guard's staging profile applies to every tool.

### Rebuilding staging

For a lost, broken or outdated host, or a new key or root hash:
1. Dispatch **Infrastructure** `operation=apply` with `replace=linode_instance.host["staging"]`, `allow_destroy` and `allow_access_removal`. The Plan job shows the instance's `replace`, updates of its two records and `+2 -2` on the access list, since the old addresses leave it. Approve the Apply job, then check production's readiness.
2. [Pin the new host's key](#infrastructure-opentofu) once its name resolves to the new addresses.
3. Dispatch **Deploy** `target=staging`, `action=configure`: the first Configure upgrades the host and reboots it. Dispatch it again: its PLAY RECAP must show `changed=0`.
4. Dispatch `action=deploy` with the live version. Its secrets are already in the environment, and `migrate.js` finds nothing pending on the database, which the rebuild didn't touch. Before the DevBot move a `deploy` ends `configured`; a `preflight` proves the database and backup instead.

### The staging database and role (2026-09-27)

@deconfined created staging's database and role on the managed cluster on 2026-09-27, before any staging credential existed. As the admin role, in `defaultdb`, after reading `SHOW max_connections` and the current use, and checking whether any provider role relied on PUBLIC's CONNECT (the provider's monitoring role, `_akmadmin_monitor`, did, so it got its own grant first). Connect with `sslmode=verify-full` and the cluster's CA. On this cluster (`max_connections` 50, 3 reserved) `<n>` was 16: staging's pool of 12, the writer lease and a few tools.

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

Each database's access list then names only its owner (`CTc`), `akmadmin` (`c`) and `_akmadmin_monitor` (`Tc`). `\password` keeps the password out of the statement text. `has_database_privilege` confirms that `tarubot_staging` can't connect to `tarubot`, that `tarubot` can't connect to `tarubot_staging`, and that PUBLIC holds neither. The staging tool profile and `bot.yml`'s database check accept exactly these names.

**The same rule for every later database on the cluster:** revoke PUBLIC's `CONNECT` and `TEMPORARY` as soon as it is created, and grant `CONNECT` only to the roles that need it. That includes `tarubot_restore` ("Restoring a dump" above). The tool guard checks only the maintenance tools. The bot itself is held back only by these grants: a database it can connect to is one where it can take the writer-lease lock (advisory locks belong to one database), and a staging bot holding it in a database production is repointed at would keep production unready.

The cluster's access list is OpenTofu's since 2.36.0: the first apply imports it with every entry it had, the production Compose host's included, in `db_allow_extra`.

### Owner steps for 2.36.0

In this order, each @deconfined's. Agents never create or change an environment, never read its secrets or variables, never hold a host key and never approve a run (REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)"); a read-only look at an environment's protection rules is allowed.

1. **Before anything else, in GitHub:** make sure the repository variable `STAGING_DEPLOY_ENABLED` is gone (it was never set; delete it if it exists), so the old staging job stays off and no merge can aim it at a host you are deleting. Then delete the `staging` environment's `DEPLOY_SSH_KEY` secret and its `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` variables, and confirm that `staging` accepts only `main` and has no required reviewer.
2. **Retire the old staging host before merging,** because its pull unit would stop at the new merge and page:
   - delete that Linode and its Cloud Firewall;
   - delete its A and AAAA records, and any SSHFP records left;
   - remove its two entries from the database's access list in Cloud Manager;
   - delete its pull-unit healthchecks.io check;
   - delete the staging-only Ansible key from the agent VM, or ask the agent to.
3. **Review the 2.36.0 pull request.** It changes what runs as root on staging and adds `infra.yml`. Merge it with a merge commit. Production's Deploy run then asks you to approve a restart of about 7 seconds onto 2.36.0 through the unchanged Compose path, with no bot change: approve it or leave it. Its **Deploy staging** job ends green with "no host in the staging environment".
4. **The Protect Main ruleset:** require review from code owners, 1 approval, and dismissal of stale approvals on push. Keep signed commits, merge commits only, `CI result` and the CodeQL gate. If you ever author a pull request yourself, add yourself as a bypass actor in "pull requests only" mode, since GitHub never counts an author's own approval. In the repository's Actions settings, turn off "Allow GitHub Actions to create and approve pull requests".
5. **On your own machine, prepare:**
   - a private Object Storage bucket for OpenTofu's state, and two access keys limited to it: one read-only (for `infra-plan`) and one read/write (for `infra`);
   - two Linode personal access tokens with an expiry: one with Linodes, Firewalls, Databases and Events all read-only (for `infra-plan`), and one with Linodes, Firewalls and Databases read/write and Events read-only (for `infra`). Give the read-only one a short expiry, such as 90 days, and renew it when it lapses: Databases read-only also shows each cluster's admin user and password, and no narrower scope exists, so it is as sensitive as the database's admin password and runs without an approval (a risk you accepted on 2026-09-29; REQUIREMENTS.md "Accepted risks");
   - two Cloudflare API tokens on the one zone: one with Zone Read and DNS Read (for `infra-plan`), and one with DNS edit (for `infra`);
   - a state passphrase of 32 or more random characters, kept in your password manager. The workflow and the module refuse a shorter one: it is all that protects the saved plan, which anyone signed in to GitHub can download for a day;
   - staging's Configure key pair, made in memory with no passphrase (ssh runs in batch mode and could never unlock one), its private half straight into the `staging` environment, and only its public half printed, for step 6:

     ```sh
     d=$(mktemp -d /dev/shm/ck.XXXXXX) && ssh-keygen -q -t ed25519 -N '' -C tarubot-configure-staging -f "$d/k" \
       && gh secret set ANSIBLE_SSH_KEY --env staging < "$d/k" && cat "$d/k.pub"; rm -rf -- "${d:?}"
     ```

     Until `TARGET_HOST` exists, runs end `no-host` before they read the key;
   - optionally, root's console password hash: `mkpasswd -m yescrypt`, or `openssl passwd -6`.
6. **The `infra-plan` and `infra` environments** ([ops/tofu/README.md](../ops/tofu/README.md#the-infra-plan-and-infra-environments)), in Settings → Environments, both with deployment branches "Selected branches and tags" and the one branch rule `main`, and no wait timer. A new environment starts with no branch rule, and `infra-plan`'s is the only thing between another branch's code and its secrets:
   - **`infra-plan`:** no required reviewers, so a plan never waits. Its secrets: `LINODE_READ_TOKEN`, `CLOUDFLARE_READ_TOKEN`, `TOFU_STATE_READ_ACCESS_KEY` and `TOFU_STATE_READ_SECRET_KEY` (the read-only ones from step 5), and the four shared ones below.
   - **`infra`:** required reviewer `deconfined` only; "Prevent self-review" **off**; "Allow administrators to bypass configured protection rules" **off**. Its secrets: `LINODE_WRITE_TOKEN`, `CLOUDFLARE_WRITE_TOKEN`, `TOFU_STATE_WRITE_ACCESS_KEY` and `TOFU_STATE_WRITE_SECRET_KEY` (the write ones), and the four shared ones below.
   - **In both, with exactly the same values:** `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `TOFU_STATE_PASSPHRASE`, and `TOFU_VARS` ([ops/tofu/README.md](../ops/tofu/README.md#tofu_vars)). The saved plan records `infra-plan`'s bucket and endpoint, and the apply writes the new state there, so `infra`'s read/write key must be for that same bucket; Apply decrypts with its own passphrase, and refuses a plan made with a `TOFU_VARS` other than its own. `TOFU_VARS` holds:
     - `hosts` = `{}`;
     - `database_ids` = `{"primary": <id>}`;
     - `db_allow_extra` = exactly the access list Cloud Manager shows now, in its CIDR form, including the production Compose host's IPv4 and IPv6;
     - `root_keys` = your FIDO2 line (with `verify-required`) and an optional operator key;
     - `configure_keys.staging` = the Configure key's public half;
     - `root_password_hash` and `cloudflare_zone_id`.
   - **Then read both back once,** before the first dispatch, and again after any change to either. For each of `infra-plan` and `infra`, `gh api repos/deconfined/tarubot/environments/<name> --jq .deployment_branch_policy` must show `protected_branches` false and `custom_branch_policies` true, and `gh api repos/deconfined/tarubot/environments/<name>/deployment-branch-policies --jq '[.branch_policies[] | {name, type}]'` exactly one entry, `main` of type `branch`. For `infra`, `gh api repos/deconfined/tarubot/environments/infra --jq '{can_admins_bypass, rules: [.protection_rules[] | select(.type == "required_reviewers") | {prevent_self_review, reviewers: [.reviewers[] | .type + " " + .reviewer.login]}]}'` must show `can_admins_bypass` false and one rule, `prevent_self_review` false, with the one reviewer `User deconfined`. No run checks these settings again: like the ruleset, they are yours to keep right (REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)").
7. **The first apply, import only.** Dispatch **Infrastructure** with `operation=apply`. The Plan job runs without an approval, and its summary must show only `import linode_database_access_controls.db["primary"] +0 -0`; anything else means a value is wrong, so reject the Apply job, fix `TOFU_VARS` in both environments and dispatch again. Approve the Apply job only for exactly that line.
8. **Build staging.** Add the `staging` entry to `TOFU_VARS`' `hosts` in both environments (role `staging`; the label is the Linode's display name, so leave the domain out of it). Dispatch `operation=apply`: the Plan job must show creates for the firewall, the instance and the A and AAAA records, and one access-list update that only adds entries (`+2 -0`). Approve the Apply job. Then check production's readiness: the heartbeat, and `/sync status`.
9. **Pin the new host's key** from your own machine ([above](#infrastructure-opentofu)), then set `TARGET_HOST` (the DNS name) in the `staging` environment (`ANSIBLE_SSH_KEY` went in at step 5).
10. **Configure it:** dispatch **Deploy** with `target=staging`, `action=configure` and `version=2.36.0`. The first run upgrades the host and reboots it. Dispatch it again: its PLAY RECAP (host `target`) must show `changed=0`.
11. **Staging's values** in the `staging` environment, all new and staging-only: `DATABASE_URL` (`tarubot_staging`, its password percent-encoded) and `DATABASE_CA_CERT`; `REPORTS_GITHUB_TOKEN` (the reports token, which the bot reads as `GITHUB_REPORTS_TOKEN`: GitHub refuses a secret name that starts with `GITHUB_`) and `HEALTHCHECKS_PING_URL`; `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_REGION`, `BACKUP_STORAGE_ACCESS_KEY` and `BACKUP_STORAGE_SECRET_KEY` with a new key pair; and `HEALTHCHECKS_BACKUP_URL` with a new check. Single-line values carry no stray spaces or newlines. Leave `DISCORD_TOKEN` unset until the DevBot move. Then dispatch `target=staging`, `action=preflight`, `version=2.36.0`: it must end `preflight-ok`. It also enables the nightly backup, so the new backup check keeps getting pings from here on.
12. **The restore drill** on your machine ([Backups on staging](#backups-on-staging)).
13. **Revoke what the new values replaced:** the old staging bucket key, reports token and checks; retire the old staging `.env` copies as you see fit. Then ask the agent to download and grep the staging runs' logs (read-only) for the host's name, its addresses and any secret shape, and to record the result, before 2.36.1.

### Not yet

| Release | What |
| --- | --- |
| 2.36.1 | CrowdSec, simplified: its switch as a `staging` or `production` variable, the vendor repository the normal way, and the set-only nftables bouncer, after staging shows a clean second Configure. |
| 2.36.2 | **The DevBot move.** Staging's secrets and a preflight first. Then local DevBot moves to that same release and stops, and the schema heads are checked equal; @deconfined restores its database on the staging host, resets DevBot's token into the `staging` environment only, and dispatches a `bot` run. At least a week of soak follows, then a patch retires local DevBot. |
| 2.37.0 | **Production on the simple pipeline.** Any pending migration reaches the old host first, and the new host and its secrets are ready. 2.37.0 merges in the working session that also cuts over, and nothing else merges until the cutover is done. Its preflight proves the new host; then, while the approval waits, @deconfined stops the old bot, shuts the old Linode down, resets the token into the `production` environment and approves (#62 answer 1). The old host stays off as a fallback for a week. |
| 2.38.0 | **The cleanup,** after a settled week, once the fallback is given up and the shared secrets are rotated: `ops/deploy.sh`, the Compose production files, `scripts/host-env-backup.ts`, the production `.env` and its copies, `DEPLOY_ENABLED`, the `notify` job and the old runbooks. |

### The old staging host (2.32.0 to 2.34.0)

Before 2.36.0 the staging host was built by hand and configured by the playbook's two plays: root's, then `tarubot`'s. It never ran a bot. Its pieces are all gone in 2.36.0:
- 2.33.0's Quadlet modes of `ops/deploy.sh`, now unused;
- `ops/quadlet/` with `secrets.sh`, `check-env.sh` and `run-tool.sh`;
- the root-owned host lock `/run/tarubot/host.lock`;
- the playbook's `start` tag;
- 2.34.0's pull unit, `tarubot-host-config`, which applied `main` to its own host and checked question 14's signatures.

[VERIFICATION.md](VERIFICATION.md) and the changelog keep their record. The owner steps done for it on 2026-09-27 and 28 still stand where they concern the cluster (the database and role above) and GitHub (the `staging` environment and the merge methods).
