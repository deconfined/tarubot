# TaruBot deployment process: who does what

From building a host to "the new bot is online in prod", on the simple pipeline ([#62](https://github.com/deconfined/tarubot/issues/62)). [HOSTING.md](HOSTING.md#the-simple-pipeline-2360) has the detail behind each step, [CI_CD.md](CI_CD.md) the workflows' side, and [ops/tofu/README.md](../ops/tofu/README.md) the infrastructure runbook.

- **Manual** means @deconfined: a click, a dispatch, or a value in a GitHub environment.
- **Automatic** means GitHub Actions or the host, with nobody involved.
- **Approval** marks the only points where a run waits for you.

**Status:** since 2.36.0, **staging** runs all of this. Production keeps its Compose deploy ([HOSTING.md](HOSTING.md#automated-deploys-2300)) until **2.37.0**, which moves it (Phase 6). Where production differs, the table says so.

**Agents:** they never approve a run, never create or change an environment or its secrets, and never hold a key. They dispatch a workflow only when you ask in that session.

---

## Phase 0: One-time setup

| # | Manual | Automatic |
|---|---|---|
| 0.1 | **Protect Main ruleset:** require review from code owners, 1 approval, and dismiss stale approvals on push. Keep signed commits, merge commits only, `CI result` and the CodeQL gate. In Actions settings, turn off "Allow GitHub Actions to create and approve pull requests". | — |
| 0.2 | **On your own machine:**<br>• a private Object Storage bucket for OpenTofu state, with a read-only key and a read/write key<br>• two Linode tokens: read-only with a short expiry (e.g. 90 days), and read/write<br>• two Cloudflare tokens on the zone: Zone and DNS Read, and DNS Edit<br>• a state passphrase of **32+** random characters<br>• optionally, root's console hash (`mkpasswd -m yescrypt`) | — |
| 0.3 | **Environments,** each accepting **`main` only:**<br>• `infra-plan`: no reviewer; read-only tokens and state key<br>• `infra`: you as the only reviewer, no admin bypass; write tokens and read/write state key<br>• `staging`: no reviewer<br>• `production`: you as reviewer (it exists today, and gets the new secrets in 2.37.0)<br>`infra-plan` and `infra` both also hold `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `TOFU_STATE_PASSPHRASE` and `TOFU_VARS`. | — |
| 0.4 | **Configure key** for each environment: generate it in memory, with no passphrase, and send the private half straight into that environment's `ANSIBLE_SSH_KEY`. Its public half goes into `TOFU_VARS.configure_keys`. | — |
| 0.5 | **Read the environments' settings back once** (`gh api …/environments/<name>`): main-only, and `infra`'s reviewer is you. | — |
| 0.6 | Dispatch **Infrastructure** `operation=apply` with `TOFU_VARS.hosts = {}`. | **Plan** (in `infra-plan`, no approval) must show exactly one line: the database access list's import, `+0 -0`. |
| 0.7 | **Approval:** approve the Apply job only if the plan is exactly that line. | **Apply** imports the access list into the state. |

---

## Phase 1: Build a host (a new host, or a rebuild)

| # | Manual | Automatic |
|---|---|---|
| 1.1 | Edit `TOFU_VARS`, in both `infra-plan` and `infra`: add `hosts.<role>` (label, fqdn, region, type, role). For a rebuild, set any new key or hash here too. | — |
| 1.2 | Dispatch **Infrastructure** `operation=apply`. For a rebuild add `replace=linode_instance.host["<role>"]`, `allow_destroy` and `allow_access_removal`. | **Plan** runs in `infra-plan` with read-only tokens and no approval. Its summary lists each change's action and resource, and `+N -M` on the access list. It never shows a host, domain or address. It keeps the plan as a one-day encrypted artifact. |
| 1.3 | **Approval:** read the summary, then approve (or reject) the Apply job in `infra`. | **Apply** refuses a plan whose digest, change list or variables differ, and OpenTofu refuses a stale one. It then applies exactly that plan: the Linode (disk encrypted), its Cloud Firewall (SSH and ICMP in), the A and AAAA records, and the host's addresses on the database access list. |
| 1.4 | — | **cloud-init, first boot only:** hostname; root's keys (your FIDO2 key and the Configure key); root's console hash if given, otherwise root is locked; password SSH off; `verify-required` for FIDO keys; `python3-libselinux`. The host generates its own SSH host key. |
| 1.5 | Check production is still healthy after any access-list change: the heartbeat and `/sync status`. | — |
| 1.6 | **Pin the host key (trust on first use):** `ssh-keyscan -q -t ed25519 <name> \| cut -d' ' -f2- \| gh secret set TARGET_HOST_KEY --env <role>`. Then set `TARGET_HOST`. Optionally compare the fingerprint with the one cloud-init printed on Lish. | — |
| 1.7 | Dispatch **Deploy** `target=<role>` `action=configure`. | **Configure** (`site.yml`, as root, over SSH from a GitHub runner):<br>• waits for cloud-init<br>• on a new host, upgrades everything and **reboots once**<br>• installs Podman and friends<br>• sets dnf-automatic to all updates, rebooting when needed<br>• hardens sshd<br>• adds `pam_wheel` on `su` and a polkit rule refusing non-root<br>• creates the `tarubot` account with linger |
| 1.8 | Dispatch `action=configure` again. | Must report `changed=0`. |

---

## Phase 2: First bot on a new host

| # | Manual | Automatic |
|---|---|---|
| 2.1 | **Set the environment's secrets,** all except the Discord token:<br>• `DATABASE_URL` (password percent-encoded) and `DATABASE_CA_CERT`<br>• `REPORTS_GITHUB_TOKEN` and `HEALTHCHECKS_PING_URL`<br>• `BACKUP_STORAGE_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY`<br>• `HEALTHCHECKS_BACKUP_URL`<br>• production only: `SUGGEST_APP_PRIVATE_KEY`<br>Single-line values must have no stray spaces or newlines. | — |
| 2.2 | Dispatch `action=preflight`. | **Preflight:** writes the database and backup secrets, runs `migrate.js` (it must print "Schema ready."), makes one backup to the bucket, and enables the nightly backup timer. The result is `preflight-ok`. |
| 2.3 | **Restore drill** on your machine: fetch the newest `daily/` dump, decrypt it with the age key, `pg_restore` it into a scratch database and count rows. | — |
| 2.4 | Set `DISCORD_TOKEN`. If that application runs anywhere else, stop it first and reset the token: one Discord app never runs in two places. | — |
| 2.5 | Dispatch `action=deploy`, or just wait for the next merge. | **Bot** (Phase 3, step 3.4) → `deployed`. |

---

## Phase 3: Ship a release (every merge)

| # | Manual | Automatic |
|---|---|---|
| 3.1 | Review the PR as code owner, then **merge with a merge commit**. | On the PR: CI (`CI result`), CodeQL and the Claude review. |
| 3.2 | — | **Publish containers:** builds the amd64 and arm64 images, pushes them to GHCR, signs build provenance and moves `latest`. |
| 3.3 | — | **Deploy → Plan**, from public data only: version, commit, digest, **provenance verified** against `publish.yml@main`, `main`'s head for Configure, and the schema head. |
| 3.4 | — | **Deploy staging, with no approval:**<br>1. **Configure:** `main`'s `site.yml`.<br>2. **Bot:** the release's own `bot.yml`, as `tarubot`:<br>• every check before any write: secrets present and well formed, `DATABASE_URL` is this target's database, the Discord token belongs to the right application, the image's labels match the plan, and a rollback doesn't cross a migration<br>• each secret goes into its Podman secret over stdin, never argv, logs or disk<br>• the Quadlet unit is rendered and dry-run<br>• **restart:** the old bot stops and frees the writer lease, `migrate.js` runs in the new image, the new bot starts<br>• healthy within 3 minutes, and still healthy 60 s later<br>• backup timer on, test-guild commands registered, old images tidied<br>→ `deployed` |
| 3.5 | Test on staging with DevBot (after the DevBot move). | — |
| 3.6 | **Approval** (production, from 2.37.0): *Review deployments → production → Approve*. The approval text names the Configure commit, the version and digest, and any migrations. One approval covers the whole job. | — |
| 3.7 | — | **Deploy production:** the same Configure and Bot as 3.4, registering **global** commands. |
| 3.8 | — | **Pushover:** outcome, version and schema head. **`deployed` = the new bot is online in prod.** |

---

## Phase 4: When something goes wrong, or needs changing

| # | Manual | Automatic |
|---|---|---|
| 4.1 | Read the run summary or the Pushover: `refused`, `unhealthy` or `failed`, with the step and reason. | The run fails and pages. **Nothing is rolled back automatically**, and an `unhealthy` release stays in place. |
| 4.2 | **Roll back:** dispatch the previous version with `action=bot`. The `unhealthy` summary names the exact dispatch. | That release's own `bot.yml` deploys it, skipping Configure. **Across a migration it is refused** (`rollback-across-migration`), so fix forward or restore. |
| 4.3 | **Rotate a secret:** set the new value in the environment, dispatch the live version with `action=bot`, then revoke the old value. For the **database password**: set the secret, change the password, and dispatch at once. One secret per dispatch. | Writes the new value into its Podman secret and restarts the bot. |
| 4.4 | **Change host config:** merge a `site.yml` change. | Applied by the next deploy's Configure, or a `configure` dispatch. |
| 4.5 | **Pause:** for staging, add a required reviewer to `staging`; for production, simply don't approve. | — |
| 4.6 | **New root key, Configure key or root hash:** update `TOFU_VARS`, then rebuild the host (Phase 1). | — |

---

## Phase 5: Running on its own

| # | Manual | Automatic |
|---|---|---|
| 5.1 | — | **dnf-automatic:** all updates daily, rebooting when one needs it (staging around 06:00 UTC, production 10:00 UTC). |
| 5.2 | — | **Nightly backup** at 04:30 UTC: the database dump, age-encrypted, goes to the bucket (daily, plus monthly on the 1st), and pings its own healthchecks.io check. |
| 5.3 | — | **Heartbeat** to healthchecks.io every 5 minutes while the bot is ready. |
| 5.4 | — | **Crash restarts** (`Restart=always`). Secrets stay in Podman's store, so restarts and reboots don't need GitHub. |
| 5.5 | Act on pages: the heartbeat, the backup check, or a failed run. | — |

---

## Phase 6: Production's move (2.37.0, once)

| # | Manual | Automatic |
|---|---|---|
| 6.1 | Build the new production host (Phase 1) and set its secrets without the Discord token (Phase 2, step 2.1). Make sure any pending migration has already reached the old host. | — |
| 6.2 | Merge 2.37.0, with no other runtime merges until the cutover is done. Reject the merge's own production request. Dispatch `action=preflight` for 2.37.0, then **Approval**. | Preflight on the new host: first Configure (upgrade and reboot), `Schema ready.`, one backup → `preflight-ok`. |
| 6.3 | Dispatch the 2.37.0 deploy with `action=bot`. **While its approval waits:**<br>1. Stop the old bot.<br>2. Shut the old Linode down in Cloud Manager.<br>3. Reset the Discord token into the `production` environment.<br>Then **Approval**. | Bot on the new host → `deployed`, global commands registered, Pushover. **About 2 to 4 minutes down.** |
| 6.4 | Keep the old Linode off for a week as a fallback. Then delete it, remove it from `db_allow_extra`, and rotate the shared secrets. | 2.38.0 removes `deploy.sh`, the Compose files and the old runbooks. |

---

## Where things live

| What | Where | Who can change it |
|---|---|---|
| Every secret and every approval | GitHub environments `infra-plan`, `infra`, `staging`, `production` | You only |
| Host shape (`TOFU_VARS`) | `infra-plan` and `infra`, identical in both | You only |
| Infrastructure state | Your private bucket, encrypted with your passphrase | Written only by the approved Apply job |
| Bot secrets on a host | Podman's secret store in `tarubot`'s rootless storage | Only the Bot step, from the environment |
| Host configuration and the bot's unit | `ops/ansible/` in `main` | Merges you review |
| Infrastructure code | `ops/tofu/` in `main` | Merges you review |
