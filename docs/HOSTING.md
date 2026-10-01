# Host operations

Use [DEPLOYMENT](DEPLOYMENT.md) for delivery/setup, [configuration](CONFIGURATION.md) for settings and [OpenTofu](../ops/tofu/README.md) for infrastructure. Production currently uses Compose; staging has the Quadlet path. This guide does not assert which host/version is live. The agent rule, confirmed on 2026-09-26, is in [AGENTS.md](../AGENTS.md); real host access and recovery belong to the owner.

## Everyday checks

On production, as its operator in `~/tarubot`:

```sh
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=100 tarubot
docker compose -f docker-compose.production.yml exec -T tarubot \
  bun -e 'console.log(await (await fetch("http://127.0.0.1:3000/health/ready")).text())'
```

On a configured Quadlet host, log in as root and use `run0`:

```sh
run0 --user=tarubot systemctl --user status tarubot.service
run0 --user=tarubot journalctl --user -u tarubot.service -n 100 --no-pager
run0 --user=tarubot podman inspect --format '{{.State.Health.Status}}' tarubot
run0 --user=tarubot sh -c '~/.local/bin/tarubot-tool commands.js list'
```

Under SELinux, directly launching a home executable through `run0` can fail with `203/EXEC`; the shell form avoids it. The bot account has linger and no SSH login.

Readiness needs database/Discord connectivity and the writer lease. Lodestone/visibility status is informational; incomplete upstream data is not an empty roster. `/sync status` and `/config validate` expose operational problems. See [monitoring](../site/src/content/docs/deploy/monitoring.md) for heartbeat and backup checks.

## Deployment outcomes

Read the target job's result. Production and staging currently run independently.

| Result | Action |
| --- | --- |
| `deployed` | Verify readiness, command inventory and expected behavior |
| `superseded` / `already-live` | Confirm the intended live release |
| `no-host` / `configured` | Finish setup; no healthy bot was proven |
| `preflight-ok` | Database/backup checks passed; no bot/Discord acceptance |
| `refused` | Fix the precondition before a fresh authorized dispatch |
| `recovered` | Compose restored the previous release; verify it and diagnose the failed candidate |
| `needs-you` / `unhealthy` / `failed` | Inspect phase, writer and live schema before recovery |
| `unreachable` / `outcome-unknown` | Inspect the host before retrying; work may already have started |

Quadlet leaves an unhealthy candidate in place: no automatic rollback. A previous-version staging `action=bot` dispatch is safe only with verified unchanged schema and a fenced writer. After a committed migration, fix forward or restore in an owner-approved window. Missing restore-point output does not prove no migration committed.

The Quadlet play stops the writer and records `~/.config/tarubot/recovery-boundary.json` before installing the candidate. Preserve its stop timestamp and previous/candidate image/schema context. An old image's schema head does not prove the database's current head; a timestamp does not prove usable provider PITR.

Compose has stage-aware automatic recovery, but an old image cannot undo a committed migration. Its private worker log is `~/.local/state/tarubot-deploy/runs/<run>/worker.log`. Never start a second writer or delete run state to unstick a deployment.

For unresolved failure, stop/fence writes, record the live image and schema, and inspect the deployment phase, recovery boundary and available backup/PITR sources. Choose fix-forward or a verified restore, then start one matching release and verify health and commands. If Actions is unavailable, manual recovery still needs the owner's explicit go-ahead. Use the matching release's tools and [maintenance profiles](CONFIGURATION.md#maintenance-tool-profiles).

## Backups

Recovery sources are managed PostgreSQL PITR, independent age-encrypted dumps and production's stopped-writer pre-migration dump. Quadlet records a stop-time PITR boundary. Verify recoverability with restore drills.

- Production runs `ops/backup.sh` at 04:30 UTC via cron, uploading a dump and encrypted `.env` copy.
- Staging runs the persistent user `tarubot-backup` timer at 04:30 UTC. Healthy deployment/preflight enables it; Podman's rootless secret store survives reboot without GitHub access.
- Dumps stream from `pg_dump` to age without plaintext disk. [Public recipients](../ops/age-recipients.txt) are tracked; the owner holds the decryption key and an offline second copy.
- [Retention](../ops/bucket-lifecycle.xml) is 30 days for daily/settings copies and 365 for monthly copies. A host credential can delete objects; keep independent copies.

Owner-run staging checks:

```sh
run0 --user=tarubot systemctl --user list-timers tarubot-backup.timer
run0 --user=tarubot journalctl --user -u tarubot-backup.service -n 50 --no-pager
run0 --user=tarubot sh -c '~/.local/bin/tarubot-backup'
```

After production settings changes, the operator can verify an encrypted copy with `bun run host:env-backup -- --host tarubot@<production host> --identity <owner age key>`. Staging has no `.env`; use its configured backup path.

### Restore a dump

1. Stop writes and establish the writer-lease gate. Never restore over the live database.
2. Choose a new cluster or production's same-cluster `tarubot_restore`. Before loading, revoke PUBLIC's `CONNECT`/`TEMPORARY`, preserve provider monitoring access and verify staging cannot connect.
3. Fetch/decrypt on the owner's protected machine. Load the isolated target with `pg_restore --no-owner --no-privileges --exit-on-error` and verified TLS.
4. Run the matching release's `check-restore.js` against source and target. Before migration, select the old schema head explicitly or use the deployed build; see [maintenance profiles](CONFIGURATION.md#maintenance-tool-profiles) and [persistence](PERSISTENCE.md).
5. Confirm image/schema/access, change only owner-authorized settings and start one bot. Verify readiness, inventory and data. Retain the source until acceptance; securely remove plaintext scratch artifacts.

Staging cannot create databases and has no restore target in its tool profile; the owner performs its drill/reset separately. PITR creates a new cluster, requiring checks of address, CA and access controls. An image rollback cannot substitute for database recovery. See the site's [operations guide](../site/src/content/docs/deploy/operations.md) for tool usage.

## Rotation and rebuilds

- **Staging runtime secret:** set the new value, dispatch the live version with `action=bot`, verify health, then revoke the old credential. Coordinate database-password changes in one window. Missing secrets on an existing bot are refused.
- **Host key/access key:** cloud-init is creation-only. Follow [rebuilds](../ops/tofu/README.md#rebuilding-a-host), verify and explicitly repin the new host key.
- **Compose host loss:** fence the old host, retain the managed database and encrypted settings, then restore the matching Compose configuration and image on the owner-provisioned replacement. Verify schema, TLS/access and one writer before acceptance. Rebuilding a VM does not require replacing its database.
- **Suggestion app key:** production only. Update settings, restart and verify before revoking the old key. An empty client ID disables suggestions without blocking the bot; see [configuration](CONFIGURATION.md).

dnf-automatic is the Quadlet updater and may reboot after updates. Verify that logs, health checks and backups survive restarts. An offline test does not prove the live host was configured. Recovery assumptions and limits are recorded in [the threat model](THREAT_MODEL.md).
