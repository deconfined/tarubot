# TaruBot deployment process: who does what

This is the runbook for the one deployment path of 2.37.0 ([#62](https://github.com/deconfined/tarubot/issues/62); REQUIREMENTS.md "Approved unified-pipeline amendments (2026-09-29)"). It covers everything from the one-time setup and building a host to "the new bot is online in prod", then rollback and the prod cutover. Related pages:
- [HOSTING.md](HOSTING.md#the-simple-pipeline) has the detail behind each step;
- [CI_CD.md](CI_CD.md#deploy-workflow) has the workflows' side;
- [ops/tofu/README.md](../ops/tofu/README.md) is the OpenTofu module's reference.

The columns:
- **Manual** means @deconfined: a click, a dispatch, or a value in a GitHub environment.
- **Automatic** means GitHub Actions or the host, with nobody involved.
- **Approval** marks every point where a run waits for you. There are only two kinds: approving the `prod` environment (for prod, and for any infrastructure apply), and, until the cutover, approving Compose's `production` environment.

**Status.** Since 2.37.0 staging runs on this path. Production keeps its Compose deploy ([HOSTING.md](HOSTING.md#automated-deploys-2300)) until your cutover to the `prod` host (Phase 6: owner steps on 2.37.0 or later, after the DevBot move's soak). Where prod differs from staging, the table says so.

**Agents** never approve, reject, re-run or cancel a run, never create or change an environment or its secrets, never hold a key, and never read or write the pin store. They dispatch Deploy only when you ask in that session.

## The one entry point

Everything goes through the **Deploy** workflow (`.github/workflows/deploy.yml`):
- **Automatically,** after each merge's **Publish containers** run: staging deploys at once, and production asks for your approval of the same image.
- **By hand:** *Actions → Deploy → Run workflow* on `main`, with these fields:
  - `version`: the release, X.Y.Z. An older one with `action=bot` is a rollback.
  - `target`: `staging`, `prod`, or `production` (the Compose host, until 2.38.0; `action=deploy` only, plus `rollback` and `from`).
  - `action`: one of the actions in the table below.
  - `rebuild`: replaces the target's own instance.
  - `allow_destroy` and `allow_access_removal`: for a plan that deletes or replaces more than a rebuild's own host, or removes access-list entries beyond its two.

The run's title shows the version, the action (when it isn't `deploy`), the target and a rebuild: `Deploy 2.37.0 infra to prod (rebuild)`.

| `action` | What runs on the host | Staging | Prod |
|---|---|---|---|
| `deploy` | Configure, then the release's `bot.yml` | at once, no plan, no approval | plan, then one `prod` approval |
| `bot` | the release's `bot.yml` alone: a rollback, a rotated secret, a first start | at once | one `prod` approval, never a plan |
| `configure` | Configure alone | at once | plan, then one `prod` approval |
| `preflight` | Configure, then the database and backup secrets, `migrate.js` and one backup, with no bot | at once | plan, then one `prod` approval |
| `infra` | nothing: OpenTofu and host keys only, for every host | plan, then a `prod` approval only if it has changes or keys to pin (either target) | the same |

A staging dispatch with `rebuild` plans too. Its **Infrastructure** job waits for your approval of `prod`, and staging's own job then runs without one.

---

## Phase 0: One-time setup (2.37.0)

| # | Manual | Automatic |
|---|---|---|
| 0.1 | **Protect Main ruleset** (if not done yet): require review from code owners, 1 approval, and dismiss stale approvals on push. Keep signed commits, merge commits only, `CI result` and the CodeQL gate. In Actions settings, turn off "Allow GitHub Actions to create and approve pull requests". | — |
| 0.2 | **On your own machine, prepare:**<br>• a private Object Storage bucket for OpenTofu's state and the host-key pins (no dot in its name), with two keys limited to it: one read-only and one read/write<br>• two Linode tokens: read-only (Linodes, Firewalls, Databases and Events) with a short expiry, such as 90 days; and read/write (Linodes, Firewalls and Databases, with Events read-only)<br>• two Cloudflare tokens on the zone: Zone Read with DNS Read, and DNS Edit<br>• a state passphrase of **32+** random characters<br>• optionally, root's console hash (`mkpasswd -m yescrypt`) | — |
| 0.3 | **Object Storage key scoping:** check that every other Object Storage key is limited to its own bucket. The Compose backup key already is; staging's and prod's backup keys get only their own backup buckets. Read the key list back once. This is what makes the pin store trustworthy: only `prod`'s write key and you can write a pin. | — |
| 0.4 | **Environments,** each accepting **`main` only** (deployment branches "Selected branches and tags", one branch rule, `main`):<br>• `infra-plan`: no reviewer<br>• `staging`: no reviewer<br>• `prod`: you as the only required reviewer, self-review allowed, admin bypass **off**<br>Don't create `infra`, or delete it if you made it for 2.36.0. Delete any `TARGET_HOST` or `TARGET_HOST_KEY` from `staging`. Keep every infrastructure secret out of repository and organization secrets. Leave `notify` and `production` as they are. | — |
| 0.5 | **Secrets:**<br>• `infra-plan`: `LINODE_READ_TOKEN`, `CLOUDFLARE_READ_TOKEN`, `TOFU_STATE_READ_ACCESS_KEY`, `TOFU_STATE_READ_SECRET_KEY`, `TOFU_STATE_PASSPHRASE`, `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT` and `TOFU_VARS` (below)<br>• `staging`: `ANSIBLE_SSH_KEY`, `TOFU_STATE_READ_ACCESS_KEY`, `TOFU_STATE_READ_SECRET_KEY`, `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`<br>• `prod`: `LINODE_WRITE_TOKEN`, `CLOUDFLARE_WRITE_TOKEN`, `TOFU_STATE_WRITE_ACCESS_KEY`, `TOFU_STATE_WRITE_SECRET_KEY`, `TOFU_STATE_PASSPHRASE`, `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `ANSIBLE_SSH_KEY`<br>The bucket, endpoint and passphrase must be the same wherever they appear. | — |
| 0.6 | **Configure keys,** one for `staging` and one for `prod`: generate each in memory, with no passphrase, and send its private half straight into that environment's `ANSIBLE_SSH_KEY` (command below). Only the public halves are printed. | — |
| 0.7 | **`TOFU_VARS`,** in `infra-plan` only (its one copy), compact on one line:<br>• `hosts` = `{}` for now<br>• `configure_keys` = `{staging, prod}`, the public halves<br>• `root_keys` = your FIDO2 line (with `verify-required`) and an optional operator key<br>• `root_password_hash` and `cloudflare_zone_id`<br>• `database_ids` = `{"primary": <id>}`<br>• `db_allow_extra` = exactly the access list Cloud Manager shows now, in its CIDR form, including the Compose host's addresses and your own | — |
| 0.8 | **Read the environments' settings back once** (commands below): main-only for all three, `prod`'s reviewer is you with no admin bypass, and no `infra` environment exists. No run checks them again. | — |
| 0.9 | Dispatch **Deploy**: `target=staging`, `action=infra`, `version=<live release>` (the version is ignored). | **Plan** (public data), then **Infrastructure plan** (`infra-plan`, read-only, no approval). It must show exactly one change, the access list's import, `import linode_database_access_controls.db["primary"] +0 -0`, and under **Host keys**, "No hosts." |
| 0.10 | **Approval:** approve `prod` for the **Infrastructure** job, only if the plan is exactly that line. Otherwise reject it, fix `TOFU_VARS` and dispatch again. | **Infrastructure** adopts the saved plan (its SHA-256 and change list must match), applies it, and imports the access list into the state. It pins nothing. |

**The Configure key** (0.6), once per environment; change `staging` to `prod` for the second:

```sh
d=$(mktemp -d /dev/shm/ck.XXXXXX) && ssh-keygen -q -t ed25519 -N '' -C tarubot-configure-staging -f "$d/k" \
  && gh secret set ANSIBLE_SSH_KEY --env staging < "$d/k" && cat "$d/k.pub"; rm -rf -- "${d:?}"
```

**`TOFU_VARS`** (0.7): `jq -c . values.json | gh secret set TOFU_VARS --env infra-plan`. `ops/tofu/examples/example.tfvars.json` shows the shape with placeholders.

**The read-back** (0.8). For each of `infra-plan`, `staging` and `prod`:
- `gh api repos/deconfined/tarubot/environments/<name> --jq .deployment_branch_policy` must show `protected_branches` false and `custom_branch_policies` true;
- `gh api repos/deconfined/tarubot/environments/<name>/deployment-branch-policies --jq '[.branch_policies[] | {name, type}]'` must show exactly one entry, `main` of type `branch`.

For `prod`, `gh api repos/deconfined/tarubot/environments/prod --jq '{can_admins_bypass, rules: [.protection_rules[] | select(.type == "required_reviewers") | {prevent_self_review, reviewers: [.reviewers[] | .type + " " + .reviewer.login]}]}'` must show `can_admins_bypass` false and one rule, `prevent_self_review` false, with the one reviewer `User deconfined`. `gh api repos/deconfined/tarubot/environments --jq '[.environments[].name]'` must not list `infra`.

---

## Phase 1: Build a host (a new host, or a rebuild)

For staging now; prod's own build is Phase 6.1.

| # | Manual | Automatic |
|---|---|---|
| 1.1 | Edit `TOFU_VARS` in `infra-plan`: add `hosts.<key>` (`label`, `fqdn`, `region`, `type` and `role`; the key and role are `staging` or `prod`, and the label is a Linode display name, never the domain). For a rebuild, also set any new root key, Configure key or hash. | — |
| 1.2 | Dispatch **Deploy**. For a new host: `action=infra`, with `target` `staging` or `prod` (it plans for every host either way). For a rebuild: `target=<key>`, `rebuild=true` and any action but `bot`. A rebuild replaces the instance, so the bot on it stops at the apply. On a host that runs a bot (prod, or staging after the DevBot move), dispatch it as `action=deploy` with `version=<live release>`: one run rebuilds, pins, configures and starts the bot again. With `configure`, the rebuild and the first Configure are one run. After a `configure` or `preflight` rebuild the host runs no bot until you dispatch the live version with `action=bot`, and after an `infra` one, with `action=deploy`. | **Infrastructure plan** in `infra-plan`, read-only, with no approval. Its summary lists each change as `ACTION ADDRESS`, with `+N -M` on the access list, and one line per host under **Host keys**, such as "staging: new host — approving trusts its host key on first use". It never shows a host, domain or address.<br>The guards: a delete or replace needs `allow_destroy`, and an access-list removal needs `allow_access_removal`. A rebuild alone allows exactly its own instance's replace and that instance's two old entries.<br>It keeps the encrypted saved plan for one day, only when it has changes or keys to pin. |
| 1.3 | **Approval:** read the plan (the changes, then **Host keys**), then approve `prod` (or reject it). For a new staging host expect four creates and `+2 -0`; for a rebuild, a replace, its two records updated and `+2 -2`. | The approved job (**Infrastructure**, or **Prod** for a prod request):<br>1. adopts the saved plan only if its SHA-256 and change list are the ones shown; OpenTofu refuses a stale one<br>2. applies it: the Linode (disk encrypted), its Cloud Firewall (SSH and ICMP in), the A and AAAA records, and the host's addresses on the database access list<br>3. pins each listed host's key: it checks that the instance is the one the plan expects, scans IPv6 first, then IPv4 (GitHub's runners have no IPv6), and stores the pin at once, before any login |
| 1.4 | — | **cloud-init, first boot only:** hostname; root's keys (your FIDO2 key and the Configure key); root's console hash if given, otherwise root is locked; password SSH off; `verify-required` for FIDO keys; `python3-libselinux`. The host generates its own SSH host key. |
| 1.5 | Check production is still healthy after any access-list change: the heartbeat and `/sync status`. | — |
| 1.6 | Staging: dispatch `target=staging`, `action=configure`. No approval. (A prod `configure` request did this in 1.3's job.) | **Configure** (`site.yml`, as root, over SSH from a GitHub runner, with the pinned key only, IPv6 first):<br>• waits for cloud-init<br>• on a new host, upgrades everything and **reboots once**<br>• installs Podman and friends<br>• sets dnf-automatic to all updates, rebooting when needed (prod's timer at 10:00 UTC)<br>• hardens sshd<br>• adds `pam_wheel` on `su` and a polkit rule refusing non-root<br>• creates the `tarubot` account with linger<br>→ `configured` |
| 1.7 | Dispatch `action=configure` again (prod: one more approval, with nothing to apply). | Must report `changed=0`. |

A pin stays with its Linode instance. If the first Configure fails after the pin was stored (a wrong Configure key, a slow boot), the next run uses the same pin and never scans again. The plan then says "`<key>`: pinned".

---

## Phase 2: First bot on a new host

For staging. Prod's bot secrets are Phase 6.1.4, and its first bot (with an optional preflight) is 6.2: the `prod` profile accepts only `tarubot_prod`, which exists only after the rename inside the cutover window.

| # | Manual | Automatic |
|---|---|---|
| 2.1 | **Staging's backup bucket and check,** if they don't exist yet: a bucket for staging's dumps (no dot in its name), with `ops/bucket-lifecycle.xml` applied with its key ([HOSTING.md](HOSTING.md#daily-dumps), "A new bucket also needs its retention rules"), a key pair limited to it, and staging's own healthchecks.io backup check (period 1 day, grace 3 hours).<br>**Then set `staging`'s bot secrets,** all except the Discord token:<br>• `DATABASE_URL` (password percent-encoded) and `DATABASE_CA_CERT`<br>• `REPORTS_GITHUB_TOKEN` and `HEALTHCHECKS_PING_URL`<br>• `BACKUP_STORAGE_ENDPOINT`, `_REGION`, `_ACCESS_KEY` and `_SECRET_KEY` (that bucket and its key), and `HEALTHCHECKS_BACKUP_URL` (that check's `https://` ping URL)<br>Single-line values must have no stray spaces or newlines. | — |
| 2.2 | Dispatch `target=staging`, `action=preflight`. | **Preflight:** the settings check in the release image first, then the database and backup secrets, `migrate.js` (it must print "Schema ready."), one backup to the bucket, and the nightly backup timer. The result is `preflight-ok`. |
| 2.3 | **Restore drill** on your machine: fetch the newest `daily/` dump, decrypt it with the age key, `pg_restore` it into a scratch database and count rows. | — |
| 2.4 | **The DevBot move** (staging; owner steps on 2.37.0 or later, with no release of its own):<br>1. local DevBot moves to the live release and stops<br>2. check that the schema heads are equal<br>3. restore its database on staging<br>4. reset DevBot's token into `staging` only: one Discord app never runs in two places<br>5. dispatch `target=staging`, `action=bot`<br>At least a week of soak follows before the prod cutover. Prod's token is Phase 6. | **Bot** (Phase 3, step 3.4) → `deployed`, commands registered in the test guild. |

---

## Phase 3: Ship a release (every merge)

| # | Manual | Automatic |
|---|---|---|
| 3.1 | Review the PR as code owner, then **merge with a merge commit**. | On the PR: CI (`CI result`), CodeQL and the Claude review. |
| 3.2 | — | **Publish containers, once per release.** It refuses before building if the version tag or the `sha-` tag already exists, so a release is never pushed twice (bump the version instead). It builds the amd64 and arm64 images, pushes them to GHCR, signs build provenance and moves `latest`. |
| 3.3 | — | **Deploy → Plan**, from public data only:<br>• version, commit and digest, with **provenance verified** against `publish.yml` on `main` by its exact identity<br>• `main`'s head for Configure, and the schema head<br>• the migrations added, the maintenance-window warning (Tuesdays 19:00-23:00 UTC), and "Tried on staging?"<br>• what approving does<br>Docs-, test- and CI-only merges end here with a quiet message. |
| 3.4 | — | **Staging, with no approval:**<br>1. **Configure:** `main`'s `site.yml`.<br>2. **Bot:** the release's own `bot.yml`, as `tarubot`:<br>• every check before any write: secrets present and well formed (the backup's URLs on HTTPS), `DATABASE_URL` is this target's database, the Discord token belongs to the right application, the image's labels match the plan, and a rollback doesn't cross a migration<br>• **the settings check:** the release's own configuration and tool guard over exactly the settings the bot will get, in a throwaway container with no network<br>• each secret goes into its Podman secret over stdin, never argv, logs or disk<br>• the Quadlet unit is rendered and dry-run<br>• **restart:** the old bot stops and frees the writer lease, `migrate.js` runs in the new image, the new bot starts, and the restore point goes to `~/.config/tarubot/recovery-point`<br>• healthy within 3 minutes, and still healthy 60 s later<br>• backup timer on, test-guild commands registered, old images tidied<br>→ `deployed` |
| 3.5 | Test on staging with DevBot (after the DevBot move). | — |
| 3.6 | **Until the cutover** (`DEPLOY_ENABLED` exactly `true`): **Approval** of `production`, as today ([HOSTING.md](HOSTING.md#automated-deploys-2300)). | **Deploy** (Compose, `ops/deploy.sh`), then **Notify** (Pushover). |
| 3.7 | **After the cutover** (`DEPLOY_ENABLED` off): — | **Infrastructure plan** at `main`'s head, read-only and with no approval. Usually it shows no changes and "`prod`: pinned". |
| 3.8 | **Approval** of `prod`: *Review deployments → prod → Approve*. The plan names the version, digest and commit, the migrations, the Configure commit, the infrastructure changes and the host keys. One approval covers the whole job. | **Prod:** adopts the saved plan and applies it if it has changes, writes the pins it listed, then runs the same Configure and Bot as 3.4, registering **global** commands. |
| 3.9 | — | **Report** (Pushover): the outcome, version and reason, or the exact rollback dispatch when the release is unhealthy or didn't start (`restart-failed`). **`deployed` = the new bot is online in prod.** |

Staging's outcomes aren't paged; a red staging run still sends GitHub's failure email. Staging never holds prod up, and prod never waits for staging.

---

## Phase 4: When something goes wrong, or needs changing

| # | Manual | Automatic |
|---|---|---|
| 4.1 | Read the run summary or the Pushover: `refused`, `unhealthy` or `failed`, with the step, the reason and the restore point. | The run fails and pages (prod and infrastructure). **Nothing is rolled back automatically**, and an `unhealthy` release stays in place. |
| 4.2 | **Roll back:** on prod, first reject any `prod` request still waiting for approval: a waiting request holds `host-prod`, and the rollback would wait behind it with no approval button. Then dispatch `target=<staging\|prod>`, `version=<previous>`, `action=bot` (prod: **Approval**). The `unhealthy` and `restart-failed` summaries and Pushover messages name the exact dispatch. Compose production, until the cutover, rolls back with `rollback` and `from` ([HOSTING.md](HOSTING.md#automated-deploys-2300)). | That release's own `bot.yml` deploys it, with no plan and no Configure. **Across a migration** (the live image has a migration file the target lacks):<br>• **while the live bot runs,** it is refused before any write (`rollback-across-migration`): the database holds that migration. The way back is a fix release, or stopping the bot, restoring from before the migration and dispatching the rollback again;<br>• **while it doesn't** (its start failed, as when its migration failed and committed nothing), the rollback goes ahead, and the older release's own `migrate.js` decides at the restart: it starts when the newer migration never committed, and otherwise refuses the newer schema without writing anything, so the run ends `restart-failed` with the bot down, as it already was.<br>Prod takes 2.37.0 or later, staging 2.36.0 or later. |
| 4.3 | **Rotate a secret:** set the new value in the environment, dispatch the live version with `action=bot` (prod: **Approval**), then revoke the old value. For the **database password**: set the secret, change the password, and dispatch at once. One secret per dispatch. | Writes the new value into its Podman secret and restarts the bot. |
| 4.4 | **Change host config:** merge a `site.yml` change. | Staging applies it with the next deploy's Configure. Prod applies it with its next approved request, or a `configure` dispatch. |
| 4.5 | **An infrastructure change** (an `ops/tofu/` merge, or a `TOFU_VARS` edit such as `db_allow_extra`): dispatch `action=infra`, with `allow_access_removal` or `allow_destroy` if the change needs it. Then **Approval** of `prod`, after reading the plan. | Infrastructure plan, then the **Infrastructure** job: it applies and pins, with no host step. A plan with no changes and nothing to pin asks for nothing. |
| 4.6 | **Rebuild a host:** dispatch `target=<key>`, `rebuild=true` (Phase 1.2), then **Approval**. The rebuild replaces the instance, so the bot on it stops. On a host that runs a bot, dispatch the rebuild as `action=deploy` with `version=<live release>`, so the same run starts it again; a `configure` or `preflight` rebuild needs an `action=bot` dispatch of the live version right after, and an `infra` one an `action=deploy`. | The instance's replace, `+2 -2` on the access list, and a new pin for the new instance. Unless the rebuild is `infra`, staging then configures (and, with `deploy`, starts the bot) at once, and prod does the same in its job. |
| 4.7 | **Re-pin a host** (a key changed outside a Deploy run): delete `tarubot/pins/<key>.json` with your own bucket credentials, dispatch `action=infra`, read "`<key>`: no pin for its current instance — approving trusts its host key on first use", then **Approval**. | The pin is written for the current instance. A host-key mismatch at connect otherwise fails with reason `host-key` and never falls back to the other address family. |
| 4.8 | **Pause:** for staging, add a required reviewer to `staging`; for prod, reject its requests rather than leaving them waiting: a request left waiting holds `host-prod`, so every later `prod` and Infrastructure job, a rollback included, waits behind it until it is approved or rejected. Until the cutover, turning `DEPLOY_ENABLED` off pauses the Compose host, but automatic runs then ask for `prod` instead: reject those too. | — |
| 4.9 | **Dispatch again** after "Saved plan is stale", "the host changed since the plan; dispatch again", or a saved plan older than a day (the artifact expired). | — |
| 4.10 | **The Infrastructure plan fails** (for example, an expired read-only token): dispatch `target=prod`, `action=bot` with the version, which never plans, then rotate `LINODE_READ_TOKEN` in `infra-plan`. | Report says so, and names that dispatch. |
| 4.11 | **New root key, Configure key or root hash:** update `TOFU_VARS` (and the environment's `ANSIBLE_SSH_KEY` for a Configure key), then rebuild (4.6), which stops the host's bot: rebuild with `action=deploy` and the live version to start it again in the same run. Until then, root's `authorized_keys` can be edited by hand with the FIDO2 key. | — |
| 4.12 | **Retire a host:** remove `hosts.<key>` from `TOFU_VARS`, dispatch `action=infra` with `allow_destroy` and `allow_access_removal`, and **Approval** after reading the plan. Then delete `tarubot/pins/<key>.json` with your own bucket credentials: no run deletes a pin. | The Linode, its firewall, its records and its two access-list entries are deleted. Until its pin is gone, every run for that host fails at connect, `unreachable` (or `host-key` if its address was reused), and a staging merge is red instead of ending `no-host`. |

---

## Phase 5: Running on its own

| # | Manual | Automatic |
|---|---|---|
| 5.1 | — | **dnf-automatic:** all updates daily, rebooting when one needs it (staging around 06:00 UTC, prod at 10:00 UTC). |
| 5.2 | — | **Nightly backup** at 04:30 UTC: the database dump, age-encrypted, goes to the host's own bucket (daily, plus monthly on the 1st), and pings its own healthchecks.io check. |
| 5.3 | — | **Heartbeat** to healthchecks.io every 5 minutes while the bot is ready. |
| 5.4 | — | **Crash restarts** (`Restart=always`). Secrets stay in Podman's store, so restarts and reboots don't need GitHub. |
| 5.5 | Act on pages: the heartbeat, the backup check, or a failed run. | — |

---

## Phase 6: The prod cutover (owner steps, on 2.37.0 or later)

After the DevBot move's week of soak. The old Compose bot stays live through 6.1.

| # | Manual | Automatic |
|---|---|---|
| 6.1.1 | **Rehearse the rename on the cluster** as the admin user, connected to another database: create a scratch role with a password and a scratch database it owns, rename both, log in with the same password under the new name, then drop both. In the lab, an admin with `CREATEDB` and `CREATEROLE` but no superuser needed membership in the owning role (`GRANT <owner> TO <admin>`) before `ALTER DATABASE … RENAME` worked. Note whether the cluster's admin does too.<br>**Also watch `tarubot`'s sessions** for a few minutes, as the admin: `SELECT usename, application_name FROM pg_stat_activity WHERE datname = 'tarubot'`. Note every role besides the bot's that connects: the provider's monitoring role, `_akmadmin_monitor`, holds `CONNECT` there and may connect on its own schedule. Note too whether the admin may end such a session with `pg_terminate_backend`. Unverified: the lab has no provider monitor, so this is the only look at it before the window. | — |
| 6.1.2 | Add `hosts.prod` (role `prod`) to `TOFU_VARS` in `infra-plan`, with a new `fqdn` and `label`, never the Compose host's: its DNS name and Linode label stay live until 6.4. The same name would give the Compose job's host name a second address, and Linode labels are unique. | — |
| 6.1.3 | **Prod's backup bucket and check:** a new bucket for prod's dumps (no dot in its name), with `ops/bucket-lifecycle.xml` applied with its key ([HOSTING.md](HOSTING.md#daily-dumps), "A new bucket also needs its retention rules"), a new key pair limited to it, and prod's own healthchecks.io backup check (period 1 day, grace 3 hours). The Compose host keeps its own bucket and "TaruBot backups" check. | — |
| 6.1.4 | In `prod`, set `DATABASE_CA_CERT`, `REPORTS_GITHUB_TOKEN`, `HEALTHCHECKS_PING_URL`, `SUGGEST_APP_CLIENT_ID` and `SUGGEST_APP_PRIVATE_KEY` (both, or neither to keep `/suggest` off), and the five backup settings: 6.1.3's bucket, key pair and check URL. Single-line values must have no stray spaces or newlines. Leave out `DATABASE_URL` and `DISCORD_TOKEN`. | — |
| 6.1.5 | Make sure any pending migration has already reached the Compose host, and that no runtime merge is waiting. | — |
| 6.1.6 | Dispatch `target=prod`, `action=configure`, `version=<2.37.0 or later>`. | Infrastructure plan: the prod Linode, its firewall and DNS records, `+2 -0` on the access list, and "prod: new host — approving trusts its host key on first use". |
| 6.1.7 | **Approval** of `prod`, after reading that plan. | **Prod:** applies, pins, then Configure (upgrade and reboot) → `configured`. |
| 6.1.8 | Dispatch `configure` again, then **Approval** (nothing to apply). | `changed=0`. |
| 6.2.1 | **The window.** Optional, to prove a backup before the bot starts: dispatch `target=prod`, `action=preflight`, `version=<live release, 2.37.0 or later>`, and wait until its **Prod** job asks for approval (its Infrastructure plan runs first). Then dispatch `target=prod`, `action=bot` with the same version. | Each request waits for its approval. A waiting request holds `host-prod`, so the bot request's job queues behind the preflight's and asks only once that one is answered. That is why the bot request goes second: dispatched first, it would hold `host-prod` and the preflight could never ask before it. |
| 6.2.2 | **While the approval waits:**<br>1. Stop the Compose bot, then shut the old Linode down in Cloud Manager, and pause the Compose host's "TaruBot backups" check in healthchecks.io (its host is off, so it would page the next night).<br>2. Set `DEPLOY_ENABLED` to `false`: automatic runs now ask for `prod`.<br>3. As the cluster admin, connected to another database: check `pg_stat_activity` for `tarubot` and end any stray session. Then rename the database `tarubot` → `tarubot_prod`, `tarubot_restore` → `tarubot_prod_restore` if it exists, and the role `tarubot` → `tarubot_prod`, after the `GRANT` if 6.1.1 needed it. If the rename prints "MD5 password cleared", set a new password.<br>If it refuses because the database "is being accessed by other users", such as the monitoring role 6.1.1 saw (unverified): as the owning role, revoke that role's `CONNECT` on `tarubot`, end its session or wait for it to end, rename, then grant `CONNECT` back on `tarubot_prod` ([HOSTING.md](HOSTING.md#the-prod-database-and-role-the-cutover)). If the session can't be ended and doesn't end, stop and go back: grant the `CONNECT` back on `tarubot`, reject the waiting requests, set `DEPLOY_ENABLED` to `true`, boot the old Linode, start Compose and resume its "TaruBot backups" check.<br>4. Set prod's `DATABASE_URL` to `…/tarubot_prod` as `tarubot_prod`, with the password percent-encoded.<br>5. Reset the production Discord token into prod's `DISCORD_TOKEN`. | — |
| 6.2.3 | **Approval** of `prod`: the preflight first, if you dispatched one, and once it ends `preflight-ok`, the bot request, which then asks. | Preflight (if any), for a few more minutes down: Configure (nothing to change), the settings check, `migrate.js` (nothing pending) and one backup to prod's bucket → `preflight-ok`.<br>Bot on the new host: the settings check, the secrets, the unit, `migrate.js` (nothing pending), healthy, global commands → `deployed`, and Report's Pushover. Down from the Compose bot's stop until the new bot is healthy. |
| 6.2.4 | If the preflight fails, reject the waiting bot request, fix what the run names, and dispatch both again as in 6.2.1. Without a preflight, the first nightly backup proves the backup. | — |
| 6.3 | **After the cutover:**<br>1. Check the heartbeat, `/sync status` and readiness, and that the next nightly backup reaches prod's own check.<br>2. **Operator tools** now run on the prod host through `tarubot-tool` ([HOSTING.md](HOSTING.md#tarubot-tool)), such as `run0 --user=tarubot sh -c '~/.local/bin/tarubot-tool retry.js GUILD_ID JOB_ID'`. If you keep `~/tarubot-cutover/production.env` for tools on your machine, switch it to the prod names: `TARUBOT_ENVIRONMENT=prod`, and `DATABASE_URL` `…/tarubot_prod` as `tarubot_prod` (any restore URL under `tarubot_prod_restore`). The `production` profile refuses the renamed database.<br>3. Keep the old Linode off for a week. | Every merge now deploys staging at once and asks for `prod`. |
| 6.3F | **The fallback, during that week:**<br>1. Shut the prod Linode down, not just its unit (a reboot or the next deploy would start it again), and reject any waiting prod request. Pause prod's own backup check (6.1.3) while it is down, and resume it if you cut over again; the heartbeat check is shared, so the Compose bot keeps it.<br>2. Rename the databases and the role back, the same way as 6.2.2 step 3, the monitoring role's `CONNECT` included if it had to move.<br>3. Boot the old Linode; its bot stays stopped. Reset the production token into its `.env`, and delete `DISCORD_TOKEN` from `prod`. If 6.2.2 set a new password, that `.env` no longer matches: set the role's password again if renaming back cleared it (an MD5 one), and put the current password, percent-encoded, into the `.env`'s `DATABASE_URL`.<br>4. Start Compose, set `DEPLOY_ENABLED` to `true`, and resume the "TaruBot backups" check.<br>5. Switch `~/tarubot-cutover/production.env` back to `TARUBOT_ENVIRONMENT=production` and `…/tarubot` as `tarubot`, if 6.3 changed it. | — |
| 6.4 | **After a settled week:**<br>1. Delete the old Linode, its hand-made A, AAAA and SSHFP records in the zone (OpenTofu manages only the new hosts' records), and the Compose host's "TaruBot backups" check (prod's own check replaced it).<br>2. Remove its entries from `db_allow_extra`, dispatch `action=infra` with `allow_access_removal`, and approve.<br>3. Rotate the secrets the two hosts shared: the database password and the heartbeat URL.<br>4. Merge 2.38.0, which removes the Compose path.<br>5. Delete the `production` environment and the `DEPLOY_ENABLED` variable. | 2.38.0 removes `ops/deploy.sh`, the Compose files, `DEPLOY_ENABLED`'s use and the old runbooks. |

---

## Where things live

| What | Where | Who can change it |
|---|---|---|
| Every secret and every approval | GitHub environments `infra-plan`, `staging` and `prod`; `notify` for Pushover; `production` for the Compose host until 2.38.0 | You only |
| Host shape (`TOFU_VARS`) | `infra-plan` only | You only |
| Infrastructure state | Your private bucket, `tarubot/infra.tfstate`, encrypted with your passphrase | Written only by approved `prod` jobs |
| Host-key pins | The same bucket, `tarubot/pins/<key>.json`: the host key, the Linode instance, its addresses | Written only by approved `prod` jobs, for the hosts their plan listed, and by you; read by `infra-plan` and `staging` with the read-only key |
| Release images | `ghcr.io/deconfined/tarubot`, built and signed once per release on its merge | `publish.yml` on `main` only |
| Bot secrets on a host | Podman's secret store in `tarubot`'s rootless storage | Only the Bot step, from the environment |
| Host configuration and the bot's unit | `ops/ansible/` in `main` | Merges you review |
| Infrastructure code | `ops/tofu/` in `main` | Merges you review |

| Environment | Reviewer | Holds |
|---|---|---|
| `infra-plan` | none | The read-only Linode and Cloudflare tokens, the state bucket's read-only key, the passphrase, the bucket and endpoint, and `TOFU_VARS` |
| `staging` | none (add one to pause) | `ANSIBLE_SSH_KEY`, the state bucket's read-only key, the bucket and endpoint; the bot's secrets and staging's backup settings. `DISCORD_TOKEN` only from the DevBot move. |
| `prod` | you only; admin bypass off | The write tokens, the state bucket's read/write key, the passphrase, the bucket and endpoint, and `ANSIBLE_SSH_KEY`; the bot's secrets, `SUGGEST_APP_CLIENT_ID` and `SUGGEST_APP_PRIVATE_KEY`, and prod's backup settings. `DISCORD_TOKEN` only from the cutover. |
| `notify` | none | `PUSHOVER_TOKEN`, `PUSHOVER_USER` |
| `production` | you | Compose until 2.38.0: `DEPLOY_SSH_KEY`, and the variables `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` |
| `infra` | — | Never created in 2.37.0; delete it if it exists |

| Object Storage key | Limited to | Access | Held by |
|---|---|---|---|
| State, read-only | the state bucket | read | `infra-plan`, `staging` |
| State, read/write | the state bucket | read/write | `prod` |
| Staging's backup | staging's backup bucket | read/write | `staging` |
| Prod's backup | prod's backup bucket | read/write | `prod` |
| Compose's backup | production's backup bucket | as today | the Compose host's `.env`, until 2.38.0 |

No key may reach another bucket: any key that can write the state bucket could replace a pin, and with it redirect a deploy and its secrets.
