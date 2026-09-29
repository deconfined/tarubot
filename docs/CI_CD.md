# CI/CD and container delivery

## Branch → pull request → merge → publish

1. Create a feature branch. Increment SemVer and update `CHANGELOG.md` for each coherent change set.
2. Open a PR against `main`. **CI** runs version/changelog validation, type checking, lint/format checks, compilation, all unit/contract/PostgreSQL integration tests, and both runtime image builds for `linux/amd64` and `linux/arm64`. The unit tests that start processes allow 120 seconds each (`setDefaultTimeout(120_000)`, since 2.36.0), because the arm64 image build runs them under QEMU. `CI result` also requires:
   - **Checks** (besides the suites): on pull requests, **Refuse edits to applied migrations** (`git diff --name-only --diff-filter=a` against the base must list nothing under `migrations/`: a pull request may add a migration, never edit, rename, delete or retype one; since 2.36.0); ShellCheck on `ops/*.sh` and on `infra.yml`'s `ops/tofu/ci/tofu-ci.sh`; and the staging unit, rendered by `tests/fixtures/bot-render.ts`, through Podman's own Quadlet generator in `quay.io/podman/stable` at the hosts' Podman version, pinned by digest, with `QUADLET_DRYRUN` set so `tests/unit/quadlet.test.ts` compares the generated service with the unit and Compose's hardening.
   - **Host playbook**, which checks `ops/ansible/` without a host, with the runner's ansible-core and ansible-lint from `ops/ansible/requirements-lint.txt` (hash-pinned, offline, nothing from Galaxy): `--syntax-check` of `site.yml` (with the example inventory and host settings) and `bot.yml`, ansible-lint's production profile, the test renderer diffed against Ansible's own `ansible.builtin.template` for both bot templates, and ShellCheck on the IPv6 wait script, `tarubot-tool` and `tarubot-backup`. `tests/unit/playbook.test.ts` fails if a script under `ops/` has no ShellCheck line.
   - **Infrastructure checks** (2.36.0; pull requests and dispatches only, so an OpenTofu registry or AlmaLinux mirror outage never blocks `publish.yml`, which reuses CI): the pinned OpenTofu's `fmt -check`, `init -backend=false -lockfile=readonly`, `validate` and `test` with mock providers and the example values, and `cloud-init schema` over the two user-data examples in `almalinux:10`, pinned by digest. It holds no secret and names no environment. On pull requests `CI result` requires it; elsewhere it may be skipped.
