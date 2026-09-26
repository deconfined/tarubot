# Version history

The current application version is **2.30.4**, with `package.json` as the source of truth. This codebase is a complete rewrite of the original TaruBot and therefore belongs to major version **2**. `/version` reads the manifest included in its compiled build and obtains commit history independently from GitHub's `main` branch.

## 2.30.4 — No invite link on the site; the day's records

Issue [#54](https://github.com/deconfined/tarubot/issues/54). This release changes docs, tests and records only, so Deploy production should end `no-runtime-change`.

- **No invite link.** @deconfined decided that the site carries no Discord invite or authorization URL, not even a template. Every deployment runs its own Discord application, and whoever runs one builds their own invite: "If they can't do that on their own, they're not going to have a good time self-managing a bot."
  - "Add TaruBot to a server" now has an "Adding the bot" section. It says the application's owner adds the bot with the `bot` and `applications.commands` scopes and the permissions the page lists. With **Public Bot** off, which is recommended, nobody else can.
  - The Discord application page says to turn Public Bot off. If Discord refuses, it says to set Install Link to None first.
  - The install page and README point to the page instead of a link.
- **Test.** `docs-site.test.ts` no longer pins an invite integer. Instead it checks:
  - that the page's Permissions table lists exactly the code's `requiredBotPermissions` plus Manage Channels;
  - that the page still names its key terms;
  - that no site page, and not README, carries a Discord authorization URL, a `discordapp.com` link, or a server invite link.
- **Records.** The 2.30.1–2.30.3 rollouts are recorded:
  - the first normal automated deploy;
  - 2.30.2's deploy, including a cancelled manual dispatch;
  - DevBot's updates;
  - the 2.30.3 rehearsal on DevBot and production verified hardened.

  Also recorded, all confirmed read-only: the zone is now DNSSEC-signed, the host clone has no group-writable files, and both Discord applications have Presence, Message Content and Public Bot off. The open items close, and a check that the first hardened nightly backup ran green is added. The staging host and #50's Quadlet and pull-based host-configuration decisions are in the handoff.

## 2.30.3 — Hardened containers

Issue [#51](https://github.com/deconfined/tarubot/issues/51): @deconfined decided on 2026-09-26 to harden the containers on today's Docker hosts, before the move to AlmaLinux and rootless Podman ([#50](https://github.com/deconfined/tarubot/issues/50)). It changes only the Compose files. There is no migration, and the image is unchanged.

- **The bot** (`tarubot` in `docker-compose.yml`, which DevBot inherits, and in the standalone `docker-compose.production.yml`) now runs with:
  - `read_only: true` and no tmpfs, because it writes no files;
  - `cap_drop: [ALL]`;
  - `security_opt: ["no-new-privileges:true"]`.

  It still runs as the unprivileged `bun` user, under Docker's default AppArmor profile and seccomp filter.
- **The backup job** (`backup` in the production file) gets the same three settings, plus a 1 MB private `/tmp` tmpfs. The job writes exactly one file there, `/tmp/ca.crt`.
- **How the write paths were established.** Throwaway containers ran with a disposable PostgreSQL and a fake token, never a second DevBot. `docker diff` showed nothing for every bot path the deploy and the maintenance tools use:
  - the migrations and the restore check;
  - a writer-lease wait;
  - the health check and a readiness probe;
  - a Lodestone parse in its worker, and a selector check;
  - `register.js`, `commands.js`, `retry.js` and `preview.js`.

  Every path behaves the same hardened. Inside the container, the capability sets are zero and `NoNewPrivs` is 1. The backup dump comes out the same size and restores.
- **Two tools write a file.** `preview.js --output` and `snapshot.js --output` need a one-run writable mount. Production runs both from the operator clone. The site's tools page gives the mount.
- **Tests.** `tests/unit/container-hardening.test.ts` pins the settings on both bot definitions and on the backup job, and keeps the two bot definitions in step. It also checks that the DevBot, build and tools overlays don't loosen anything. Mutations of each setting fail it.
- **Docs.** HOSTING.md ("Container hardening"), CONFIGURATION.md ("Container settings"), and the site's install, tools and requirements pages. The records include DevBot's rehearsal plan. Production's deploy request waits, unapproved, until that rehearsal passes.

## 2.30.2 — Keep onboarding correct under Discord's channel obfuscation

Issue [#47](https://github.com/deconfined/tarubot/issues/47). From 2026-11-16, Discord hides channels a bot can't view: `GET /guilds/{id}/channels` leaves them out, and the gateway sends them as `___hidden___`, flagged `CHANNEL_OBFUSCATED`, with a single fake @everyone deny. Only the id, type, position and parent_id are real. Without a fix, onboarding would have blocked from that date on servers where TaruBot can't see the Community Updates channel or its category, and elsewhere a managed channel TaruBot can't see would have silently dropped out of the pass. @deconfined decided on #47 to **fail closed**: refuse, naming the channel and the fix, rather than leave a half-working setup. Production is unaffected, because onboarding is off there.

- **The Community Updates area.** The pass finds it through the gateway cache, which keeps its id and parent. An excluded channel missing from this pass's list counts as unreadable, and the pass then keeps @everyone's View Channel default, the fallback ACCESS-05 already documents. The saved scope and the pre-write check use the same result, so the pass can't loop on `superseded`.
- **Hidden managed channels fail closed.** A channel in the gateway cache but missing from the list is checked with one `GET /channels/{id}`:
  - `50001`, an obfuscated answer, or one that denies TaruBot View Channel: the pass refuses with the existing "TaruBot needs View Channel…" fix, naming `<#id>`;
  - `10003`: the channel is deleted and ignored, unless the gateway cache still holds it obfuscated, or denying TaruBot View Channel (a slash-command channel option clears the flag but keeps the fake deny), in which case the pass refuses the same way;
  - a full `200`: the channel was created mid-pass and is skipped.

  A server where nothing is hidden makes no extra requests. `/setup` refuses a hidden saved room instead of creating a second one, and recreates only a saved room Discord confirms deleted.
- **No writes from placeholder data.** Overwrites are copied from the forced read before any other wait, and a channel that is obfuscated, or wasn't readable in this pass, is never written. A guild the gateway hasn't delivered yet makes the pass retry, instead of deciding from an empty cache.
- **Smaller fixes.**
  - In a channel TaruBot can't view (the interaction's permissions lack View Channel, or the cached entry is obfuscated), `/channel` shows only the ID and the unavailable card ("TaruBot can't see this channel's details"), instead of `___hidden___` or a real name over fake permissions.
  - Channel validation (`/config` and `/setup` destinations, guest applications, posts) treats a `10003` for a text channel the gateway still holds obfuscated, or denying TaruBot View Channel, as the permissions refusal with its fix rather than "unavailable".
  - `discord-inspect.js` now asks Discord about each destination the channel list left out and reports it as `hidden_or_other_server` (50001), `deleted` (10003), `other_server` or `unchecked`, instead of only `exists: false`.
  - A shared helper, `src/discord/obfuscation.ts`, reads the flag, the error codes and whether a cached entry looks hidden.
- **Tests.** The access fixture models the post-2026-11-16 Discord by default, alongside "off" and the Developer Portal's gateway-only test toggle. It includes hidden answers of every kind, a guild the gateway hasn't delivered yet, slash-command options that patch cached entries, and hooks that inject failures.
  - Channel-access tests cover a hidden updates area, hidden managed channels and saved rooms (also when Discord answers `10003` for an entry a channel option un-flagged), deleted and mid-pass channels, the request budget in both modes, and every new guard; ten mutations of the guards each fail a test. Channel-validation tests cover a `10003` for a cached hidden text channel and for a deleted one.
  - An integration test runs whole reconciliations against PostgreSQL.
- **Docs.** The site's setup, "Add TaruBot to a server", command reference and "Progress and problems" pages, REQUIREMENTS ACCESS-01 and ACCESS-05, CLAUDE.md and MODULES.md, and the records now describe the behavior. They include the DevBot checks for the date: DevBot keeps the obfuscation test toggle on until then.

## 2.30.1 — Cleanup after automated deploys

Issue [#48](https://github.com/deconfined/tarubot/issues/48): records, deploy docs and small tooling fixes after 2.30.0 went live. Nothing changes for members, and there is no migration.

- **The agent rule is confirmed in full.** @deconfined agreed to the whole rule on [#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419) on 2026-09-26. REQUIREMENTS.md, AGENTS.md (verbatim), CLAUDE.md, CI_CD.md and HOSTING.md now mark every clause confirmed. `deploy-workflow.test.ts` checks that no file still calls it pending.
- **`DEPLOY_ENABLED` is a repository variable.** CI_CD.md and HOSTING.md give the web UI path and require the exact lowercase value `true`. They warn that a copy in the `production` environment is invisible to the plan job, which then skips the run, and that inside the deploy job it overrides the repository variable, which defeats the pause. The first attempt on 2026-09-26 hit the first half: run 36242804814 was skipped.
- **Key probe wording.** A refused Unix-socket forward reports "connect failed", not "administratively prohibited". OpenSSH gives that wording only to TCP forwards. HOSTING.md step 6 now expects the right message and describes the optional control with an unrestricted key.
- **File modes.** `ops/deploy.sh` has run under `umask 077` since 2.30.0. New tests pin it: a static check, a worker that rewrites a group-writable clone, and the whole entry path starting from a session umask of 0002. HOSTING.md explains that a `git pull` by hand follows the session's umask, and gives the one-time `chmod -R go-w ~/tarubot`.
- **Tool guard.** The DigitalOcean cluster is gone, so the guard drops its direct port 25060 and its `doadmin` login. Managed hosts must use Linode's direct port 27520 and a login other than `akmadmin`. The test fixtures use reserved `.example` placeholder hosts on Linode's direct port 27520, and `akmadmin` in place of `doadmin`.
- **Claude review tools.** The review job now allows only read-only tools: Read, Grep, Glob, the inline-comment tool, `git diff`/`log`/`show`/`status`/`blame`, `gh pr` and `gh issue` reads, `gh search`, and `ls`, `cat`, `head`, `tail`, `wc` and `grep`. It denies `git … --output`. A pull request that changes this workflow skips its own review, so the list first runs on the next reviewed pull request.
- **Site.**
  - The roadmap re-slot from [#43](https://github.com/deconfined/tarubot/issues/43): v3 is stabilization plus the web baseline, a view-only dashboard for officers and administrators. v4 is the member web app, and its first planned feature is activity scheduling from a member's suggestion ([#45](https://github.com/deconfined/tarubot/issues/45)).
  - "Add TaruBot to a server" now gives the right reason for Read Message History: TaruBot checks for it before posting, and a guest review redraw fetches the earlier message. The lifecycle rewrite of that page belongs to [#46](https://github.com/deconfined/tarubot/issues/46).
  - A new **Thank you** page (Project) credits the v2 testers by the names they use on Discord, and names the maintainer and TaruBot's in-game contact, at @deconfined's request.
- **Records.**
  - OPEN_ITEMS.md, SESSION_HANDOFF.md, VERIFICATION.md and DEV_GUILD.md now record the 2.30.0 rollout: the hand deploys, the skipped first run and why, the first automated run (`already-live`), and the key probe with its control.
  - 2.24.3's production check is recorded as passed: no roster notice since the deploy.
  - Also recorded: the least-privilege attempt and its rollback, DevBot's obfuscation test toggle, the open issues and release order (2.30.2 for [#47](https://github.com/deconfined/tarubot/issues/47), 2.31.0 for #46), and the owner checks still owed.
  - Other members' character names and Lodestone IDs were replaced with neutral wording in the records and the CHANGELOG. The maintainer's own in-game contact is named on the Thank you page, at @deconfined's request. Testers' handles and Discord user IDs were replaced with roles ("the officer tester", "the visitor tester") in the records and CHANGELOG, and with invented names in the tests. The testers are now named only on the Thank you page.

## 2.30.0 — Approved production deploys over SSH

Issue [#41](https://github.com/deconfined/tarubot/issues/41): production deploys run from GitHub Actions after the owner approves them, over one restricted SSH key. The owner approved the [plan](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843136740) and answered its ten questions on 2026-09-26 ([decision comment](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843517579)). No bot change, no migration (it requires `010_status_notices.sql`, as 2.29.0 does) and no command change.

- **Workflow.** `.github/workflows/deploy.yml` ("Deploy production") runs after "Publish containers" succeeds for a push to main, or by hand with a version (a rollback also names the live version it leaves). Its three jobs use no action and no checkout, and every expression reaches a script through `env:`:
  - `plan` (a read-only token, no environment, no secret) checks that `production` requires @deconfined alone with self-review allowed, no admin bypass and main only, and that `notify` accepts only main. It resolves the version, commit and image digest (the version tag and `sha-<commit>` must be the same image, on a commit on main) and decides whether anything that runs in production changed. GitHub's compare API lists at most 300 files, so a merge or a rollback range of 300 files or more is refused as `compare-too-large` (deploy it by hand) rather than planned from a list that may be cut short. It writes the plan to the run summary: migrations added and host-side changes in this merge (never a bare "none", with links to the host-side files' history for a production older than the previous release), warnings for the Tuesday maintenance window and the daily backup, the changelog section and what approving does, including that the target's host-side files run as a root-equivalent docker-group user. Docs-, test- and CI-only merges end there with a quiet Pushover message.
  - `deploy` runs in the `production` environment, so it waits for @deconfined's approval. It reads the host from the environment variable `DEPLOY_HOST` (the repository names no host), pins its key from `DEPLOY_KNOWN_HOSTS`, and sends one command to the host's forced command, retrying only dropped connections, with the same command, for up to 80 minutes (the host's longest run is about 68). A changed host key or a rejected key stops it at once. It reports `unreachable` only when every attempt failed before sshd answered; otherwise a missing result is `outcome-unknown`.
  - `notify` sends one Pushover message from the `notify` environment: deployed, already live, superseded, not deployed, recovered, or NEEDS YOU with what to do, the way back depending on the path (a rollback after a restart, an ordinary deploy after a rollback, a fix release or fork after a migration).

  Re-runs are refused (every job requires the first attempt), and there is no concurrency group: several approval requests may wait, and the host serializes runs. With `DEPLOY_ENABLED` unset, nothing runs.
- **Publishing.** `publish.yml` no longer publishes `v*` tags: only main publishes, so every version and `sha-` tag a deploy trusts was built from main.
- **CI.** The checks job runs ShellCheck on `ops/*.sh`.
- **Host script.** `ops/deploy.sh` is the deploy key's forced command (`restrict,command=`). It accepts exactly `deploy <version> <commit> <digest> <run>` or `rollback <version> <commit> <digest> <run> <from>`; anything else prints the usage line and exits 64 before any lock, git or Docker call. It checks with GitHub's public API that this exact run is in progress on main with its Deploy job running, names that target and was approved by @deconfined (by login and account id) for `production`, and checks the run again just before its first change. It refuses while manual work looks in progress (the bot stopped, the pin not the running release, a backup running, a changed clone, a log level above info). Then:
  - no migration files added since the live release: `docker compose up` onto the new release, a one-minute stability check, then the `.env` pin;
  - migration files added: stop, a fresh `ops/backup.sh` dump, `migrate.js` in the new image, the pin, then start;
  - the previous release comes back automatically only when the new one never got a container, or its one container provably never took the writer lease (its logs must reach "Modules loaded" and show no lease line), or the migration did not commit. When Compose shows anything else after a failed start, nothing is restored or pinned; otherwise the new release stays, pinned, and the result asks for the owner. A restore removes orphans, so the previous Compose file decides what runs;
  - `register.js --global` and `commands.js list` run on every run that starts or verifies a release;
  - the image must be the digest the plan showed;
  - a migration during the Tuesday maintenance window warns but runs (the owner's answer to question 9);
  - only fixed `step`, `warning` and `result` lines leave the host; tool output stays in `~/.local/state/tarubot-deploy/runs/<run>/worker.log`. The worker runs detached with a clean environment and holds a per-run lock, so a dropped connection reattaches and a dead worker is reported. A run refused before its approval was confirmed starts over on the next request, so a request sent before the approval can't block the approved run; such runs are pruned after 10 minutes, and at most four workers run at once;
  - every `docker` call is bounded by `timeout`, and the host lock and backup waits are 5 minutes each;
  - its header freezes the two bot log messages the recovery rule reads, since the live release's copy judges the new release's logs.
- **Tests.** `deploy-script.test.ts` runs the real script against a throwaway git repository with simulated `docker`, `curl`, `df` and `mktemp`: hostile requests, every path and recovery rule (including what Compose shows after a failed start), the refusals, the approval check and its second look, host-lock contention, starting over, the worker cap, pruning, attach and replay (with a committed v1 run directory), the detached launch, and one request through `main` into the real worker. It also pins the two log messages in `src/`. `deploy-workflow.test.ts` pins the workflow's shape and its contract with the host script, asserts that neither names a host, and runs the plan (automatic, dispatch and rollback runs, the 300-file compare cap for a merge and a rollback, the host-side summary and the clock warnings), SSH and notify scripts with simulated `gh`, `docker`, `date`, `ssh` and `curl`. It also checks that AGENTS.md carries REQUIREMENTS.md's agent rule verbatim, with its confirmed and proposed parts marked. Both files give each test two minutes by default: the linux/arm64 image build runs them under QEMU, where two exceeded Bun's 5-second default. `migration-files.test.ts` now forbids migrations that control their own transaction, which the recovery rule relies on.
- **Requirements and rules.** REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)" records the owner's ten answers: the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy and what its plan lists; the host dump stands in for the operator dump in automated migrations (the manual procedure keeps it); docs-, test- and CI-only releases ask nothing; port 22 stays open to all under the firewall; the maintenance window warns; and the agent guard, in place since 2026-09-26 (deny rules, a read-only `gh` token, pushes over SSH, writes through the agent's app). Its canonical "Agent rule", carried verbatim by AGENTS.md and pointed to by CLAUDE.md, CI_CD.md and HOSTING.md, marks what is confirmed: the owner's approval is the go-ahead and Claude sessions never approve (question 1), and a deploy by hand still needs the owner's explicit go-ahead. The rest is proposed in PR #44, pending @deconfined's confirmation, and followed meanwhile: agents never approve, reject or bypass a deployment, never create, read or hold the deploy key, never change the environments, their secrets or variables or `DEPLOY_ENABLED`, never enable, disable, cancel or re-run the workflow, and dispatch it only when the owner asks. AGENTS.md and CLAUDE.md also freeze the two log messages.
- **Docs.** HOSTING.md "Automated deploys": the flow, what the host checks and does, every outcome and reason with what to do (the way back by path, and recovery steps that pin and move the clone before starting), the host's logs, what to do when a worker dies, pause, stop and kill, and the owner's setup: the environments, `jq`, the key generated in memory into `production`, its restricted line in the `tarubot` user's `authorized_keys` (the path by that user's home), probes that keep the owner's own key out and test forwarding, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` checked against SSHFP without the key file's comment (both shown in every public deploy log), Pushover, the firewall, `DEPLOY_ENABLED`, and a first run expecting `already-live`. The rebuild runbook installs `jq`, checks logind's `KillUserProcesses`, rotates the deploy key and updates `DEPLOY_KNOWN_HOSTS`; the manual procedure gains `-T` and names release commits rather than tags. CI_CD.md "Deploy production" has the triggers, jobs, settings and rules, and "Agent access to deployments" the guards in place, what a pushed branch workflow could still do, and the owner's open decisions (signed build provenance with `gh attestation verify`; the agent's push credential). The records (OPEN_ITEMS.md, SESSION_HANDOFF.md, DEV_GUILD.md's planned rollout, VERIFICATION.md, the test plan) show the owner's 2026-09-26 steps (the environments and settings, the firewall, W14 and W15, the DigitalOcean cleanup) and 2.29.1's confirmed review run, and CONFIGURATION.md says `ci:version`'s tag check no longer runs in CI. The old App Platform proposal points at 2.30.0. The site's deploy pages describe the stock Compose install and are unchanged.
- **Rollout.** 2.30.0 changes no running code, so DevBot needs nothing. The owner created the environments and their settings on 2026-09-26 with `DEPLOY_ENABLED` unset, so the first run after the merge does nothing. Production gets 2.30.0 once by hand, as a restart, so the host has `ops/deploy.sh`; then the rest of the owner's setup and a first run of 2.30.0. No member note: members notice nothing.
- **Scoped starts.** Every `up` in `ops/deploy.sh` names the `tarubot` service, so a profile-gated service added later (the v3 web proxy planned in #43) can neither start with nor fail a bot deploy. Today it behaves exactly like a bare `up`.

## 2.29.2 — Generic production host references

The docs and the settings-copy tool no longer name the production host; `host-env-backup` now requires `--host`. Tooling, tests and documentation only: no bot change, no migration (it requires `010_status_notices.sql`, as 2.29.0 does), no command change, and nothing to deploy.

- **Settings copy.** `scripts/host-env-backup.ts` has no default host: run it as `bun run host:env-backup -- --host tarubot@<production host> --identity …`. Without `--host` it stops with a message naming the flag, before any SSH read or file write. Everything else it does is unchanged.
- **Docs.** HOSTING.md, CLAUDE.md, SESSION_HANDOFF.md and VERIFICATION.md write `tarubot@<production host>` in commands and "the production host" in prose, and the rebuild runbook's DNS steps name no domain.
- **Tests.** `host-env-backup.test.ts` covers the missing host. The site's guard against hosts under the operator's domain keeps every case (a sentence-final period, a DNS record, a hyphen suffix, a URL), written with the bare domain.
- No member note: members notice nothing.

## 2.29.1 — Claude reviews the agent's pull requests

The owner asked for the Claude review to start on its own for the pull requests the agent's GitHub App, `tarubot-agent[bot]`, opens ("Let's handle the Claude review trigger, since that's an easy win."). CI and records only: no bot change, no migration (it requires `010_status_notices.sql`, as 2.29.0 does), no command change, and nothing to deploy.

- **CI.** The advisory Claude review (`claude-code-review.yml`) now runs when the agent's GitHub App, `tarubot-agent[bot]` (not the TaruBot app, `app/tarubot`, that opens `/suggest` issues), opens, reopens or marks ready one of the agent's pull requests. The job used to skip every bot, so the agent's pull requests were closed and reopened by hand to get a review (#35 and #38, for example). The job condition admits that one login next to `User` senders, for those three event types only; the app's pushes (synchronize) stay skipped. Pushes to the agent's branches normally come from the maintainer's account, a `User` event that is reviewed as before, and if the agent ever commits through the app, each push would otherwise start a review of up to 90 minutes and cancel the one running. The review step passes `allowed_bots: "tarubot-agent[bot]"`, since the action otherwise fails a bot actor with "Workflow initiated by non-human actor". The action checks no repository permission for a `[bot]` actor, so the list names that account alone, never `*`. Every other bot, Dependabot included, stays skipped, and so do drafts and fork pull requests. The action pins and the rest of the workflow are unchanged.
- **Verification.** This release's pull request changes the workflow, so the action skips its review (it runs only a workflow identical to `main`'s copy). The first pull request the app opens after the merge is the check: its run should log "Actor tarubot-agent[bot] is in allowed_bots list, skipping human actor check" and then review. If Anthropic's token exchange refused an app actor, the step would fail visibly ("App token exchange failed"), and a close and reopen would still start a review.
- **Records.** The 2.28.0 rollout (2026-09-25: the app settings on the production host, both deploys, 21 roots / 46 paths registered, the app probe and the owner's test `/suggest`, issue #39) and the 2.29.0 rollout (2026-09-26: migration 010 on DevBot and production, a silent first pass, no registration) in DEV_GUILD.md, VERIFICATION.md, OPEN_ITEMS.md and SESSION_HANDOFF.md. 2.27.0 changed only documentation, so nothing was deployed for it. The Woven Souls changelog channel is recorded as set (the owner, 2026-09-25: "Changelog channel config was already done."). When it was set isn't recorded, so whether Woven Souls got 2.28.0's update post stays open: it did only if the channel was set before production started 2.28.0 (healthy at 23:50:27 UTC). The two 2.25.0 notes now say production had no changelog channel then.
- **Docs.** CI_CD.md describes the exception and its two gates. No member note: members notice nothing.

## 2.29.0 — Member status changes in the officer channel

Issue [#31](https://github.com/deconfined/tarubot/issues/31): officers see material membership changes in the officer notifications channel (OPS-11). The owner approved the [plan](https://github.com/deconfined/tarubot/issues/31#issuecomment-5836583557) and accepted all seven recommendations in the [decision comment](https://github.com/deconfined/tarubot/issues/31#issuecomment-5836910305) ("Accept all recommendations. We'll tweak if needed."); REQUIREMENTS.md "Approved status-notice amendments (2026-09-25)" records them. It adds migration `010_status_notices.sql` and no command change. The first pass after the deploy only records everyone's status and posts nothing.

**Version.** This release was built and reviewed as 2.27.0 on top of 2.25.0. The documentation site (#33, PR #37) merged first as 2.27.0 and `/suggest` (#32, PR #36) as 2.28.0, so this release follows them as 2.29.0, as 2.28.0's release-order note says. The merge carries this release's `docs/OPERATIONS.md`, `docs/SETUP.md` and README edits into the site pages: what officers see on "Officer notices and update posts", the operators' side (the job key, outcomes, the inspection query, the manual reversal and the lock order) on the monitoring page, and the "Status notice" job label on the replies page.

- **The post.** One embed, "Member status changes", about 2 minutes after the first change, covering every change in that window; a change undone inside it cancels out. It groups mentions by transition and reason ("Member → Guest · no linked character is in the FC", "No access → Guest · guest grant", "Officer removed · officer access revoked", "FC Leader added · FC leader"), then a "Left the FC" list with the character's name and its owner's mention. Mentions only, no "by @officer" line, and they never ping. The footer counts the members and the timestamp is when the batch was frozen.
- **Size.** Each post names every member it holds: at most 100, and fewer when their lines wouldn't fit in nine fields and 5,800 characters. A larger set posts back to back in the same run. The only "Not listed" field is a defensive guard for one member whose own lines exceed the budget.
- **What is recorded.** After each successful role update, `Synchronization.user` records Member, Guest, Officer and FC Leader, but only decisions that don't depend on the roles the member already holds: `accessDecisive` runs the real policy for every combination of holding Member and Guest, and `rankDecisive` does the same for the rank roles. A rebind, an out-of-date roster, an unchecked new link, an unknown rank or a hand edit the bot keeps therefore records nothing; the next decisive pass compares against what was last announced. An unbound role's flag is null, and the first decisive value (after the deploy, a first binding, a rebind or a rejoin) is a silent baseline. A blocked role write records nothing until it is fixed. A pass for a member with no `guild_users` row yet records nothing and logs nothing (`Synchronization` has no logger); the next enumeration creates the row and its pass takes the baseline. A lost Guest reads "a linked character is in the FC" only when the same pass decided Member; with Member kept by hand on an out-of-date roster the reason is the revocation or the missing basis.
- **Departures.** The accepted roster records every confirmed departure of a linked character (missing, then absent a minute later) on its owner's row in the snapshot transaction, including alts whose owner keeps Member and owners who left the server. DevBot's "FC roster accepted" line keeps its count.
- **No channel** (decision 5: changes made while it is unset aren't saved for later). A pass reads the officer notifications channel under its guild lock: with none, its change is taken as announced at once and nothing is queued; the roster likewise records no departure (and locks no owner) in a guild without one. So setting the channel within two minutes of a change never posts it. Unsetting the channel with `/config` clears everything the guild still has waiting in the same transaction (`dropWaiting`, shared with the job's no-channel drop), `status_posting` included, for every member, those who left the server and those whose passes park while Discord changes are paused included: a job that ended `failed` before the unset is never revived, and no pass reaches a member who left, so without this their waiting changes and frozen batch would post once a channel was set again. As backstops, the job's no-channel drop clears whatever it still finds, and every pass with no channel clears whatever its member still has waiting, whether or not it changed anything; a pass with nothing to clear still writes nothing.
- **State.** Three nullable `guild_users` columns: `status_state` (the announced and last decisive flags, their reasons and unposted departures, validated on every read), `status_since` (when something first waited) and `status_posting` (the member's frozen lines in a post in flight).
- **The job.** `officer.status`, key `officer:<guild>:status`, payload `{}`, queued by every recorded change and due one window later:
  - no officer notifications channel: what waited from before the unset is announced as it is and nothing is saved for later (`{skipped: "officer notifications unconfigured"}`), before the effects gate, even with Discord changes off;
  - with Discord changes paused it parks as `disabled` and posts on resume;
  - a batch frozen earlier is resent first, unchanged, under the same nonce key `status:<batch>`, or only marked when its `delivered` attempt shows Discord already took it;
  - then it waits (`ordered`, at debug) until the oldest change is two minutes old, or completes `{skipped: "nothing to post"}`;
  - then it freezes batches under its lease, sends each and marks it straight after the send, before the lease check, so a lost lease never leaves a posted batch unmarked. Each send records `started`, then `failed` (missing permissions block it and keep the batch frozen) or `delivered`, with the message ID and the nonce key, written before the mark: a mark that fails after Discord took the post (the database, say) is an ordinary retry, and the retry only marks the batch, so a late retry never posts it twice. There is no in-process retry of the mark;
  - each freeze re-reads the guild under its share lock: if the bot left, Discord changes were paused, or the officer channel was unset or moved since the run started, the drain stops with `superseded` (a wait) and the rerun drops, parks or posts to the new channel.
  - The job label is "Status notice" ("Status notice posted").
- **Lock order.** The guild row first, then its `guild_users` rows in `(guild_id, user_id)` order (`COLLATE "C"`), then job rows. `sync.guild`, a pass's recording and the status job's freeze, mark and no-channel drop take the guild row `FOR SHARE` first; `/config` adoption, the officer channel's unset, `/setup` and activation take it `FOR UPDATE` before their member and job rows, so the two sides queue on the guild row instead of deadlocking (a pass's status job insert takes `FOR KEY SHARE` on the guild row through its foreign key). The roster, which already share-locked its guilds before any member row, now decides every link's transition before any write and locks the departing owners' rows in that order before any `characters` row, the order `/unclaim`, `/assign` and the two-404 unlink use; `sync.guild` then locks all its guild's rows up front. Every new member-row lock is `FOR NO KEY UPDATE`: it serializes with the others and with `/unclaim`'s `FOR UPDATE`, but never blocks the `FOR KEY SHARE` of a foreign-key check, such as the roster's `membership_history` insert for another owner.
- **Queue.** A run that finishes after newer input bumped its generation is requeued with a fresh attempt budget (`attempts` reset), as `requeueParked` and `retry.js` give, so a busy guild's status post isn't failed by one transient error after about seven requeues.
- **Not announced** (decision 7): role changes after `/config roles` or `/setup` binding changes (except officers adopted when a new Officer role replaces one already set), hand edits the bot keeps while evidence is unconfirmed, roles given on joining, people who left the server, nicknames, rank changes that don't change Officer or FC Leader, and FC joins that change no access. Linking an FC to a server whose roles are set up posts its confirmed members as "Guest → Member" after the first roster, or about 2 minutes after the relink when the same FC is relinked while its last roster is still fresh (`/config fc unlink` keeps the membership rows); it is the mirror of the unlink post.
- **Member note.** None: the posts go only to the officer notifications channel, so members notice nothing (CLAUDE.md step 2).
- **Deploy.** The migration procedure: stop, back up, `migrate.js`, `up`. No command registration. Rolling back to 2.28.x or earlier isn't possible across the migration (the schema check refuses to start); the ways back are a fix release, a restore, or the manual reversal on the site's monitoring page ("Status notices").
- **Tests:**
  - `tests/unit/status.test.ts`: the probe table for `accessDecisive` and `rankDecisive`, recording (baselines, changes, cancelling, unbinding, rejoining), every reason code, a lost Guest's reason from real policy facts (Member held on a stale roster, fresh, and unbound), entries and every access transition, the mark (including a rejoin while the post was in flight) and the no-channel drop;
  - the post: the plan's example, group order, 100 members in three fields, a departure-heavy batch sized by the budget, the "Not listed" guard, byte-identical renders and the gateway's `status:<batch>` nonce; `splitFields` with a separator; the job label;
  - on PostgreSQL: migration 010; the first-pass baseline and an unchanged pass leaving the row untouched; grant, grant-and-revoke, stale hand edits, Member rebinds, an Officer rebind with adoption, `/setup` naming a new FC, an FC unlink and relink (after the roster went stale, and at once with a fresh one), an unchecked link, unbinding and rebinding, a rejoin, no `guild_users` row, a blocked role write; departures (lost Member, an alt, an owner who left), 105 members plus former-member guests in two posts, a departure-heavy batch; the lock order (the roster's owners before characters, `sync.guild`'s rows in user order, `sync.guild` and recording waiting on a held guild row before any member row, and `sync.guild`'s and the freeze's member locks refusing a writer but not a foreign-key check); a blocked send resent first with a reconcile pass due, a lost lease after the send, a lapsed lease, a failed mark after the send (marked on retry, one post), a channel moved during a drain, the job's no-channel drop with Discord changes off, no channel when the change is recorded, an unchanged pass with no channel clearing a waiting change and a frozen batch that a failed job left (then a channel set again posts only the next change), the `/config` unset clearing a failed job's frozen batch at once, a departed owner whom no pass reaches included (the repair pass then changes nothing, and a channel set again posts only the next change), a change during a run, and paused and resumed; next to the queue tests, the attempt reset.
- **Docs:** the documentation site (merged from 2.27.0): the officers' page "Officer notices and update posts" gains "Member status changes" (what the post shows, when it posts, what isn't announced, no channel, an example with placeholder names), the monitoring page gains "Status notices" (the `officer:<guild>:status` job, its outcomes and failures, the inspection query, the manual reversal and the lock order), the replies page the "Status notice" label and the post, the command reference's `/config officer_notifications` names the posts, the permissions table on "Add TaruBot to your server" names them under Send Messages and Embed Links, the operations page's rollback links the manual reversal, and the index, access-and-sync and data-and-privacy pages mention the posts and the new columns. REQUIREMENTS.md (the amendment and OPS-11), REPLIES.md, CONFIGURATION.md, PERSISTENCE.md and CLAUDE.md follow, with the planned DevBot rollout in DEV_GUILD.md.

## 2.28.0 — Public feature suggestions with `/suggest`

Issue #32 asked for a way to suggest TaruBot features from Discord as public issues in this repository. The owner answered the plan's questions on 2026-09-25 (REQUIREMENTS.md "Approved public-suggestion amendments"). There is no migration (it runs on 2.25.0's schema 009); the command surface grows to 21 roots and 46 paths (2.25.0's 20 roots and 45 paths, plus `/suggest`), so commands must be registered after the deploy.

**Version.** This release was built and reviewed as 2.26.0. The documentation site (#33, PR #37) merged first as 2.27.0, so 2.26.0 is skipped and this release follows it as 2.28.0; #31 (PR #38, migration 010) becomes 2.29.0. The merge carries this release's `docs/OPERATIONS.md`, `docs/SETUP.md` and README edits into the site pages, and the member note moves to the 2.28.0 key.

- **`/suggest idea:…`** (10–1,000 characters) opens an issue in `deconfined/tarubot` at once, labelled `enhancement` and `from-discord`, and replies privately with its link ("Suggestion posted"). Nothing is saved first: an idea is easy to retype, and posting inside the deferred interaction needs no table, job or migration.
- **Who.** Only in the FC's own server (production's `deployments.production.guilds`, DevBot's test guild), and only for people holding the server's bound Member or Guest role (the owner's "anyone with server access"). Officer access alone doesn't qualify; officers qualify through their Member role. Other servers that add the bot are refused, even for their managers.
- **What goes public** (`src/domain/suggestions.ts`, pure). Only the cleaned text and TaruBot's version: a fixed first line, the text in a `text` code block, and "Sent by TaruBot X.Y.Z." The title is the start of the text, cut at a word within 80 characters.
  - `normalise` folds compatibility forms (NFKC) and removes controls and every default-ignorable, format, private-use and unassigned character, so an ID split by an invisible mark (a soft hyphen, U+180B) is seen whole.
  - `clean` applies one shared list, repeated until nothing changes (nested Discord markup unwraps one level per pass): Discord mentions become words, custom emoji and command mentions keep their names, links with or without a scheme (including a domain or `localhost` followed only by a port, query or fragment), IPv4 addresses and global IPv6 addresses become `[link removed]`, then email addresses, the issue reporter's credential shapes, runs of 17 or more digits or other number characters in any script (marks on them included), and every `@` (to `＠`). Titles also turn `#` into `＃` and `GH-` into a look-alike, so nothing cross-references.
  - **Hosts in any script** (second review): the link rule's labels and TLDs take letters, digits and marks of every script, and punycode, so `пример.рф/путь`, `пример.com/путь`, `例子.中国/路径`, `उदाहरण.भारत/पथ` and `مثال.إختبار/مسار` go like `example.com/path`, with a port, path, query or fragment as before. `。` separates labels as browsers treat it (`discord。gg/…`; NFKC folds `｡` into it and `．` into `.`). Chinese and Japanese are written without spaces and end sentences in `。`, `．` or `？`, so three rules keep their prose intact: a label never mixes Han, Hiragana or Katakana with other scripts (text running into a link keeps its words), `。` separates labels only where neither side is in those scripts, and a TLD in them needs a `.` before it and a port or path after it. The accepted cost is that a Chinese or Japanese host written next to `。`, or with only a query or fragment after a Chinese or Japanese TLD, stays. Email addresses take marks and `。` too, so `नाम@उदाहरण.भारत` and `name@example。com` go. The rule is built from named Unicode-set pieces, and a host's labels start matching only where a run of them begins, so labels need no length bound.
  - **Hostile review** (third review): a tester's bypasses are closed, each with a unit test, and the title follows the text.
    - Hosts as browsers read them: a fully qualified name's final dot (`discord.gg./…`, `discord.gg。/…`, `localhost.:3000/…`), a backslash path (`discord.gg\…`), an empty port (`discord.gg:/…`), percent-escapes, which browsers decode in a host (`discord%2Egg/…`, `disc%6Frd.gg/…`, the escaped `。`), and emoji and symbol labels (`i❤.ws/…`, `☃.net/…`, `ab€.com/…`). `http:`, `https:`, `ws:`, `wss:`, `ftp:` and `file:` go with the host after them whatever slashes or backslashes follow (`https:\\example.com\…`, `https:intranet/…`), as whole words, so `profile:x` stays.
    - Chinese and Japanese sound marks (U+3099, U+302A–302F) count as marks in any label or TLD, so `discord.gg゙/…` goes like `discord.gǵ/…`.
    - IPv4 addresses in octal or hexadecimal (`0177.0.0.1`, `0x7f.1/…`, `0x7f000001/…`) and touching letters (`ip192.168.1.10`, `192.168.1.10x`) go; `v1.2.3.4` and `1.2.3.4567` stay.
    - A `user:password@` of any characters in front of a host goes with it (`admin:hunt!er2@…/x`, `admin:p@ss@…/x`), and so do email addresses with a quoted local part or RFC 5322's other characters (`"john doe"@…`, `john!smith@…`, `o'brien@…`) or `_` in the domain.
    - IDs in keycaps (`1️⃣2️⃣…`), with marks on their digits, or in other number characters (`➀➁…`, `❶❷…`) go.
    - "Awww. That…" and a bare "www." are no longer links.
    - Left as accepted limits, named in the module's header and the site's monitoring page: look-alike dots and slashes with no compatibility form (`discord·gg`, `discordꓸgg`, `discord.gg∕x`), which browsers send to other hosts and several scripts use as punctuation or digits; IPv4 addresses written as one to three decimal numbers (`127.1`, `192.168.1`, `2130706433`), which read exactly like ratings, times, version ranges and counts; and the ideographic full stop's limit, which covers any host whose `。` sits next to a Chinese or Japanese label or TLD, including a Latin subdomain in front (`abc.例え。jp/…`) and a Latin host before such a TLD (`discord。コム/…`).
    - Speed: a run of labels starts only where it begins, escapes included, and digit labels after Chinese or Japanese ones belong to their run, so the tester's quadratic chains (`例1.` repeated) are linear. The slowest 1,000-character shapes tried clean in under 1 ms a pass, and 120-level nests padded with Chinese chains take about 40 ms (from about 120 ms).
  - **Global IPv6 addresses** (@deconfined's rule): global unicast is 2000::/3, so an address whose first group is exactly four hex digits starting with 2 or 3, with at least two colons, goes whole: `::` compression, either case, an IPv4 tail (`2001:db8::192.0.2.1`), brackets with a port (`[2001:db8::1]:8080`), and any path, prefix length, query or fragment, as for IPv4. Dates, totals, scores and slices fit the rule too (`2025:09:25`, `2150:30:12`, `2000:1500:1200`, `data[2000:3000:10]`), so the rest must have an address's shape: one `::`, or all eight groups (or six and an IPv4 tail). It must also be a whole run of groups and colons, so those, times (`10:30:00`, `23:59:59`), ratios (`16:9`), one-colon forms (`2024:01`), scopes (`std::vector`, `a::b`) and non-global addresses (`fe80::1`, `fd00::1`, `::1`, `1234:5678::1`) stay; a label before it (`IPv6:`, `ip:`) keeps its word, and so does text around it in the scripts that run words into numbers: Chinese, Japanese, Thai, Lao, Khmer and Myanmar, written without spaces, and Korean, whose particles attach (`주소는 [link removed]입니다`). The accepted limits, named in the module's header and the site's monitoring page: an address inside a longer run of other letters, digits or colons (`ip2001:db8::1`, `2001:db8::1x`) stays, and so does the start of one with no `::` (`2001:db8:1234`), which reads like a date or a score. Each colon starts at most one group and a run starts only at its beginning, so long colon and hex runs clean in linear time.
  - `assertPublic` checks the text against the same list, and the title and body for `@`, long IDs, invisible characters and controls, well-formedness, the header, one fenced block and the size limits. A failure is a bug: the member gets the unexpected card and the owner a private report.
- **Limits.** One per member per hour, three per member and ten in total in any 24 hours, counted from `audit` rows (`suggestion.posted`, target `#N`, which also records who sent each issue). Any GitHub error other than a rate limit, a rejected request or a refused credential may have posted, so it writes `suggestion.unconfirmed`, which every limit counts; its card ("GitHub didn't confirm your suggestion") asks the member to check GitHub first. An outage during the app's sign-in counts the same way, so one path and one card cover both. Submissions run one at a time in the writer process, so the limits are exact. At shutdown the lifecycle's new `drain` option waits for a post in progress to finish and record its row before the writer lease is released, and later submissions are refused as `stopping`.
- **Identity.** Production posts as the TaruBot GitHub App (App ID 5076273; Issues write and Metadata read only, installed on this repository alone), so issues show the app's bot account, never the owner. `src/infrastructure/github/app.ts` signs an RS256 JWT with the app's key and mints a one-hour installation token, narrowed to this repository's issues, for each post; failures map to catalog codes (GitHub's rate limits as waits, through `rateLimitWait`, which the issue client now shares) and no message carries the key, JWT or token. New settings `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` are production-only (the production Compose file, `production.env.example` empty, and `host-env-backup`'s expected settings); either one empty switches `/suggest` off. `GitHubIssues` can name the app's settings in its refusals.
- **DevBot** previews into the private reports repository with `GITHUB_REPORTS_TOKEN`, ignoring the app settings. `GITHUB_REPORTS_REPO` may no longer name the public repository: startup refuses it.
- **Workflow guard.** `claude.yml` never starts the agent for an issue whose body contains the marker "Suggested in Discord with TaruBot". No action or pin changed.
- **Replies.** New failure concepts `wait.suggest` (the limits and GitHub's rate limit) and `upstream.github`, the success card `suggest.posted`, an Example for `idea`, and `/suggest`'s own "How to qualify" steps on the membership card, which lead to either role.
- **Member note** (CLAUDE.md step 2, after merging 2.25.0): `src/domain/release-notes.ts` gains 2.28.0's note, "Members and guests can now suggest TaruBot features with /suggest: the idea is posted publicly on GitHub by TaruBot, without your name." A server with a changelog channel gets it in one update post when it starts on 2.28.0.
- **Moved.** `secondsUntil` and `after` move from `issue-reports.ts` into `src/domain/reports.ts`, and `SECRET_PATTERNS` is exported; the issue reporter is otherwise unchanged.
- **Tests.** A unit suite for every cleaning rule, the invisible characters, the fixed point on nested markup (990-character nests included), hosts in any script (Cyrillic, Chinese, Japanese, Korean, Greek, Arabic, Hebrew, Devanagari and Thai labels and TLDs, mixed-script and punycode hosts, and ideographic full stops, each with a port, path, query or fragment) and the Chinese, Japanese and other prose that must stay, each of the hostile review's bypasses and accepted limits, global IPv6 addresses and the forms that stay, a time bound on 13 adversarial 1,000-character chains and 15 colon and hex runs, a seeded fuzz of 2,000 ideas (mulberry32, seed 32, with internationalised-host, hostile-review and IPv6 fragments, each cleaned text checked as a fixed point), the owner-approved public example, the final check's refusals, who may suggest, where each deployment posts, the settings guard, the workflow guard, and how GitHub's answers are translated. Contract tests sign and verify a JWT with a throwaway key generated in the test (no key is committed) and cover the installation lookup, the token request and every failure, rate limits on either call included. Lifecycle and Suggestions unit tests cover the shutdown drain, and the off switch's and a foreign server's refusals are checked to classify at info. Integration tests cover the canary post and its audit row, every refusal, the three limits, concurrent submissions and each GitHub failure against PostgreSQL. The command-surface, reply-catalog and Compose tests follow.
- **Docs.** The documentation site (merged from 2.27.0): `/suggest` in the command reference; a members' page, "Suggest a feature" (where and who, what goes public and what never does, the limits, the failures); an officers' page, "Feature suggestions" (moderation, stopping one member, the off switch); the configuration page's "Upstream production only" settings and the `GITHUB_REPORTS_REPO` and `TEST_GUILD_ID` notes; the monitoring page's "Public suggestions" (what goes public with its accepted limits, the private record and finding a submitter, failures, moderation); the replies page's rows and cards; and mentions on the getting-started, progress, access, privacy, overview and index pages. HOSTING.md "Public suggestions (the GitHub App)" holds the production-only parts (the app, key storage, rotation, a probe that creates nothing, the off switch), CI_CD.md the workflow guard, and CONFIGURATION.md, PERSISTENCE.md, REPLIES.md, REQUIREMENTS.md, CLAUDE.md and DEV_GUILD.md's planned rollout the rest.

- **CI.** The advisory Claude review may run 90 minutes instead of 30: a review of a large pull request was cancelled unfinished at the old limit (run 36194928467). The workflow is otherwise unchanged.

## 2.27.0 — Documentation site

Issue #33: a public documentation site, built with [Astro Starlight](https://starlight.astro.build) in `site/` and published to GitHub Pages at <https://deconfined.github.io/tarubot/>. The owner chose GitHub Pages and pnpm for the site ([#33 comment](https://github.com/deconfined/tarubot/issues/33#issuecomment-5836313261), [pnpm](https://github.com/deconfined/tarubot/issues/33#issuecomment-5837160498)) and answered the plan's six questions ([answers](https://github.com/deconfined/tarubot/issues/33#issuecomment-5837662307)): an advisory site build, pnpm for `site/` only, reader docs moved into the site, a hand-written command reference checked by a test, the links validator, and the github.io address. The bot doesn't change: no migration, no command change, and nothing to deploy.

- **The site.** 31 hand-written Markdown pages in six sections: Use TaruBot (members), Run a server (officers and managers), Deploy and operate (self-hosters, with the stock Compose file and its bundled PostgreSQL), Architecture and design, Reference (every command and option, every reply code), and the roadmap. Starlight adds search, dark mode and edit links. Pages use placeholders only and describe the latest release on `main`, with no version numbers.
- **One home per fact.** `docs/SETUP.md`, `docs/OPERATIONS.md` and `docs/ROADMAP.md` moved into the site with `git mv` and were split into pages, and the README's permissions, installation, daily-use and operations sections moved too. Upstream-only details stayed in the records: OPERATIONS.md's DevBot backup notes went to DEV_GUILD.md, its production `retry.js` form to HOSTING.md, and its App Platform export commands to APP_PLATFORM.md. LODESTONE.md's settings table moved to the configuration page. The README now points to the site and keeps the stack, development and license sections. Every reference to the moved files in code comments, tests and docs points at the site.
- **Toolchain.** `site/` is a standalone pnpm package (pnpm 12.6.0 on Node 24.21.0, both pinned in `site/package.json`) with exact `astro` 7.3.5, `@astrojs/starlight` 0.42.4 and `starlight-links-validator` 0.26.0, which fails the build on a broken internal link or anchor. `site/pnpm-workspace.yaml` declines esbuild's install script, whose binary comes from its platform package. The bot, its lockfile, its image and CI stay on Bun; AGENTS.md records the one exception.
- **`pages.yml`.** Pull requests that touch the site get an advisory build, outside `CI result`. `main` builds and deploys through the `github-pages` environment, and a manual dispatch from `main` redeploys. Actions are pinned to full commits.
- **`tests/unit/docs-site.test.ts`,** the required gate for page content. It checks that the command reference has every command path, option and example, the configuration page every `.env.example` setting, the replies page every failure code, and the invite link the code's permission integer. It also checks that GitHub links name existing files, that the site package stays pnpm-only without its own version, and that no page carries a real ID, a private host, a secret shape or a retired component's name. Every run of seven or more digits must be a listed placeholder or constant, and every public-content pattern must still catch its known-bad samples.
- **Review fixes.** The update procedure fetches the new release's `docker-compose.yml` and `.env.example` from the commit its image names (a release can change the settings Compose passes) and starts with `--remove-orphans`; rollback puts back the matching Compose file, and install fetches from the pinned release's commit. The restore rehearsal stops the bot and takes a fresh dump, since `check-restore.js` compares every row, then removes the copied dump and starts the bot again. The officer definition says the Officer role counts only with a rank or `/officer grant` behind it. `pages.yml` keeps build-only runs from other branches out of the deploy group. The host guards end in a `$`-anchored `(?:$|.)`, so CodeQL's missing-anchor query doesn't read them as URL checks and a trailing period no longer slips past.
- **Repository files.** A monthly grouped Dependabot entry for `/site` (and the stale doctl note removed), `.astro/` ignored by Git, Biome and the image build context (with `site/dist`), and `.env.example`'s CA comment without DigitalOcean. CI_CD.md gains a "Documentation site" section.
- **On top of 2.25.0.** The branch merged `main` at 2.25.0 and carries 2.24.3's and 2.25.0's documentation into the site: `/config changelog` in the command reference (its options, examples and who can use it), the setup page's optional changelog step with the onboarding visibility warning, and a new "Officer notices and update posts" admin page (the held, rate-limited Lodestone notice and its recovery line, and update posts: what members see, choosing the channel, the visibility warnings, and a post that doesn't arrive). The monitoring page adds the operators' side of both (job keys, outcomes, the accepted edge cases, the baseline and its SQL), the operations page raises the update-post baseline after a restore, and the replies, health-checks, getting-started, permissions, access, architecture and data pages follow. Requeue wording now names the `/config` saves that release blocked work at once, since `officer_rank`, `role_layout` and `fc unlink` don't, and the scheduler's own retry about every 10 minutes (health checks, monitoring and ledger pages). The update-post "No repeats" rule names its two exceptions, a crash mid-post and a restore of an older backup. Main's edits to the moved guides and the README's usage sections were ported into these pages; the old paths stay deleted. It merges after #36 (2.26.0).

## 2.25.0 — Update posts in a changelog channel

Issue [#30](https://github.com/deconfined/tarubot/issues/30): when the bot starts on a newer version, it posts what's new for members in a channel officers choose. REQUIREMENTS.md "Approved changelog amendments (2026-09-25)" records the owner's four decisions ([issue comment](https://github.com/deconfined/tarubot/issues/30#issuecomment-5835854639)): member notes are a short list in the code, optional per release ("It should be what's meaningful for users, not the technical side. If people want the commit list, /version will lead them there."); an update with nothing for members posts nothing; setting a channel waits for the next update; and in servers where onboarding manages visibility, the bot only warns about a channel members can't read. It adds migration `009_changelog_channel.sql` and one command path, `/config changelog` (20 roots, 45 paths), so commands must be registered after the deploy. Nothing is posted on this deploy.

- **`/config changelog channel:#… | unset_channel:true`** (officers). Posts stay off until a channel is set. It must be a normal text channel that members and guests can read; Announcement channels are refused, like every channel setting.
- **The baseline.** Two new `guilds` columns: `changelog_channel_id` and `changelog_version`, the newest version the server was told about. Setting a channel where none was stores the running version (or keeps a higher stored one) in the same update, so nothing is posted now and releases published while posts were off are never posted later. Moving or unsetting the channel keeps it, and the bot never lowers it. Two CHECKs keep it a `MAJOR.MINOR.PATCH[-pre]` version and require it whenever a channel is set. The audit records the baseline.
- **Startup.** Each present server with a channel and an older baseline gets one `changelog.post` job (`changelog:<guild>`, payload `{}`), whatever the effects switches say. A restart while one is queued, running or blocked merges into it, so a post covers every release since the last. The log line "Queued update posts" carries the count and the version only.
- **The job** reads the release range when it runs:
  - posts turned off (`changelog unconfigured`) or a baseline at or past the running version (`already announced`) skip before the effects gate, as `roles.layout` does, so a paused server never parks a job with nothing to send;
  - a range whose releases have no member notes moves the baseline without posting (`nothing for members`);
  - otherwise one embed: "TaruBot updated to v…" linking CHANGELOG.md, "What's new since v…", one field per release newest first (at most ten; the footer counts the rest), no button and no timestamp. It is sent under the nonce key `changelog:<guild>:<running version>`, then a compare-and-set moves the baseline and audits `changelog.advanced`.
  - Missing permissions block it without moving the baseline; the scheduler retries about every 10 minutes, and a `/config` save, `retry.js`, activation or the next startup releases it at once. With Discord changes paused it parks as `disabled`, and resuming keeps only the newest parked post.
- **Member notes.** `src/domain/release-notes.ts` maps a version to one sentence, and only releases with a note are shown. This release adds its own. CLAUDE.md's "Every change set" step 2 now asks for a note when a release changes something members notice.
- **Visibility.** The receipt says members and guests need to read the channel. Where onboarding manages visibility, the lobby, the officer room or a staff-only channel gives a warning receipt, and a channel onboarding has no record of (one created since the last repair pass, or the Community Updates channel, which it never manages) gets a Visibility field. Choosing the same channel again gives the no-change card, which keeps either warning as a Visibility field. `/config validate` shows either as a `[WARN]` Changelog line; the bot writes no permissions for it. `/config show` has a Changelog field: 13 fields for a configured server, 15 at the widest, which is now exactly the documented cap.
- **Release order** (agreed 2026-09-25): #29 is 2.24.3 (no migration), #30 is 2.25.0 (migration 009), #32 is 2.26.0 and #31 is 2.27.0 (migration 010). The SSH deploy workflow takes the next free minor after #31.
- **Deploy.** The migration procedure: stop, back up, `migrate.js`, `up`, then register (`register.js --global` in production) and read the commands back. Registering after `up` keeps the old release from seeing `/config changelog`. Both columns start NULL, so nothing is posted. Rolling back to 2.24.x isn't possible across the migration (the schema check refuses to start); a fix release or a restore is the way back.
- **Tests:**
  - `tests/unit/changelog.test.ts`: the release range, every job decision, and the notes against the repository (each key a CHANGELOG release that fits the column's CHECK and isn't ahead of `package.json`; each note one line of at most 300 characters with no mention or link, shown whole);
  - `tests/unit/migration-files.test.ts`: migrations numbered 001..N with no gap or repeat, and `SCHEMA_VERSION` the last;
  - the post (including the largest: twelve 300-character notes, ten shown, nothing cut), the receipts, the show field and validate lines, the command path and its input checks, and the job line;
  - on PostgreSQL: migration 009; startup's enqueue, its merge and the collapse of parked posts; and delivery: the baseline rules, the audience lookup (including the Community Updates channel), one post per range, repeats and forged payloads, nothing for members, blocked and released, unset while waiting, paused (only a post with something to say parks), the compare-and-set, and two servers;
  - migration 006's rehearsal inserts its later guild with raw SQL, since today's Drizzle mapping names 009's columns, which a schema-006 table lacks.
- **Docs:** REQUIREMENTS.md (the amendment, the command table and AC-23), OPERATIONS.md, REPLIES.md, SETUP.md, README.md, CONFIGURATION.md, PERSISTENCE.md and CLAUDE.md.

## 2.24.3 — Quieter officer Lodestone notices

Issue #29. Production officers got "FC roster accepted: …" for every roster read, and during an outage the "degraded" line could repeat about once a minute. The owner decided ([first round](https://github.com/deconfined/tarubot/issues/29#issuecomment-5834639862), [second round](https://github.com/deconfined/tarubot/issues/29#issuecomment-5836920321)): the roster line stays on DevBot only, and production gets a held, rate-limited degraded notice and a recovery line (REQUIREMENTS.md "Approved officer-notice amendments"). There is no migration and no command change; a restart deploys it.

- **Roster line.** "FC roster accepted: …" posts only in the test guild (`TEST_GUILD_ID`), unchanged there. Production posts nothing for a routine roster read, so its departures count goes too; issue #31 reports departures.
- **Degraded notice.** The same text, now on its own key per guild and FC (`officer:<guild>:degraded:<fc>`):
  - it is queued on the first non-waiting roster failure since the FC's last accepted roster, and posts only if it is still pending 5 minutes later (it was 60 seconds). A roster accepted in that time closes it unposted, as `{skipped: "recovered before posting"}`;
  - while the FC keeps failing, another is queued at most once every 24 hours, counted from when the last one finished (posted or skipped);
  - a notice still waiting to post (held, paused or blocked) blocks new ones, however old, so repeated failures no longer bump its generation or flip a blocked one back to queued;
  - throttling and the queue's other waits still post nothing.
- **Recovery line.** "Lodestone synchronization recovered: the FC roster was accepted again." posts once, 5 seconds after the accepted roster, on `officer:<guild>:recovered:<fc>`, and only when a degraded notice was actually posted (or was posting) during that outage. Officers who never heard an outage began aren't told it ended. Each outage longer than the hold gets its own pair.
  - The accepted roster also closes waiting degraded notices in guilds linked to the FC that the bot was removed from. The queue never claims an inactive guild's rows, so such a notice would otherwise post about the ended outage once the bot is added back. Those guilds get no recovery line.
  - Accepted edge case: a degraded notice that is being sent when the roster is accepted counts as posted. If that send fails (or its worker dies) and is retried, the degraded line can post after the recovery line, with nothing after it.
- **FC unlink.** `/config fc unlink` closes the guild's waiting degraded notice for the FC it leaves (`{skipped: "FC unlinked"}`). The degraded check share-locks the guild rows, as the roster publication does, so an unlink either waits for it and closes what it queued, or commits first and takes the guild out of it. Accepted edge case: a notice already being sent during the unlink is left to finish, and if that send fails and is retried it can still post about the old FC.
- **Race fixed.** The roster line and the degraded notice shared `officer:<guild>`, and `enqueue` replaces an active row's payload, so a roster accepted before the degraded notice posted could replace it. Every notice now has its own key, in both environments.
- **State.** The job rows are the notice history, read by exact key; nothing is kept in memory, so a restart during an outage resets nothing. The first deploy during an outage can post one more degraded notice, because the new key has no history. Rolling back to 2.24.2 is safe: queued rows keep the `{message}` payload that 2.24.2 posts.
- **Tests.** Five PostgreSQL scenarios: the roster line only under DevBot's configuration, with the departures count; a held notice unchanged by further failures and closed by a success, the post, no repeat within a day, the daily repeat, one recovery line, and a throttle-only outage that posts nothing, with one outage measured against the roster's own `observedAt` rather than a boundary pinned to database time; no channel, paused effects and a notice released after more than a day parked (the day counts from its post); a blocked notice left alone by further failures and closed at recovery, then a notice running at recovery that waits to retry, closed by an FC unlink; and a waiting notice in a guild the bot was removed from, closed at recovery. The throttled-roster test follows the new key.

## 2.24.2 — Code-scanning fixes in the Lodestone parser

The owner asked to address the two open CodeQL alerts, both in code from the parser's move into the bot (2.20.0 and 2.21.0). Neither was exploitable in production, but both now read correctly. There is no migration and no command change.

- **#7, `js/missing-origin-check` (medium), `worker.ts`.** The parser worker's message handler didn't check where a message came from. Only the thread that created a dedicated worker can message it, and Bun gives those messages an empty origin (checked: origin `""`, source `null`). The handler now ignores any message that carries an origin, before parsing anything, and the runner's deadline ends such a request.
- **#8, `js/comparison-between-incompatible-types` (warning), `parser.ts`.** `isDefinition` checked `value !== null` after `typeof value === "object"`, which CodeQL read as comparing incompatible types. The null check now comes first. The behaviour is the same, since `typeof null` is `"object"` and the check is needed.
- **Records.** The 2.24.1 rollout to DevBot and production, with 2.24.0's host step: the pull, the backup crontab line (04:30 UTC) and a first run from `~/tarubot/ops/backup.sh`.

## 2.24.1 — `/sync status` shows only unresolved failures

The owner saw "a ton of errors" in `/sync status` and asked whether they were stuck. None was. All 167 were profile refreshes from the first night:
- 149 Lodestone refusals while production was on App Platform;
- 13 rate limits after the move;
- 5 for a deleted character.

Every one of the 79 characters had a later refresh succeed, and no job had failed since 2.17.0. They stayed listed because the work list showed the newest non-succeeded jobs with no age limit, and nothing newer had failed. There is no migration and no command change.

- **Change.** `Service.syncStatus` leaves a failed job out of the work list once the same work (its dedupe key) has succeeded after the failure. A failure after an earlier success, or one with no success since, is still listed. Job rows stay as history, and run totals are unchanged.
- **Failure time (review fix).** "After the failure" needs to know when a job failed, and `retry.js` re-runs a row in place, keeping its creation time.
  - The queue now stamps `completed_at` when a job ends failed, as it does on success. An error that ends a job as succeeded (`gone`) is stamped too.
  - `retry.js` clears the stamp when it requeues a row.
  - A row retried after a success that fails again therefore stays listed.
  - Rows that failed before 2.24.1 have no failure time and fall back to their creation time.
- **Effect in production.** A read-only query applying the same rule lists 0 of the 167 failed jobs.
- **Tests.** An integration test covers a resolved failure (left out), a lone failure, a failure after a success, a row retried in place that failed after a newer success (all three listed), and a failure from before 2.24.1 that later succeeded (left out). A second test has the queue fail a job, finding its `completed_at` stamped, and `retry.js` clear it. Both fail against the first version of this change.

## 2.24.0 — Daily encrypted off-site database backups

The robust, disposable host's backup layer. Linode's point-in-time recovery reaches back to the cluster's creation, and now a daily dump lives outside the cluster too. The owner chose Linode Object Storage over Backblaze B2 ("not really worried about Akamai going down") and set up the bucket, a key limited to it, and a second healthchecks.io check. The bot itself doesn't change: there is no migration, no command change and no restart.

- **`ops/backup.sh`**, daily at 04:30 UTC from the `tarubot` user's crontab on the host.
  - `pg_dump` (custom format) runs in the pinned PostgreSQL 18 image through a new profile-only `backup` service in the production Compose file, which `up` never starts, with the bot's database URL and verified TLS.
  - The dump streams straight into `age` for `ops/age-recipients.txt`, so no plaintext touches the disk and the host can't decrypt what it wrote.
  - `curl` signs the uploads itself (SigV4): `daily/` every day and `monthly/` on the 1st. An encrypted copy of the host's `.env` goes to `env/`, keeping the settings copy current without the operator machine.
  - healthchecks.io's "TaruBot backups" check hears the start, then success with the sizes, or a failure naming the step.
  - Strict bash (`set -Eeuo pipefail`, `umask 077`). Credentials and ping URLs reach curl on stdin, never in its arguments.
  - **Review fix.** The `backup` service's logging is off (`driver: none`). Its stdout is the unencrypted dump, and Docker's logging driver copies a container's stdout to disk even while `docker compose run` pipes it. The first test run's plaintext stayed in that container's log file until `--rm` removed it.
- **Retention.** `ops/bucket-lifecycle.xml` keeps `daily/` and `env/` for 30 days and `monthly/` for a year. It is applied to the bucket and was read back.
- **Settings.** The host's `.env` holds `BACKUP_STORAGE_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`, `_REGION` and `HEALTHCHECKS_BACKUP_URL`. The bot never sees them, because Compose passes it only its own settings. `host-env-backup` now expects all five.
- **Docs.** HOSTING.md's "Backups and recovery" covers the three layers, the weekly maintenance window, the bucket and its limits (Linode has no write-only keys), setup, retention and restore. Rebuild step 10 points to it.
- **Tests.** `tests/unit/backup-job.test.ts`:
  - the script's syntax and strict mode;
  - the dump encrypted as it streams;
  - no secrets in curl's arguments;
  - https only;
  - the Compose service behind its profile, with the registry deployment's PostgreSQL image and verified TLS;
  - the retention rules.

  The Compose test now allows the profile-only service.

## 2.23.0 — A rebuild runbook and an off-host settings copy

The robust, disposable host (owner decision, 2026-09-25) needs a way back when the host is gone. The owner declined Terraform for now ("too much trouble at least at this stage"), so this is a runbook and a small operator script. No running code changes: there is nothing to deploy, no migration and no command change.

- **Settings copy (`scripts/host-env-backup.ts`, `bun run host:env-backup`).** It runs on the operator machine and reads the host's `.env` over SSH.
  - It checks that the settings production needs are present, naming only what's missing, and encrypts with `age` for the public keys in `ops/age-recipients.txt`.
  - It writes only the encrypted copy (`~/tarubot-cutover/env-backups/tarubot-env-<UTC time>.age`, mode 600), so the settings never touch the operator machine's disk or the terminal.
  - `--identity` decrypts the new copy in memory and confirms it matches. The copy is written under a hidden temporary name and renamed into place only after that check, so a failed run leaves nothing a restore could pick up.
  - The setting-name scan tracks quotes, so no line of a multi-line value, such as the CA, is ever printed.
  - Its output names the settings present, never their values.
- **Rebuild runbook (HOSTING.md "Rebuilding the host").** Eleven steps from a lost host to a running bot:
  - stop the old writer;
  - create the Linode;
  - the base system as root (Docker CE from Docker's repository, `age`, the `tarubot` user in the docker group, key-only SSH);
  - DNS with new SSHFP records;
  - the database allow list;
  - clone;
  - restore and pin the settings;
  - start and check;
  - the backup schedule;
  - retire the old host.
- **Key.** The `age` private key lives on the operator machine, with an offline copy kept by the owner. The daily database dumps (2.24.0) will use the same key.
- **Found and fixed.** `sshd` offered password login on the host (although `tarubot` had no password). The owner made it key-only the same day, and a probe from outside now sees `publickey` alone. No Linode Cloud Firewall is attached; that is an owner item.
- **Records.** The 2.22.0 rollouts: DevBot with the heartbeat off, and production with the ping URL set over SSH stdin and good pings confirmed. The Terraform decision is in REQUIREMENTS.md and OPEN_ITEMS.md.
- **Tests.** `tests/unit/host-env-backup.test.ts`:
  - argument parsing;
  - setting names read without values, including a multi-line CA;
  - the required settings refused by name;
  - UTC file names;
  - the recipients file's format;
  - from the review: the quote-aware name scan, and the verify-then-rename write path.

## 2.22.0 — A healthchecks.io heartbeat

The robust, disposable host (owner decision, 2026-09-25) needs alerting that works when the bot or host can't report on itself. The owner signed up for healthchecks.io. There is no migration and no command change.

- **Heartbeat (`src/application/heartbeat.ts`).** While readiness is fully green (database, writer lease, Discord), the bot pings `HEALTHCHECKS_PING_URL` every five minutes, from the scheduler pass that already runs every 30 seconds.
  - Each ping is a POST carrying one status line for the check's event log: version, pending and blocked work, degraded FCs, the Lodestone cooldown and the live selectors. It never carries secrets.
  - It sends no failure pings. An unready bot stays silent and the check's grace period decides when to alert, so a Discord reconnect doesn't page anyone.
  - A failed ping is retried after a minute, and a failure streak logs one warning plus one line when pings recover. A ping never takes more than 5 seconds and never affects readiness.
  - Empty turns it off, which is what DevBot and CI use.
- **The owner's check.** "TaruBot production": period 5 minutes, grace 10 minutes, Pushover for down. The URL is kept on the operator machine and copied into the host's `.env` over SSH stdin, never through chat ([HOSTING.md](docs/HOSTING.md#heartbeat)).
- **Privacy.** Issue reports treat the ping URL as one of the deployment's secrets and redact any `hc-ping.com` URL, since anyone holding it can ping the check and hide an outage.
- **Settings.** `HEALTHCHECKS_PING_URL` is in both Compose files and both env templates. The production template leaves it empty: tools don't ping.
- **Records.** The 2.21.0 rollouts to DevBot and production, including the in-container live parse on production, the operator clone's move to 2.21.0 and the stopped cutover sidecar.
- **Tests.** `tests/unit/heartbeat.test.ts`:
  - an immediate first ping, then one every five minutes;
  - silence while unready;
  - retry after a minute, and one warning per failure streak;
  - off without a URL;
  - the summary format;
  - `hc-ping.com` redaction.

## 2.21.0 — The Lodestone parser inside the bot, without the sidecar

With the parser TaruBot's own, the owner asked what the sidecar still bought, then decided: "Remove the sidecar. I would rather reduce complexity and places where things can break." There is no migration and no command change. Deploying 2.21.0 also brings 2.19.0 and 2.20.0.

- **In process (`src/infrastructure/lodestone/`).** The `Lodestone` adapter takes a parse slot, and `runner.ts` fetches the page under the same network policy as the sidecar:
  - only the configured region's Lodestone;
  - the gate's start spacing and 429 cooldown;
  - a fetch deadline and no redirects;
  - a body bound;
  - private-profile detection.

  It then hands a fresh worker the page and the operation's selector files. The worker only parses, and is terminated when the request's deadline or shutdown aborts it. The adapter's validation, retries and reachability are unchanged.
- **Simpler.**
  - No HTTP API or wire envelope, and no fetch bridge between worker and server.
  - Parse slots wait for capacity within the deadline instead of refusing as `busy`.
  - The live selector set is held in memory, so the pointer file, restore and cleanup are gone. After a restart the bundled set runs until the first check, moments later.
  - `linkedom` and `lodestone-css-selectors` are runtime dependencies. `bundled.ts` imports the selector files directly, so the worker build step and the generated fallback file are gone. A unit test checks the recorded commit against `bun.lock`, formerly a build check.
- **Settings.** The sidecar's settings joined the bot's, under `LODESTONE_*`:
  - `LODESTONE_REGION` replaces `PAGE_REGION`;
  - `LODESTONE_SELECTOR_CHECK_SECONDS` replaces `NODESTONE_UPSTREAM_CHECK_SECONDS`;
  - `LODESTONE_CONCURRENCY`, `_START_MS`, `_TIMEOUT_MS` and `_BODY_BYTES` move to the bot;
  - `NODESTONE_URL`, `NODESTONE_RESPONSE_BYTES` and `NODESTONE_SELECTORS_DIR` are removed. Leftover values are ignored.
- **Status.** `/health/ready` carries an informational `lodestone` object (gate, parse slots, selectors, upstream), replacing the sidecar's `/health`. Issue reports read it directly. The adapter's events are bot log lines: the gate closing, selector updates and rejections, and upstream status.
- **Deployment.**
  - The `nodestone` Compose service and image target are gone from every Compose file and the Dockerfile. CI builds and publishes only `ghcr.io/deconfined/tarubot`.
  - Deploy with `up -d --wait --remove-orphans`, which removes the old sidecar container.
  - Rolling back past 2.21.0 needs the older Compose file.
- **App Platform retired (owner decision).** It could no longer serve as a fallback. `.do/app.yaml`, `scripts/app-spec.ts`, their tests, CI's doctl validation and the `app:spec` script were removed. The Compose image-path check moved to the Compose tests. docs/APP_PLATFORM.md stays as the record.
- **Tests.**
  - The contract suites now drive the in-process runner:
    - spacing, and slots that wait;
    - a request abandoned at its deadline while waiting;
    - transport cancellation, and a spinning worker terminated at its deadline;
    - private profiles and the 429 gate;
    - a newly activated selector set reaching the parser.
  - The adapter tests use scripted parse results instead of fake HTTP servers.
  - A new check keeps sidecar settings out of every deployment file.
- **Docs.**
  - NODESTONE.md became LODESTONE.md ("Lodestone adapter").
  - REQUIREMENTS.md records both decisions.
  - HOSTING, OPERATIONS, CONFIGURATION, CI_CD, README, AGENTS, CLAUDE and the handoff follow.

## 2.20.0 — TaruBot's own Lodestone parser, without Nodestone

The owner: "get rid of Nodestone entirely, pull xivapi/lodestone-css-selectors for ourselves, and do the parsing internally." The sidecar had wrapped the `xivapi/nodestone` library through:
- a Git submodule;
- seven source patches;
- an Axios adapter that bridged its fetches into our bounded transport;
- a stubbed logger;
- and, since 2.19.0, an import rewrite to make selectors live.

We used four of its operations. 2.20.0 replaces it with a first-party parser, keeping the sidecar's HTTP contract, so the bot doesn't change. There is no migration and no command change. The Compose service `nodestone`, the image `tarubot-nodestone` and `NODESTONE_URL` keep their names.

- **Parser (`sidecar/lodestone.ts`).** A pure, selector-driven parser on linkedom. It builds each operation's URL and applies the `lodestone-css-selectors` definitions with the semantics TaruBot relied on:
  - raw `innerHTML` or attributes;
  - named regex groups spread into the record, with our own `(?P<` translation;
  - groups and `ROOT` lists with malformed rows kept;
  - the page root required;
  - the same `Pagination` fields;
  - query values encoded once.
- **Worker.** `sidecar/worker.ts` fetches through the server's gate and parses with the live selector set.
- **Removed:**
  - the `vendor/nodestone` submodule and `.gitmodules`;
  - `sidecar/transforms.ts` and the import rewrite;
  - `scripts/nodestone-source.ts` and `nodestone-update.ts`;
  - the `nodestone-upstream` and `axios` dependencies, and with them `regex-translator`, `express` and `lodash`;
  - the submodule steps in the Dockerfile, CI and publish checkouts, Dependabot and Biome.
- **Added:** `linkedom` 0.16.11, pinned as a build dependency bundled into the worker.
- **Selector checks follow the parser.** A new selector set only has to keep the columns the parser reads (`PARSED_KEYS`, every key of `pagePlan`), each with everything inside it at any depth, as 2.19.0's review fix requires. Other columns may change or go, so a column TaruBot never reads can't hold back the latest selectors. `sidecar/pages.ts` holds each operation's URL, files and keys apart from the parser, so the sidecar server checks sets without loading linkedom.
- **Selectors only.** The upstream monitor follows only `xivapi/lodestone-css-selectors`. `bun run selectors:check` and `selectors:update` replace the `nodestone:*` scripts and refresh just the bundled fallback, now the 6 files the parser reads.
- **Parity.**
  - Before removing Nodestone, the 2.19.0 build and this build parsed 6 live Lodestone pages in 7 cases through their workers (`execute()`). The cases were a profile with and without the biography, the FC page, member pages 1 and 3 (50 and 5 entries), a search hit and an empty search. Output and requested URLs were identical.
  - The first-party worker took 53–85 ms per operation against Nodestone's 105–180 ms.
  - The image built with its tests inside and parsed three live pages through `/v1/parse`.
  - After rebasing onto 2.19.0's review fixes, the comparison was repeated with identical results (first-party 40–71 ms, Nodestone 105–176 ms).
- **Tests.** `tests/unit/lodestone-parser.test.ts` pins every parsing rule, the URLs, the regex translation and the column names. The worker contract suite, including the older Nodestone parity cases, private profiles, the gate and live selectors, passes unchanged. The upstream tests follow the selector-only monitor.
- **Docs:**
  - NODESTONE.md, retitled "Lodestone sidecar";
  - the owner's decision in REQUIREMENTS.md (SCOPE-03 and the 2026-09-22 tracking decision superseded);
  - AGENTS.md, CLAUDE.md, README.md, CI_CD.md, CONFIGURATION.md, MIGRATION.md and the backlog.

## 2.19.0 — Live Lodestone selectors

The second test report showed the sidecar parsing with selectors `1e9dd65`, while `xivapi/lodestone-css-selectors` was at `a96d68b`. The owner: "xivapi/lodestone-css-selectors should ALWAYS be the latest version available." The selectors were a `#HEAD` Git dependency, but `bun.lock` pinned what it last resolved and the build bundled that into the worker, so only a manual `nodestone:update` release ever advanced them. 2.19.0 makes them follow upstream at runtime. The missing three commits only added Beastmaster selectors to `profile/classjob.json`, which TaruBot doesn't read. There is no migration and no command change.

- **Runtime loading.**
  - The build rewrites Nodestone's static selector imports into loads through `sidecar/selector-runtime.ts`. Each parser worker, which is fresh per request, reads the active set from `NODESTONE_SELECTORS_DIR`, or the bundled `dist/sidecar/selectors-baseline.json`.
  - The build checks that all 9 referenced selector files load this way.
- **Following HEAD.** The upstream monitor now activates a new selector HEAD instead of only reporting it. `SelectorStore` (`sidecar/selectors.ts`):
  - downloads the 9 files from `raw.githubusercontent.com` at that commit, each read at most 512 KiB into memory;
  - validates them structurally: a non-empty `selector` string, typed options, and no lost or reshaped definition or group at any depth;
  - writes the set, then switches `active.json` atomically, keeping the replaced set until the next activation for workers that just read the old pointer.
  - A failure keeps the active set and logs `selectors_rejected` once per revision; a switch logs `selectors_updated`.
  - A restarted container adopts its active set only if the set is still there and valid; otherwise it removes the pointer so workers use the bundled set too, logs `selectors_not_restored`, and fetches HEAD again.
  - The reported revision follows the pointer as soon as it moves; a failed removal of old sets can't make a live switch look rejected.
- **Faster checks.** The monitor checks every 15 minutes (`NODESTONE_UPSTREAM_CHECK_SECONDS` default 900, was 3600) in both Compose files and both env templates.
- **Visibility.** `/health` reports `selectors {revision, source, activatedAt, bundled}`, the upstream component shows the live revision, and issue reports show the live selectors.
- **Worker environment.** Parser workers now receive the process environment explicitly. A Bun worker sees only the environment from process start, which would have missed the selector directory; `PAGE_REGION` worked only because Compose sets it.
- **The bundled copy** moved to `a96d68b` through `bun run nodestone:update`. The parser, `5b7eec6`, was already current.
- **Found while testing against real upstream.** Validation first compiled regexes, and that rejected the real selector set: upstream's `profile/achievements.json` `ENTRY.NAME` regex already fails Nodestone's own translation, affecting only that unused column. Regexes are no longer compiled during validation.
- **Tests:**
  - validation, activation, restore and failure handling of the store against a fake GitHub;
  - from the code review (each fails without its fix): nested key loss, restoring a missing or damaged set and removing its pointer, keeping the replaced set, a failed cleanup after a live switch, and the size limit applied while reading;
  - the monitor's live path;
  - a contract test in which a real parser worker parses an FC page with an activated set whose name selector points at the tag;
  - a one-off activation against the real upstream (9 files at `a96d68b`, 710 ms).
- **Next.** The owner asked to drop Nodestone and parse with the selectors directly: planned for 2.20.0, reusing this selector store. The records also add the 2.18.1 rollouts and the reports-token rotation.

## 2.18.1 — Readable issue reports

The owner's first `/issue` (issue #1) worked, but read poorly on GitHub. A code fence that started mid-line (`Sidecar health: ```json`) made GitHub render the rest of the report as code. Readiness and sidecar health were raw JSON (the sidecar's on one long line), times were raw ISO strings with milliseconds, booleans read `true`/`false`, and the log records were raw pino JSON, mostly `Capability status` repeating every 30 seconds. A member's report also ended with an occurrence count. There is no migration and no command change.

- **Layout:**
  - single records are two-column tables (`fields()`): the summary, readiness, the Lodestone client, the sidecar, the server, the roster and the member;
  - lists stay tables: links (active first, with names), work, audit ("this member" or "TaruBot" as the actor), failures, and the sidecar's upstream components (short SHAs, and whether each is current);
  - times read `2026-09-25 03:07:37 UTC` (`when()`), durations read `3.7 h`, and booleans read yes/no;
  - the member's main character is shown by name.
- **Logs.** `logLines()` turns pino records into `03:07:37 INFO Modules loaded · commands=20 …`, and drops `pid`, `hostname` and the routine `Capability status` records.
- **Footer.** Only automatic reports end with their occurrence count and fingerprint.
- **Review round (PR #20).** An unknown roster age (`null`: no roster accepted yet) no longer reads as "0 s", because `duration()` shows a dash for anything that isn't a finite number. The recent-log buffer now skips routine records as they are written. Before, the filter ran after the newest 30 were taken, so an idle bot's log section could come out empty while useful records sat earlier in the buffer.
- **Tests.** Unit tests cover the new helpers. The `/issue` delivery test now requires every code fence to start its line, no raw ISO times, and no occurrence footer on a member's report. A sample was verified through GitHub's Markdown renderer.
- **Records.** The 2.18.0 rollouts are recorded in DEV_GUILD.md and VERIFICATION.md.

## 2.18.0 — Issue reports and /issue

The owner asked for an "unexpected behavior handler" that opens GitHub issues with as much context as possible, and for `/issue`, so members can report problems with the same state collection. REQUIREMENTS.md "Approved issue-reporting amendments" records their answers. Reports go to the private repository `deconfined/tarubot-reports`. It adds migration `008_issue_reports.sql` and one command, `/issue` (20 roots, 44 paths), so commands must be registered after the deploy. It also records the owner's hosting follow-up: stay on Linode, and make the host robust and disposable.

- **`/issue description:…`** for every member: one per member per 10 minutes and twenty per server per day, refused with a new `wait.issue` card that says when to try again. The reply is "Report received", or "Report saved" when reporting isn't connected, and lists what the report carries.
- **Automatic reports:**
  - every error-level report, from interactions, events, the lifecycle or the queue worker;
  - every job that ends failed at error level;
  - repeated trouble, checked every five minutes on the lifecycle's new `tick` hook: a linked FC's roster not accepted for 12 hours, and no Lodestone answer for an hour. The Nodestone client now tracks `reachability()`.
- **Grouping and caps.** A fingerprint of what failed and where groups repeats into one issue. Repeats are counted, and a comment posts the count and the newest context at most hourly. A repeat after a close opens a new issue that names the old one. Context is re-collected at most once a minute per fingerprint, so an error flood costs a counter update. Each day allows at most 10 new automatic issues and 50 comments. The reporter never reports its own delivery failures.
- **Context.** Each report includes:
  - the deployment, version and uptime;
  - `/health/ready` (the lifecycle's new `status()`);
  - Lodestone reachability and the sidecar's health;
  - active and recently failed jobs;
  - the server's settings and FC roster state;
  - for member reports, the member's links, main, nickname state, guest and officer standing, recent work and audit;
  - the newest 30 log records, from an in-memory buffer fed by a second pino destination at info and above.

  `redact()` removes Discord and GitHub tokens, Authorization values, URL passwords, PEM blocks and the deployment's own secret values. Member text goes in a fenced block, so it can't @mention anyone on GitHub.
- **Durability.** `issue_reports` saves every report before delivery, and `issue.report` jobs deliver it through the new `GitHubIssues` client. GitHub's rate limits wait, outages retry, and a refused token fails as `configuration`. Without `GITHUB_REPORTS_TOKEN`, reports are saved and sent once a token is set.
- **Configuration.** `GITHUB_REPORTS_TOKEN` and `GITHUB_REPORTS_REPO` (default `deconfined/tarubot-reports`) are passed through both Compose files and listed in both env templates.
- **Review round (PR #19).** The Claude review found three behavior bugs, all fixed with regression tests:
  - A repeat of a closed issue opens a new issue, but was checked against the comment allowance. Delivery now reads the issue's state first, so a reopen spends the new-issue allowance.
  - An FC with no accepted roster yet (freshly linked) was reported as "not accepted for 12+ hours" within minutes. It is now reported only after the check has seen it without a roster for 12 hours.
  - One failed Lodestone request followed by an hour of quiet looked like an hour-long outage. The client now records its last attempt, and an outage is reported only while attempts keep failing (the last within 30 minutes).
  - A CONFIGURATION.md sentence was corrected.
  - The re-review found that a job deadline expiring during the client's retry backoff escaped as a raw `AbortError`. That counted as a Lodestone answer, which reset the outage clock, and read as an unexpected error. It now ends as `unavailable`, like a deadline caught before the backoff, and anything other than a page that says something about the request counts as unanswered.
  - The third pass found two more issues:
    - `/issue` took only a per-server lock, so one member in two servers at once could pass the per-member limit twice. It now takes the member's lock first, then the server's.
    - A GitHub secondary rate limit can be a bare 403 without rate-limit headers, and was reported as a token problem. A 403 whose message mentions a rate limit is now `rate_limited` with GitHub's minimum one-minute wait. Other 403s stay `configuration`, so a truly refused token still fails instead of waiting forever.
- **Tests:**
  - redaction of every secret shape, fingerprints, stack frames, bounds and Markdown, and the log buffer;
  - the GitHub client's requests and failure mapping against a local fake;
  - `/issue`'s command path and replies, and the new `wait.issue` card;
  - on PostgreSQL: `/issue`'s limits, context and delivery; the saved-only mode; grouping, the hourly comment window, the sweep, reopening after a close, redaction of the deployment's token and the daily cap; the stale-roster and Lodestone checks; migration 008.
- **Docs:**
  - REQUIREMENTS.md: the issue-reporting amendments, the hosting follow-up, and AC-23 at 20 roots and 44 paths;
  - OPERATIONS.md: a new Issue reports section;
  - CONFIGURATION.md, HOSTING.md, PERSISTENCE.md, SETUP.md, REPLIES.md, README.md and CLAUDE.md;
  - the 2.17.0 rollout records in DEV_GUILD.md and VERIFICATION.md.

## 2.17.0 — Lodestone hardening: paced refreshes, private profiles, and the two-404 unlink

After the move to Linode, `/sync status` filled with failed profile refreshes, several for the same character. In production, three characters produced 125 failed profile jobs in a few hours:
- one deleted character, which answers 404;
- two private profiles, which answer 403 "Access Restricted".

Every job for them failed, and the scheduler kept making more. 2.17.0 fixes the causes and adds the owner's decisions of 2026-09-24 (REQUIREMENTS.md "Approved Lodestone amendments"). It adds migration `007_profile_checks.sql`, so it needs the stopped-writer migration procedure. There are no command changes.

- **The retry storm.** The 30-second scheduler re-queued every stale profile with `enqueue`. On conflict, that pulled a job that was backing off forward to now, so eight attempts took about 2.5 minutes, and a new job followed each failure.
  - The scheduler now uses the new `scheduleJob`, which leaves an active job alone.
  - It stamps `characters.profile_retry_at` an hour ahead for each character it queues, so a character is refreshed at most once an hour, however the job ends.
  - A startup catch-up is spread over a minute. Rosters are scheduled the same way.
- **Deleted characters: the two-404 rule.** A profile 404 now completes the job instead of failing it.
  - The first 404 is recorded in `characters.profile_missing_at`.
  - A 404 at least an hour later ends every active link to the character, in every guild, through the same `endLink` path as `/unclaim`. It clears a main character for a nickname restore, records member loss, and reconciles the owner.
  - Each unlink is audited as `character.unlink` with a null actor and `automatic: "lodestone_not_found"`. Officers get an `officer.notify` naming the character and mentioning the owner, without a ping.
  - Any sighting in between clears the mark: a profile read, a private profile, or a roster listing.
- **Private profiles.** The sidecar recognizes the Lodestone's own "Access Restricted" page on a character page by its `ldst__error` markup, and reports it as `private`, which the bot reports as `private_profile`. Any other 403, such as DigitalOcean's edge block, stays `unavailable`.
  - A private profile completes the refresh job and waits for the profile interval.
  - Commands show a new reply, "Lodestone profile is private", which asks for the profile to be made public. `/verify` adds that the token is still valid.
- **Throttling.**
  - The sidecar's new `LodestoneGate` (`sidecar/gate.ts`) keeps the start spacing and adds a shared cooldown after a Lodestone 429. New starts are refused locally for 15 s, doubling on consecutive 429s up to 5 min, or for a longer Retry-After of up to 15 min. Any other answer resets the escalation.
  - `/health` reports `lodestone: {cooldownSeconds, strikes}`, and each 429 logs one `lodestone_throttled` line.
  - The client no longer retries `rate_limited`.
  - `rate_limited` is now a waiting code: a throttled job waits out the cooldown without spending attempts, and shows as `↻ WAITING`.
  - A full sidecar now answers `busy`, which the client retries, instead of pretending to be Lodestone throttling. A stopping sidecar answers 503.
  - A throttled roster crawl still records `last_error` for `/sync status`, but no longer queues a "Lodestone synchronization is degraded" officer notice. A throttled crawl now retries until the cooldown lifts, so it would otherwise send one each time.
- **Tests:**
  - unit tests of the gate's spacing, cooldown, escalation, Retry-After bound and aborts;
  - sidecar contract tests: private versus edge-block 403s, the gate refusing starts after a 429, and `busy` capacity;
  - client contract tests: `busy` is retried; `rate_limited` and `private` are not;
  - the waiting-code catalog and the job-line markers;
  - the new reply in every audience;
  - PostgreSQL tests: a throttled roster crawl records `last_error` without re-queuing the officer notice; `scheduleJob` never moves an active job; the scheduler's hourly pacing; the private outcome; the full two-404 sequence (first, repeat within the hour, a sighting that clears, confirmation, then the link, audit, main, reconciliation and notice); migration 007 over 006.
- **Docs:**
  - REQUIREMENTS.md: the Lodestone amendments;
  - NODESTONE.md: the codes, gate and client retries;
  - OPERATIONS.md: a new section on refreshes, private profiles and deleted characters, with a query;
  - REPLIES.md: the new reply;
  - HOSTING.md: the sidecar health check;
  - PERSISTENCE.md, CONFIGURATION.md and SETUP.md: migration 007;
  - CLAUDE.md;
  - the 2.16.1 rollout records in DEV_GUILD.md and VERIFICATION.md.

## 2.16.1 — Production on a Linode Docker host

The production cutover ran on 2026-09-24 with 2.16.0 and went live on App Platform. Every profile refresh then failed: the Lodestone answers DigitalOcean's addresses with HTTP 403. That evening the owner moved production to a Linode Docker host with Linode managed PostgreSQL; the move took about 90 seconds of downtime. 2.16.1 brings the repository in line with that. It has no migration (the schema stays `006_guest_application_switch.sql`), no command change and no bot behavior change.

- **Tool guard.** The production and rehearsal profiles accept the Linode cluster's direct port 27520. They refuse its 27521 connection pool, like DigitalOcean's 25061, because a pool can't hold the writer lease. They also refuse the `akmadmin` administrator login, like `doadmin`. The DigitalOcean rules stay until that cluster is deleted, so it remains usable as a fallback and a restore source. Until now, production tools refused the Linode database, which blocked the post-cutover `retry.js` and `preview.js --late-joiners` runs.
- **`docker-compose.production.yml`.** The production host's self-contained Compose file:
  - only `nodestone` and `tarubot`, with no bundled PostgreSQL;
  - the release pinned by a required `TARUBOT_IMAGE_TAG`, never `latest`;
  - required `DATABASE_URL`, `DATABASE_CA_CERT` and `DISCORD_TOKEN`;
  - production scoping fixed in the file: the production application, `TARUBOT_ENVIRONMENT=production`, effects on, and no test guild;
  - `restart: unless-stopped`, a readiness health check, and json-file logs capped at 5 × 10 MB per container.

  A unit test checks those rules and that every setting the registry `docker-compose.yml` passes also reaches production. CI validates the file with placeholder values.
- **`production.env.example`** points at the Linode cluster's direct port.
- **Docs:**
  - HOSTING.md (new): the production host's layout, everyday checks, updates with and without a migration, rollback, backups, and the DigitalOcean leftovers;
  - MIGRATION.md: a record of the cutover and the move;
  - APP_PLATFORM.md is marked superseded, with its trusted-source step corrected: App Platform did not add the app's `app:` rule by itself, and the first pre-deploy migration timed out until it was added;
  - REQUIREMENTS.md: the owner's "Approved hosting amendment";
  - CLAUDE.md, README.md and OPERATIONS.md now point at the host;
  - SESSION_HANDOFF.md, OPEN_ITEMS.md and DEV_GUILD.md record the 2.16.0 rollout, the cutover and the post-cutover backlog. That backlog includes the Lodestone retry storm found after the move, which 2.17.0 is to fix. The owner approved the order, 2.17.0 hardening before the 2.18.0 issue reporter, and a two-404 rule before a deleted character is unlinked.

## 2.16.0 — Deployment safeguards for the cutover

The owner approved the App Platform deploy-workflow proposal (`docs/proposals/app-platform-deploy-workflow.md`) on 2026-09-24 and wants v2 live that day. 2.16.0 is the proposal's Release A: safeguards that production starts with, so that migrations, restarts and command registration can later be automated safely. No migration (the schema stays `006_guest_application_switch.sql`) and no command change, so nothing needs re-registering. OPS-10/OPS-11 (telemetry and officer alerts) move to 2.17.0, after launch, and the cutover floor stays 2.16.0 (owner decision).

- **Migration guard.** `Database.migrate` verifies every applied file first, then applies all pending files in one transaction, as before.
  - When anything is pending, it also takes the database writer lease (`714882494`) for that transaction with `pg_try_advisory_xact_lock`. That lock conflicts with a bot's session lock on the same key and ends at COMMIT or ROLLBACK.
  - It waits up to `MIGRATE_WRITER_WAIT_SECONDS` (default 90, at most 600) for a stopping bot, then refuses with `busy`, naming the holder's database process, and changes nothing.
  - With nothing pending it never touches the lease, so a deployment's pre-deploy job succeeds while the previous bot still runs.
  - `migrate.js` prints `Migration writer lease acquired at <time>; applied <files>; committing at <time>.` from the database clock. The first time is the migration's restore point.
- **Schema check after the lease.** `ApplicationLifecycle.prepare` checks the schema again once it holds the writer lease, before logging in. A bot that waited, for example an old release restarting during a migration, would otherwise take the lease after the commit and write with old code. On a mismatch it releases the lease and exits with status 1.
- **Undeclared command shapes.** Discord can deliver another release's commands, for example after a registration or a rollback. The router now compares each invocation with the command's declared options (`src/bot/shape.ts`). An undeclared subcommand group, subcommand or option, a different option type, or a missing required subcommand gets the stale card ("This command is from a different version of TaruBot") instead of running the handler. Autocomplete for such a shape suggests nothing. The pre-2.16 `/officer` handler, for example, treated any subcommand other than `grant` and `reset` as a revoke.
- **Deferred to the deploy workflow.** `commands.js declared` and `check` and the `app-spec.ts` digest rules move to that release (Release B), because only the workflow uses them.
- **Tests:**
  - every discovered command path (43) fits its own shape, and shapes another release could send are refused;
  - the router never runs a handler for an undeclared shape;
  - a bot that passes its first schema check and then finds a migrated database refuses and unlocks;
  - on PostgreSQL, the guard refuses pending migrations under a held lease (with the holder named and nothing changed), ignores the lease when nothing is pending, waits for a bot that stops within the bound, and releases the lease at COMMIT.
- **Docs:**
  - OPERATIONS.md: the guard and the second schema check;
  - README.md: stop `tarubot` before migrating;
  - CONFIGURATION.md: `MIGRATE_WRITER_WAIT_SECONDS`;
  - the release plan in REQUIREMENTS.md, MIGRATION.md, REPLIES.md, CLAUDE.md, SESSION_HANDOFF.md and OPEN_ITEMS.md;
  - the approved proposal is committed under `docs/proposals/`.

## 2.15.1 — Follow the GitHub account rename

A maintenance patch: no migration (the schema stays `006_guest_application_switch.sql`) and no command changes, so nothing needs re-registering. The only runtime change is the repository `/version` names and links. DevBot runs 2.15.0 and need not redeploy; the first Compose `up` from this checkout recreates its containers from the same digests, so do it with the next DevBot update.

- The owner renamed the GitHub account `connstructor` to `deconfined` on 2026-09-24, so the repository is now `deconfined/tarubot`. Git, web and API URLs under the old name keep redirecting unless a new holder of the name creates a repository called `tarubot`. GHCR image paths moved with the account and don't redirect: `ghcr.io/connstructor/…` answers 403, while `ghcr.io/deconfined/tarubot:2.15.0` and `tarubot-nodestone:2.15.0` serve the same digests as before (`sha256:9d6d756d…` and `sha256:c17d4e0e…`).
- Point Compose's default images and `.do/app.yaml`'s GHCR registry at `deconfined`. With the old defaults, a DevBot `pull` fails, and App Platform could not have pulled its images.
- Name `deconfined/tarubot` in `package.json` `repository.url`, so `/version` shows and links the repository by its new name and reads its history without the redirect.
- Update the private vulnerability reporting link in SECURITY.md, the image names in README.md and CI_CD.md, the `/version` requirement in REQUIREMENTS.md, MIGRATION.md's cutover clone URL and sidecar image, and the PR and run links in the handoff documents.
- Add a unit test that the App Platform spec and Compose pull the images this repository publishes: they must name the owner and repository from `package.json`, and under GitHub Actions `package.json` must name the running repository (`GITHUB_REPOSITORY`), which `publish.yml` publishes under. A rename or transfer then fails CI instead of leaving the pull sites stale together.
- Record the DevBot 2.15.0 rollout (stopped-writer backup, exact restore at 005, migration 006 rehearsed and applied, 19 roots / 43 paths registered, the startup plan) the owner's 2.15.0 session (D1, D2, D4, D7 and D9 confirmed live, the rest accepted by the owner; `/officer reset` removed the officer tester's manual grant, correcting notes that called him revoked) and the rename in DEV_GUILD.md, OPEN_ITEMS.md, VERIFICATION.md and SESSION_HANDOFF.md, and keep the 2.15 session in `test-plans/current.json` for 2.15.0 or later, with version-neutral rollout steps.

## 2.15.0 — Reply session fixes, member autocomplete and the guest-application switch

The owner's 2.14.0 reply session on DevBot (2026-09-24) compared every reply with the approved mockups; this release ships its findings and the decisions the owner made during it. The officer alerts and telemetry planned as 2.15.0 (OPS-10/OPS-11) move to **2.16.0**, and the production cutover now requires a published release at or above 2.16.0.

- Show an FC's tag once. The Lodestone delivers tags with their guillemets (`«Souls»`) and the stored row keeps them, so `/config show`, `/config validate`, `/config fc link|unlink` and the ledger receipt footers rendered `Woven Souls ««Souls»»`. One helper, `fcTagText`, removes a surrounding pair before every presenter adds its own; bare tags render as before.
- Never imply a change where none occurred (owner decision). `/main` naming your current main replies "Already your main character", `/nickname enabled:true` while sync is already on replies "Nickname sync already on", and turning sync off when it is already off gets the approved "Nickname sync already off" card; each is an info or neutral `= NO CHANGE` card, and `Service.preferences` saves nothing and queues no reconciliation for them. Resuming sync that a manual nickname suspended is still a change. `/config officer_rank` naming the saved rank (or `unset_rank:true` with none set) is likewise "Officer rank already set" or "already unset", with no revision bump, audit or repair pass; it names the saved rank and keeps the Heads-up when no FC is linked or no Officer role is bound, rather than claiming access the rank can't give yet. `/main` with sync off no longer cancels the restore that turning sync off queued. `/nickname enabled:true` without a main no longer shows an Example that repeats the failed command.
- Give every input failure an Example (owner decision: "If there's a parameter to input, it should provide an example"). `EXAMPLES` in `presenters/failure.ts` now covers every option of every registered command path, including `/ledger adjust entry:`, `/sync status run_id:` and `/guest approve|deny application:`, which the 2.14.0 session showed without one; `failure-reply.test.ts` walks the registered commands and fails on any option without an example.
- Accept the entry number in `/ledger adjust entry:` (owner decision). The owner read the option as the `#5` history, receipts and posts show, but it took only the entry UUID. It now takes `5`, `#5` or the UUID; a number is resolved in the current FC account, and a number or ID that isn't there is "Entry not found". The option reads "Entry this corrects: its number (e.g. 5) or ID from /ledger history", so guild commands need re-registering.
- Suggest members on every member option (owner decision). `member:` on `/characters`, `/guest status|grant|revoke`, `/officer grant|revoke`, `/assign` and `/unassign` was free text that accepted only a user ID or a resolved mention, so a typed name was "Check your input" and a non-officer's `/characters member:` never reached "Only your own records" (2.14.0 session). Each option now autocompletes server members by display name, username, global name or nickname from the member cache, falling back to Discord's member search within about a second when the cache has no match; a pasted ID or mention is offered back, so departed owners stay nameable. Members are offered only themselves where naming anyone else is refused. The input failure reads "Pick a member from the suggestions, or paste a Discord user ID or @mention." Guild commands need re-registering.
- Make a new link the main again after a member removed every link (owner decision). Only a member's first-ever link became their main, so an officer assignment that was removed and followed by a verified re-link left one active link, no main, and nickname sync with nothing to follow, while the verify reply said "Main character: Unchanged" (the officer tester, 2.14.0 session). A new link now becomes the main whenever the member has no main and no other active link; unlike a first link it keeps their nickname sync setting (with sync on it replaces the restore the last unlink queued, so the new main's nickname applies, as `/main` does), and the verify and assign replies say "Set as your main because you didn't have one." Imported members keep their imported state.
- Skip the server owner's nickname instead of blocking the job. Discord lets no bot change the server owner's nickname, so the owner's `/nickname enabled:true` queued a `reconcile.user` job that blocked with a warn line, sat under Needs attention in the officer `/sync status` and blocked again after every `/config` change (2.14.0 session). The gateway's member view now marks the owner, and reconciliation (and its preview) never writes or restores their nickname and drops any pending restore or write; the owner's `/nickname` reply already says it has no visible effect.
- Give guest applications their own switch (owner decision: "The channel setting should be separate from whether applications are enabled"). Migration `006_guest_application_switch.sql` adds `guilds.guest_applications_enabled`; it starts on for guilds that already had a review channel (so DevBot stays open) and off everywhere else, including imports still awaiting first activation. `/config guest_applications` now takes `enabled:true|false`, `channel:#…` and `unset_channel:true`, in any combination, saved in one revision and audited per setting; `/apply` opens only when the switch is on and a review channel and Guest role are set. A request that matches what is saved is an info `= NO CHANGE` card, a new channel for open applications reads "Review channel changed", and switching off keeps waiting applications reviewable. Switching applications on validates the review channel that will take them, including a stored legacy channel (also when `/setup` switches them on), and never validates when switching off or unsetting; the officer's next step on a closed `/apply` names `enabled:true`. `/setup` switches applications on. Imports now keep the legacy review channel with the switch off, so reopening after launch is `/config guest_applications enabled:true`; `activate.js --guest-applications open|closed` sets the switch and keeps the channel, and without the flag activation leaves applications closed. `/config show` reads "Off · reviews in #channel" and `/config validate` checks the channel only while applications are on.
- Rename every `/config` option that unsets a setting (owner decision: "Clear sounds like you're erasing the channel's history"): `clear:true` becomes `unset_channel:true` on `/config ledger`, `officer_notifications` and `guest_applications`, `unset_role:true` on `/config roles …`, and `unset_rank:true` on `/config officer_rank`; receipts read "unset" ("Ledger channel unset", "Officer rank unset"). Guild commands need re-registering.
- Add `/officer reset` and `/guest reset` (owner decision: "a third option that removes any override and goes back to membership/rank logic"). `/officer reset member reason` deletes the member's officer grant or revoke, so the in-game rank decides again; like grant and revoke it needs a server manager whose highest role is above the bound Officer role, and like a revoke it works for someone who has left. `/guest reset member reason` lifts a Guest revocation and ends every active grant of any provenance (approved, manual, imported, grandfathered), so FC membership and registered characters decide Guest again. Ended grants are kept as history: migration 006 adds `guest_grants.ended_at`, `ended_by` and `ended_reason`, only grants without `ended_at` confer Guest or appear in `/guest status`, and grandfathering still counts them, so grants a reset ended before activation aren't replaced by a grandfathered grant. Both are audited (`officer.reset`, `guest.reset`), reconcile the member, reply "Officer override removed" and "Guest access reset", and with nothing to remove reply with an info `= NO CHANGE` card and audit nothing. The grant and revoke receipts and the officer guest record now name the reset. Two command paths are added (19 roots, 43 paths), so guild commands need re-registering.

## 2.14.1 — Foreground Claude reviews and sidecar test clock

A CI and test patch: no runtime source changes, no migration (the schema stays `005_launch_access_policy.sql`), and no command changes, so nothing needs re-registering. DevBot runs 2.14.0 and need not redeploy.

- Fix Claude Code Review runs that passed in about 40 seconds with nothing posted. Since Claude Code 2.1.198 a subagent starts in the background unless Claude asks otherwise. The plugin's gating agent started in the background, the main agent ended its turn to wait for it, and `claude-code-action` stops reading at the first result message, so the step passed while the gating agent was still running (run 35948050785; [anthropics/claude-code-action#1499](https://github.com/anthropics/claude-code-action/issues/1499)). The review step now sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so every subagent runs in the foreground and the only result arrives after the review finishes. The 2.14.1 PR's own review is skipped because it changes the workflow, so the fix can only be confirmed on the next ready, same-repository PR to `main` (see OPEN_ITEMS.md).
- Print the review transcript (`show_full_output`) only when debug logging is on: a re-run with debug logging, or the `ACTIONS_STEP_DEBUG` secret or variable. The temporary 2.13.0 setting printed it on every run into the public Actions log.
- Add a "Check that the review finished" step. It prints the turns, duration, cost, subagent counts and permission denials by tool from the action's execution file, and fails the job when a subagent started in the background or never reported back, or when the review produced no result message. It is skipped when the action produced no execution file, as on a pull request that changes the workflow.
- Measure transport start spacing in the sidecar contract test with `performance.now()`, the monotonic clock the sidecar reserves starts on, instead of `Date.now()`, allowing 10 ms for the in-process hop between reserving a start and calling the transport. The wall clock measured the enforced 1,000 ms gap as 999 ms in the amd64 image build of 2.14.0's publish run 35948831624, whose failed jobs were re-run and published. Unspaced starts land a few milliseconds apart, so the test still catches missing spacing.
- Record the DevBot 2.14.0 rollout (backup and exact restore, no migration, 19 roots / 41 paths, the startup plan) in DEV_GUILD.md, OPEN_ITEMS.md, VERIFICATION.md and SESSION_HANDOFF.md, describe the review workflow's new behavior in CI_CD.md, correct README.md's `/version` marker (`✓ verified` since 2.14.0) and DEV_GUILD.md's note on the production application, and keep the 2.14 reply session in `test-plans/current.json` for 2.14.0 or later.

## 2.14.0 — Embed replies instead of JSON

Every command, button, form and pre-form reply is now one private house-style embed ([REPLIES.md](docs/REPLIES.md)) instead of a JSON dump, and ledger posts, guest review messages and decision DMs are embeds too. No migration: the schema stays `005_launch_access_policy.sql`. Re-register commands after deploying, because the `/ledger history` `before` description and the `/config` channel options changed. Interaction logs change level and `code` for several failures; see the log changes below and [OPERATIONS.md](docs/OPERATIONS.md#reply-references-and-error-codes).

- Add a failure catalog (`src/domain/failures.ts`) that gives every thrown code one presentation category and log level, with an optional typed, presentation-safe detail on `Failure`. It catalogues the new codes `pending_proof`, `insufficient_funds`, `fc_linked` and `idempotency_conflict`.
- Log interaction failures by category: routine refusals at info (so a reply's reference stays findable at the default level), Lodestone, Discord and settings trouble at warn, and only failures without an approved explanation at error. Lifecycle, gateway-event, queue-worker and shutdown reports stay at error; job outcomes keep their 2.12.3 levels.
- Report logs gain `category`, `source` and `scope`. **Log change:** an error that is not an approved `Failure` now logs `code: "unexpected"` with its class in `source` (for example `DiscordAPIError[50013]` or `ZodError`); 2.13.0 logged the class name as the code. Raw Discord permission, unknown-member, rate-limit and server errors in interactions classify as blocked, forbidden and upstream failures instead of unexpected ones.
- Reword the note check as "Add a note of 1–1,000 characters." with a label, so reason and rank checks can name their own option, and add `sequenceCursor()` for ledger history cursors, so a bad `before` value can report an entry-number error instead of a balance error.
- Type every interaction-facing service result (`src/application/results.ts`) and add the data the new replies need: `effectsMode` (`live`, `awaiting_activation` or `deployment_disabled`) on every change result, including `/apply`; character identity, main-character and roster-freshness evidence on `/verify` and `/assign`; `already_assigned` for a repeated `/assign`; ended links, cleared mains and remaining links; the FC identity, ledger channel, corrected entry number and replayed post status on ledger receipts; exact history paging (`older`, `newer`, `total`, `above`, page-aligned deliveries); previous values, requeued jobs and holder samples on configuration changes; and application outcomes, decision details and the membership facts behind `/guest status`. The earlier result keys are unchanged, so the officer JSON files only gain fields. `/nickname enabled:false` for someone TaruBot never tracked is now a no-op instead of a refusal.
- **Log and job-diagnostic change:** failures thrown for these conditions use new codes and the approved wording, with a typed detail. `funds` becomes `insufficient_funds` (below zero only; passing the storable maximum is `input`); `pending` becomes `pending_proof`; missing links, members, applications, ledger entries and accounts, claims and FC links become `not_found` (they were `input` or `expired`); ambiguous role and channel choices become `ambiguous`, a second FC link `fc_linked` and idempotency-key collisions `idempotency_conflict` (they were `conflict` or `input`); an obsolete command, button, form, review message or join context becomes `stale` (it was `input` or `forbidden`). `funds` and `pending` leave the catalog. A malformed Lodestone ID in sidecar output is `invalid_response` ("Nodestone returned an invalid Lodestone ID.") rather than the input failure the ID check gives typed options, and a missing join time names its member ("Discord didn't include join details for <@id>."); in a full member-list read it is the member-list failure. A full member request that Discord rate limits or stops answering is the member-list failure too, logged at warn, instead of an unexpected error; the gateway no longer re-requests into another rate limit. A deleted, non-text or other-server channel is refused as "<#channel> is unavailable …" without the channel-permissions fix (a permission refusal keeps its wording), so ledger post states read "channel unavailable" for it; a text channel in the server that TaruBot can't view (Discord 50001 Missing Access) keeps the permissions refusal and its How to fix step. A ledger mutation that finds no ledger account for the linked FC is a broken invariant, logged as `unexpected` at error (2.13.0 logged `setup`), instead of pointing officers at fixes that do nothing. A job parked while `ENABLE_EFFECTS=false` stores "disabled: Discord changes are off for this deployment (ENABLE_EFFECTS=false)." instead of the activation wording.
- Restarting with `ENABLE_EFFECTS=true` requeues the work the dispatcher parked while effects were off, for every present guild whose own effects flag is on, so ledger posts, review messages, DMs and role updates held during a deployment-wide pause go out as receipts promise; an unactivated guild's work still waits for activation, and blocked work for its fix. Startup, activation and `/config` changes now requeue parked work one row per dedupe key, closing older duplicates as `skipped: superseded`; before, a key enqueued again while parked made the requeue violate the active-job index. A closed duplicate keeps its `applied` role changes, a sync run that tracked it tracks the row that carries its work instead (so an earlier run no longer reads Completed before that work runs), requeued rows drop their stored paused diagnostic (so they read `… QUEUED`, not "retrying after a Discord error"), and an enqueue that commits the same key mid-requeue makes the requeue retry from a savepoint instead of failing startup or the `/config` change. `jobs:retry` refuses a job whose work a newer queued, running or blocked job already carries, naming that job, instead of failing on the active-job index. With effects live, leftover paused work no longer promises an activation: members read "held from an earlier pause", and ledger officers, the officer `/guest status` record and the officer `/sync status` overview get the `/config` step that re-queues it instead of "Nothing to fix".
- `/apply` now counts as open only when both the review channel and the Guest role are set, in the pre-form check, at submission, in activation and in the preview tool, so a visitor is never shown a form that would be refused.
- Commands parse application, entry and run IDs, member options, name and world lengths and history cursors into input failures that name the option, instead of raising a raw validation error. `/ledger balance|history fc_id:` also accepts a Lodestone link.
- Application autocomplete lists the newest 25 pending applications as "display name · submitted date · short ID" and matches on the display name, user ID or application ID.
- Add the building blocks the new replies use, in `src/discord/presenters/`. They cover:
  - the house-style tones, status markers, health-check tokens and limits;
  - formatting that escapes user text for where it renders, keeps gil exact, and cuts text on grapheme boundaries;
  - a `Presented` message that only `reply()`, `post()` and `dataReply()` can build, and that enforces every Discord limit deterministically;
  - audiences derived from the authorization policy;
  - the approved job line (labels for members, raw kinds and diagnostics for officers, split across fields when long), the effects and roster-evidence fields, and provenance labels;
  - the approved buttons.
  One strict codec (`src/discord/custom-ids.ts`) builds and parses every button ID; the review buttons keep their format. Tests gain the reply catalog harness and a guard that keeps JSON on the officer details path and bans `JSON.stringify` and `json()` wherever replies are built.
- Answer every refusal and error with one approved embed from a single failure presenter instead of plain text ending in `Operation: <id>`. Each concept has one title and tone however it is reached, "Nothing was changed." where its approved copy says so ("Nothing was recorded." for ledger funds, the reuse sentence on `/setup`), one next step, and the footer `Code <code> · Ref <interaction ID>`, where Ref is the log `operation` field. Members, and replies sent before the actor is known, get member-safe wording; officers also see the affected role or channel and a diagnostic. Unexpected errors never show their text; after a command's work ran they say the request may have been saved, and ledger commands warn against recording twice. Officers see the affected role or channel on "Discord permissions need attention", with How to fix only when TaruBot's role position or channel permissions are the cause, and a configured role that was deleted now says so ("That role no longer exists in this server") in the card, `/config validate` and job diagnostics. `/setup`'s channel-permission refusal names Manage Channels. Officers running `/assign` see who owns a character on "Linked to another member"; members, and officers on their own `/claim` or `/verify`, never do. A retry-timed refusal says "Nothing was changed." before its "Try again …".
- Reply to `/apply` in a closed server with the approved "Guest applications are closed" embed before the form opens, adding the commands that open applications for people with Manage Server; a refused submission reuses the same card with its code and reference.
- Router: handlers receive the viewer and return presenter replies; a component can update its own message in place, only when that message is private or belongs to the presser; the interaction scope (for example `/ledger withdraw` or `button guest`) is logged with each failure; expired interactions and failures while sending a reply are logged at warn instead of rejecting, and an autocomplete that can no longer be answered is logged at warn with no fallback response.
- Character commands (`/claim`, `/verify`, `/unclaim`, `/characters`, `/main`, `/nickname`, `/assign` and `/unassign`) reply with the approved embeds instead of JSON. `/claim` shows the token as copyable text above the card (never inside it) with **Open Lodestone profile**, **Edit Character Profile** and **I've added it — verify now**, which checks in a new reply so the token message is never edited; the pending-token card's **Check again** re-checks in place, at most once every 15 seconds on the presser's own card. `/characters` shows IDs, link UUIDs and **Full details (JSON)** only when an officer names a member. Receipts say when roles and nicknames change, show `↻ WAITING` when the FC roster is stale, and become the pending "Saved, Discord changes paused" card while Discord changes are paused (awaiting activation or off for the deployment). The server owner's first `/verify` link says Discord doesn't let bots change the owner's nickname instead of promising the change, as `/main` does; both stay success, and only `/nickname enabled:true` by the owner is the warning caveat card. Officers' `/assign` and `/unassign` receipts show the member, character, reason (capped at 300 characters) and link, and a delegated officer's assignment notes that it can never grant the Officer role. Character autocomplete labels are cut on character boundaries.
- `/ledger` replies with the approved embeds instead of JSON. Receipts show the exact change, the new balance and entry number and when the entry will be posted; officers also see the previous balance, the post status, the entry UUID and the Ref, and a receipt saved while Discord changes are paused is the pending "Saved, Discord changes paused" card. An unchanged correction is "No correction needed" and a replayed interaction "Already recorded". `/ledger balance` never shows an unset opening balance as 0 gil; members see how many recent entries are still waiting to be posted, and officers see each recent post's state (collapsed runs of posted entries, blocked, waiting, paused or failed) with next steps only when something needs them, plus **Full details (JSON)**. **View history** opens `/ledger history` in a new reply, and its **Newer**, **Older** and **Latest** buttons page in place as whoever clicked; page numbers come from exact counts, so a hand-typed `before:` cursor still numbers and pages correctly. Officers' history pages add entry UUIDs, each post's state and a problem summary. Each **Posted** link uses the channel the post went to, which the dispatcher now records in the job result (no migration), so rebinding the ledger channel keeps earlier links working; posts made before 2.14.0 link through the configured channel. The `before` option now reads "Entry number from a previous page (e.g. 34)", so re-register commands after deploying.
- `/guest`, the `/apply` receipt, the review buttons, `/refresh`, `/sync status`, `/ping`, `/channel` and `/version` reply with the approved embeds instead of JSON. `/guest status` leads with how the member qualifies (confirmed FC membership, a revocation, a grant, former membership, a registered character, a roster check still due, a pending or denied application) and a Roles line that warns when the role update is blocked or failed; members never see officer reasons, reviewers or job details, only their own denial reason (capped at 300 characters). An officer who names a member gets the record view: the newest five grants and applications with review-message links, the latest three deliveries as job lines, and **Full details (JSON)**. Grant, revoke and decision receipts and a new application become the pending "Saved, Discord changes paused" card while Discord changes are paused, the application receipt saying when officers will see it, and review buttons answer "Recorded. The review message updates shortly." `/refresh` shows the run to track, when it starts and the last roster read (officers also see the mode, cooldown and force hint). `/sync status` shows members their refreshes and pending work, and officers the recent runs, outstanding work, what runs next and what needs attention (split across fields when long); the overview stays pending while work is in progress and turns warning only when blocked or failed work is all that's left. The new `sync` component serves **Check sync status**, and Full details covers the sync and guest views. `/version` marks verified commits with "· ✓ verified" instead of ✅, and the character profile refresh job gets a member-facing label.
- `/config`, `/setup` and `/officer` reply with the approved embeds instead of JSON. `/config validate` is a checklist of `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` lines per section (the FC and its roster freshness, the access roles in layout order, the channels, onboarding, Discord changes, role layout and pending guest grandfathering), titled by its verdict: problems (error), warnings, ready for activation (pending) or all checks passed, each saying "Nothing was changed."; a review channel without a Guest role and `ENABLE_EFFECTS=false` now show as warnings. `/config show` summarizes every setting, collapsing unset roles or channels and listing next steps; it keeps one field per setting, so it may use up to 15 fields where other replies stay within 10. **Run health check** and **Re-check** re-run the check in place for the officer who clicked. `/config ledger`, `officer_notifications` and `guest_applications` offer only text channels, as `/setup` does. Change receipts name what was saved, the role they retired, the holders an Officer binding adopted (up to 20, then "+N more") and the work they queued; repeating the current setting is an info "= NO CHANGE" card, a leader or ledger channel without a linked FC and a review channel without a Guest role are warnings, and receipts for role, FC, channel, officer-rank, layout, setup and officer changes become the pending "Saved, Discord changes paused" card while Discord changes are paused. `/setup` lists each role and room as created or reused, with **Check sync status**, and while paused says channel access is secured once the pause ends; `/officer` notes a repeated grant or revoke, a member who has left, and a grant recorded before any Officer role is bound.
- Ledger channel posts, guest review messages and decision DMs are embeds, rendered by the gateway from the stored entry or application, so jobs no longer build message text. A ledger post reads `<Operation> · <amount>` (U+2212 for a negative change, an opening balance unsigned), colored by operation (deposit green, withdrawal and opening balance blurple, correction orange), with the full escaped note, the new balance (a correction shows the previous and new balance and the entry number it corrects), who recorded it, the entry number, `Entry <uuid>` in the footer and the entry's own time. Posts carry no text content and nothing per-attempt, so a retried post under the unchanged `ledger:<entry>` nonce is identical; posts made before 2.14.0 keep their old text. The review message is one embed, "Guest application" and then "Guest application · approved", "· denied", "· cancelled" or "· no longer needed", with the applicant, when they joined and applied, who decided and why, and both answers; its next update clears the pre-2.14.0 text, and Approve and Deny keep their IDs and are disabled once decided. The decision DM speaks to the applicant: approved, or not approved with the officers' reason (capped at 300 characters) and when they may apply again, naming the server when the bot has it cached. A decision DM job for an application that is neither approved nor denied now fails as `invalid_job` instead of sending. Officer notices stay escaped plain text until 2.15.0 redesigns them.
- Handlers return only presenter replies: `Command.execute` and `Component.execute` are typed to return a `Presented` (and `beforeModal` a `Presented` or `null`), and the router answers any other value as an unexpected failure instead of sending it. The pre-2.14.0 JSON dump (`src/discord/replies.ts`) is deleted, so JSON reaches Discord only as the officer **Full details (JSON)** file.
- Document the house style in `docs/REPLIES.md`: tones and the tone table, status markers and health-check tokens, content and audience rules, buttons and the JSON policy, the failure catalog, posts and their two exclusions, the deviations from the approved mockups and the resolutions record. `docs/OPERATIONS.md` gains interaction log levels and fields, reply references and error codes (with the renamed codes for queries that span releases) and status markers; `docs/MODULES.md` describes presenters, the custom-ID codec and presenter tests.
- Tests pin the house style across every catalogued reply: the tone table, `✓ DONE` only for succeeded jobs, paused views never promising queued Discord work, the approved "Check progress any time with /sync status" footer on every paused-save card, the retired catch-all titles and one pin for each of the 27 resolved inconsistencies. Every registered command path except `/apply` and `/version` is exercised through its presenter, every command stays ephemeral, the reply guard allows JSON only on the details path, and duplicate component prefixes fail discovery.
- Record the 2.13.0 DevBot rollout (backup and rehearsal, migration 005, 19 roots / 41 paths, the deployment-guard refusals) in DEV_GUILD.md, OPEN_ITEMS.md, VERIFICATION.md and SESSION_HANDOFF.md, add the 2.14.0 handoff state, and document SSH commit signing (`~/.ssh/id_git`) in SESSION_HANDOFF.md and CLAUDE.md.
- Replace the DevBot session plan with the 2.14.0 reply session, including a pass with Discord changes paused (`ENABLE_EFFECTS=false`) that checks the receipts imported guilds show at launch. DevBot has no unactivated guild, so the "ready for activation" verdict is covered by the unit catalog instead.

## 2.13.0 — Launch policy and cutover tooling

- Record the owner's 2026-09-23 launch decisions as requirement amendments: the multi-character union (any FC character gives Member, any officer-rank character gives Officer, linked characters outside the FC give Guest), first-activation grandfathering, the role-layout switch, `/apply` and onboarding off at launch, App Platform with a managed PostgreSQL cluster, and the guest-form deferral.
- Give registered visitors (trusted links, none in the FC) Guest in every guild, independent of lobby onboarding; channel visibility stays governed by onboarding alone.
- Add migration `005_launch_access_policy.sql`: the `grandfathered` grant provenance, a per-guild first-activation grandfathering marker, and `role_layout_enabled` (on by default, off for imported guilds; DevBot's guild keeps its layout).
- Grandfather every human who does not qualify as Member at an imported guild's first activation with a durable, approved-equivalent Guest grant, created once inside the activation transaction from a checksum-reviewed preview plan. Preview and activation refuse unsettled roster evidence (pending departures), report late joiners, and a repeated activation is a no-op unless `--requeue` is given.
- Gate every role hoist/order path behind `/config role_layout`, and let `/config roles officer adopt_holders:false` bind an Officer role without turning its holders into permanent grants; `/officer grant` now works before the role is bound.
- Start imported guilds with guest applications closed, and refuse `/apply` before its form opens when applications are closed.
- Hold a PostgreSQL single-writer lease before the bot logs in or starts work, check it on its own session, and exit for a supervisor restart if it is lost. Server-side TCP keepalive lets PostgreSQL free an orphaned lease within about a minute after a host loss or partition.
- Add a deployment-identity guard for every operator tool (DevBot, rehearsal and production profiles; exact database, host, user and CA rules; env-file leak checks), `scripts/commands.ts` for fingerprint-confirmed cleanup of leftover guild commands, a read-only production mode for `discord-inspect`, and identity checks in `register.js`.
- Attach the App Platform spec to an owner-provisioned managed PostgreSQL cluster, with foundation and maintenance phases derived by `scripts/app-spec.ts` and validated in CI; rewrite the cutover runbook (rehearsal, window order, abort limits, token handling) in docs/MIGRATION.md.
- Reject malformed user and character IDs as input errors instead of a raw `SyntaxError` (seen on DevBot `/assign` with a typed name), and add a working `CLAUDE.md` alongside the updated AGENTS.md.
- Temporarily print the Claude Code Review transcript (`show_full_output`) to diagnose reviews that post nothing on large pull requests; the assistant workflow is unchanged.
- Record the 2.12.3 DevBot rollout and launch-scope session so far, and the release sequence: 2.14.0 reply presentation, then 2.15.0 telemetry and officer alerts before cutover.

## 2.12.3 — Queue outcome logging and retained role changes

- Classify each failed or waiting job attempt once and log it by severity with timing and cause: expected waits at debug, escalating to warn after 10 minutes of continuous waiting; lost leases, blocks, and retries at warn; gone work at info; terminal failures at error. Row age alone never escalates, so activation-time echoes on re-queued rows stay quiet.
- Distinguish superseded reconciliation inputs (with the generation change) from a lost worker lease. A lost lease writes nothing, and a lost roster lease is no longer reported as Lodestone degradation.
- Keep an append-only `applied` list (newest 20) of role changes on `reconcile.user` results, so a pass superseded by the bot's own gateway echo no longer loses the evidence of what it applied; successful results carry only that key forward.
- Replace the paused guest-form session plan with the launch-scope DevBot session: ledger, non-officer denials, assignment, role removals and drift repair, and Guest grant/revoke.
- Record the owner's hold on guest-form acceptance and onboarding until after launch, the managed-database hosting choice, and the updated delivery order.

## 2.12.2 — Workflow and code-scanning hardening

- Release the Claude Code workflows added in PR #8, which merged without the required version increment and so left `main` unpublished.
- Pin `anthropics/claude-code-action` v1.0.231 and `actions/checkout` v7.0.1 by commit SHA in the Claude assistant and review workflows, resolving code-scanning alerts #3 and #4. Start `@claude` runs only for owner/member/collaborator mentions, drop the idle assignment trigger, skip fork review events, queue requests per issue or PR, and commit through the API so assistant commits are verified.
- Review only ready, same-repository PRs to `main` started by people; cancel superseded reviews, bound both jobs with timeouts, keep `GITHUB_TOKEN` read-only, and stop persisting checkout credentials.
- Remove CodeQL's experimental `analysis-kinds` input, which was ignored, logged errors, and will become fatal; run the `code-quality` query suite through code scanning instead, since GitHub Code Quality is unavailable for this repository. Record the exact CodeQL action version and let main/scheduled analyses finish instead of cancelling them.
- Make Lodestone tag stripping an explicit fixed point with identical output, resolving high-severity alert #1, and document that display text is not HTML-safe. Add direct `display()` tests.
- Replace the template Dependabot config with Bun, Bun runtime image, Compose PostgreSQL, and grouped GitHub Actions updates with cooldowns, excluding Nodestone-managed dependencies and PostgreSQL majors. Document how maintainers complete Dependabot PRs under the version policy.
- Record the DevBot 2.12.1 rollout on schema 004, the officer-chat review destination, the first approved unverified-visitor application, and the queue-logging follow-up it exposed.
- Add a unit test that keeps the Bun runtime pins and the CI/Compose PostgreSQL images in agreement, run the version check last in the CI checks job so dependency PRs report its other steps first, add an advisory `bun audit` workflow, comment GHCR write grants, and add a security policy that routes reports to private vulnerability reporting.

## 2.12.1 — Release handoff and future roadmap

- Record the next-session handoff with verified merged/published/deployed versions, DevBot identities and read-only health/persistence observations, policy decisions, and implementation pointers.
- Refresh the v2 release checklist after PR #6 and its image publication completed; retain the outstanding migration, live acceptance, operational features, recovery, and production cutover work.
- Document the owner's v3–v6 roadmap: rank-aware dashboard, interactive actions/reaction roles, ModMail, and expanded Lodestone profiles after v2 is settled and online.
- Link the handoff and roadmap from the README and synchronize the maintenance version in the startup plan and App Platform template.

## 2.12.0 — Officer-reviewed guest application forms

- Open `/apply` as a two-question modal for unverified visitors, with immediate form acknowledgement and freshly authenticated submissions bound to the user, guild, and current join.
- Persist bounded introduction/interest answers, submission audit, and review outbox atomically in additive migration `004_guest_application_form.sql`; repeated submissions retain the original pending application and answers.
- Show escaped answers beside persistent officer Approve/Deny buttons, including restart and deleted-message repair. Keep answers out of ordinary status/decision replies and distinguish legacy reviews without form answers.
- Preserve automatic verified non-FC Guest access, FC Member precedence, denial cooldown, explicit revocation, and existing grants. Verification while a form is pending supersedes manual approval.
- Cover real SDK acknowledgement/rendering, forged/stale context, concurrent decisions, persistence/rollback, cooldown, and registered-visitor behavior; update the live application-review test plan.

## 2.11.1 — Bound channel reconciliation reads

- Reuse a single captured channel session per reconciliation instead of force-fetching the guild and complete channel list for every target.
- Use the connected Gateway cache for no-op detection and protected binding/parent fences, with targeted REST reads before and after changed-channel writes.
- Keep full initial/final inventory verification, with at most one additional catalogue check before lowering the shared everyone default.
- Add a real application/SDK/PostgreSQL request-count regression for an 82-channel managed guild, plus disconnected/missing-scope safety coverage.

## 2.11.0 — DigitalOcean App Platform deployment

- Add a GHCR-backed App Platform spec with one bot worker, internal Nodestone service, pre-deploy migration job, and a newly provisioned inline PostgreSQL 18 dev database.
- Bind database credentials and the provider CA at runtime; enforce certificate/hostname verification when `DATABASE_CA_CERT` is supplied, including over conflicting URL TLS flags.
- Validate the provider schema offline in CI and test release/credential/networking invariants and actual driver TLS option parsing.
- Document initial provisioning, secrets, command registration, dev-database limits, and phased single-writer updates with persistent database identity.

## 2.10.2 — Separate officer chat from community channels

- Exclude Discord's configured community-updates channel and its parent category from onboarding preflight, selection, snapshots, and permission writes, using IDs rather than channel names.
- Prefer/create `#officer-chat` as the separate officer room and reject reserved resources as onboarding bindings.
- Recheck protected scope before remote mutations and react to community binding changes. Preserve the everyone visibility default where changing it would affect an excluded area.
- Verify reserved-channel privacy and limited-permission setup with SDK, PostgreSQL, and read-only DevBot preflight checks; record the new live officer room.

## 2.10.1 — Preserve explicit channel privacy

- Treat any explicit View Channel deny as private-area evidence when everyone, Member, and Guest visibility are all absent, including role and member-specific denies after onboarding is enabled.
- Keep a channel with no visibility overwrites distinguishable as an ordinary default-closed channel.
- Add SDK-effective and PostgreSQL regressions covering Member, Guest, other-role, and member-specific privacy; retain the first snapshot and prevent Member/Guest grants.

## 2.10.0 — Lobby onboarding and channel access

- Extend `/setup` to create/reuse a newcomer lobby and officer room, with explicit channel selections and manager/channel permission checks.
- Enforce lobby, Member/Guest, and staff-only visibility across all non-thread channel types; threads inherit parent visibility. Officers and FC Leaders can see the lobby while ordinary Members/Guests cannot.
- Preserve first-observed channel permissions/parents and the original everyone permission bitfield; retain existing private areas as staff-only. Persist the opt-in policy in `003_guild_access.sql` using Drizzle.
- Reconcile channel creation, edits, deletion, startup, refresh, and role rebinding through durable, revision-fenced work with full readback and no-op convergence.
- Derive Guest access for trusted registered non-FC visitors, preserving revocation, FC Member precedence, stale-evidence safeguards, and guild isolation.
- Verify effective Discord.js permissions, provisioning/reuse, partial-failure recovery, snapshot durability, authorization, refresh accounting, and visitor access transitions.

## 2.9.0 — Drizzle persistence

- Map the existing PostgreSQL schema with Drizzle ORM and use typed queries for application persistence.
- Preserve exact external IDs, bigint money, UTC timestamps, and database-enforced invariants.
- Bind ORM operations to the same connection as transactional decisions and PostgreSQL locks.
- Retain the applied SQL migrations and explicit PostgreSQL-specific control statements.
- Convert roster/rank projection, role setup, gateway observations, work leases/outbox, capability metrics, import, and maintenance commands to the shared ORM boundary.
- Derive persisted record contracts from the mapped schema and verify mapping parity, scalar JSON, transaction isolation/rollback, and concurrent queue fencing against PostgreSQL.

## 2.8.4 — Dependabot maintenance

- Enable weekly Bun dependency-update pull requests.
- Keep dependency updates subject to the existing SemVer, changelog, CI, and CodeQL requirements before merge.

## 2.8.3 — Release publication review fixes

- Isolate publication and reusable verification by commit SHA so new merges cannot cancel an older version's image builds.
- Serialize only the mutable latest-tag promotion, retaining its current-main guard.
- Reject build metadata and oversized release versions instead of silently changing or colliding Docker tags.

## 2.8.2 — CodeQL and project licensing

- Analyze JavaScript/TypeScript and GitHub Actions workflows with CodeQL, including the repository's required security/code-quality results.
- License first-party TaruBot code under AGPL-3.0-only; include the license in runtime images and OCI metadata.
- Add source-code and license links to `/version` output.

## 2.8.1 — Cross-platform test startup budgets

- Give subprocess and parser-worker tests bounded startup headroom under ARM64 emulation.
- Preserve all module, parser, transport-spacing, and cancellation assertions while avoiding the default five-second test deadline for cold worker startup.

## 2.8.0 — Pull-request CI and published containers

- Validate PRs with version/changelog checks, source checks, the full PostgreSQL-backed test suite, and both multi-platform container builds.
- Generate an invented CI migration fixture while retaining the separate supplied-dump acceptance path.
- Build and publish TaruBot and Nodestone images to GHCR after `main` changes pass verification, using latest, SemVer, and full-commit tags.
- Default Compose to registry images; retain an explicit local source-build override and development database overlay.
- Adopt the feature-branch, PR, passing-CI, merge-to-main workflow.

## 2.7.1 — Versioning policy and delivery readiness

- Require an appropriate SemVer increment for every coherent change set, including documentation, tests, and maintenance.
- Present required Discord intents and bot permissions as name/reason tables in the setup guide.
- Record the requirements-backed implementation gaps, live acceptance checks, and production-delivery work in `docs/OPEN_ITEMS.md`.
- Record live version-command registration and GitHub signature/history verification.

## 2.7.0 — Version and GitHub history command

- Add `/version [commits]` for any human guild member; show five commits by default, up to ten.
- Show the installed SemVer, linked short commit IDs, and commit titles.
- Mark signed commits with **✅** only when GitHub reports a valid verified signature.
- Share/cache bounded GitHub requests, and retain version output during GitHub outages or rate limits.

## Retrospective development milestones

These numbers are assigned now to the completed work stages to establish a meaningful SemVer baseline. Earlier working snapshots used the placeholder `1.0.0`; these entries describe development milestones, not previously published releases or tags.

| Version | Completed milestone |
| --- | --- |
| 2.0.0 | Core rewrite: ownership, membership, nicknames, guest workflow, ledger, PostgreSQL import/recovery, and containers |
| 2.1.0 | Dynamically discovered commands, events, components, and typed service injection |
| 2.2.0 | Independent Nodestone/selector HEAD tracking and checked update workflow |
| 2.3.0 | Role setup, officer/leader rank projection, explicit officer overrides, and startup test plans |
| 2.4.0 | Public development-guild interaction replies |
| 2.5.0 | Automatic role grouping and hierarchy reconciliation |
| 2.5.1 | Correct consecutive role blocks and reuse of existing Member/Guest role IDs |
| 2.6.0 | Nodestone submodule-backed builds, source fingerprints, and clean-clone verification |
| 2.7.0 | Installed-version and verified GitHub commit-history command |
| 2.7.1 | Mandatory version increments and delivery-readiness tracking |
| 2.8.0 | Pull-request validation and GHCR container delivery |
| 2.8.1 | Bounded subprocess/worker test budgets for emulated image builds |
| 2.8.2 | CodeQL merge-gate integration and AGPL-3.0 licensing |
| 2.8.3 | Non-cancelling release publication and exact registry version tags |
| 2.8.4 | Weekly Bun dependency-update pull requests |
| 2.9.0 | Typed Drizzle persistence with exact-value, transaction, and queue regression coverage |
| 2.10.0 | Opt-in lobby/staff channel security and derived registered-visitor Guest access |
| 2.10.1 | Preserve private channels expressed through explicit role/member visibility denies |
| 2.10.2 | Protected community-update resources and separate officer chat |
| 2.11.0 | App Platform spec with automatic PostgreSQL provisioning and provider-CA support |
| 2.11.1 | Reconciliation-scoped inventories and bounded targeted Discord reads |

## Increment policy

- **Major:** incompatible changes to supported commands, configuration, or persisted-data contracts.
- **Minor:** backward-compatible functionality and supported operational capabilities.
- **Patch:** backward-compatible corrections or maintenance, including documentation, tests, and tooling changes without a new feature contract.
- Every coherent change set receives an appropriate version increment; related edits share that increment.

Future changes update `package.json`, the Bun-generated lockfile when affected, and this changelog together. Released versions identify the running build; the latest GitHub commits can include work newer than that build.
