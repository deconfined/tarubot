# Build and deploy TaruBot

The **Build and deploy** workflow (`.github/workflows/pipeline.yml`, added in 2.37.0) takes one reviewed `main` commit through image publication, Linode infrastructure, Ansible configuration and a rootless Podman deployment on AlmaLinux 10. Start it once and follow that run to its result. The selected GitHub environment holds its infrastructure, SSH and bot settings together.

**Live production stays on its existing Compose deployment until the owner performs the cutover.** Adding this workflow, merging its code or preparing an environment does not move the running bot. The new path starts with an explicit staging dispatch and supports production only when the owner selects and prepares that target.

The owner performs account setup, environment changes, dispatches and approvals. Agents may review and test repository code; they never hold environment secrets, connect to a real host or approve a deployment.

## One-time setup

1. Keep `main` protected: a code-owner review of the final PR head, signed commits, merge commits, `CI result` and the CodeQL gate. Only reviewed code may run with pipeline credentials.
2. Prepare the selected environment, `staging` or `production`, restricted to `main`. Staging has no approval gate; production requires the owner's approval once for provisioning, configuration and bot deployment together. Enter its infrastructure, Ansible and bot settings once. The owner migrates any credentials from the old `infra-plan` and `infra` environments; repository code never changes GitHub environments or secrets.
3. Prepare the existing Linode managed PostgreSQL database and private Object Storage backend, and the existing Cloudflare DNS zone the hosts will use. Give the pipeline its Linode and Cloudflare API tokens and state-storage credentials. Keep the state-encryption passphrase in the owner's password manager. The [OpenTofu runbook](../ops/tofu/README.md) lists the exact configuration.
4. Supply root's public login keys and the public half of the Ansible key in the infrastructure configuration. Put the private Ansible key in the selected GitHub environment. Hosts generate their own SSH host keys; no host private key enters GitHub or OpenTofu configuration.
5. Supply that target's database, Discord and backup settings. Keep `TOFU_VARS` as the complete shared topology: both environments' copies must describe every managed host and all retained database access entries. Preserve the old production host's database access while preparing a replacement. Before importing an existing access list, compare the intended entries with the current list so the first apply preserves access.

Provider accounts, databases and credential grants are owner bootstrap work. They are not created by the bot release pipeline.

Each selected environment holds these secrets:

| Settings | Secret names |
| --- | --- |
| Infrastructure | `LINODE_TOKEN`, `CLOUDFLARE_API_TOKEN`, `TOFU_VARS` |
| Shared private state and host pins | `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `TOFU_STATE_ACCESS_KEY`, `TOFU_STATE_SECRET_KEY`, `TOFU_STATE_PASSPHRASE` |
| Ansible root login | `ANSIBLE_SSH_KEY` |
| Bot | `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, `REPORTS_GITHUB_TOKEN`, `HEALTHCHECKS_PING_URL` |
| Backup | `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_REGION`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY`, `HEALTHCHECKS_BACKUP_URL` |
| Optional suggestion application | `SUGGEST_APP_CLIENT_ID`, `SUGGEST_APP_PRIVATE_KEY` |

The state bucket, endpoint and passphrase must agree between targets. Both storage credentials must reach that same shared state. `TOFU_VARS` describes the aggregate topology; the pipeline refuses a plan that would change the other environment's host, and the database access list remains owned by this single shared state.

For an existing host created by the earlier workflow, the owner also migrates its verified SSH public key and Linode instance ID into the private pin object before the first normal update. Its JSON shape is `{"instance_id":"<linode-instance-id>","host_key":"ssh-ed25519 <public-key>"}`. A missing pin on a reused instance is refused. An intentional rebuild can establish a new pin from its create plan; a normal run never scans an existing host to replace a missing pin.

## One run

In GitHub Actions, open **Build and deploy**, choose `main`, set **environment** to `staging` and leave **rebuild** and **prepare_only** off for a normal deployment. Staging starts after the build. Production waits for the owner's one approval before infrastructure or host changes; that approval covers the rest of this same run. Production uses this path only after its owner preparation and cutover decision.

| Stage | What happens |
| --- | --- |
| Build | CI verifies the source, publishes AMD64 and ARM64 images and signs provenance for the exact image digest. Failed checks stop the run before infrastructure changes. |
| Infrastructure | OpenTofu plans and applies the Linode host, firewall, Cloudflare DNS records and database access entries. Existing shared state is retained, and infrastructure runs serialize globally. |
| Connect | On a newly created host, the pipeline records its first SSH public key with the Linode instance ID. Later connections must match that retained pin. |
| Configure | Ansible waits for cloud-init, configures AlmaLinux 10 with SELinux enforcing, installs Podman and creates the rootless `tarubot` account. A fresh host can upgrade and reboot here. |
| Bot | Ansible deploys the build's verified digest with the target's settings, runs migrations, starts the Quadlet service and checks readiness. With `prepare_only=true`, a new host gets a read-only database probe and one encrypted backup; no migrations, bot unit or command registration run. |
| Result | The run reports success or the failed stage. Check the bot's health and a backup restore before treating the target as ready. |

The initial SSH pin is trust on first use. It is retained in the private state bucket as `tarubot/hosts/<environment>.json`, holding the instance ID and public key. The pipeline does not publish the host key, hostname, addresses, database identifiers or credential values in public logs. An unexpected changed key stops a normal update.

Use **rebuild** only when deliberately replacing that target's host. Review the infrastructure changes and database access implications first. Rebuilding is not an automatic response to a failed connection.

## First start and production cutover

Start with staging. Verify the resulting host, readiness, command scope and a backup restore before preparing production. Keep a Discord application running in only one place.

For production's first move:

1. Enter its infrastructure, Ansible, database and backup settings, leaving `DISCORD_TOKEN` absent. Run **Build and deploy** with `environment=production`, `prepare_only=true` and `rebuild=false`, then approve the environment once. Preparation is accepted only on a host with no installed bot Quadlet unit. It probes the database over verified TLS, runs one encrypted backup and enables its timer while the old bot continues running. It needs no reporting token, bot heartbeat or suggestion application credentials.
2. Verify the green preparation run and restore that backup into a scratch database. Preparation does not run migrations or certify schema compatibility. Resolve any schema compatibility problem before proceeding, and keep runtime releases steady during the cutover.
3. Choose the cutover window. The owner pauses legacy Compose production deployments with its `DEPLOY_ENABLED` switch before the cutover, since the earlier publication and Deploy workflows remain live. Agents never change that switch. Start a normal **Build and deploy** run with `prepare_only=false` and `rebuild=false`, let its build finish and leave it waiting for production approval.
4. While that run waits, stop the old Compose bot and reset its Discord token into the production environment. Then approve the waiting run once. Environment secrets resolve when the protected job starts, so the build completes before the downtime window.
5. Check the new bot, command registration, heartbeat and backup. Retain the old host while the replacement is checked. [HOSTING.md](HOSTING.md) records its recovery procedure; preparing the new path does not authorize removing it. Keep legacy Compose deployments paused; retiring that path is a separate owner step.

## If a run fails

Read the failed stage's summary. Fix the source or owner-managed setting it names, then start a new workflow run. A failed apply or deployment is not rolled back automatically. A host-key mismatch needs an owner investigation; a normal retry must retain the existing pin.

Before rolling back a bot release, check its migrations. An older image cannot undo a schema change. Recover forward or use the established database restore procedure when a rollback would cross a migration.

The earlier separate **Infrastructure** and **Deploy** workflows remain documented in [CI_CD.md](CI_CD.md) for existing installations. Do not run competing infrastructure operations against the same shared state while **Build and deploy** is active.
