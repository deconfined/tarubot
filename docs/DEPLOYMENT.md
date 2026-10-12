# Release delivery and owner operations

The production baseline is Docker Compose on an owner-provisioned Linode host, with the existing managed PostgreSQL database. This runbook describes repository implementation, **not an observed live cutover**. Merged [PR #74](https://github.com/deconfined/tarubot/pull/74) authorizes source replacement only. Provisioning, credentials, protection rules, host installation and the first cutover are separate owner operations under [AGENTS](../AGENTS.md).

Self-hosters use the site's [Compose installation](../site/src/content/docs/deploy/install.md) and [operations guide](../site/src/content/docs/deploy/operations.md). Upstream production uses `docker-compose.production.yml` and `production.env.example`; the separate DevBot staging host uses `docker-compose.staging.yml` and `staging.env.example`. These are not another application's templates. See [configuration](CONFIGURATION.md) and [threat model](THREAT_MODEL.md).

Production and staging use **separate Docker hosts**, each with its own target-specific account/settings/state. Different OS accounts do not isolate containers on a shared rootful Docker daemon: both manifests deliberately use the Compose project `tarubot`.

The forced entry performs routine upgrades of an **existing healthy Compose baseline** on its owner-bound `production` or `staging` target. Preflight requires exactly one ordinary healthy running bot and validates its application, database and command scope against the candidate before stopping it; an empty, stopped, unhealthy or cross-target host is refused. Bootstrap and recovery are owner-run procedures, not automatic deployment modes; [recover a failed delivery](#recover-a-failed-delivery-step-by-step) gives the steps.

## Release flow

1. **Review:** protected `main`, current CI/security checks and owner code-owner approval; merge commits only. Maintenance retains the application SemVer. An explicit version increase declares a release; see [CONTRIBUTING](../CONTRIBUTING.md).
2. **Build and publish:** `publish.yml`'s release gate validates the version, then proves the pushed merge commit carries exactly a pull-request head tree whose CI passed every check and the in-image suite on native AMD64 and ARM64. The ruleset's up-to-date requirement makes that the normal case; a direct push, a dispatch or any other tree runs reusable `ci.yml` in full instead. `publish-platform.yml` then builds each runtime image on its native runner (compilation only; the suite isn't run again), and one index of both digests is tagged only while the version is absent. `scan.yml` scans both exact runtime child digests. Existing published version tags are never overwritten. A failed candidate is not an authorized release.
3. **Attest:** the exact build-returned index digest receives GitHub build provenance from `publish.yml` on `main`. Fixable high/critical findings, scanner/registry errors and expired exceptions block signing/promotion. The default exception policy is empty; an exception needs exact reviewed finding fields, a reason/issue and an expiry within 30 days. `latest` advances only after attestation.
4. **Approve and deliver:** publication calls reusable `deploy.yml` with `target=production`. Exactly one job uses the `production` environment and requests the owner's approval. The repository variable `DEPLOY_ENABLED` must be exactly `true`; a skipped deployment proves nothing about the host. Optional staging rehearsal is a separate owner-requested dispatch with `target=staging` and independent `STAGING_DEPLOY_ENABLED`; it is not an additional routine production gate. Admission validates the source commit's version/main ancestry and the selected target's protection policy before and after queue/approval, then verifies the exact attestation identity, source commit and `refs/heads/main` before DNSSEC-authenticated SSH.
5. **Host mutation:** one strict SSH request invokes the owner-installed forced command: `deploy <target> <version> <commit> <sha256:digest> <request-id>`. The request ID is the GitHub run ID followed by the three-digit run attempt (run 37786755126, attempt 1, sends `37786755126001`), so each attempt gets its own release worktree. The entry requires a single fixed target argument in the owner's `authorized_keys` command and refuses a different requested target before filesystem access. The host serializes with flock, fetches the exact commit into an isolated worktree, pulls the exact digest and verifies image version/revision labels. It refuses downgrades and any different digest or commit for the same version.
6. **Writer boundary:** persist target-bound pending state **before stopping the bot**. Stop the writer, take an encrypted offsite database/settings backup, migrate with the exact new image, register commands globally for production or only in DevBot's declared guild for staging, start that image with automatic restart disabled and observe sustained readiness plus exact digest/version/schema/writer identity. Retain the info logs `Modules loaded` and `Database writer lease acquired` with their exact text.
7. **Record:** durable accepted identity/worktree state is recorded only after observation. Only then enable the routine `unless-stopped` restart policy and clear pending. A failure after the pending boundary, including backup, migration, registration, startup, observation or restart-policy failure, leaves pending state for owner reconciliation. There is no automatic rollback. An uncatchable loss can leave a process running; inspect its actual state. A stale pending marker can survive after durable acceptance, but an unaccepted target cannot automatically restart.

An unchanged version does not publish another image or deploy a maintenance commit. A maintenance fix may finish a release whose tag was never published, but cannot replace an existing tag. Re-running a failed Publish or Deploy run retries it for real. Publication resumes only with this commit's own tagged index, never another commit's release. A delivery re-validates, and proceeds only if GitHub held this attempt's own delivery job for the owner's approval: it finds its deployment and requires that it began `waiting`, so an earlier attempt's approval is never reused. Re-run all jobs and a fresh dispatch both ask again. Each attempt sends its own request ID (the run ID followed by the three-digit attempt), so the host entry starts a fresh worktree, and decides: `already-live`, `refused` while its lock or a pending marker holds the host, or a deployment. A refusal before the writer boundary changes nothing: fix its cause, then re-run or dispatch again. After `needs-owner`, reconcile on the host and clear pending first (below), then use a fresh owner-requested Deploy dispatch with explicit target, version, full commit and digest; never re-run that run. A failed delivery says where it stopped: before the host was reached (runner, validating resolver, DNSSEC/SSHFP host key, name resolution, connection or key refusal), the host's forced command, or the host entry's own result, with the entry's fixed-shape reasons, a plain-words likely cause and the path of its private host log ([reading a failed delivery](#reading-a-failed-delivery)). A published image or successful SSH exit alone is not live acceptance.

Publication and both deployment targets accept stable numeric `X.Y.Z` only, each component at most four digits. The version gate can check prerelease SemVer, but publication treats non-stable versions as verification-only before registry reads/writes; it neither publishes nor deploys prerelease images.

Publication explicitly forwards only `DEPLOY_SSH_KEY` to the reusable workflow, rather than inheriting unrelated repository secrets. The callee declares this binding optional because the caller has no environment; the approved `deliver` job resolves the selected environment's own key. Keep the key in that target's environment, not repository secrets. An empty runner key fails before DNS or SSH, so that attempt does not reach the host.

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
5. Prepare `$HOME/tarubot/.env` privately from the target's settings template. Runtime Discord/database/GitHub App credentials and backup settings remain on the host, never in runner inputs. Use mode 600 and keep the file outside release worktrees. Confirm the resolved application identity and managed tool-profile constraints; never copy production settings to staging.
6. Configure a separate backup bucket, credentials and encryption recipients for each target, offsite retention, and the owner-held age decryption key plus an offline second copy. Each bucket uses the same daily/monthly/env layout. Configure and check the daily schedule; scheduling is manual, not a workflow side effect.
7. Verify the host's Ed25519 key out of band, preferably against the provider console, then publish its SHA-256 SSHFP record at the exact deployment hostname in the owner's DNSSEC-signed zone. Confirm the complete DNSSEC delegation chain, not just zone signing. Generate the separate deploy credential outside agent sessions. Never use accept-new/keyscan to establish trust during delivery.
8. Protect `main` with owner code-owner review, required current checks, signed commits/merge policy and stale-approval dismissal. Each enabled delivery environment (`production` and optional `staging`) must have the sole required reviewer `User: deconfined`, `prevent_self_review=false` so the owner can approve their own release, `can_admins_bypass=false`, and a custom branch policy containing only branch `main`. Admission reads the selected policy before and after approval; the owner alone changes it.
9. Set a separate `DEPLOY_SSH_KEY` secret and `DEPLOY_HOST` variable in each target's environment. The host must be a lowercase dotted DNS name, not an IP address, with authenticated matching SSHFP; delivery logs in as `tarubot`. Remove the unused `DEPLOY_KNOWN_HOSTS` value during the owner-reviewed transport cutover: it is no longer read and provides no fallback. Activation switches are **repository variables**, not environment variables: `DEPLOY_ENABLED` for production and `STAGING_DEPLOY_ENABLED` for staging. Only the corresponding value exactly `true` permits delivery. Keep the target inactive until its setup is ready; agents change neither value nor any environment/key.

Activation values are GitHub workflow-context snapshots, not live repository-variable REST reads. Changing a switch is not proof that an in-flight approved request has been revoked; owner reconciliation/fencing is required.

## DNSSEC SSH host authentication

`ops/deploy-ssh.sh` runs only on the GitHub runner. It uses native OpenSSH with `VerifyHostKeyDNS=yes`, strict noninteractive host checking, plain Ed25519 host keys and empty user/system known-host stores. Unsigned, missing, DNSSEC-bogus or mismatching SSHFP cannot fall back to a manual pin, prompt or trust-on-first-use. DNSSEC authenticates the server identity; the separate restricted deployment key still authenticates the runner account.

The workflow installs current Ubuntu 24.04 `openssh-client`, `unbound` and `dns-root-data`. The helper enforces the [CVE-2025-26465 security backport](https://ubuntu.com/security/CVE-2025-26465), at least `1:9.6p1-3ubuntu13.8`. An invocation-local Unbound validates from the OS-maintained root trust anchor using direct recursion; the runner must permit outbound UDP/TCP DNS. Only its loopback replies supply the AD bit trusted by OpenSSH. Readiness uses a private Unix socket before resolver contents change.

Unbound's config, PID, logs and control socket live in a root-owned, mode-700 invocation directory under `/var/lib/unbound`, within Ubuntu's stock AppArmor permissions. The runner-owned key and SSH diagnostics remain in a separate private temp directory. Do not disable AppArmor or add runner-temp allowances. CI separately exercises native startup under the enforcing package profile in private network/mount namespaces; the offline signed-zone fixture covers SSHFP acceptance, refusal and rotation.

The workflow `exec`s the helper so runner cancellation reaches its entry PID. SSH runs as a tracked child behind an interruptible `wait`: INT/TERM cleanup terminates and reaps that client, restores resolver contents, stops the owned resolver and removes private transport state. A second cancellation signal cannot interrupt restoration already in progress. This cleans the runner, **not a remote rollback**; a host command may continue after disconnect, so reconcile its durable state before another dispatch.

For each target, the owner derives SSHFP from the independently verified **public** host key in a private console, for example:

```sh
ssh-keygen -r staging.example.org -f /etc/ssh/ssh_host_ed25519_key.pub
```

Publish the `4 2 <hex fingerprint>` record (Ed25519, SHA-256) at that exact hostname; the usual `SHA256:<base64>` display fingerprint is not SSHFP RDATA. Confirm authenticated validation of the matching RRset through the root-to-zone DS chain with a local validating tool such as `delv staging.example.org SSHFP`. An AD flag from an arbitrary remote resolver alone is not proof. DNS/delegation/host-key changes remain owner operations.

Plan a fenced maintenance window for server-key rotation. Native OpenSSH rejects an RRset containing a nonmatching fingerprint for the same host-key algorithm, even alongside a matching fingerprint; **do not overlap different Ed25519 identities at one hostname**. Lower TTL in advance and wait out the previous TTL, independently verify the replacement key, publish only its fingerprint, allow DNS propagation/cache expiry, switch the server key and verify authenticated matching SSHFP before resuming delivery. Delivery is intentionally unavailable while DNS and the server disagree. Keep separate operator recovery access; never bypass verification with a manual pin.

## First-host setup: owner checklist

Install the reviewed entries and target-bound key command **before activating target delivery**. Old no-target and new target-bearing protocols are not interchangeable. Confirm no in-flight or unresolved deployment before changing the entry. This checklist integrates delivery with an existing healthy Linode baseline; an empty or replacement host needs a separately approved manual bootstrap.

1. Fence old workflow/cron/manual deployment writers during the owner-approved window. Retain the old checkout/settings and record actual image, version, schema and writer state privately.
2. Install the reviewed `ops/deploy.sh` as `$HOME/.local/libexec/tarubot-deploy` and `ops/backup.sh` as `$HOME/.local/libexec/tarubot-backup`, outside the pinned root checkout. Make them executable and operator-owned/protected. Point the owner-managed production daily schedule at `tarubot-backup production` (staging uses `tarubot-backup staging`), not the old checkout script. These entries never self-update; future updates are reviewed owner installations. Install each from a verified Git object, never by copying text from a web page, and replace it by renaming a checked new file over it:

   ```sh
   commit=<reviewed full commit on main>
   git -C "$HOME/tarubot" fetch --no-tags origin main
   git -C "$HOME/tarubot" merge-base --is-ancestor "$commit" FETCH_HEAD
   git -C "$HOME/tarubot" show "$commit:ops/deploy.sh" > "$HOME/.local/libexec/tarubot-deploy.new"
   sha256sum "$HOME/.local/libexec/tarubot-deploy.new"   # must equal your reviewed copy's
   bash -n "$HOME/.local/libexec/tarubot-deploy.new"
   chmod 700 "$HOME/.local/libexec/tarubot-deploy.new"
   mv "$HOME/.local/libexec/tarubot-deploy.new" "$HOME/.local/libexec/tarubot-deploy"
   ```

   Compare the hash with one computed independently, for example `git show <commit>:ops/deploy.sh | sha256sum` in your own reviewed checkout; the Deploy log also prints the hash of the workflow commit's `ops/deploy.sh`. `install -m 700` from a verified worktree is equivalent. The rename matters: Bash reads a script as it runs, so overwriting the installed file in place (`cp` over it, an editor) while a delivery runs makes that delivery read the new bytes from the old position and fail part-way. Install `tarubot-backup` the same way.
3. For production, restrict its separate deploy public key in `authorized_keys` with `restrict,command="env -i HOME=/opt/tarubot PATH=/usr/local/bin:/usr/bin:/bin SSH_ORIGINAL_COMMAND=\"$SSH_ORIGINAL_COMMAND\" /opt/tarubot/.local/libexec/tarubot-deploy production"`. The staging host's command ends in `staging` instead. Preserve `SSH_ORIGINAL_COMMAND` as one quoted value so the entry can validate the request; never evaluate it as shell code. Trust the operator-controlled sshd PATH, not client overrides; sshd must not accept client environment overrides through `AcceptEnv`. No forwarding, PTY or unrestricted shell. Keep operator recovery access separate; never share its key with the runner.
4. Check central settings, managed TLS/access, target-specific backup encryption/upload and the stable Compose project `tarubot`. Worktrees live under private `$HOME/.local/state/tarubot-deploy/releases`; the central `.env` is reused without image-pin edits. Durable records include `target`; a missing or mismatched target is refused. If a prior record exists without it, the owner must reconcile and record the verified target before using these entries, never infer it or delete pending to bypass admission.
5. Leave the existing healthy bot running for admission; fence competing deployment jobs/operators, **not the bot ahead of dispatch**. Inspect durable state and confirm a usable encrypted backup/restore boundary. The approved forced entry writes pending state and then stops that writer itself. For a replacement host, first fence the old host's writer and manually establish a matching healthy exact-release Compose baseline and reconciled `current` state in the owner-approved window. An empty/stopped host cannot bootstrap through Deploy. Any unresolved pending state requires recovery first.
6. Authorize a fresh exact release through the selected GitHub environment approval. Check the host's sustained readiness, exact image/schema/version, sole writer lease, appropriate global/guild command inventory and representative authorized Discord behavior privately. Verify backup scheduling and perform a restore drill in a separate permitted target. Record release/commit, role, observed checks and unexercised cases in the issue/PR, not this guide.

No repository test, green build or approval alone proves these owner steps occurred. This reset performs no live provisioning, environment change, secret access, dispatch, deployment or database mutation.

## Staging-first rehearsal: owner checklist

Staging exercises the same signed release admission, forced entry, encrypted backup, migration, scoped registration, observation and durable failure fencing as production. It is a separate host and managed DevBot database, not a local PostgreSQL server or permission to operate production. Complete the source review/merge before installing or dispatching this path.

1. **Inventory without mutation.** On the staging host, inspect `/etc/os-release`, availability of Docker/Compose v2, Git, jq, age, curl, flock, timeout and sync, and any existing bot container. Report only OS/tool availability and whether it is running; keep private names, addresses and settings out of public evidence. Do not stop a healthy baseline ahead of dispatch.
2. **Resolve DevBot ownership first.** DevBot's application runs in exactly one place, the staging host; the workstation copy is retired. If a copy is running anywhere else, fence it in an owner-approved window before moving the token or starting a rebuilt staging bot. Preserve existing staging data. Confirm the managed database and role are both exactly `tarubot_staging`, over the direct TLS endpoint with its verified CA and appropriate schema ownership. Do not create a new cluster or overwrite an existing database as a setup shortcut.
3. **Prepare private staging settings.** Use `staging.env.example`, not production's `.env`. Supply DevBot's application/token and its declared test guild from `src/config/deployment.ts`; staging does not accept an arbitrary throwaway guild. Keep `ENABLE_EFFECTS=false` initially and production suggestion-App/heartbeat credentials absent. Prepare staging's separate backup bucket, credentials and recipients; check its `daily/`, `monthly/` and `env/` retention rules. Update the startup test-session plan before authorized live development testing.
4. **Install target-bound entries and access.** Follow the host setup checklist above, binding the staging key to `tarubot-deploy staging` and the daily schedule to `tarubot-backup staging`. Generate/hold the key outside agent sessions, verify the server key out of band and publish its authenticated SSHFP, and keep ordinary operator access separate. Docker access is privileged; approve the account's access explicitly.
5. **Establish or verify a healthy baseline.** Routine Deploy refuses an empty/stopped host. An existing staging baseline must use the managed staging profile, an exact independently verified image and matching schema. For a fresh host, the owner must first bootstrap a known compatible release while every previous DevBot writer is fenced: migrate only staging, register only its declared guild, and start one digest-pinned container with the reviewed staging manifest. Do not silently recreate the managed database or infer schema compatibility. Staging can become ready with effects paused.
6. **Prepare GitHub staging privately.** Apply the same owner-review/main-only protection policy to `staging`; set that environment's own delivery key and DNS hostname with authenticated matching SSHFP. Enable `STAGING_DEPLOY_ENABLED` only when staging is ready. Production's activation/settings stay separate and unchanged by staging setup. If publication queues a production approval, do not approve it until production is ready and its delivery is separately authorized. Agent sessions never inspect/hold keys or change either switch.
7. **Publish, then dispatch staging.** Prepare an explicit release through normal review. Its source must contain the staging manifest and target-bound protocol; an already published older tag cannot be replaced with these sources. Build/scan/attest must complete successfully. Then the owner selects **Deploy → Run workflow → main → target: staging**, supplying the exact published version, full source commit and index digest, and approves the staging environment. Publication never automatically dispatches staging. Leave the healthy staging bot running until the forced entry writes pending and stops it.
8. **Accept the actual result.** Check sustained health, image/version/schema, the sole writer lease, DevBot's guild command inventory, backup objects and daily schedule. Paused-effects checks do not prove Discord mutation behavior; any effects-enabled test is a separate owner-approved action in the scoped test guild. Staging's maintenance profile has no restore-target allowance: perform any isolated restore drill with owner-managed PostgreSQL tooling, not by relabelling the bot as unmanaged. Record observed checks and anything unexercised. A pending (`needs-owner`) outcome requires private reconciliation, never a re-run or state deletion. A refusal before the writer boundary changed nothing: fix its cause, then re-run (asking for approval again) or dispatch again.

After staging acceptance, production still needs its own host setup and approval. Staging success does not authorize a production dispatch or prove production credentials, access, backups or readiness.

## Everyday observation and outcomes

Use the target, worktree and exact image named by private `current` state, the central `.env`, and `TARUBOT_IMAGE_DIGEST=<current.digest> docker compose --project-name tarubot --project-directory <current-worktree> --env-file "$HOME/tarubot/.env" -f <current-worktree>/docker-compose.<current.target>.yml` for owner-run inspection/tools. The manifest requires this exact digest; there is no default tag. The project directory must be the release worktree so the shared web include resolves there, not beside the central `.env`. Check `ps`, private logs, `/health/ready`, command inventory, `/sync status` and `/config validate`.

Readiness requires database, writer lease and Discord. Effects may remain paused on staging; `effects` reports that setting separately. Lodestone and visibility diagnostics are informational; an incomplete upstream roster is never an empty roster.

Remote output is limited to fixed `step` tokens (`preflight`, `fetch`, `pull`, `stop`, `backup`, `migrate`, `register`, `start`, `observe`, `record`), a `result` token and, from the 2026-10-10 entry, strictly shaped `reason` lines ([reading a failed delivery](#reading-a-failed-delivery)):

| Result | Meaning / owner action |
| --- | --- |
| `deployed` | Host observation completed; still perform appropriate live behavior acceptance |
| `already-live` | Exact digest-named runtime passed sustained observation; no migration/registration replay, bootstrap or settings reconciliation |
| `refused` | Read the reasons and the private log, fix the precondition, then make a fresh authorized request |
| `needs-owner` | Read the reasons, preserve pending/logs and reconcile with [the recovery steps](#recover-a-failed-delivery-step-by-step); never blindly retry |
| `rolled-back` | Reserved by the runner for [failure-safe deliveries](https://github.com/deconfined/tarubot/issues/115): an installed entry sends it only once that entry change is installed. The entry stopped the bot after the writer boundary, then restored the previous release and reports it running with no pending marker. This release was not delivered; read the reasons, fix the cause and dispatch again |
| Connection failure / missing result | Outcome is unknown; the remote operation may continue or have completed |

Private state lives in `$HOME/.local/state/tarubot-deploy`: `host.lock` serializes delivery and scheduled backup, target-bound `pending` retains unresolved intent, `current` records the target and successful identity/worktree, and private logs retain diagnostics. Never remove run state to bypass a refusal. Release worktrees are named `releases/<request-id>-<commit>` and private logs `logs/<request-id>-<UTC>-<pid>.log`; the `run` field of `current` and `pending` holds the request ID, whose last three digits are the attempt.

## Reading a failed delivery

When a delivery stops, the Deploy log shows the relayed `step` lines and `result`, then a **Host diagnostics** block of the entry's `reason` lines, then one `::error::` sentence. That sentence starts with the likely cause in plain words when the reasons are recognisable (for example `Likely cause: the new release didn't stay ready: Discord wasn't connected`) and names the private host log: `~/.local/state/tarubot-deploy/logs/<request-id>-<UTC>-<pid>.log` in the deploy account, where the request ID is the run ID followed by the three-digit attempt. The owner asked for this on 2026-10-10, after 2.40.0's delivery stopped past the writer boundary with no reason in its log: Bash met a syntax error in the installed entry, one the reviewed `ops/deploy.sh` doesn't have, only when it reached that line. That is why the entry now parses itself first and reports its hash, and why installation renames a checked file into place.

The reasons come from the **stable deploy entry**: review and reinstall it ([first-host setup](#first-host-setup-owner-checklist), step 2) to get them. Until then an older entry sends only steps and the result, and the runner notes that it didn't report its sha256. The runner transport, `ops/deploy-ssh.sh`, comes from the workflow's own checkout and needs no installation.

Every reason line has one shape, which the entry (`public_reason` in `ops/deploy.sh`) and the runner both enforce, matching in the C locale (under `en_US.UTF-8`, glibc's `[A-Za-z]` also matches letters such as `é`): `reason <kind>` then `key=value` pairs, printable ASCII only, short bare values, quoted text without quotes, `%`, `#`, backticks, `@`, `$` or brackets, never `::`, at most 400 characters. The runner relays at most 20 and drops anything else rather than repairing it, so a host can't make the runner print a workflow command. The lines are the host's report, so before a value goes into the likely-cause sentence the runner reads only bare values, never text inside quotes, and each must fit a narrow pattern for its key (a code, a line number, a health word, a backup stage, a signal name, an exit code, a boolean); anything else reads as empty. Nothing else leaves the host: settings, messages, URLs, IDs and stack traces stay in the private log.

| Reason | Meaning |
| --- | --- |
| `entry sha256=<hex>` | The hash the running entry reports for itself, sent first on every run. The runner compares it with `ops/deploy.sh` in its own checkout, the workflow commit's (the shallow checkout doesn't hold a different release commit). A match is shown as the host's claim, to verify on the host if in doubt; a difference is a `::warning::` naming both hashes and the `git show <commit>:ops/deploy.sh` to reinstall from, never a failure, because an older reviewed entry is legitimate |
| `entry syntax=invalid line=<n>` | The entry doesn't parse. Preflight runs `bash -n` on its own file before anything else and refuses, so nothing changed; only the line number leaves the host. After `status=2` at a later step it means the file changed while it ran: a reinstall in place during a delivery |
| `refused step=<step> code=<code>` | A refusal with a fixed code: `entry-target`, `request-form`, `target-mismatch` (the request or the `authorized_keys` binding), `state-directory`, `entry-syntax`, `lock-held`, `pending-present`, `current-invalid`, `current-target`, `live-writer-count` (not exactly one bot container), `downgrade`, `same-version-mismatch`, `scope-mismatch`, `live-reference`, `no-restore-kit` (reserved: no recorded current release to restore) |
| `failed step=<step> check=<check> status=<n>` | The check that failed and the exit status of its command, with `timeout=true` when a bounded command ran out of time (status 124 or 137), `health=<word>` for a health check and `signal=<name>` when the entry was interrupted |
| `container exit=… oom=… restarts=… health=… running=… uptime=…` | Docker's facts about the bot container: its exit code, whether it was killed out of memory, its restart count, health word, whether it runs, and seconds since it started (or until it stopped). `proxy …` is the same for bundled Caddy |
| `readiness identity=… schema=… http=… live=… ready=… database=… writerLease=… discord=…` | The observation probe's booleans and `/health/ready` status (`http=none` when it didn't answer), plus `identityCode`, `schemaCode` or `readinessCode` when an error carried a code-shaped code |
| `bot-error msg="…" code=… type=… op=…` | Up to three of the bot's last error records: pino records at level 50 or above, and Bun's report of an uncaught error (`msg="uncaught error"`). Only the developer-fixed message, a code-shaped code (`28P01`, `ECONNREFUSED`, `TokenInvalid`, `writer_lease`), the error class and a named operation; never `err.message`, a stack, a URL, an ID or user text. Codes, classes and operations must match whole (`\A…\z`), so one ending in a newline is dropped. The message is cleaned again, in an order that matters: a word holding any character outside the public set (a control character or non-ASCII included) is replaced whole, never character by character, so the pieces can't join up; then URLs, `key=value` values, dotted names and addresses, IPv6 addresses, words of 24 or more characters, mixed letter-and-digit words of 12 or more, and digit runs of six or more digits in all, even split by separators, become placeholders; only then is it cut at 120 characters. `msg="unavailable"` means the cleaner failed its self-test (below) and nothing of the message was sent. Read from the bot container's log from `start` on, otherwise from the step's private log output |
| `backup stage=<stage>` | Where `ops/backup.sh` stopped: `settings`, `dump`, `settings-copy`, `upload`, `refused` or `busy` |
| `fence writers=stopped` or `fence writers=unconfirmed` | After the writer boundary, whether the entry confirmed every bot container stopped. `unconfirmed` needs a look at the host now |
| `restore outcome=<restored, skipped or failed>` with `cause=<cause>`, `check=<check>`, `proxy=failed` | Reserved, as `rolled-back` is. Whether the entry tried to restore the previous release after a failure. A `skipped` restore names why: `writers-unconfirmed`, `no-kit`, `candidate-started`, `deadline`, `schema-ahead` (the database already moved past what the previous release accepts) or `db-unknown`. `failed` names the check that failed, and `proxy=failed` says the dashboard proxy may still use the new release's configuration |
| `commands state=unknown` | Reserved. The Discord command set may still be the new release's after a rollback; register from the running release |
| `candidate part=<identity, config, modules or registration>` | Reserved. Which part of the new release's own offline check refused it, before anything stopped |
| `accepted state=running arm=failed` | Reserved. The new release passed observation and is running, but its restart policy was not enabled, so the entry kept `pending` |

Checks by step:

- **preflight:** `entry-identity`, `entry-syntax`, `host-tools`, `settings-file`, `settings-mode`, `host-lock`, `live-writer`, `live-inspect`, `live-health`, `live-labels`, `live-image`, `live-digest`, `live-scope`, `version-order`.
- **fetch:** `git-fetch`, `commit-missing`, `commit-not-on-main`, `worktree-exists`, `worktree-add`, `package-version`, `migrations`.
- **pull:** `image-pull`, `image-inspect`, `image-identity`, `compose-config`, `compose-model`, `candidate-scope`, `web-settings`, `proxy-files`, `proxy-pull`, `proxy-config`, and `pending-write` at the boundary. Reserved for failure-safe deliveries: `candidate-check` and `restore-kit`.
- **stop, backup, migrate, register:** `stop-writers`, `backup`, `migrate`, `register`.
- **start:** `compose-up` (Compose's 180-second `--wait`; the container facts tell an exit from a container still `starting` or `unhealthy`), `start-container`, `start-restart-policy`, `proxy-start`, `proxy-container`, `proxy-stop`.
- **observe:** `gone`, `inspect`, `not-running`, `container-restarted`, `image-identity`, `labels`, `health`, `identity`, `schema-checksum`, `readiness`, `probe` (the probe couldn't run in the container), and for bundled Caddy `proxy-inspect`, `proxy-not-running`, `proxy-health`, `proxy-restart-policy`. An `already-live` request also uses `live-image-id`, `record-write` and `enable-restart`.
- **record:** `record-write`, `proxy-enable-restart`, `enable-restart`, `pending-clear`.
- `unlabelled`: a failure between named checks, such as a syntax error met at run time.

The cleaner is written for jq 1.7 or newer (Ubuntu 24.04 and Enterprise Linux 10 ship 1.7.1), using Oniguruma lookarounds and `\A`/`\z` anchors. On 2026-10-10 Debian 12's jq 1.6 gave the same results on every case of the test corpus, but older versions aren't supported. Before it trusts the cleaner, the entry runs it on a fixed sample (`CLEAN_SAMPLE` in `ops/deploy.sh`) and compares the result with the expected one. On any jq that cleans the sample differently, fails or times out, it sends only `reason bot-error msg="unavailable"`: the failed check, container facts and readiness still arrive, and the bot's errors stay in the private log.

From the moment it fails, the entry ignores HUP, INT and TERM until it has fenced the writer and sent its result, as the runner's own cleanup does, so a dropped session or a cancelled run during diagnosis can't stop it before the fence. Past the writer boundary each diagnostic Docker or jq call is bounded to 10 seconds (30 before it), so the fence starts soon even when Docker hangs.

To read the private log, sign in to the host as the deploy account and open the newest `~/.local/state/tarubot-deploy/logs/<request-id>-*.log`. It holds everything the entry and its commands printed, Bash's own errors and Compose output included, and may contain settings: keep it private. `Failure at <step> (status <n>)` marks where the entry stopped. After a start or observation failure the log names the bot container; its own output is `docker logs <container>`, which stays until a later delivery recreates the container.

## Optional dashboard: owner lifecycle

The [site installation guide](../site/src/content/docs/deploy/install.md#optional-https-dashboard) owns the DNS, OAuth, port and public verification recipe. Production/staging use the same shared `docker-compose.web.yml` and `ops/Caddyfile` from the exact requested image source; the include is parsed even with `web` off. Use private central settings with optional `COMPOSE_PROFILES=web`, shared `WEB_PUBLIC_ORIGIN`, private `WEB_PORT` (default `8080`) and plain `DISCORD_CLIENT_SECRET`, together with the existing application ID. No bot web, main health or database port is published. Preserve target identities and distinct hosts/settings; this is not authorization to operate either live target.

The stock managed deploy entry's bundled profile requires HTTPS on the default public port **443**. The site's custom-port Caddy override applies to owner-managed stock installations, not this native entry: a nonstandard public port on a managed target needs an externally managed HTTPS proxy instead, with the bundled profile off.

Before admitting releases with this optional proxy lifecycle, the owner must review and reinstall **both** stable `tarubot-deploy` and `tarubot-backup` entries as in [first-host setup](#first-host-setup-owner-checklist). A source checkout, release or workflow does not update owner-installed entries. Confirm no in-flight or unresolved delivery and retain the writer/backup/migration fences.

Private release worktrees inherit `umask 077`. On an actual upgrade with the bundled profile selected, the reviewed deploy entry makes only the public `ops/Caddyfile` readable (`0644`) before validating bundled Caddy, and, from the 2.41.0 entry, the public offline page in `ops/offline` too (`chmod -R a+rX`: directories `0755`, files `0644`; only when it is a real directory, never through a symlink, and a release without it deploys unchanged). Every other worktree keeps them private, including the fresh one an `already-live` result records as `current`, so run `chmod 644 <current.worktree>/ops/Caddyfile` (and, from 2.41.0, `chmod -R a+rX <current.worktree>/ops/offline`) before any bundled-Caddy enable or recreation against the current worktree; central settings and all other release files retain private permissions. Keep the shared read-only SELinux-labeled mount and Caddy's restricted capabilities instead of granting `DAC_OVERRIDE` or broadening worktree access.

From 2.41.0, `docker-compose.web.yml` also mounts `ops/offline` read-only (same SELinux label) as `/srv/offline`: the static page the [Caddyfile](../ops/Caddyfile) answers, as a 503 with `Cache-Control: no-store` and `Retry-After`, only for Caddy's own 502, 503 and 504, when it gets no complete answer from the bot (stopped, restarting, crashed, or the connection dropped, as for a request body over 64 KiB). Its files are public and must be readable by others, which the 2.41.0 `ops/deploy.sh` does beside the Caddyfile line (the owner approved this change to the pinned entry on 2026-10-09). **Before approving the 2.41.0 delivery, review and reinstall the stable deploy entry** as in [first-host setup](#first-host-setup-owner-checklist), as 2.37.1 required; the backup entry is unchanged. An older entry still deploys 2.41.0, with the mount, validation and every other behaviour unaffected, but its managed Caddy answers the Caddyfile's one-line text fallback instead of the page. Making it readable by hand is no substitute: every delivery checks out a fresh private worktree, so it would have to be repeated after each one. The [site's monitoring guide](../site/src/content/docs/deploy/monitoring.md#offline-page) describes the page.

For routine actual version upgrades, native delivery reuses opted-in central settings and manages Caddy from the requested exact release source alongside the sole bot writer. When the bundled profile is disabled, an actual upgrade stops the existing project-labelled Caddy container without deleting its certificate volumes. An exact already-live request performs neither web configuration validation nor settings reconciliation.

Enable/bootstrap or change of origin, client secret or private port at the **current** release is a separate owner-approved maintenance operation. Fence competing delivery/backup/manual operators, inspect `current` and pending state, and use the exact current digest, target manifest and release project directory shown above. If the current release lacks the web feature, first admit a reviewed feature-bearing version through the normal release flow; never graft moving source onto an older image. Prepare DNS/firewalls and the exact Discord redirect, update central settings privately, then run that same Compose command with `up -d --wait --force-recreate tarubot caddy` for bundled web. An external proxy instead recreates only `tarubot` and privately routes to its web port. Never start a second bot, replay migrations/registration solely for web settings, or use `restart` to reload environment.

For explicit bundled-proxy disable, clear the central profile and append `--profile web stop caddy`, then `--profile web rm -f caddy`, to the current exact Compose command. Preserve `caddy_data` and `caddy_config`; do not use `down -v`. To disable the bot dashboard as well, clear its origin/client secret and recreate only `tarubot`; retain them when switching to an external proxy. A profile edit by itself does not prove an existing proxy stopped.

Recreation must retain the recorded exact image/schema identity and one writer, and prove sustained private readiness before routine delivery resumes. Caddy health checks its loopback admin process and the private bot web response, with startup depending on the bot's main readiness; it does not prove public DNS, certificate issuance, HTTPS redirects or OAuth acceptance. Separately verify the public origin with trusted TLS and authorized Discord login, following the site's recipe. Preserve pending evidence and follow owner recovery if any operation leaves state uncertain; `already-live` does not repair or bootstrap that state.

Every member and guest of a served server can sign in, for My roles and Mod mail. Before production members use it, the owner confirms (owner decision Q1, 2026-10-09; agents run none of these steps):

- the web is enabled in production: the origin, the bundled or external HTTPS proxy, the exact `/auth/callback` redirect in Discord, and AAAA as well as A records;
- TaruBot no longer holds Administrator in the server: `/config validate` says it's no longer needed after `/setup overrides`, and the owner removes it. The code refuses members and guests until then;
- on staging, an account that never authorized the application signs in with `prompt=none`. If Discord refuses it, a consent fallback is built and passes the same check first;
- Discord changes are live, TaruBot's role sits as the [officer guide](../site/src/content/docs/admin/roles.md#where-tarubots-role-sits) says, the "Role menu" health check is clean, and the restore checklist below carries its sign-out and role-choice steps.

## Backups and restore

`ops/backup.sh` retains age encryption, settings backup and offsite storage. Host settings include `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY`, `BACKUP_STORAGE_REGION` and optional `HEALTHCHECKS_BACKUP_URL`. Public recipients are in [age-recipients.txt](../ops/age-recipients.txt); [bucket lifecycle](../ops/bucket-lifecycle.xml) specifies daily/settings retention of 30 days and monthly retention of 365 days. The owner verifies the actual storage lifecycle and daily schedule; these repository files do not prove live configuration.

Dumps stream through age without plaintext disk; production and staging each upload encrypted database and `.env` copies to their own bucket using the same `daily/`, `monthly/` and `env/` keys. Separate buckets and credentials provide target isolation; do not point both targets at the same bucket. The stable daily entry requires its owner-bound target argument, defaults to central `$HOME/tarubot/.env` and its `ops/age-recipients.txt`, and selects that target's successful `current.worktree` and `current.digest`. `TARUBOT_ROOT` and `TARUBOT_COMPOSE_FILE` override central settings and the release manifest when needed; mismatched target/configuration is refused. Delivery runs the exact new worktree's backup with the same target and digest under the inherited lock. The daily entry independently takes that shared host lock. A failed backup blocks migration/start. Keep independent copies: host upload credentials can delete objects, and same-account storage is not independent disaster recovery.

Both host entries explicitly select the `backup` profile when inspecting Compose configuration, so the inactive dump client is included in validation. Configuration inspection starts no services. Deploy also supplies `COMPOSE_PROFILES=backup` to the exact release worktree's backup subprocess; an immutable published payload that inspects default configuration still sees its dump client. Updating a stable host entry does not rewrite the release payload.

Owner restore checklist:

1. Fence automation/manual writers, stop the bot and verify no writer lease holder. Preserve damaged/current data, pending state and logs. Never restore over the live database.
2. Choose an isolated new target or the managed production restore database permitted by the tool profile. Revoke PUBLIC CONNECT/TEMPORARY as appropriate, preserve provider monitoring access and prevent unrelated clients from connecting.
3. Fetch/decrypt privately. Restore with verified TLS and `pg_restore --no-owner --no-privileges --exit-on-error`. Keep plaintext scratch artifacts restricted and remove them after acceptance.
4. Use the matching release's `check-restore.js`. Source/copy schema must match; before migration use the deployed image or explicitly select the old schema head. Exact row comparison needs a stopped-writer dump and no later source writes.
5. Once `check-restore.js` has passed, and before any bot starts on the restored database, sign everyone out of the dashboard with `DELETE FROM web_sessions`: the backup would otherwise revive sessions ended since it was taken ([persistence](PERSISTENCE.md#web-sessions)). Deleting earlier would fail the exact row comparison; a backup older than migration 011 has no such table yet.
6. In the same window, close the members' role changes the backup caught waiting, so the restored copy never replays older choices over newer ones; the database then clears the role IDs they held ([persistence](PERSISTENCE.md#self-service-role-menus)). Members save again if they still want them:

   ```sql
   UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
          result='{"skipped":"restored"}'
    WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');
   ```

7. Rehearse pending migration only in the isolated permitted target. Verify recovered data/schema, credentials/access and the matching image before starting one bot. The status page's samples (migration 013) need no step: those written after the backup are lost and show as down ([persistence](PERSISTENCE.md#status-samples)). Mod mail (migration 014) needs no SQL step either, but its cases read only with the same `MODMAIL_KEY`, which no dump carries: start the restored bot with the host's key. Cases that expired since the backup come back until the next retention pass deletes them ([persistence](PERSISTENCE.md#mod-mail)). Pauses (migration 015) need no step either, but the pauses a backup restores can differ from the current ones: a pause lifted since can reappear (unless its own end has passed) and one set since is missing, so officers check the Moderation page after the restore ([persistence](PERSISTENCE.md#pauses)).
8. Account for Discord effects already sent: restore cannot undo them; update-post baselines may need owner reconciliation to avoid repeat announcements. Verify readiness, command inventory and data; retain the source until acceptance.

Managed PITR, where configured and proven, is another recovery source, not a substitute for independent encrypted dumps. A timestamp alone does not prove usable PITR. A provider restore/new cluster needs fresh address, CA and access checks.

## Recover a failed delivery, step by step

Use this when a delivery ended `needs-owner` (it stopped after the writer boundary, so the bot is stopped and `pending` is set), or when a later delivery was `refused` because the host has no healthy running bot. After a `needs-owner` the next delivery is first refused as `pending-present`; once the marker is cleared the refusals read `live-writer-count` or `live-health` ([the reasons](#reading-a-failed-delivery)). A refusal on a healthy host changed nothing: fix its cause and deliver again; none of this applies, except `pending-present`, which can also be only a stale marker (see the last row of the table in step 2).

The steps use the entry's own commands (`ops/deploy.sh`, from `pending-write` onward) in the same order, so a recovery ends in the state a successful delivery leaves. They omit the scope comparison with the live container (a failed host has none) and do not repeat the entry's Compose-model, web-settings and bundled-proxy checks or its per-sample image-ID and identity/schema probe; each tool, `backup.sh` and the bot's own startup check repeat parts of them, but an invalid `WEB_PUBLIC_ORIGIN` or a port clash is not caught before the start. They are for the owner, on the host. Nothing here runs from a workflow or an agent session.

Rules that hold for every step:

- **One writer, ever.** Never start a second bot, and never start one while another container of the `tarubot` service runs. Step 2 stops a bot that is running and unaccepted, as the entry's fence does.
- **An image starts only on a schema it accepts.** The bot compares the database's last migration with its own and refuses with `Schema version/checksum mismatch` otherwise, so an old release cannot be started after a newer migration committed. Step 4 asks the database, read-only, which case you are in. Never run `migrate.js` to find out.
- **Never delete `pending` or `current` to get past a refusal.** Step 9 replaces `current` and removes `pending` only after step 8 observed the new container (or, for a stale marker, `stale_marker=yes`), and keeps timestamped copies.
- **No downgrade, no different build of the same version.** Step 3 applies the entry's rule: the version must not be below `current.version`, and an equal version must be the same commit and digest.
- **Run it all in one `tmux` (or `screen`) session with a clean environment.** The entry turns a dropped connection into a failure and fences the writer before it exits; a plain SSH session does not, and a drop in the middle of step 7 would leave a started, unaccepted bot running without the host lock. After a drop, `tmux attach -t recovery` resumes the session (`screen -S recovery` and `screen -r recovery` do the same, and the shell must be bash, as the blocks use bash features). The clean environment keeps shell variables such as `DATABASE_URL`, `COMPOSE_PROFILES` or `LOG_LEVEL` from overriding the host's settings file, as they do not for the forced command:

  ```sh
  tmux new -s recovery 'env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" LC_ALL=C bash --noprofile --norc'
  ```

  Keep `DOCKER_HOST` and `XDG_RUNTIME_DIR` in that `env -i` list if the host's Docker is rootless.
- **Work as the deploy account** through your operator login (the deploy key is restricted to the forced command and cannot do this). Keep the host's private logs; they are the evidence.
- **Stop at the first failure.** Each state-changing block below runs in a subshell with `set -e`, then tests the subshell's exit status on the next line and prints `STOP`. (Bash ignores `set -e` for anything on the left of `||` or inside an `if` test, so the subshell is deliberately a plain command.) Every state-changing block ends with an `OK:` line when it succeeded: no `OK:` line means do not continue. Each prints `FAILED: <command>` for the command that stopped it. When you see `STOP`, do not paste the next block: fix the cause or ask.

### 1. Set up the shell and take the host lock

Replace every `<…>` placeholder. Fill in the release to bring up. For a failed delivery these are the `VERSION`, `COMMIT` and `DIGEST` printed in the Deploy log's `env:` block; for a release that was never delivered, the version, full commit and index digest from its Publish run. Verify an image you did not just see delivered with [the provenance command](#signed-build-provenance) first. The shell checks the values against the entry's own request form and refuses to take the lock if any is wrong.

```sh
target=production                  # or staging
version=<X.Y.Z>
commit=<40-character commit on main>
digest=<sha256:64 hex digits>
request=<run ID followed by the three-digit attempt of the delivery you are completing>

umask 077                          # the records you write stay private, as the entry's do
STATE=$HOME/.local/state/tarubot-deploy
ROOT=$HOME/tarubot
ref=ghcr.io/deconfined/tarubot@$digest
worktree=$STATE/releases/recovery-$commit   # a failed delivery's own worktree is named <request>-<commit>; see step 3

# The entry's own helpers. TARUBOT_RESTART_POLICY=no keeps an unaccepted container from
# restarting by itself; step 9 arms the restart policy. Nothing here reads standard input.
compose() {
  TARUBOT_IMAGE_DIGEST=$digest TARUBOT_RESTART_POLICY=no timeout --kill-after=10 300 docker compose \
    --project-name tarubot --project-directory "$worktree" --env-file "$ROOT/.env" \
    -f "$worktree/docker-compose.$target.yml" "$@" </dev/null
}
bot_ids() {
  docker ps -aq --filter label=com.docker.compose.project=tarubot --filter label=com.docker.compose.service=tarubot
}
running_ids() {
  docker ps -q --filter label=com.docker.compose.project=tarubot --filter label=com.docker.compose.service=tarubot
}
stop_writers() {
  local ids
  ids=$(running_ids)
  if [ -n "$ids" ]; then docker stop --time 40 $ids; fi
  if [ -z "$(running_ids)" ]; then echo "bot stopped"; else echo "BOT STILL RUNNING: run docker ps now"; return 1; fi
}

# Hold the host lock on file descriptor 9 for the whole session, as the entry does: the scheduled
# backup and any delivery refuse (backup busy / lock-held) while you hold it. held() asks the
# kernel, not a flag: it fails once the descriptor is closed or the lock lost, and every block
# starts with it.
held() { [ "${locked:-no}" = yes ] && flock -n 9; }
locked=no
if [[ $version =~ ^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$ \
   && $commit =~ ^[0-9a-f]{40}$ && $digest =~ ^sha256:[0-9a-f]{64}$ \
   && $request =~ ^[1-9][0-9]{0,19}$ && $target =~ ^(production|staging)$ ]]; then
  exec 9>"$STATE/host.lock"
  if flock -n 9; then locked=yes; echo "OK: values ok; host lock held"
  else exec 9>&-; echo "STOP: a delivery or backup holds the host lock"; fi
else
  echo "STOP: fix the values above; they must match the form the entry accepts"
fi
```

### 2. See what exists

```sh
for record in current pending; do
  if [ -e "$STATE/$record" ]; then echo "$record:"; jq . "$STATE/$record"; else echo "$record: none"; fi
done
docker ps -a --filter label=com.docker.compose.project=tarubot --filter label=com.docker.compose.service=tarubot \
  --format '{{.ID}} {{.Image}} {{.Status}}'
```

`current` is the last release a delivery accepted (its `version`, `commit`, `digest`, `worktree` and `schema`). `pending` is the delivery that crossed the writer boundary and did not finish; either file may be missing. A leftover `pending` can also be only a stale marker: it can outlive a delivery that was durably accepted, and then a healthy bot runs and `current` names it. Read the delivery's private log (`ls -t "$STATE"/logs | head`, then `tail -n 80` the file for the run) and the Deploy log's `step` lines: the last `step` token tells you where it stopped.

| Last step shown | What is true | Do |
| --- | --- | --- |
| `preflight`, `fetch`, `pull` with `result refused` | Nothing changed. The reasons say why. `live-writer-count` and `live-health` mean the host has no healthy running bot; `pending-present` means only that a marker exists (the bot may be healthy: see the last row) | Fix the cause. For a stopped host, the stop block below, then step 3 with the release that matches the database |
| `pull` with `result needs-owner` (check `pending-write`) | The boundary was set before the marker was written (the marker may be missing if that write itself failed), so the fence ran as for any failure past the boundary and the old bot was stopped (`fence writers=unconfirmed` means it could not confirm that: `docker ps` first) | As `stop` |
| `stop`, `backup` | The bot is stopped (or `fence writers=unconfirmed`), the schema is the old one, nothing was registered | The stop block below, then step 3 chooses between restarting the recorded release and going forward |
| `migrate` | A migration is one transaction, so the schema is either the old head or the new one. The acknowledgement may have been lost, so do not assume which | The stop block, then steps 3 and 4 tell you; then as `backup` (old) or `register` (new) |
| `register` | If the release had a migration the schema is the new head, and the recorded release cannot start on it. A rejected registration (HTTP 400) changed nothing in Discord, but another failure may have committed | The stop block, then steps 3, 4 and 6 (read the inventory before registering again) |
| `start`, `observe`, `record` | The entry's fence has stopped the container (the writer boundary stays set until the last line of `record`), so it is down. The schema and commands are the new ones | The stop block, then steps 3, 4, 6 and 7. For the same release the failed delivery installed, `worktree` can be `$(jq -er .worktree "$STATE/pending")` |
| Nothing failed: one healthy bot whose version, commit and digest equal `current`, **and** a leftover `pending` whose version, commit and digest are the same as `current`'s | Only the marker is stale. (If `pending` names a different or newer release, a newer delivery crossed the boundary and ended `fence writers=unconfirmed`: the schema or commands may be new, so treat it as the `stop` row after `docker ps`) | **Do not stop the bot.** Run step 1 with `current`'s `version`, `commit` and `digest` and `request` set to its `run`; then `worktree=$(jq -er .worktree "$STATE/current"); stale_marker=yes`; then step 9 only |

Keep the evidence, then stop any bot that is still running or restarting. Run this block only for the rows above that say the stop block. It refuses while a healthy bot runs, because stopping an accepted bot is the outage this runbook exists to end; set `stop_healthy=yes` first only when the row tells you to stop it. A running, unaccepted bot is an unaccepted writer (a bot whose restart policy is still `unless-stopped` meeting a schema it refuses restarts every few seconds), and the entry's fence stops writers before anything else. Step 7 replaces the container with `--force-recreate`, and its `docker logs` go with it, so the log is saved first.

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  held
  if [ -n "$(docker ps -q --filter label=com.docker.compose.project=tarubot --filter label=com.docker.compose.service=tarubot --filter health=healthy)" ]; then
    [ "${stop_healthy:-no}" = yes ] || { echo "REFUSED: a healthy bot runs; set stop_healthy=yes only if the table says to stop it"; exit 1; }
  fi
  for id in $(bot_ids); do
    docker logs "$id" > "$STATE/logs/recovery-$id.log" 2>&1 || echo "log not saved for $id"
  done
  stop_writers
  [ -z "$(running_ids)" ]
  echo "OK: no bot is running"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: a bot may still be running; check docker ps before anything else"
```

### 3. Prepare the release

Create the release's worktree, pull its exact image and apply the entry's identity and order checks. For the same release the failed delivery was installing, set `worktree=$(jq -er .worktree "$STATE/pending")` first and the block reuses it after checking it is that commit and clean. Otherwise it creates `recovery-<commit>` and never touches a failed delivery's directory.

To bring back the **recorded** release instead (a failure that left the schema unchanged), run these three lines first, then the block below, then step 4; when step 4 says SAME, continue at step 6 (step 5 is skipped). They reset all of the release's variables from `current`, not only the digest:

```sh
version=$(jq -er .version "$STATE/current"); commit=$(jq -er .commit "$STATE/current")
digest=$(jq -er .digest "$STATE/current"); worktree=$(jq -er .worktree "$STATE/current")
ref=ghcr.io/deconfined/tarubot@$digest
```

If `current` is missing there is no recorded floor for the downgrade rule: set `floor=<the last version that ran on this host>` before the block, which then compares against it. With a floor only the version order is enforced; an equal version of a different build cannot be told apart.

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  held
  git -C "$ROOT" fetch --no-tags origin main
  [ "$(git -C "$ROOT" cat-file -t "$commit")" = commit ]
  git -C "$ROOT" merge-base --is-ancestor "$commit" FETCH_HEAD
  if [ -e "$worktree" ]; then
    [ "$(git -C "$worktree" rev-parse HEAD)" = "$commit" ]
    [ -z "$(git -C "$worktree" status --porcelain)" ]
  else
    git -C "$ROOT" worktree add --detach "$worktree" "$commit"
  fi
  [ "$(jq -er .version "$worktree/package.json")" = "$version" ]

  docker pull "$ref" </dev/null
  docker image inspect "$ref" | jq -e --arg ref "$ref" --arg version "$version" --arg commit "$commit" \
    'length == 1 and (.[0].RepoDigests | index($ref) != null)
     and .[0].Config.Labels["org.opencontainers.image.version"] == $version
     and .[0].Config.Labels["org.opencontainers.image.revision"] == $commit' >/dev/null

  # No downgrade, and no different build of the same version (the entry's rule).
  if [ -e "$STATE/current" ] || [ -L "$STATE/current" ]; then
    [ -f "$STATE/current" ] && [ ! -L "$STATE/current" ]
    jq -e --arg target "$target" '.target == $target' "$STATE/current" >/dev/null
    recorded=$(jq -er .version "$STATE/current")
  else
    recorded=${floor:?no current record: set floor=<the last version that ran> first}
  fi
  IFS=. read -r -a wanted <<<"$version"
  IFS=. read -r -a live <<<"$recorded"
  for i in 0 1 2; do
    (( 10#${wanted[i]} >= 10#${live[i]} )) || { echo "REFUSED: $version is below the recorded $recorded"; exit 1; }
    if (( 10#${wanted[i]} > 10#${live[i]} )); then break; fi
  done
  if [ -f "$STATE/current" ] && [ "$version" = "$recorded" ]; then
    [ "$commit" = "$(jq -er .commit "$STATE/current")" ]
    [ "$digest" = "$(jq -er .digest "$STATE/current")" ]
  fi
  echo "OK: release checks passed: $version"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: the release did not pass; do not continue"
```

### 4. Ask the database which case you are in

Read-only: it reads the last row of `schema_migrations`, compares it with this release, and when they are the same checks the migration file's checksum before it says anything. It changes nothing.

```sh
compose run --rm --no-deps --pull never -T tarubot bun -e '
  const {Database, SCHEMA_VERSION} = await import("./dist/src/infrastructure/postgres/database.js");
  const db = new Database(process.env.DATABASE_URL);
  try {
    let head = "none";
    try {
      head = (await db.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"))[0]?.version ?? "none";
    } catch (error) {
      if (error?.code !== "42P01") throw error;
    }
    if (head === SCHEMA_VERSION) await db.schema(SCHEMA_VERSION);
    const verdict = head === SCHEMA_VERSION ? "SAME: this release accepts the database"
      : head === "none" ? "NONE: the database has no migrations (step 5)"
      : head < SCHEMA_VERSION ? "OLDER: the migration of this release is still pending (step 5)"
      : "NEWER: this release is too old to start on this database";
    console.log("database head:", head, "| this release:", SCHEMA_VERSION, "|", verdict);
  } finally {
    await db.close();
  }'
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: the schema check failed (a checksum mismatch prints Schema version/checksum mismatch); do not continue"
```

- **SAME**: the migration is done and its checksum matches. Go to step 6.
- **OLDER** or **NONE**: this release's migration has not run. Go to step 5.
- **NEWER**: this release is too old for this database. Start a newer release; never an older one.

### 5. Back up and migrate, only when step 4 said OLDER or NONE

No bot may be running (the stop block in step 2 stopped it): `migrate.js` waits 90 seconds for a stopping bot to release the writer lease and then refuses. Take the encrypted backup exactly as the entry does, with the lock you hold (`TARUBOT_HOST_LOCK_HELD=true` makes `backup.sh` use file descriptor 9), and migrate only if it succeeded. Look for `backup ok: tarubot-<stamp>` in its output.

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  held
  selected=$(compose config --format json)
  profiles=backup
  if jq -e '.services | has("caddy")' >/dev/null <<<"$selected"; then profiles=backup,web; fi
  COMPOSE_PROFILES=$profiles TARUBOT_ROOT=$ROOT TARUBOT_COMPOSE_FILE=$worktree/docker-compose.$target.yml \
    TARUBOT_IMAGE_DIGEST=$digest TARUBOT_HOST_LOCK_HELD=true \
    timeout --kill-after=10 900 bash "$worktree/ops/backup.sh" "$target" </dev/null
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/migrate.js
  echo "OK: backed up and migrated"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: the backup or the migration failed. Run step 4 again to see which head the database has before anything else"
```

Skip this step when step 4 said SAME: the delivery completed the migration, and a backup taken now is not a pre-migration backup, because it captures the new schema. Re-run step 4 afterwards; it must say SAME.

### 6. Register the commands and read the inventory

Registration replaces the whole command set in one request, so a request Discord rejects changes nothing. Read first, because a failure can leave the outcome uncertain: if the first inventory is clean, registration already committed and the second command is not needed. Production registers the global scope; staging registers only DevBot's declared guild: set `devbot_guild=<that guild's ID>` (it is `TEST_GUILD_ID` in the host's settings, the guild DevBot's profile declares in `src/config/deployment.ts`) before the block.

```sh
compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/commands.js list; echo "inventory exit=$?"
```

`commands.js list` compares Discord with the release's declarations and exits 2 unless the inventory is clean: the declared scope matches exactly, every other scope is empty, and every scope is readable (a 403 or a permission mismatch also exits 2). It needs no database. Leftover guild-scoped commands make it exit 2 and are not caused by this step. If it exited 0 skip the next block; otherwise:

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  held
  if [ "$target" = production ]; then
    compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --global
  else
    compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --guild "${devbot_guild:?set devbot_guild to the DevBot guild ID first}"
  fi
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/commands.js list
  echo "OK: registered and the inventory is clean"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: registration or the inventory check failed; read the message before anything else"
```

A `register.js` error names the command and option Discord refused (for example `APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID`); that is a release defect to fix in source, not on the host. If the release cannot register, the recorded release can still start only when the schema is unchanged (step 3), and Discord then still holds the command set of whichever registration last succeeded.

### 7. Start exactly one writer

If anything in this block fails, the block saves the container's log and stops it, as the entry's fence does, because a failed `compose up --wait` can leave a running, unaccepted bot.

```sh
if ! held; then
  echo "STOP: the host lock is not held (step 1)"
else
  (
    set -Eeuo pipefail
    trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
    trap 'exit 130' INT
    compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 tarubot
    cid=$(bot_ids)
    [[ $cid =~ ^[0-9a-f]{12,64}$ ]]
    docker inspect "$cid" | jq -e --arg ref "$ref" --arg version "$version" '.[0]
      | .Config.Image == $ref and .Config.Labels["org.opencontainers.image.version"] == $version
        and .State.Running == true and .State.Health.Status == "healthy"
        and .HostConfig.RestartPolicy.Name == "no" and .RestartCount == 0' >/dev/null
    echo "OK: started $cid"
  )
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "STOP: the new bot is not up as expected; saving its log and stopping it"
    for id in $(bot_ids); do
      docker logs "$id" > "$STATE/logs/recovery-failed-$id.log" 2>&1 || echo "log not saved for $id"
    done
    stop_writers
  fi
fi
```

`--wait` can take up to 3 minutes. This step does not touch the bundled proxy; step 9 covers it.

### 8. Observe

Sustained readiness, not one good sample, like the entry's `observe`: the same container, no restarts, the exact image, `healthy` and a ready writer, four times ten seconds apart. (The entry also compares the image ID and the commit label each time; steps 3 and 7 already pinned both for this container.)

```sh
observed=
if ! held; then
  echo "STOP: the host lock is not held (step 1)"
else
  (
    set -Eeuo pipefail
    trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
    trap 'exit 130' INT
    cid=$(bot_ids)
    [[ $cid =~ ^[0-9a-f]{12,64}$ ]]
    for sample in 1 2 3 4; do
      timeout --kill-after=5 30 docker inspect "$cid" | jq -e --arg ref "$ref" '.[0]
        | .State.Running == true and .RestartCount == 0 and .Config.Image == $ref
          and .State.Health.Status == "healthy"' >/dev/null
      timeout --kill-after=5 45 docker exec "$cid" bun -e '
        const r = await fetch("http://localhost:3000/health/ready");
        const s = await r.json();
        console.log(r.status, JSON.stringify({live: s.live, ready: s.ready, database: s.database, writerLease: s.writerLease, discord: s.discord}));
        process.exit(r.status === 200 && s.live === true && s.ready === true && s.database === true
          && s.writerLease === true && s.discord === true ? 0 : 1);' </dev/null
      if [ "$sample" -lt 4 ]; then sleep 10; fi
    done
    echo "OK: four samples ready"
  )
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "STOP: observation failed; saving the log and stopping the bot"
    for id in $(bot_ids); do
      docker logs "$id" > "$STATE/logs/recovery-failed-$id.log" 2>&1 || echo "log not saved for $id"
    done
    stop_writers
  else
    observed=$(bot_ids)
    docker logs "$observed" 2>&1 | grep -E 'Modules loaded|Database writer lease acquired' || echo "(log lines not seen: LOG_LEVEL above info? Not a failure by itself)"
  fi
fi
```

`Modules loaded` (how many commands, components and events the release declares) and `Database writer lease acquired` are info-level lines the repository keeps stable, but the current `ops/deploy.sh` does not read them: it judges a release by health, the readiness probe and the schema checksum, and reads only error-level records for its failure reasons. Here they are quick evidence. A `LOG_LEVEL` of `warn` or above hides them without anything being wrong. Then check the behavior privately in Discord (`/version`, and a command the release added or changed). Only then record.

### 9. Record the release, arm the restart policy and clear pending

This is what the entry's `record` step does, in its order. The version, commit and digest come from the running container, which is what lets the next delivery's preflight (it compares `current` with the live container) accept it; `target`, `request` and `worktree` are the ones you set, and the block checks the worktree is that commit. The old files are kept under timestamped names.

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  held
  cid=$(bot_ids)
  [[ $cid =~ ^[0-9a-f]{12,64}$ ]]
  # Step 8 observed this container, or the table's last row (a stale marker) set stale_marker=yes.
  [ "${observed:-}" = "$cid" ] || [ "${stale_marker:-no}" = yes ]
  [ -d "$worktree/migrations" ]
  docker inspect "$cid" | jq -e --arg ref "$ref" --arg env "TARUBOT_ENVIRONMENT=$target" '.[0]
    | .State.Running == true and .State.Health.Status == "healthy" and .Config.Image == $ref
      and (.Config.Env | index($env) != null)' >/dev/null
  if [ -e "$STATE/pending" ]; then jq -e --arg target "$target" '.target == $target' "$STATE/pending" >/dev/null; fi

  # The record's values, each on its own line so a failed command stops the block.
  running=$(docker inspect "$cid" | jq -er '.[0].Config.Image')
  version_label=$(docker inspect "$cid" | jq -er '.[0].Config.Labels["org.opencontainers.image.version"]')
  commit_label=$(docker inspect "$cid" | jq -er '.[0].Config.Labels["org.opencontainers.image.revision"]')
  schema_file=$(basename "$(ls "$worktree"/migrations/[0-9][0-9][0-9]_*.sql | tail -n 1)")
  [[ $version_label =~ ^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$ ]]
  [[ $commit_label =~ ^[0-9a-f]{40}$ && ${running#*@} =~ ^sha256:[0-9a-f]{64}$ ]]
  [[ $schema_file =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]
  [ "$(git -C "$worktree" rev-parse HEAD)" = "$commit_label" ]

  # The bundled proxy, when the host's settings select it, must be running and healthy before
  # anything is recorded; the failed delivery may have recreated it with restart policy "no".
  proxy_selected=no
  selected=$(compose config --format json)
  if jq -e '.services | has("caddy")' >/dev/null <<<"$selected"; then proxy_selected=yes; fi
  if [ "$proxy_selected" = yes ]; then
    proxy=$(docker ps -q --filter label=com.docker.compose.project=tarubot --filter label=com.docker.compose.service=caddy)
    [[ $proxy =~ ^[0-9a-f]{12,64}$ ]]
    docker inspect "$proxy" | jq -e '.[0].State.Running == true and .[0].State.Health.Status == "healthy"' >/dev/null
    # Caddy reads these files through the worktree (deploy.sh does the same for a release).
    chmod 644 "$worktree/ops/Caddyfile"
    if [ -d "$worktree/ops/offline" ] && [ ! -L "$worktree/ops/offline" ]; then chmod -R a+rX -- "$worktree/ops/offline"; fi
  fi

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if [ -e "$STATE/current" ]; then cp -p "$STATE/current" "$STATE/current.before-recovery-$stamp"; fi
  jq -n --arg target "$target" --arg version "$version_label" --arg commit "$commit_label" \
    --arg digest "${running#*@}" --arg run "$request" --arg worktree "$worktree" --arg schema "$schema_file" \
    '{target:$target,version:$version,commit:$commit,digest:$digest,run:$run,worktree:$worktree,schema:$schema}' \
    >"$STATE/current.tmp"
  sync -f "$STATE/current.tmp"
  mv "$STATE/current.tmp" "$STATE/current"
  sync -f "$STATE"
  jq . "$STATE/current"

  if [ "$proxy_selected" = yes ]; then docker update --restart unless-stopped "$proxy"; fi
  docker update --restart unless-stopped "$cid"
  if [ -e "$STATE/pending" ]; then
    cp -p "$STATE/pending" "$STATE/pending.before-recovery-$stamp"
    rm "$STATE/pending"
  fi
  sync -f "$STATE"
  [ ! -e "$STATE/pending" ]
  echo "OK: recorded; pending cleared"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: nothing past the failing command was done; read the output, then repeat this step"
```

If the block stopped, fix the cause and run it again; it is safe to repeat. If `pending` names another target it stops before changing anything: reconcile that first. A proxy running while the host's settings no longer select it is stopped by the next delivery of a new version, not here. Deliveries refuse with `lock-held` while a shell still holds the lock, so release it when you are done.

**If step 9 stopped at the proxy check** (the settings select the bundled proxy and it is stopped or unhealthy, usually because the failed delivery died while recreating it), recreate it with the entry's commands (`ops/deploy.sh`, `proxy-files` to `proxy-config` and `proxy-start`), then repeat step 9. Neither `already-live` (step 10) nor a running proxy from an older release does this: a proxy keeps the old release's Caddyfile and offline page until a delivery of a new version recreates it.

```sh
(
  set -Eeuo pipefail
  trap 'echo "FAILED: $BASH_COMMAND" >&2' ERR
  trap 'exit 130' INT
  held
  chmod 644 "$worktree/ops/Caddyfile"
  if [ -d "$worktree/ops/offline" ] && [ ! -L "$worktree/ops/offline" ]; then chmod -R a+rX -- "$worktree/ops/offline"; fi
  compose pull caddy
  compose run --rm --no-deps --pull never -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 caddy
  echo "OK: proxy recreated; repeat step 9"
)
rc=$?; [ "$rc" -eq 0 ] || echo "STOP: the proxy could not be recreated; the bot is unaffected, read the output"
```

When the block printed `OK: recorded; pending cleared`, release the host lock.

```sh
exec 9>&-; locked=no
```

### 10. Prove routine delivery works again

Before the next real release, dispatch Deploy once with the recovered release's `target`, `version`, `commit` and `digest` (**Actions → Deploy → Run workflow → main**, then approve the environment). The entry finds the live container already matches, observes it twice and reports `already-live` without migrating or registering, which proves its preflight accepts the host again. It refuses `live-digest` if `current` does not match the running container, and `live-reference` if the container was not created from the digest reference; both mean step 7 or step 9 went differently than described, so look before retrying.

### When a container will not start

`docker logs <id>` has the reason. The bot prints its own error as a `Failure` with a fixed code. A failed delivery relays it to the Deploy log only after the entry's cleaning, as a `bot-error` reason.

| Message or sign | Meaning | What to do |
| --- | --- | --- |
| `Schema version/checksum mismatch. Use matching versioned migrations and application image.` | The database's last migration is not this image's. Most often an old release met a migrated database | Step 4 says which way; start the release whose migration head the database has, never an older one |
| `Run db:migrate before starting the application.` | `schema_migrations` does not exist: the database was never migrated | Step 5, with a backup first |
| `A TaruBot writer (database process N) holds the writer lease, so … migration(s) were not applied` | A bot is running while `migrate.js` waited its 90 seconds (the default; the host's settings do not change it) | The stop block in step 2; run step 5 again |
| `migrate.js` fails with a statement timeout | Another migration runner holds the migration lock, or one migration statement ran past the 15 second statement limit | Find the other runner (`docker ps -a`, a second shell); do not start another. A slow statement is a release defect |
| Readiness stays `ready: false` with `writerLease: false` | A previous writer still holds the lease: a container you did not stop, or a database session not yet closed | `docker ps -a` for another `tarubot` container; the lease frees when its process exits |
| `backup busy` | Something else holds `host.lock` and the backup was started without the held-lock flag | Run step 5's command from the shell that holds the lock; do not release the lock to run it |
| `backup.sh` exits 1 and prints nothing | `TARUBOT_HOST_LOCK_HELD=true` is set but file descriptor 9 is not `host.lock` (a new shell, or `exec 9>&-` already ran) | Redo step 1 in this shell; the lock must be taken in the shell you run step 5 from |
| `lock-held` in a Deploy log | Your recovery shell, a scheduled backup or another delivery holds `host.lock` | Finish step 9 (`exec 9>&-`), or wait for the backup |
| The container restarts every few seconds | Its restart policy is `unless-stopped` and it exits at startup | The stop block in step 2 stops it and keeps its log; then step 7 replaces it |

## Pending recovery, rotation and host loss

The commands are in [Recover a failed delivery](#recover-a-failed-delivery-step-by-step). A pending marker blocks every new deployment. The owner inspects the bound target, intent, private phase/logs, container identity, actual database schema, writer state and available backup/PITR. Choose fix-forward or a verified isolated restore; an old image cannot undo a committed migration. Migration and command registration may have committed even if their acknowledgement was lost. Preserve evidence and reconcile the actual outcome. Before clearing pending for routine delivery, manually establish exactly one healthy matching release/container, verify its target/schema/writer state and reconcile durable `current` identity/worktree state. Only then clear pending and use a fresh explicit owner-requested dispatch with that target. A fresh dispatch does not repair an unhealthy/stopped baseline; never rerun the uncertain operation or bypass downgrade/same-version protections.

If GitHub is unavailable, manual recovery still requires the owner's explicit go-ahead and the same writer/image/schema boundaries. There is no automatic rollback.

- **Runtime credentials:** update central settings privately, recreate the intended exact container in an approved window, verify, then revoke the old credential. Coordinate database passwords in one window. A simple Compose restart keeps the old container environment.
- **Host/deploy keys:** verify replacement server keys out of band and use the fenced DNS/key cutover above; replace restricted deployment credentials through owner-controlled steps and revoke the old credential. Never disable DNS verification or add a pin fallback to bypass a refusal.
- **Mod mail key:** `MODMAIL_KEY` has no rotation in 2.43.0. A different key makes every existing case unreadable (the pages say so and file one issue report), so never replace it while cases matter, and recreate the container with the same value after any settings change. Keep it in the host `.env` and one more copy off the host; losing every copy loses every case. The daily backup's encrypted `.env` copy carries it next to the dump, to the same age recipients, so that copy is how a lost key is recovered, and **whoever holds the backups' age identity can read every mod mail case in them**. That's the owner's deliberate trade-off (2026-10-11): a lost host restores fully, cases included. Guard the age identity accordingly. Production and staging each have their own.
- **Suggestion App:** production only; verify settings/recreation before revoking its old key. An empty client ID disables suggestions without blocking startup.
- **Host loss:** fence the old host, retain the managed database and encrypted settings, manually provision the replacement, install the reviewed entries and publish its independently verified authenticated SSHFP. In an approved manual bootstrap, recover exact image/schema/settings, start one writer, reconcile durable `current` state and prove sustained health/backups. Routine pipeline upgrades resume only after that healthy baseline exists. Host replacement does not authorize database replacement.