3. Merge after the required **CI result** check, the **CodeQL** code-scanning gate and, since 2.36.0, @deconfined's review as code owner. The **Protect Main** ruleset requires `CI result` from GitHub Actions on an up-to-date branch, signed commits, no new high-severity security alerts or error-level CodeQL results, and a code owner's review with one approval, dismissing stale approvals on push ([below](#code-owners-and-the-ruleset); #62 answer 5). Pull requests merge with a merge commit only: @deconfined turned squash and rebase merging off in the repository's settings on 2026-09-28, and the ruleset allows `merge` only too. Until 2.36.0 the pull unit checked merged `ops/ansible/` heads for @deconfined's SSH signature and an approval commit; both are gone. Don't add a merge queue or "Require linear history". CodeQL analyzes both JavaScript/TypeScript and GitHub Actions workflows on PRs, main updates, and a weekly schedule with the `security-extended` query suite, plus the `code-quality` suite for JavaScript/TypeScript (the Actions query pack has no quality queries); it excludes upstream/generated dependencies. GitHub's separate Code Quality product is not available for this repository, so quality results report through code scanning.
4. **Publish containers** revalidates the merged commit, builds both image targets, and pushes them to GHCR. Pull requests have read-only repository permissions; only publication jobs receive `packages: write`. Since 2.32.0 it also signs build provenance for each published image before `latest` moves ([below](#signed-build-provenance)).
5. **Deploy** (named "Deploy production" until 2.33.0) plans the published release and verifies its signed provenance. It deploys to the production host over SSH once the owner approves it in GitHub (2.30.0), and since 2.36.0 to the staging host at once, without approval, through `host.yml`: Configure with Ansible, then the release's own bot deploy ([below](#deploy-workflow)). Documentation-, test- and CI-only merges deploy nothing and ask for no approval.

Actions are pinned to full commits, and the repository's Actions settings require full-SHA pins. Dependabot proposes updates to those pins and their version comments. No checkout needs submodules since 2.20.0, which replaced Nodestone with a first-party parser; since 2.21.0 there is one image, because that parser runs inside the bot. No checkout persists its credentials. Registry login uses the workflow's `GITHUB_TOKEN`; no stored publishing PAT or Discord/database production credentials are needed by CI.

The **Validate version and changelog** step runs last in the checks job. A PR without a version increment still fails, but only after every other step of that job has reported; the container builds depend on that job, so they run once the version commit is pushed.

## Signed build provenance

Since 2.32.0 (#50 part 1), `publish.yml` signs SLSA build provenance for each published image. The **Sign build provenance** (`attest`) job runs after the build and before **Promote latest**:

- It runs `actions/attest` (pinned by SHA) with only `contents: read`, `id-token: write` and `attestations: write`: no registry write and no login. It is the only job, in any workflow, allowed to write attestations. The build itself never holds an OIDC token.
- The subject is `ghcr.io/deconfined/tarubot` at the index digest `docker/build-push-action` returned, handed over as the publish job's `digest` output. It never reads a tag back, because any same-repository workflow can repoint a GHCR tag. The matrix stays one image, so that output is that image's digest. A value that isn't one `sha256:` digest stops the job before it signs; an empty subject would make the action look for subjects elsewhere.
- The certificate comes from Sigstore's public-good instance and names `publish.yml`, `refs/heads/main` and the commit. No pull request or branch workflow can mint one. The attestation is stored with the repository, not pushed to GHCR, so the package gains no extra versions. The BuildKit provenance and SBOM the build attaches stay unsigned.
- `latest` needs `attest` and is promoted from the same digest, not from the `sha-` tag.
- A failed signature fails the publish run, so the automatic deploy isn't planned; the images and their version and `sha-` tags are already pushed. Re-running the failed `attest` job keeps the build's output.

Since 2.33.0 the Deploy plan verifies the signature before anything else uses the digest: before its "nothing to deploy" exit and before either deploy job. It runs `gh attestation verify oci://ghcr.io/deconfined/tarubot@<digest> --repo deconfined/tarubot --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main --source-ref refs/heads/main --source-digest <commit> --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners --format json`, requires at least one verified attestation, and otherwise fails `unattested` (gh also fails on a network or TUF error, so a new dispatch retries). It names the signer by the certificate's exact identity: gh's `--signer-workflow` is a pattern anchored only at its start, which a workflow named `publish.yml-anything.yml` would also match. It needs no registry login and no `packages` permission, because the package is public; it reads the attestations with the job's own `attestations: read` token. On success the summary says `Provenance verified: publish.yml on refs/heads/main, commit <commit>`. Releases before 2.32.0 have no attestation, so the plan refuses them; a production rollback to one goes by hand ([HOSTING.md](HOSTING.md#rolling-back-to-a-release-without-provenance-before-2320)). The same command, without `--format json`, checks a later image by hand from any `gh` login (gh asks for a token even for a public repository). Since 2.36.0 a host's first start is an ordinary run, checked by the plan.

`tests/unit/publish-workflow.test.ts` pins these rules, and that every action in every workflow is pinned to a full commit SHA with its version comment.

## Deploy workflow

Since 2.30.0 (issue #41; REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"), `.github/workflows/deploy.yml` deploys published releases to the production host over SSH after @deconfined approves them. Since 2.33.0 (#50) it is named **Deploy**; the host checks the workflow's path, not its name. Since 2.36.0 (#62; REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)") its staging job calls the reusable [`host.yml`](#host-job-hostyml), which configures the staging host and deploys the bot there with Ansible, with no approval. Production's job, `ops/deploy.sh` and the notify job are byte-identical to 2.35.0's until 2.37.0 moves production to `host.yml` too. [HOSTING.md](HOSTING.md#automated-deploys-2300) has production's host side, and [The simple pipeline](HOSTING.md#the-simple-pipeline-2360) staging's.

**Triggers.** `workflow_run` of "Publish containers" (it must have succeeded, for a push to `main`, from `publish.yml` in this repository), which asks for both targets; and `workflow_dispatch` from `main` with `version`, `rollback`, `from`, `target` (`production`, the default, or `staging`) and, since 2.36.0, `action` (`deploy`, the default, `bot`, `configure` or `preflight`), which asks for that one target.
- `action` is staging's alone until 2.37.0: a production dispatch with anything but `deploy` fails the plan as `action`.
- `rollback` and `from` are production's: a staging dispatch with either fails as `staging-rollback`, since staging goes back with `action=bot` and the older version.
- The run's title names the target: `Deploy <commit>` for an automatic run; `Deploy <version>` or `Deploy <version> rollback from <live version>` for a production dispatch; `Deploy <version> to staging`, or `Deploy <version> <action> to staging` for any action but `deploy`, for a staging one. Production's host refuses every title that ends in ` to staging`.

**Jobs.** Every `${{ }}` reaches a script through `env:`. `deploy.yml` itself uses no action and checks nothing out; `host.yml` does both for staging.

| Job | Environment | Token | What it does |
| --- | --- | --- | --- |
| `plan` | none | `contents: read`, `actions: read`, `attestations: read` | Decides which targets this run deploys (production's switch, each environment's gate), resolves the version, commit and image index digest (the version tag and `sha-<commit>` must be the same image, and the commit must be on `main`), verifies the image's signed provenance, holds staging to 2.36.0 or later, decides whether the merge changed anything that runs on a host, refuses an edited applied migration, a rollback across a migration, or a compare GitHub may have cut at 300 files, and writes the plan to the run summary. For staging it also outputs the action, `config_commit` (`main`'s head when the run was created, which Configure applies) and the release's schema head. A staging `configure` dispatch skips the version, digest, provenance and runtime checks: it touches no release. |
| `deploy` ("Deploy") | `production` | none | Waits for the approval; then writes the key to a mode-600 file under `RUNNER_TEMP` and unsets its variable, pins the host key, and sends one command to the host. Only connection failures are retried, with the same command, for up to 80 minutes (the host's longest run is about 68); a changed host key or a rejected key stops it at once. It reports `unreachable` only when every attempt failed before sshd answered, and `outcome-unknown` otherwise, since the host may have started. It removes the key file in an `always()` step. |
| `deploy-staging` ("Deploy staging") | `staging`, in `host.yml` | `contents: read` | Calls `host.yml` with the plan's outputs and `secrets: inherit`, at once, beside production's approval request. Production never needs it, and its failure never holds production up. |
| `notify` | `notify` | none | Sends one Pushover message about production; the credentials reach `curl` on stdin. A failed send never changes the outcome. Staging sends none: notify skips a staging dispatch, and its messages read only production's job. The plan decides at its start whether the run is reported (its `notify` output: the run asks for production while `DEPLOY_ENABLED` reads as true), so turning the switch off while a request waits or a deploy runs never silences that outcome. Only a plan that never wrote the output falls back to the switch as it reads then. |

`tests/unit/deploy-workflow.test.ts` pins the SHA-256 of the `deploy` and `notify` jobs' text, and of `ops/deploy.sh`, `ops/backup.sh`, `docker-compose.production.yml`, `production.env.example` and `scripts/host-env-backup.ts`, as of 2.35.0.

**Targets and switches.** Production has a repository variable, `DEPLOY_ENABLED`: while it isn't exactly `true`, production is left out, and when nothing is left the plan ends with `deploy=false` and `reason=paused`, without failing. The production job checks its switch again before it connects (`refused` `paused`). Staging has no switch since 2.36.0: every automatic run and every staging dispatch plans it. To pause staging, @deconfined adds a required reviewer to the `staging` environment, and its runs then wait there. The plan's `production` and `staging` outputs say which deploy jobs run; `notify` and `production_reason` (why production is off in a run that goes on for staging: `paused` or `gate`) are for notify.

**Environment protection** (the gates). `production` has exactly one required reviewer, the user `deconfined`, with "Prevent self-review" off, no administrator bypass, and deployment branches limited to the one branch rule `main`. `staging` has the same branch rule and no required reviewer. `notify` is limited to `main`. A failed gate turns off only its own target (with an error and a line in the summary), notify's fails the plan, and if no requested target passes, the plan fails `gate`. `infra` isn't checked by this plan: its own jobs name it, and GitHub enforces its reviewer and branch rule.

**Provenance** ([above](#signed-build-provenance)). After the version, commit and digest are bound and before any early exit, the plan runs `gh attestation verify` and fails `unattested` unless `main`'s `publish.yml` signed this digest for this commit. Releases before 2.32.0 are refused.

**Staging's floor.** Each release deploys staging with its own `ops/ansible/bot.yml`, which exists from 2.36.0 (`STAGING_MIN_RELEASE`). A staging dispatch of an older release fails `below-floor`; in an automatic run, staging is left out. The plan copies no other floor: the release's own playbook and the `host.yml` interface, pinned by tests, decide the rest.

**What counts as a runtime change** (automatic runs only; a dispatch always proceeds): every changed path except `docs/`, `site/`, `tests/`, `test-plans/`, `.github/` (but `publish.yml` counts), top-level `*.md`, the development Compose files (`docker-compose.yml`, `.devbot`, `.tools`, `.build`), `.env.example`, `production.env.example`, `staging.env.example`, `ops/tofu/` (which reaches the hosts only through the Infrastructure workflow; since 2.36.0), ansible-lint's pins (`ops/ansible/requirements-lint.txt`) and `biome.json`, plus `package.json` when only its version line changed. Since 2.36.0 `ops/ansible/requirements.txt` is a runtime path, because it is the Ansible that configures staging, and so is the rest of `ops/ansible/` and `ops/`. A merge of 300 files or more is refused as `compare-too-large`, as is a rollback across that many: GitHub's compare API lists at most 300 files, so the plan could neither show the host-side changes nor check the migrations (deploy such a release by hand). Without a runtime change the run ends with `deploy=false` and a quiet message: no approval request, and nothing on staging.

**The host-side list.** The summary lists this merge's files under `ops/`, `docker-compose.production.yml` and `production.env.example`, and says where they run: on production's Docker host as a docker-group user, which is root-equivalent there; on the staging host, Configure runs `ops/ansible/site.yml` as root, and the release's `ops/ansible/bot.yml` runs the bot as the unprivileged `tarubot` user. It names the targets the run deploys, the release's schema head, what staging does for the run's action, and, before production's approval, where the release was tried on staging.

**Settings.**

| Name | Kind | Where | Holds |
| --- | --- | --- | --- |
| `DEPLOY_ENABLED` | variable | repository only | Exactly `true`, lowercase, turns production on. The rollout and pause switch (below). |
| `DEPLOY_HOST` | variable | `production` | The production host's DNS name. The repository names no host (`deploy-workflow.test.ts` checks the workflows and `ops/deploy.sh`), but every production deploy run's public log shows this one (below). |
| `DEPLOY_KNOWN_HOSTS` | variable | `production` | One line: `DEPLOY_HOST`, then `ssh-ed25519` and the host's key (checked against its SSHFP records); no trailing comment. The public log shows it too. |
| `DEPLOY_SSH_KEY` | secret | `production` | The production deploy key, forced on the host to `ops/deploy.sh` with no arguments. |
| `PUSHOVER_TOKEN`, `PUSHOVER_USER` | secrets | `notify` | The "TaruBot deploys" Pushover application and the owner's user key. |
| `TARGET_HOST`, `TARGET_HOST_KEY`, `ANSIBLE_SSH_KEY` | secrets | `staging` (2.36.0; `production` from 2.37.0) | The host's DNS name (with A and AAAA records), its pinned host key (exactly `ssh-ed25519 <key>`, no name), and root's Configure key. Secrets, so Actions masks them ([host.yml](#host-job-hostyml)). |
| The bot's secrets | secrets | `staging` | `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN` (only from the DevBot move), `REPORTS_GITHUB_TOKEN` (the bot's `GITHUB_REPORTS_TOKEN`) and `HEALTHCHECKS_PING_URL`; `SUGGEST_APP_PRIVATE_KEY` (the bot's `GITHUB_APP_PRIVATE_KEY`) is production's, from 2.37.0. GitHub refuses a secret name that starts with `GITHUB_`, so those two settings come from secrets named otherwise ([host.yml](#host-job-hostyml)). |
| The backup's settings | secrets | `staging` | `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_REGION`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY` and `HEALTHCHECKS_BACKUP_URL`: staging's own bucket, key and check. |
| OpenTofu's | secrets | `infra` | `LINODE_TOKEN`, `CLOUDFLARE_API_TOKEN`, `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `TOFU_STATE_ACCESS_KEY`, `TOFU_STATE_SECRET_KEY`, `TOFU_STATE_PASSPHRASE` and `TOFU_VARS` ([Infrastructure workflow](#infrastructure-workflow-infrayml)). |

`STAGING_DEPLOY_ENABLED` (never set) and the `staging` environment's `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` are retired in 2.36.0; @deconfined deletes whatever exists of them ([HOSTING.md](HOSTING.md#owner-steps-for-2360)). From 2.37.0 production takes the `TARGET_*` names, so its new values can be set while the Compose job still reads `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.

**The switch is a repository variable**: Settings → Secrets and variables → Actions → Variables → **Repository variables**, or `gh variable set DEPLOY_ENABLED --body true` (no `--env`). The value must be exactly `true`, lowercase: `True` leaves production off (`paused`) and nothing asks for approval, while notify, which reads the switch without case, says that `DEPLOY_ENABLED` must be exactly `true`. Never give an environment a copy. The `plan` job has no environment, so it can't see one, and production stays off; inside the deploy job an environment variable overrides the repository's, so deleting the repository variable would no longer pause a request already waiting. The first automated run hit the first half on 2026-09-26: run 36242804814 was skipped because `DEPLOY_ENABLED` had been created in `production`, and after @deconfined moved it to the repository, run 36242986952 planned, waited for the approval and ended `already-live`.

**Rules.**
- **Re-runs are refused:** every job requires `run_attempt == 1`, and production's host refuses a later attempt. Start a new run instead.
- **Concurrency.** `deploy.yml` has no group: several production approval requests may wait, an older one approved after a newer release is live ends as `superseded`, and production's host lock runs one deploy at a time. `host.yml` holds one group per target, `host-<target>`, with `queue: max`: a newer staging run waits for the one on the host, and every waiting run keeps its place (GitHub's default keeps one waiting run per group and cancels it when the next arrives).
- **A run's conclusion isn't production's result.** The two deploy jobs run side by side, so a run can fail on its staging job while production deployed. Whether production deployed a run is the `Deploy` job's conclusion together with the production approval, never the run's conclusion. Notify reads it that way.
- **Public data only:** the plan summary, the run log and approval comments are public. Production's host prints only fixed `step`, `warning` and `result` lines; ssh's own messages stay in a private file on the runner. GitHub prints a step's `env:` values in its log and masks only secrets, so each production deploy job's log shows `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`. Staging's host name and key are secrets, `host.yml` masks every address before anything else prints, and its ssh runs at `LogLevel=FATAL`, so a changed host key never prints its fingerprint; production takes the same names at 2.37.0.
- **Publication stays separate:** `publish.yml` never deploys. Since 2.30.0 it publishes from `main` only (the `v*` tag trigger was dropped), so every tag a deploy trusts was built from `main`, and since 2.33.0 the plan verifies that for the digest itself.

The first `publish.yml` run after the 2.30.0 merge (run 36242066698) completed a run of this workflow that stopped at the `DEPLOY_ENABLED` gate; the variable has been set, at repository level only, since 2026-09-26.

### Host job (`host.yml`)

`.github/workflows/host.yml` ("Host", 2.36.0) is a reusable workflow with one job, `host`, called by `deploy.yml`'s staging job; production calls it from 2.37.0. Its inputs are public: `target` (`staging` only in 2.36.0), `action`, `version`, `commit`, `digest` and `config_commit`, each checked against its pattern first. The job names the target's environment, so that environment's secrets load there and nowhere else. It runs on `ubuntu-24.04`, first attempts only, for at most 40 minutes, with `contents: read` and one concurrency group per target (`queue: max`). Its steps:

1. **Load the host settings** (`TARGET_HOST`, `TARGET_HOST_KEY`, `ANSIBLE_SSH_KEY`).
   - Without `TARGET_HOST`, an automatic run ends green with `no-host` and a notice, "no host in the staging environment"; a dispatch fails.
   - It resolves the name with `getent ahosts` and masks every address first.
   - It checks that `ssh-keygen` reads an Ed25519 key in `TARGET_HOST_KEY` (and masks its base64 and fingerprint too), and that `ANSIBLE_SSH_KEY` is an OpenSSH private key without a passphrase (`ssh-keygen -y -P ''`): ssh runs in batch mode and could never unlock one.
   - It writes the key, a `known_hosts` of the one line `target <key>`, and an inventory whose one host is `target`, reached as root with `StrictHostKeyChecking=yes`, `HostKeyAlias=target`, the Ed25519 host key only and `AddressFamily=any` (a runner without IPv6 fails the IPv6 attempt at once and uses IPv4), all under `umask 077`. ssh runs with `LogLevel=FATAL`: a key other than the pinned one ends in "Host key verification failed." without ssh's "REMOTE HOST IDENTIFICATION HAS CHANGED" banner, which would print that key's fingerprint, on every connection of the run. An authentication failure still prints; a host that is down ends UNREACHABLE with no reason given.
2. **Find the release's commit in its image:** the revision label of the plan's digest must equal the plan's commit. The release checkout's ref comes from that label, never from event data, and the reusable workflow takes nothing from its caller on trust.
3. **Two checkouts** at the same pinned `actions/checkout`, with no persisted credentials: `main`'s head at `config_commit` into `config/`, and the release's commit into `release/` (not for `configure`).
4. **Install Ansible:** `main`'s `ops/ansible/requirements.txt`, by hash, into a virtual environment on the runner. The hosts carry none.
5. **Configure** (not for `bot`): `ansible-playbook -i … site.yml -e tarubot_role=<target>` from `config/ops/ansible`, with no secret in its environment.
6. **Deploy the bot** (not for `configure`): the release's `bot.yml` from `release/ops/ansible`, with `main`'s `ansible.cfg`, the six public `-e` values, and exactly the eleven names of `vars/bot.yml`'s `tb_secret_env` in this step's environment. Each comes from the environment secret of the same name, except the two GitHub won't take as secret names: `GITHUB_REPORTS_TOKEN` from `REPORTS_GITHUB_TOKEN` and `GITHUB_APP_PRIVATE_KEY` from `SUGGEST_APP_PRIVATE_KEY` (`vars/bot.yml` `tb_secret_source`). `bot.yml`'s refusals name the environment's secret, and `deploy-workflow.test.ts` fails on any `secrets.GITHUB_…` or `vars.GITHUB_…` in a workflow but `GITHUB_TOKEN`. `bot.yml` decides what a missing `DISCORD_TOKEN` means.
7. **Summary** (always): prints the result file (`bot.yml`'s last play wrote it on this runner from public fields only, or the job did for `no-host` and `configure`), each value as plain characters. It decides nothing: the job's colour comes from the steps above, and `bot.yml`'s last play fails its step unless the outcome is `deployed`, `superseded`, `configured` or `preflight-ok`. No file means the run stopped before that play (a failed step, or a host that became unreachable while `bot.yml` ran), and the summary says so. For `unhealthy` it names the rollback dispatch.
8. **Remove the key** (always).

No script traces, no playbook runs with `-v`, `--diff` or `--check`, and `bot.yml` keeps every secret in `no_log` tasks ([HOSTING.md](HOSTING.md#bot-deploys-and-the-result)). `tests/unit/host-workflow.test.ts` runs the steps' scripts against stand-ins for `getent`, `docker` and `ansible-playbook`, with the real `ssh-keygen`, and `tests/unit/deploy-workflow.test.ts` keeps its interface equal to `bot.yml`'s.

### Infrastructure workflow (`infra.yml`)

`.github/workflows/infra.yml` ("Infrastructure", 2.36.0) plans and applies `ops/tofu/`. It runs by dispatch only, from `main` only, first attempts only, in one concurrency group (`infra`) with `queue: max`, so a waiting run is never cancelled for a newer one; no pull request's code ever runs with its secrets. Each step runs one phase of `ops/tofu/ci/tofu-ci.sh` (install, prepare, init, plan, summarize; Apply adds compare and apply), whose rules live in the jq programs beside it, so both jobs run the same code while each step's `env:` holds only the secrets its phase needs. [ops/tofu/README.md](../ops/tofu/README.md) is its runbook.

- **Inputs:** `operation` (`plan` or `apply`), `replace` (exactly `linode_instance.host["<key>"]`), `allow_destroy` (any delete, a replace's included) and `allow_access_removal` (any entry removed from a database access list).
- **Plan** waits for @deconfined's approval in `infra`, then plans with the environment's tokens and state. Its outputs are the change list, one `ACTION ADDRESS` line per change, with `+N -M` on access lists, and whether there are changes. The guards refuse what the inputs don't allow, and anything the list can't name.
- **Apply** runs only for `operation=apply` with changes, and waits for a second approval in `infra`. It refuses when the Plan's change list didn't arrive (GitHub drops an output that looks like a secret), plans again, refuses unless its own list equals the approved one, and applies that new saved plan. It prints only the counts, plus one line per host built, pointing at the host-key pin.
- **Public logs.** The prepare phase checks `TOFU_VARS`' shape (`shape.jq`), then masks every `fqdn`, the zone ID, each `db_allow_extra` entry and its bare address, root's hash and each key's base64 field (`masks.jq`), before anything else prints: GitHub masks a secret only where its whole value appears. Linode labels are display names and aren't masked. OpenTofu's own output goes to private files, a failure prints each diagnostic's severity, address and a summary stripped of digits, `/`, `@` and `=`, and nothing prints a host key. The summaries show actions, resource addresses and access-list counts only.
- **OpenTofu** is installed from the release in `ops/tofu/.opentofu-version`, checked against `ops/tofu/opentofu.sha256` before it runs, by the script's install phase, which `ci.yml`'s Infrastructure checks run too. `tests/unit/infra.test.ts` runs the jq programs against sample plans and the phases against a stand-in `tofu`, and CI's ShellCheck covers the script.
- **State** is `tarubot/infra.tfstate` in the bucket, through the S3 backend with `backend.hcl` written by the job, encrypted with OpenTofu's `pbkdf2` and `aes_gcm` (state and plan both enforced). There is no state lock; the concurrency group serializes runs.
- **The `infra` environment:** required reviewer @deconfined (self-review allowed), administrators can't bypass it, deployment branches `main` only. @deconfined creates it and its secrets; agents never read, set or change them.

### Code owners and the ruleset

Since 2.36.0 (#62, answer 5), `.github/CODEOWNERS` is `* @deconfined`, and the **Protect Main** ruleset requires a code owner's review, one approval, and dismissal of stale approvals on push, beside `CI result`, signed commits, merge commits only and the CodeQL gate. @deconfined sets the ruleset. A merge reaches staging at once, as root through Configure and with staging's secrets through the release's `bot.yml`, so that review of the final head is the gate. The hosts check no signatures, and there is no approval commit. GitHub never counts an author's own approval, so if @deconfined authors a pull request, they add themselves as a bypass actor in "pull requests only" mode. "Allow GitHub Actions to create and approve pull requests" stays off.

### Agent access to deployments

The agent rule is REQUIREMENTS.md's "Agent rule" in "Approved SSH-deploy amendments (2026-09-26)", verbatim in AGENTS.md. Confirmed by the owner (question 1): the owner's approval in GitHub is the go-ahead for a production deploy, and Claude sessions never approve one. Proposed in PR #44 and confirmed by @deconfined on 2026-09-26, after the merge ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run Deploy production (the Deploy workflow, `.github/workflows/deploy.yml`, since its rename in 2.33.0); and dispatch it only when the owner asks in that session. The owner's answer to question 10 added guards. They have been in place since 2026-09-26, as the agent's [token comment](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843540619) proposed (its option A):

- **Deny rules.** The owner's user-level Claude Code settings on the dev VM refuse any shell command that mentions the REST pending-deployments endpoint or the GraphQL approve and reject mutations: three rules, `Bash(*pending_deployments*)`, `Bash(*approveDeployments*)` and `Bash(*rejectDeployments*)`. They catch the obvious commands, not every way to send a request. Worth adding: `Bash(gh workflow enable *)`, `Bash(gh workflow disable *)`, `Bash(gh run cancel *)`, `Bash(gh run rerun *)`, `Bash(gh secret *)` and `Bash(gh variable *)`.
- **A read-only token.** The dev VM's `gh` uses a fine-grained token with access to `deconfined/tarubot` only (optionally `deconfined/tarubot-reports`, to read issue reports), all read-only:

  | Permission | Access | Used for |
  | --- | --- | --- |
  | Metadata | read | Required for every fine-grained token. |
  | Contents | read | Fetching over HTTPS, reading files, compares and diffs. |
  | Pull requests | read | `gh pr view`, `list`, `diff` and `checks`, and review comments. |
  | Issues | read | Issues and their comments. |
  | Actions | read | Workflow runs, jobs and logs, and the environments' settings. |
  | Commit statuses | read | The status part of `gh pr checks`. |
  | Pages | read | The documentation site's deploy status. |
  | Code scanning alerts | read | CodeQL results. |
  | Administration | read (optional) | Rulesets and branch protection. |
  | Dependabot alerts | read (optional) | Dependabot alerts. |

  Never granted: **Deployments** (write approves or rejects pending deployments), **Environments**, **Secrets** and **Variables** write, **Actions** write (dispatching, re-running or cancelling runs) and **Administration** write. Fine-grained tokens have no "Checks" permission; check runs on this public repository are readable without one. The earlier classic token (`repo`, `workflow`, `read:org`, `gist`) and the GitHub MCP server's all-scopes token are revoked.
- **Pushes over SSH.** The checkout's push URL is `git@github.com:deconfined/tarubot.git`, with the owner's account key on the dev VM; fetches stay on HTTPS.
- **Writes through the agent's app.** Pull requests, and issue comments and closes, go through `tarubot-agent[bot]` (Issues and Pull requests write, Metadata read).

**Staging and the widened rule (REQUIREMENTS.md "Approved staging amendments (2026-09-26)", question 5, and "Approved pipeline amendments (2026-09-29)").** The same limits hold for both targets and the Infrastructure workflow. Agents never approve, reject or re-run a deployment or an Infrastructure run; never change the `staging`, `production`, `notify` or `infra` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never hold a deploy key, `ANSIBLE_SSH_KEY` or any other environment secret; never enable, disable or cancel either workflow; and never push a workflow that does any of these. They dispatch Deploy, for either target, or Infrastructure, only when @deconfined asks in that session. Since 2.36.0 a staging dispatch no longer has to come from @deconfined's own account: the staging dispatcher check went with the old staging job.

By the rules and AGENTS.md, merging, approving, dispatching and every environment, secret and variable change are the owner's alone. Technically one path remains. The SSH key pushes as the owner, so it can push any branch but `main`, including one whose workflow asks for write permissions on its own `GITHUB_TOKEN`: the repository's default is read, and a same-repository workflow may raise it. Such a workflow can:
- dispatch, cancel and re-run runs, including Deploy and Infrastructure on `main` (production and every Infrastructure job still wait for @deconfined's approval; a staging dispatch runs at once, but only a release `main`'s `publish.yml` signed, 2.36.0 or later, with the environment's own settings);
- push release and `sha-` tags to `ghcr.io/deconfined/tarubot`, with any labels;
- read repository secrets such as `CLAUDE_CODE_OAUTH_TOKEN`;
- merge a pull request whose required checks pass, if the ruleset didn't also require a code owner's review (since 2.36.0 it does).

It can't reach the `production`, `staging`, `notify` or `infra` environments, which accept only `main`, so it can't read their secrets. The owner's approval, the code-owner review of what reaches `main`, and the written rules are what stop a deploy. The plan resolves the digest from the version tag (and checks that `sha-<commit>` is the same image), and the hosts check only that digest and the image's labels. Until 2.33.0 an approval of a normal-looking plan, with the real version and commit and an opaque digest, could therefore deploy an image a branch pushed. Since 2.33.0 the plan's provenance check refuses such a digest (`unattested`): only `main`'s `publish.yml` can sign one.

**Open decisions for the owner.** The 2.30.0 design declined signed build-provenance attestation because only the owner could publish images. That doesn't hold while an agent-held key can push branch workflows. Two options, either or both:
- Sign build provenance in `publish.yml`, and have the plan verify the digest before it asks for approval. **Adopted in #50:** `publish.yml` signs from 2.32.0 ([above](#signed-build-provenance)), and the plan verifies from 2.33.0. The BuildKit provenance the build attaches stays unsigned, so a branch could forge that one; the plan never reads it.
- Give the agent a push credential that can't change `.github/workflows/`, so that the owner pushes workflow edits. The token comment's option B (Contents write without Workflows write) is one such credential, but it would also let the token merge, which a deny rule would then have to catch.

## Claude review and assistant

- **Claude Code Review** (`claude-code-review.yml`) reviews ready, same-repository PRs to `main` with the code-review plugin and posts inline comments. Since 2.30.1 it may use only read-only tools: Read, Grep, Glob, the inline-comment tool, `git diff`/`log`/`show`/`status`/`blame`, `gh pr` and `gh issue` reads, `gh search`, and `ls`, `cat`, `head`, `tail`, `wc` and `grep`; `git … --output` is denied, and anything else is refused because nobody can answer a prompt (`tests/unit/review-workflow.test.ts` pins the list). It skips drafts, fork PRs, and runs started by any bot except the agent's GitHub App, `tarubot-agent[bot]` (since 2.29.1; not the TaruBot app, `app/tarubot`, that opens `/suggest` issues), and a newer push cancels an unfinished review. `tarubot-agent[bot]` opens the agent's PRs; its opened, reopened and ready-for-review events start a review, so its PRs no longer need a manual close and reopen. Its pushes (synchronize) stay skipped: pushes to the agent's branches normally come from the maintainer's account, a `User` event that is reviewed as usual, and if the agent ever commits through the app, each push would otherwise start a review of up to 90 minutes and cancel the one running. Two gates must name that account together: the job condition (`github.event.sender.login`, with the event type) and the action's `allowed_bots`, without which the action fails the run with "Workflow initiated by non-human actor". The action checks no repository permission for a bot actor (its write check passes any `[bot]` login), so `allowed_bots` stays that one name, never `*`. With the login pinned and the same-repository condition, no other app and no fork can start a review. It is advisory, never a required check. The review step sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` so every subagent runs in the foreground. Since Claude Code 2.1.198 a subagent starts in the background unless Claude asks otherwise, and the action stops reading at the first result; without the variable that result arrived before the review had finished, so reviews passed in about 40 seconds with nothing posted ([anthropics/claude-code-action#1499](https://github.com/anthropics/claude-code-action/issues/1499)). The full transcript (`show_full_output`) prints to the public Actions log only when debug logging is on: a re-run with debug logging, or the repository's `ACTIONS_STEP_DEBUG` secret or variable. Never set that secret or variable repository-wide. The next step, **Check that the review finished**, prints the turns, duration, cost, subagent counts and permission denials from the action's execution file. It fails the job when a subagent started in the background or never reported back, or when there is no result message, since each means the review was cut short. The review also skips, reporting success, on a PR that changes the workflow file itself, because the action only runs a workflow identical to the default branch's copy.
- **Claude Code** (`claude.yml`) answers `@claude` in issues, PR comments, and reviews written by the owner, members, or collaborators; the action separately requires write access. Requests for the same issue or PR queue instead of running in parallel. The assistant commits through the GitHub API so its commits are signed and verified. Those commits write Claude's copy of each changed file onto the branch's current tip without checking for newer pushes, so do not push to a branch while an `@claude` run on it is in progress, and check an issue run's PR for reverted `main` changes. Do not ask `@claude` to change code on a fork PR: its commits go to a same-named branch in this repository, not to the fork. Since 2.28.0 it never starts for an issue whose body contains "Suggested in Discord with TaruBot", the marker every `/suggest` issue carries, whatever its author or text; an `@claude` comment by a trusted account on a `from-discord` issue still starts it and hands the member's text to the agent, so treat that text as untrusted. Any new workflow gated on the OWNER, MEMBER or COLLABORATOR association must skip those issues too.

Both authenticate with the `CLAUDE_CODE_OAUTH_TOKEN` repository secret and exchange the job's OIDC token for a short-lived Claude GitHub App token, which posts comments and pushes. The workflow `GITHUB_TOKEN` stays read-only.

## Dependency updates

Dependabot (`.github/dependabot.yml`) proposes updates, and a maintainer completes them. It cannot raise the SemVer or write the changelog, so **Validate version and changelog** fails on every Dependabot PR until a maintainer pushes the version commit. Publication checks the version again on `main`.

| Updates | Schedule | Pull requests | Maintainer adds |
| --- | --- | --- | --- |
| Bun runtime (`oven/bun` in the `Dockerfile`) | Monthly | One per Bun release | The same Bun version in `packageManager`, `engines.bun`, `@types/bun`, and the README stack table; a regenerated `bun.lock`; version commit |
| PostgreSQL (`docker-compose.yml`) | Monthly | Minor updates only | The same image in `.github/workflows/ci.yml` `services.postgres` and the README stack table; version commit |
| GitHub Actions | Monthly, after a 7-day cooldown; no security updates, because GitHub raises no Dependabot alerts for SHA-pinned actions | All actions in one PR | Version commit |
| Documentation site (`site/package.json`, `site/pnpm-lock.yaml`; pnpm) | Monthly, after a 7-day cooldown (14 for majors) | Astro, Starlight and the links validator grouped in one PR, at most 1 open | A green **Documentation site / Build** on the PR; version commit |

`tests/unit/runtime-pins.test.ts` fails until the Bun runtime pins and the two PostgreSQL images agree, so a half-finished runtime or database update cannot pass CI.

Dependabot does not manage:

- `lodestone-css-selectors`. The bot follows its HEAD live; refresh the bundled set with `bun run selectors:update` on a feature branch. (Nodestone was removed in 2.20.0.)
- The CI PostgreSQL service image in `ci.yml`, because Dependabot reads only `uses:` lines in workflows.
- Bun packages (`package.json`, `bun.lock`), since 2.32.1 (below).
- `ops/ansible/requirements.txt` and `requirements-lint.txt`: hash-pinned with a header Dependabot can't rewrite. Alerts still cover them; regenerate them by hand as their headers describe (since 2.36.0 they pin the runner's ansible-core, 2.21.4, and ansible-lint 26.9.0).
- OpenTofu and its providers (`ops/tofu/.opentofu-version`, `opentofu.sha256` and `.terraform.lock.hcl`, since 2.36.0): Dependabot reads neither the release nor the OpenTofu registry. `ops/tofu/README.md` "Checks and upgrades" has both procedures.
- PostgreSQL major versions. A new major image starts an empty cluster, so plan the upgrade as a migration.

GitHub's Dependabot updater can't read Bun 1.4 lockfiles ([dependabot-core#16026](https://github.com/dependabot/dependabot-core/issues/16026)), so the Bun packages entry failed with `DependencyFileNotSupported` on every run; 2.32.1 removed it. The advisory **Dependency audit** workflow runs `bun audit` against every locked package, including transitive ones, weekly and on PRs that change `package.json` or `bun.lock`. Apply package updates through a normal feature branch (a version commit, `bun run format` if a Biome update changes formatting, and the README stack table when a listed package moves), and restore the entry once the updater supports the lockfile.

Dependabot **security updates**, the pull requests it opens on its own to fix an alert, are off (@deconfined, 2026-09-27). Like version updates they can't pass the version gate without a maintainer's commit, and their one attempt failed on the hash-pinned Ansible requirements. Dependabot **alerts** stay on.

### Completing a Dependabot pull request

1. Read the linked release notes and the results of the checks that ran before the version check.
2. Check out the branch with `gh pr checkout <number>`, then run `bun install --frozen-lockfile`. For a site update, also run `cd site && pnpm install --frozen-lockfile`.
3. Make the changes listed for that row in the table above.
4. Raise the version and record it: increment `package.json` above `main` (a patch for compatible updates, minor or major when behavior or compatibility changes), add a `## X.Y.Z — Dependency updates` entry and the current-version sentence to `CHANGELOG.md`, and update the version references in `test-plans/current.json` and the current-version statements in `docs/CONFIGURATION.md` and `docs/PERSISTENCE.md`.
5. Run `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run test:unit`, and `bun run test:contract`. For a site update, also run `pnpm run build` in `site/`, which checks every internal link and anchor.
6. Commit with a signed, imperative message such as `Release dependency updates in 2.12.3`. Do not include `[dependabot skip]`, which lets Dependabot force-push over the commit.
7. Push to the Dependabot branch and merge once **CI result** and **CodeQL** pass.

After that push, Dependabot stops rebasing the PR. If `main` moves first, merge `main` into the branch and raise the version above the new base; `@dependabot recreate` discards the maintainer commit. When several Dependabot PRs are open, merge their branches into one maintainer branch and release them with a single version increment; Dependabot then closes its own PRs as up to date.

## Documentation site

The reader-facing documentation is an [Astro Starlight](https://starlight.astro.build) site in `site/`, published to GitHub Pages at <https://deconfined.github.io/tarubot/>. It is a standalone pnpm package on Node: `site/package.json` pins pnpm (`packageManager`) and Node (`engines.node`), and `site/pnpm-lock.yaml` locks its three dependencies (`astro`, `@astrojs/starlight` and `starlight-links-validator`). The bot, its lockfile, its image and CI stay on Bun; pnpm refuses to run in the repository root, which pins Bun.

**`pages.yml` ("Documentation site")** is the only workflow that builds it:

- **Pull requests** that touch `site/**` or the workflow get a **Build** job: `pnpm install --frozen-lockfile` and `pnpm run build`, which fails on a broken internal link or `#anchor`. It is **advisory**: not part of `CI result` and not required by the ruleset, so an Astro or npm outage never blocks a bot fix. Don't merge a site change while it is red.
- **`main`** rebuilds the site on the same paths, uploads it as the Pages artifact and deploys it through the `github-pages` environment, which accepts only `main`. A failed deploy leaves the last good site live.
- **Manual dispatch** from `main` redeploys the current content; from any other branch it only builds. To redeploy, dispatch from `main` rather than re-running an old run, which would publish old content.
- **Concurrency.** Only runs on `main` share the deploy group, where they queue and are never cancelled. Pull requests (`refs/pull/N/merge`) and dispatches from other branches each get their own group and cancel only their own stale builds, so a build-only run can never displace a pending `main` deploy.

The required gate for page content is `tests/unit/docs-site.test.ts`, in CI's checks job and the image build. It needs no site dependencies: it reads the pages as text and checks the command reference (every path, option and example), every `.env.example` setting, every reply code, the add-to-server page's permissions table (exactly the code's `requiredBotPermissions` plus Manage Channels), repository links, the site package's pnpm-only shape, and public content (no real IDs, private hosts, secrets or retired component names, and no Discord invite or authorization URL). Every run of seven or more digits must be a listed placeholder or constant, and each public-content pattern must still catch its known-bad samples, so a later edit can't narrow a guard unnoticed. Host patterns end in `(?:$|.)`: the `$` keeps CodeQL's missing-anchor query from reading them as URL checks without narrowing what they match.

**Enabling Pages** is a one-time owner step: Settings → Pages → Source **GitHub Actions**, and under Settings → Environments, `github-pages` allowing only `main`.

**Updating the site's dependencies** by hand, on a feature branch: `cd site && pnpm update --latest`, check that `@astrojs/starlight` and `starlight-links-validator` still accept each other's and Astro's peer ranges, run `pnpm audit` and `pnpm run build`, then release with a version commit like any Dependabot update. pnpm 12 runs no dependency build script unless `site/pnpm-workspace.yaml` allows it; esbuild's is declined there, because its optional platform package supplies the binary.

## Security reporting and scanning

`.github/SECURITY.md` routes vulnerability reports to GitHub private vulnerability reporting. Secret scanning with push protection and the GitGuardian PR check cover credentials. Dependabot alerts cover published advisories for the direct `package.json` dependencies in the dependency graph and for the Ansible pins in `ops/ansible/`, and the **Dependency audit** workflow covers every locked Bun package. SHA-pinned actions receive no alerts, so review action advisories when the monthly Actions update arrives. Dismiss a code-scanning false positive individually with a written justification rather than disabling its query, so the query still protects future code.

The workflows also support manual dispatch. Since 2.30.0 only `main` publishes (the `v*` tag trigger was dropped), and only `main` advances `latest`. PR/main changes must advance the base version. Published versions omit SemVer build metadata (`+...`) and fit Docker's 128-character tag limit so their registry tag is exactly the manifest version.

Distinct source commits have independent, non-cancelling publication and reusable-CI concurrency groups. This avoids discarding an older version when merges arrive during a build. Only latest-tag promotion is serialized, after version/SHA images have completed; its current-main check prevents stale runs from moving latest backward.

## Published images and tags

| Image | Purpose |
| --- | --- |
| `ghcr.io/deconfined/tarubot` | Discord bot and one-shot application tools |

The image supports AMD64 and ARM64. Until 2.20.0 a second image, `ghcr.io/deconfined/tarubot-nodestone`, held the Lodestone parser service; since 2.21.0 the parser runs inside the bot, and that image is no longer published (its old tags stay in GHCR). Each successful publication supplies:

- `latest` for the newest passing `main` publication.
- The manifest SemVer, for example `2.8.3`.
- `sha-FULL_COMMIT_SHA` for the exact published source commit.

OCI labels identify source, revision, and version. Build provenance and SBOM attestations accompany the images. Both versioned images must publish successfully before the final job advances their `latest` tags. Registry tag changes are separate operations; use a shared version/SHA tag when selecting an exact matched pair.

After the first publication, make both packages public in GitHub Packages if deployment hosts should pull anonymously. Otherwise authenticate Docker to `ghcr.io` with a credential that has package read access. Repository visibility and package visibility are separate settings.

## Deploy without a source checkout

A host needs only `docker-compose.yml` and an `.env` based on `.env.example`: the published image carries the compiled bot, its migrations and its tools. Installing, pinning a release, migrating, registering commands and updating are on the documentation site's [install](../site/src/content/docs/deploy/install.md) and [operations](../site/src/content/docs/deploy/operations.md) pages; production's own procedure is [HOSTING.md](HOSTING.md). Image publication never restarts a deployment or changes its database by itself: production changes only through [Deploy](#deploy-workflow) after the owner's approval, or by hand.

## Local source builds

Contributors can select the build override:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml build
```

For the existing DevBot database and editable startup plan:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml -f docker-compose.build.yml up -d --build --wait
```

That override uses `tarubot:local`. Registry deployments use the plan packaged in the image; the source-build override mounts `test-plans/` for local editing.

To refresh the bundled selectors, run `bun run selectors:update` on a feature branch, merge its passing PR, then pull the resulting published image. The running bot already follows the selectors' HEAD.

## PostgreSQL test data

The checks also validate the Compose models, and the managed-privileges integration test runs every migration with only the documented managed-cluster grants. (Until 2.21.0 they also derived and validated the App Platform phases; see [APP_PLATFORM.md](APP_PLATFORM.md).)

CI runs the full integration suite with deterministic **synthetic** data generated under `.cache/ci/legacy.sql`. It exercises the migration schema, fixture counts, ownership links, known/unknown opening balances, and the same persistence/recovery scenarios without uploading the supplied database dump.

Reproduce that path locally:

```sh
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

`bun run test:docker` without the override continues to use the locally supplied `tarubot_backup.sql` acceptance fixture. The supplied-dump rehearsal remains part of migration acceptance; synthetic CI input is never a production import artifact. Both inputs stay outside container image layers.
