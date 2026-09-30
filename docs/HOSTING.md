# Host operations

Use [DEPLOYMENT.md](DEPLOYMENT.md) for delivery/setup and [the OpenTofu runbook](../ops/tofu/README.md) for infrastructure. This guide distinguishes the current production Compose host from the staging Quadlet path; it does not assert which version or host is live.

## Everyday checks

On production, as its operator in `~/tarubot`:

```sh
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=100 tarubot
docker compose -f docker-compose.production.yml exec -T tarubot \
  bun -e 'console.log(await (await fetch("http://127.0.0.1:3000/health/ready")).text())'
```

On a configured Quadlet host, log in as root and run user tools with `run0`, not plain `su`/`runuser`:

```sh
run0 --user=tarubot systemctl --user status tarubot.service
run0 --user=tarubot journalctl --user -u tarubot.service -n 100 --no-pager
run0 --user=tarubot podman inspect --format '{{.State.Health.Status}}' tarubot
run0 --user=tarubot sh -c '~/.local/bin/tarubot-tool commands.js list'
```

Under SELinux, launching a home-directory executable directly through `run0` can fail with `203/EXEC`; the shell form above avoids it. The bot account has linger and no SSH login.

Readiness needs database/Discord connectivity and the writer lease. Lodestone/visibility status is informational; degraded upstream data must not be read as an empty roster. `/sync status` and `/config validate` expose operational work/capability problems. The heartbeat pings every five minutes while ready; backup checks are independent. See the site's [monitoring page](../site/src/content/docs/deploy/monitoring.md).

## Deployment outcomes

Read the **target job's** result, not just the run's conclusion. Production and staging currently run independently; staging failure can coexist with successful production.

| Result | Action |
| --- | --- |
| `deployed` | Verify readiness, command inventory and expected behavior |
| `superseded` / `already-live` | No new deployment; confirm the intended live release |
| `no-host` / `configured` | No healthy bot was proven; finish host/token setup |
| `preflight-ok` | Database/backup checks passed, not Discord or a bot deployment |
| `refused` | Read the reason; fix the precondition before a fresh authorized dispatch |
| `unhealthy` / `failed` | Inspect the reported phase and live schema before choosing recovery |
| `unreachable` / `outcome-unknown` | Inspect host state before retrying; a command may already have started |

Quadlet deployment leaves an unhealthy release in place: **no automatic rollback**. A same-schema rollback is a fresh staging `action=bot` dispatch of the previous version. Across a committed migration it is refused; fix forward or restore under an owner-approved window. A missing/`-` restore point is not evidence that migrations did not commit. Confirm the database's schema head and writer activity independently.

Before installing/reloading a candidate, the Quadlet play stops the existing writer, requires its stop timestamp and writes private `~/.config/tarubot/recovery-boundary.json` with that boundary and previous/candidate image/schema context. A failed start can therefore leave a boundary even when no workflow result returns. The previous image's schema head does not prove the live database's schema, and the timestamp does not prove a usable provider PITR point. Preserve the record while inspecting/fencing the writer and checking recovery sources; it never authorizes an image rollback or restore by itself.

