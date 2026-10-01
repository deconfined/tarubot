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

### Infrastructure and enrollment records

Recovery is an owner-run procedure. Fence all Infrastructure and Host writers, keep durable records enabled, and preserve the failed run's encrypted plan, private inputs/state and every relevant object version. Work privately from its reviewed source and original backend settings. Use standard S3 [version listing](https://docs.aws.amazon.com/cli/latest/reference/s3api/list-object-versions.html) and [version reads](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object.html), and the existing `RecordCodec`, `hostRecordCodec` and `S3ControlStore` helpers. Derive `actualState` with `stateEvidence(rawState)` from native private state. Never roll native state back to satisfy an old record, bulk-restore the bucket, delete pending markers or retry an uncertain write without checking its actual outcome.

Choose the repair from verified outcomes:

| Observed outcome | Owner action |
| --- | --- |
| Apply never started; native state exactly matches the intent's `before`; read-only provider/refresh checks confirm no remote effects or enrollment activity | Authenticate the prior completed generation and its links, and require `current` still to name that predecessor and the original pending generation. Restore its selected `current` ciphertext version to the same bucket/key, preserve the abandoned intent/history, then require `InfrastructureRecords.inspect(actualState)` to succeed. This shortcut requires a prior complete generation; an already restored valid head needs no write. |
| Apply partially completed, evidence is missing, or provider/state/history disagree | Keep pending. Review a repair of the actual effects before changing records. A failed job or a no-change plan alone does not establish completion. |
| Apply completed but enrollment or record completion was interrupted | Verify the exact saved plan against actual show and matching raw-state reads. Prepare the per-object repair below; ordinary `enroll` and `finish` are not retry commands. |
| Completion and pending clear already succeeded despite a lost acknowledgement | Reopen the complete infrastructure links, host records and DNS evidence. If all agree and no pending marker remains, a new authorized dispatch needs no record repair. |

For verified completed Apply, keep the original generation `G`, intent, run and binding. Require the same native state lineage and a serial later than `intent.before`. Recover the first persisted key from version history; verify the same instance/addresses, rescan only to confirm that key, reconcile its SSHFP and validate DNSSEC locally. If no key was ever persisted, make an explicit owner console/TOFU decision and persist the first key before authentication or SSHFP publication. A different key, conflicting history or changed intended effects requires a separately reviewed recovery plan; never fabricate a successful run or repurpose the old generation.

For an interrupted initial baseline, verify its complete no-change plan and native state exactly equal to `intent.before`, then complete the original generation using the same history table. It has no prior completed head to restore.

Review this write table privately before making single writes, each followed by exact ciphertext readback. Require `current` to match an original operation stage: `{baseline: intent.previous, pending: G}`, `{baseline: G, pending: G}` or `{baseline: G, pending: null}`. Stop for an unrelated generation. Reconcile every target in `hosts/pending`, including targets removed from later inputs. Retain existing matching history bytes; create historical objects only when definitely absent.

| Record | Required value and order |
| --- | --- |
| Affected `hosts/<target>` | The original host identity/generation and first observed key, with `status: "complete"` only after instance/key/DNS verification. Keep `hosts/pending` set. |
| `baselines/G` | `{intent, state: actualState}`; the original intent and verified post-Apply state evidence. |
| `completed/G` | `{generation: G, baseline: privateDigest(baseline)}`. |
| `current` | `{baseline: G, pending: null}` only after the matching history is complete. Require `InfrastructureRecords.inspect(actualState)` to reopen every link successfully. |
| `hosts/pending` | `{schema: 1, targets: []}` last, after every affected host record and infrastructure completion reopen successfully. |

If `current` still names the original predecessor/pending generation and both new history objects are absent, the existing `finish({generation: G, binding: intent.binding}, actualState)` can perform infrastructure completion after host verification. Otherwise follow the reviewed write table; it deliberately refuses to overwrite history. Any uncertain acknowledgement stops further writes until readback establishes what happened. Preserve all versions and perform one owner-controlled strict Host validation while other writers remain fenced. Host replacement remains blocked until a separately reviewed owner recovery plan permits a new generation.

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
- **Host key/access key:** cloud-init is creation-only. Follow [rebuilds](../ops/tofu/README.md#rebuilding-a-host); replacement Apply is fenced until owner-controlled trust recovery is implemented. Preserve the old trust history and never repin a changed key to bypass a refusal.
- **Compose host loss:** fence the old host, retain the managed database and encrypted settings, then restore the matching Compose configuration and image on the owner-provisioned replacement. Verify schema, TLS/access and one writer before acceptance. Rebuilding a VM does not require replacing its database.
- **Suggestion app key:** production only. Update settings, restart and verify before revoking the old key. An empty client ID disables suggestions without blocking the bot; see [configuration](CONFIGURATION.md).

dnf-automatic is the Quadlet updater and may reboot after updates. Verify that logs, health checks and backups survive restarts. An offline test does not prove the live host was configured. Recovery assumptions and limits are recorded in [the threat model](THREAT_MODEL.md).
