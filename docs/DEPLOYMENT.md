# Release delivery and owner operations

The production baseline is Docker Compose on an owner-provisioned Linode host, with the existing managed PostgreSQL database. This runbook describes repository implementation, **not an observed live cutover**. Merged [PR #74](https://github.com/deconfined/tarubot/pull/74) authorizes source replacement only. Provisioning, credentials, protection rules, host installation and the first cutover are separate owner operations under [AGENTS](../AGENTS.md).

Self-hosters use the site's [Compose installation](../site/src/content/docs/deploy/install.md) and [operations guide](../site/src/content/docs/deploy/operations.md). Upstream production uses `docker-compose.production.yml` and central host-only settings from `production.env.example`; these are not another application's template. See [configuration](CONFIGURATION.md) and [threat model](THREAT_MODEL.md).

The forced entry performs routine upgrades of an **existing healthy Compose baseline**. Preflight requires exactly one ordinary healthy running bot; an empty, stopped or unhealthy host is refused. Replacement-host bootstrap and recovery are owner-run procedures, not automatic deployment modes.

## Release flow

1. **Review:** protected `main`, current CI/security checks and owner code-owner approval; merge commits only. Maintenance retains the application SemVer. An explicit version increase declares a release; see [CONTRIBUTING](../CONTRIBUTING.md).
2. **Build and publish:** `publish.yml` orchestrates reusable `ci.yml`, then builds AMD64/ARM64 candidates and calls `scan.yml` for both exact runtime child digests. Existing published version tags are never overwritten. A failed candidate is not an authorized release.
3. **Attest:** the exact build-returned index digest receives GitHub build provenance from `publish.yml` on `main`. Fixable high/critical findings, scanner/registry errors and expired exceptions block signing/promotion. The default exception policy is empty; an exception needs exact reviewed finding fields, a reason/issue and an expiry within 30 days. `latest` advances only after attestation.
4. **Approve and deliver:** publication calls reusable `deploy.yml`. Exactly one job uses the `production` environment and requests the owner's approval. The repository variable `DEPLOY_ENABLED` must be exactly `true`; a skipped deployment proves nothing about the host. No separate notification or staging gate exists. Admission validates the source commit's version/main ancestry and production protection policy before and after the queue/approval, then verifies the exact attestation identity, source commit and `refs/heads/main` before SSH.
5. **Host mutation:** one strict SSH request invokes the owner-installed forced command: `deploy <version> <commit> <sha256:digest> <run-id>`. Both ends validate input. The host serializes with flock, fetches the exact commit into an isolated worktree, pulls the exact digest and verifies image version/revision labels. It refuses downgrades and any different digest or commit for the same version.
6. **Writer boundary:** persist pending state **before stopping the bot**. Stop the writer, take an encrypted offsite database/settings backup, migrate with the exact new image, register commands globally, start that image with automatic restart disabled and observe sustained readiness plus exact digest/version/schema/writer identity. Retain the info logs `Modules loaded` and `Database writer lease acquired` with their exact text.
7. **Record:** durable accepted identity/worktree state is recorded only after observation. Only then enable the routine `unless-stopped` restart policy and clear pending. A failure after the pending boundary, including backup, migration, registration, startup, observation or restart-policy failure, leaves pending state for owner reconciliation. There is no automatic rollback. An uncatchable loss can leave a process running; inspect its actual state. A stale pending marker can survive after durable acceptance, but an unaccepted target cannot automatically restart.

An unchanged version does not publish another image or deploy a maintenance commit. A maintenance fix may finish a release whose tag was never published, but cannot replace an existing tag. Workflow reruns never authorize another host mutation; recovery uses a **fresh owner-requested** Deploy dispatch with explicit version, full commit and digest, after reconciliation. A published image or successful SSH exit alone is not live acceptance.

Production publication/deployment accepts stable numeric `X.Y.Z` only, each component at most four digits. The version gate can check prerelease SemVer, but publication treats non-stable versions as verification-only before registry reads/writes; it neither publishes nor deploys prerelease images.

## Signed build provenance

For owner verification of an exact image, substitute its index digest and full source commit:

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@sha256:<digest> \
  --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

Keep the exact `--cert-identity`; a broader signer-workflow pattern is insufficient. Image labels are checked in addition to, not instead of, provenance. Normal delivery refuses unsigned releases. Actions use SHA-pinned tools/checkouts; only attestation receives the required OIDC permissions.

## Manual Linode provisioning

Owner checklist, performed privately:

1. Preserve the existing managed database and live bot. Rebuilding the host does not require replacing its database. If provisioning another host, verify its address can reach the Lodestone before relying on it.
2. Provision/maintain Linux, Docker Engine/Compose v2, Git, OpenSSH, flock/util-linux, age, the backup upload tool and a PostgreSQL client compatible with the database. Configure time synchronization, OS updates and firewall rules manually. Expose no bot health port publicly.
3. Create the `tarubot` account and its approved Docker access. The existing account home is `/opt/tarubot`; the checkout is `/opt/tarubot/tarubot`, expressed by scripts as `$HOME/tarubot`. Review ownership and permissions; Docker access is effectively privileged.
4. Retain the direct managed PostgreSQL connection, verified CA/hostname, application database/user and access restrictions. Do not use a transaction-mode pool: the writer lease requires a session connection.
5. Prepare `$HOME/tarubot/.env` privately from the production template. Runtime Discord/database/GitHub App credentials and backup settings remain on the host, never in runner inputs. Use mode 600 and keep the file outside release worktrees. Confirm the resolved application identity and managed tool-profile constraints.
6. Configure encrypted backup recipients, offsite upload credentials/retention and the owner-held age decryption key plus an offline second copy. Configure and check the daily schedule; scheduling is manual, not a workflow side effect.
7. Verify the host's Ed25519 key out of band, preferably against the provider console. Generate the deploy credential outside agent sessions. Never use accept-new/keyscan to establish trust during delivery.
8. Protect `main` with owner code-owner review, required current checks, signed commits/merge policy and stale-approval dismissal. `production` must have the sole required reviewer `User: deconfined`, `prevent_self_review=false` so the owner can approve their own release, `can_admins_bypass=false`, and a custom branch policy containing only branch `main`. Admission reads this policy before and after approval; the owner alone changes it.
9. Set production secret `DEPLOY_SSH_KEY`, production variable `DEPLOY_HOST` and production variable `DEPLOY_KNOWN_HOSTS` (one pinned Ed25519 known_hosts line for that host). Delivery logs in as `tarubot`. The activation switch `DEPLOY_ENABLED` is a **repository variable**, so non-environment publication/admission jobs can read it. Keep it off until cutover is ready, then the owner sets it to exactly `true`; this reset changes neither its scope nor its value.

## First-host setup: owner checklist

Install the reviewed entry **before** switching workflow source. Old and new deploy protocols are not interchangeable. This checklist integrates delivery with the existing healthy Linode baseline; a first replacement host needs a separately approved manual bootstrap.

1. Fence old workflow/cron/manual deployment writers during the owner-approved window. Retain the old checkout/settings and record actual image, version, schema and writer state privately.
2. Install the reviewed `ops/deploy.sh` as `$HOME/.local/libexec/tarubot-deploy` and `ops/backup.sh` as `$HOME/.local/libexec/tarubot-backup`, outside the pinned root checkout. Make them executable and operator-owned/protected. Point the owner-managed daily schedule at the stable backup entry, not the old checkout script. These entries never self-update; future updates are reviewed owner installations.
3. Restrict the deploy public key in `authorized_keys` with `restrict,command="env -i HOME=/opt/tarubot PATH=/usr/local/bin:/usr/bin:/bin SSH_ORIGINAL_COMMAND=\"$SSH_ORIGINAL_COMMAND\" /opt/tarubot/.local/libexec/tarubot-deploy"`. Preserve `SSH_ORIGINAL_COMMAND` as one quoted value so the entry can validate the request; never evaluate it as shell code. Trust the operator-controlled sshd PATH, not client overrides; sshd must not accept client environment overrides through `AcceptEnv`. No forwarding, PTY or unrestricted shell. Keep operator recovery access separate; never share its key with the runner.
4. Check central settings, managed TLS/access, backup encryption/upload and the stable Compose project `tarubot`. Worktrees live under private `$HOME/.local/state/tarubot-deploy/releases`; the central `.env` is reused without image-pin edits.
5. Leave the existing healthy bot running for admission; fence competing deployment jobs/operators, **not the bot ahead of dispatch**. Inspect durable state and confirm a usable encrypted backup/restore boundary. The approved forced entry writes pending state and then stops that writer itself. For a replacement host, first fence the old host's writer and manually establish a matching healthy exact-release Compose baseline and reconciled `current` state in the owner-approved window. An empty/stopped host cannot bootstrap through Deploy. Any unresolved pending state requires recovery first.
6. Authorize a fresh exact release through GitHub production approval. Check the host's sustained readiness, exact image/schema/version, sole writer lease, global command inventory and representative authorized Discord behavior privately. Verify backup scheduling and perform a restore drill. Record release/commit, role, observed checks and unexercised cases in the issue/PR, not this guide.

No repository test, green build or approval alone proves these owner steps occurred. This reset performs no live provisioning, environment change, secret access, dispatch, deployment or database mutation.

## Everyday observation and outcomes

Use the worktree and exact image named by private `current` state, the central `.env`, and `TARUBOT_IMAGE_DIGEST=<current.digest> docker compose --project-name tarubot --env-file "$HOME/tarubot/.env" -f <current-worktree>/docker-compose.production.yml` for owner-run inspection/tools. The manifest requires this exact digest; there is no default tag. Check `ps`, private logs, `/health/ready`, command inventory, `/sync status` and `/config validate`.

Readiness requires database, writer lease, Discord and effects. Lodestone and visibility diagnostics are informational; an incomplete upstream roster is never an empty roster.

Remote output is limited to fixed `step` tokens (`preflight`, `fetch`, `pull`, `stop`, `backup`, `migrate`, `register`, `start`, `observe`, `record`) and a `result` token:

| Result | Meaning / owner action |
| --- | --- |
| `deployed` | Host observation completed; still perform appropriate live behavior acceptance |
| `already-live` | Exact digest-named runtime passed sustained observation; no migration/registration replay |
| `refused` | Inspect the private precondition failure before a fresh authorized request |
| `needs-owner` | Preserve pending/logs and reconcile; never blindly retry |
| Connection failure / missing result | Outcome is unknown; the remote operation may continue or have completed |

Private state lives in `$HOME/.local/state/tarubot-deploy`: `host.lock` serializes delivery and scheduled backup, `pending` retains unresolved intent, `current` records successful identity/worktree, and private logs retain diagnostics. Never remove run state to bypass a refusal.

## Backups and restore

`ops/backup.sh` retains age encryption, settings backup and offsite storage. Host settings include `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY`, `BACKUP_STORAGE_REGION` and optional `HEALTHCHECKS_BACKUP_URL`. Public recipients are in [age-recipients.txt](../ops/age-recipients.txt); [bucket lifecycle](../ops/bucket-lifecycle.xml) specifies daily/settings retention of 30 days and monthly retention of 365 days. The owner verifies the actual storage lifecycle and daily schedule; these repository files do not prove live configuration.

Dumps stream through age without plaintext disk; database and `.env` copies upload encrypted to the existing daily/monthly/env prefixes. The stable daily entry defaults to central `$HOME/tarubot/.env` and its `ops/age-recipients.txt`, selecting successful `current.worktree` and `current.digest` automatically. `TARUBOT_ROOT` and `TARUBOT_COMPOSE_FILE` override central settings and the release manifest when needed; delivery runs the exact new worktree's backup with its digest under the inherited lock. The daily entry independently takes that shared host lock. A failed backup blocks migration/start. Keep independent copies: host upload credentials can delete objects, and same-account storage is not independent disaster recovery.

Owner restore checklist:

1. Fence automation/manual writers, stop the bot and verify no writer lease holder. Preserve damaged/current data, pending state and logs. Never restore over the live database.
2. Choose an isolated new target or the managed production restore database permitted by the tool profile. Revoke PUBLIC CONNECT/TEMPORARY as appropriate, preserve provider monitoring access and prevent unrelated clients from connecting.
3. Fetch/decrypt privately. Restore with verified TLS and `pg_restore --no-owner --no-privileges --exit-on-error`. Keep plaintext scratch artifacts restricted and remove them after acceptance.
4. Use the matching release's `check-restore.js`. Source/copy schema must match; before migration use the deployed image or explicitly select the old schema head. Exact row comparison needs a stopped-writer dump and no later source writes.
5. Rehearse pending migration only in the isolated permitted target. Verify recovered data/schema, credentials/access and the matching image before starting one bot.
6. Account for Discord effects already sent: restore cannot undo them; update-post baselines may need owner reconciliation to avoid repeat announcements. Verify readiness, command inventory and data; retain the source until acceptance.

Managed PITR, where configured and proven, is another recovery source, not a substitute for independent encrypted dumps. A timestamp alone does not prove usable PITR. A provider restore/new cluster needs fresh address, CA and access checks.

## Pending recovery, rotation and host loss

A pending marker blocks every new deployment. The owner inspects intent, private phase/logs, container identity, actual database schema, writer state and available backup/PITR. Choose fix-forward or a verified isolated restore; an old image cannot undo a committed migration. Migration and global command registration may have committed even if their acknowledgement was lost. Preserve evidence and reconcile the actual outcome. Before clearing pending for routine delivery, manually establish exactly one healthy matching release/container, verify its schema/writer state and reconcile durable `current` identity/worktree state. Only then clear pending and use a fresh explicit owner-requested dispatch. A fresh dispatch does not repair an unhealthy/stopped baseline; never rerun the uncertain operation or bypass downgrade/same-version protections.

If GitHub is unavailable, manual recovery still requires the owner's explicit go-ahead and the same writer/image/schema boundaries. There is no automatic rollback.

- **Runtime credentials:** update central settings privately, recreate the intended exact container in an approved window, verify, then revoke the old credential. Coordinate database passwords in one window. A simple Compose restart keeps the old container environment.
- **Host/deploy keys:** verify any replacement out of band, update the pin/forced key through owner-controlled steps and revoke the old key. Never silently repin to bypass a refusal.
- **Suggestion App:** production only; verify settings/recreation before revoking its old key. An empty client ID disables suggestions without blocking startup.
- **Host loss:** fence the old host, retain the managed database and encrypted settings, manually provision the replacement and install the reviewed entries/pin. In an approved manual bootstrap, recover exact image/schema/settings, start one writer, reconcile durable `current` state and prove sustained health/backups. Routine pipeline upgrades resume only after that healthy baseline exists. Host replacement does not authorize database replacement.