Production Compose has its own stage-aware automatic recovery. A schema-preserving restart can roll back; a committed migration cannot be undone by an old image. Never manually start a second worker or delete a run directory to “unstick” a deployment. See the [frozen Compose recovery reference](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/HOSTING.md#outcomes) for its result codes and [manual recovery](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/HOSTING.md#updating-to-a-release) when Actions is unavailable.

## Backups

There are three recovery sources: managed PostgreSQL PITR, independent age-encrypted dumps, and production's stopped-writer pre-migration dump. Quadlet records a stop-time restore point for PITR rather than automatically restoring. Verify recoverability; backup success alone is not a restore drill.

- Production runs `ops/backup.sh` at 04:30 UTC via cron; it uploads the dump and encrypted `.env` copy.
- Staging runs `tarubot-backup` from a persistent user timer at 04:30 UTC. A healthy deploy/preflight enables it. Runtime and backup secrets remain in Podman's rootless store, so restarts/reboots need no GitHub access.
- Dumps stream from `pg_dump` to age, never plaintext disk. Public recipients are in [ops/age-recipients.txt](../ops/age-recipients.txt); only the owner holds the decryption key, with an offline second copy.
- [Retention](../ops/bucket-lifecycle.xml): daily/settings 30 days, monthly 365 days. A host's storage credential can delete copies; encryption is not deletion protection. Keep independent copies for disaster recovery.

Owner-run staging checks:

```sh
run0 --user=tarubot systemctl --user list-timers tarubot-backup.timer
run0 --user=tarubot journalctl --user -u tarubot-backup.service -n 50 --no-pager
run0 --user=tarubot sh -c '~/.local/bin/tarubot-backup'
```

Production can take a verified encrypted settings copy with `bun run host:env-backup -- --host tarubot@<production host> --identity <owner age key>`, from the operator machine. Run after settings changes. This tool is not for staging, which has no `.env`.

### Restore a dump

1. Stop writes for a consistent recovery window and establish the writer-lease gate. Never restore over the live database.
2. Choose a new cluster or production's same-cluster `tarubot_restore`. Before loading data, revoke PUBLIC's `CONNECT`/`TEMPORARY`, preserve the provider's monitoring access, and verify the staging role cannot connect. The application owner keeps its own access.
3. Fetch the encrypted object and decrypt it on the owner's protected machine. Use `pg_restore --no-owner --no-privileges --exit-on-error` against the isolated target, with verified TLS.
4. Run the matching release's `check-restore.js` against source and target. Before a migration, select the old schema head explicitly or use the deployed build. Follow [maintenance-tool profile boundaries](CONFIGURATION.md#maintenance-tool-profiles).
5. Confirm the required schema/image match, adjust only owner-authorized settings, then start exactly one bot. Verify readiness, inventory and data. Retain the recovery source until acceptance passes; remove plaintext scratch artifacts securely.

Staging's role cannot create databases and its tool profile has no restore target. The owner performs its restore drill/reset separately. Provider PITR forks a new cluster: new address, CA and access controls must all be checked. Restore automation must never assume a post-migration image rollback is safe.

The [Compose database restore reference](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/HOSTING.md#daily-dumps) preserves exact owner-side commands; substitute current private values and verify them before use. Generic restore tooling is on the site's [operations page](../site/src/content/docs/deploy/operations.md).

## Rotation and rebuilds

- **Staging runtime secret:** the owner sets one new environment value, dispatches the live version with `action=bot`, verifies health, then revokes the old credential. For a database password, coordinate the database change and dispatch in one window. The playbook refuses a missing secret on an existing bot.
- **Host access key/hash:** cloud-init is creation-only. Follow [OpenTofu rebuilds](../ops/tofu/README.md#rebuilding-a-host); a rebuilt host's key must be explicitly verified/repinned. Never silently relearn a mismatch.
- **Compose production host loss:** retain the database and latest encrypted settings, stop/fence the old host, and follow the [frozen rebuild reference](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/HOSTING.md#rebuilding-the-host). Do not replace the managed cluster merely to rebuild a VM.
- **Public-suggestion app key:** production only; the owner rotates it, updates settings, restarts and verifies before revoking the old key. An empty client ID disables suggestions without blocking the bot. The [app operations record](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/HOSTING.md#public-suggestions-the-github-app) preserves the probe/moderation procedure.

dnf-automatic is the Quadlet hosts' only updater and may reboot after daily updates (staging around 06:00 UTC, production's configured schedule 10:00 UTC). Logs, health checks and backups must survive unattended restarts; do not claim that path verified merely because an offline test passed.

The agent rule was confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and widened to every environment/Infrastructure. [AGENTS.md](../AGENTS.md) carries the binding wording: the owner holds keys, secrets and approvals; agents may read public evidence and rehearse offline, not operate real hosts.
