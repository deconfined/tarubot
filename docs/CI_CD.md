# CI/CD and container delivery

## Branch → pull request → merge → publish

1. Create a feature branch. Increment SemVer and update `CHANGELOG.md` for each coherent change set.
2. Open a PR against `main`. **CI** runs version/changelog validation, type checking, lint/format checks, compilation, all unit/contract/PostgreSQL integration tests, and both runtime image builds for `linux/amd64` and `linux/arm64`. Since 2.32.0 its **Host playbook** job checks `ops/ansible/` without a host: `ansible-playbook --syntax-check` with the example inventory and host settings, ansible-lint (both pinned by hash in `ops/ansible/requirements-lint.txt`, with ansible-core at 2.16.19, the hosts' 2.16 series with its security fixes, offline and with nothing from Galaxy), and ShellCheck on the IPv6 wait script, `tarubot`'s shell start-up files and, since 2.34.0, the pull unit's script (`ops/ansible/files/host-config/tarubot-host-config`, which runs as root). `CI result` requires it ([HOSTING.md](HOSTING.md#staging-host-50)). The Checks job's `bun run test` runs `tests/unit/host-config.test.ts`, which drives the pull unit through a sandbox with real git, `ssh-keygen`, `jq` and `flock`; it skips its scenarios where one of them is missing, as in the `oven/bun` image build. The Checks job also runs Podman's own Quadlet generator over `ops/quadlet/` for both targets, in `quay.io/podman/stable` at the hosts' Podman version and pinned by digest, and sets `QUADLET_DRYRUN` so `tests/unit/quadlet.test.ts` compares the generated unit with the source and Compose. Its ShellCheck step covers `ops/*.sh` and `ops/*/*.sh`, and `tests/unit/playbook.test.ts` fails if a script under `ops/` has no ShellCheck line.
3. Merge after the required **CI result** check and the **CodeQL** code-scanning gate pass. The **Protect Main** ruleset requires `CI result` from GitHub Actions on an up-to-date branch, signed commits, and no new high-severity security alerts or error-level CodeQL results. Pull requests merge with a merge commit only: @deconfined turned squash and rebase merging off in the repository's settings on 2026-09-28 (question 14 of REQUIREMENTS.md "Approved staging amendments (2026-09-26)"), because the pull unit checks each merged head that changes `ops/ansible/` for an allowed SSH signature and a tree equal to the merge's ([HOSTING.md](HOSTING.md#the-signature-rule-question-14)). On such a pull request, don't use "Update branch" or a web edit last: GitHub signs those commits with its own key, so push a signed commit on top before merging. Don't add a merge queue or "Require linear history". The ruleset's own pull-request rule still lists `merge` and `squash` as allowed merge methods (read on 2026-09-28), so for now the repository toggle alone enforces merge commits; setting the ruleset to `merge` only is an owner step ([HOSTING.md](HOSTING.md#installing-it-owner), step 1). Agent pull requests that change `ops/ansible/` stay unpushed or in draft until reviewed: their heads are signed with the key the hosts accept, so an early merge would reach staging's root ([HOSTING.md](HOSTING.md#the-signature-rule-question-14)). CodeQL analyzes both JavaScript/TypeScript and GitHub Actions workflows on PRs, main updates, and a weekly schedule with the `security-extended` query suite, plus the `code-quality` suite for JavaScript/TypeScript (the Actions query pack has no quality queries); it excludes upstream/generated dependencies. GitHub's separate Code Quality product is not available for this repository, so quality results report through code scanning.
4. **Publish containers** revalidates the merged commit, builds both image targets, and pushes them to GHCR. Pull requests have read-only repository permissions; only publication jobs receive `packages: write`. Since 2.32.0 it also signs build provenance for each published image before `latest` moves ([below](#signed-build-provenance)).
5. **Deploy** (named "Deploy production" until 2.33.0) plans the published release, verifies its signed provenance, and deploys it over SSH: to the production host once the owner approves it in GitHub (2.30.0), and since 2.33.0 to the staging host at once, without approval, when staging deploys are on ([below](#deploy-workflow)). Documentation-, test- and CI-only merges ask for no approval.

Actions are pinned to full commits, and the repository's Actions settings require full-SHA pins. Dependabot proposes updates to those pins and their version comments. No checkout needs submodules since 2.20.0, which replaced Nodestone with a first-party parser; since 2.21.0 there is one image, because that parser runs inside the bot. No checkout persists its credentials. Registry login uses the workflow's `GITHUB_TOKEN`; no stored publishing PAT or Discord/database production credentials are needed by CI.

The **Validate version and changelog** step runs last in the checks job. A PR without a version increment still fails, but only after every other step of that job has reported; the container builds depend on that job, so they run once the version commit is pushed.

## Signed build provenance

Since 2.32.0 (#50 part 1), `publish.yml` signs SLSA build provenance for each published image. The **Sign build provenance** (`attest`) job runs after the build and before **Promote latest**:

- It runs `actions/attest` (pinned by SHA) with only `contents: read`, `id-token: write` and `attestations: write`: no registry write and no login. It is the only job, in any workflow, allowed to write attestations. The build itself never holds an OIDC token.
- The subject is `ghcr.io/deconfined/tarubot` at the index digest `docker/build-push-action` returned, handed over as the publish job's `digest` output. It never reads a tag back, because any same-repository workflow can repoint a GHCR tag. The matrix stays one image, so that output is that image's digest. A value that isn't one `sha256:` digest stops the job before it signs; an empty subject would make the action look for subjects elsewhere.
- The certificate comes from Sigstore's public-good instance and names `publish.yml`, `refs/heads/main` and the commit. No pull request or branch workflow can mint one. The attestation is stored with the repository, not pushed to GHCR, so the package gains no extra versions. The BuildKit provenance and SBOM the build attaches stay unsigned.
- `latest` needs `attest` and is promoted from the same digest, not from the `sha-` tag.
- A failed signature fails the publish run, so the automatic deploy isn't planned; the images and their version and `sha-` tags are already pushed. Re-running the failed `attest` job keeps the build's output.

Since 2.33.0 the Deploy plan verifies the signature before anything else uses the digest: before its "nothing to deploy" exit and before either deploy job. It runs `gh attestation verify oci://ghcr.io/deconfined/tarubot@<digest> --repo deconfined/tarubot --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main --source-ref refs/heads/main --source-digest <commit> --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners --format json`, requires at least one verified attestation, and otherwise fails `unattested` (gh also fails on a network or TUF error, so a new dispatch retries). It names the signer by the certificate's exact identity: gh's `--signer-workflow` is a pattern anchored only at its start, which a workflow named `publish.yml-anything.yml` would also match. It needs no registry login and no `packages` permission, because the package is public; it reads the attestations with the job's own `attestations: read` token. On success the summary says `Provenance verified: publish.yml on refs/heads/main, commit <commit>`. Releases before 2.32.0 have no attestation, so the plan refuses them; a production rollback to one goes by hand ([HOSTING.md](HOSTING.md#rolling-back-to-a-release-without-provenance-before-2320)). The same command, without `--format json`, checks a later image by hand from any `gh` login (gh asks for a token even for a public repository), and the first start on a Quadlet host takes a digest checked that way.

`tests/unit/publish-workflow.test.ts` pins these rules, and that every action in every workflow is pinned to a full commit SHA with its version comment.

## Deploy workflow

Since 2.30.0 (issue #41; REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"), `.github/workflows/deploy.yml` deploys published releases to the production host over SSH after @deconfined approves them. Since 2.33.0 (#50; REQUIREMENTS.md "Approved staging amendments (2026-09-26)") it is named **Deploy**, and it also deploys to the staging host, without approval, beside production's request. The host checks the workflow's path, not its name. [HOSTING.md](HOSTING.md#automated-deploys-2300) has the host side: what each host checks and does, the outcomes, the logs and the owner's setup, and [Staging deploys](HOSTING.md#staging-deploys-2330) the staging target.

**Triggers.** `workflow_run` of "Publish containers" (it must have succeeded, for a push to `main`, from `publish.yml` in this repository), which asks for both targets; and `workflow_dispatch` from `main` with `version`, `rollback`, `from` and `target` (`production`, the default, or `staging`), which asks for that one target. The run's title names the target: `Deploy <commit>` for an automatic run; `Deploy <version>` or `Deploy <version> rollback from <live version>` for a production dispatch; the same with ` to staging` for a staging one. Each host requires its own titles, so an approval covers only that target, and production refuses every staging title.

**Jobs.** None uses an action or checks out the repository, and every `${{ }}` reaches a script through `env:`.

| Job | Environment | Token | What it does |
| --- | --- | --- | --- |
| `plan` | none | `contents: read`, `actions: read`, `attestations: read` | Decides which targets this run deploys (the switches, each environment's gate, the staging dispatcher), resolves the version, commit and image index digest (the version tag and `sha-<commit>` must be the same image, and the commit must be on `main`), verifies the image's signed provenance, checks that a staging target declares Quadlet staging deploys, decides whether the merge changed anything that runs on a host, refuses an edited applied migration, a rollback across a migration, or a compare GitHub may have cut at 300 files, and writes the plan to the run summary. |
| `deploy` ("Deploy") | `production` | none | Waits for the approval; then writes the key to a mode-600 file under `RUNNER_TEMP` and unsets its variable, pins the host key, and sends one command to the host. Only connection failures are retried, with the same command, for up to 80 minutes (the host's longest run is about 68); a changed host key or a rejected key stops it at once. It reports `unreachable` only when every attempt failed before sshd answered, and `outcome-unknown` otherwise, since the host may have started. It removes the key file in an `always()` step. |
| `deploy-staging` ("Deploy staging") | `staging` | none | The same SSH step against the staging host, at once, beside production's approval request, with a 30-minute limit and 5 minutes of reconnects. Production never needs it, and its failure never holds production up. |
| `notify` | `notify` | none | Sends one Pushover message about production; the credentials reach `curl` on stdin. A failed send never changes the outcome. Staging sends none: notify skips a staging dispatch, and its messages read only production's job. The plan decides at its start whether the run is reported (its `notify` output: the run asks for production while `DEPLOY_ENABLED` reads as true), so turning the switch off while a request waits or a deploy runs never silences that outcome. Only a plan that never wrote the output falls back to the switch as it reads then. |

The two SSH steps are the same script, written twice (the test keeps them byte-identical); only `DEPLOY_ENVIRONMENT` (`production` or `staging`, used in messages) and `RECONNECT_SECONDS` (4800 or 300) differ. Staging's limits are the accepted plan's: a dead staging host never holds a runner for 90 minutes. The trade-off is that a long staging migration trial, or a connection lost for more than 5 minutes, outlives the job; the host run carries on, the job ends cancelled or `outcome-unknown`, the host's run directory keeps the result, and the next staging run waits up to 5 minutes for the host lock.

**Targets and switches.** Each target has a repository variable: `DEPLOY_ENABLED` for production and `STAGING_DEPLOY_ENABLED` for staging. The plan runs when either is `true`; with both unset nothing runs and no environment is touched. A requested target whose switch is off is left out, and when nothing is left the plan ends with `deploy=false` and `reason=paused`, without failing. The plan's outputs `production` and `staging` say which deploy jobs run; each job checks its own switch again before it connects (`refused` `paused`). Two more are for notify: `notify` (above), and `production_reason`, which says why production is off in a run that goes on for staging (`paused` or `gate`).

**Environment protection** (the gates). `production` has exactly one required reviewer, the user `deconfined`, with "Prevent self-review" off, no administrator bypass, and deployment branches limited to the one branch rule `main`. `staging` has the same branch rule and no required reviewer: its host checks no approval, so a reviewer rule there would only look like a protection. `notify` is limited to `main`. A failed gate turns off only its own target (with an error and a line in the summary), notify's fails the plan, and if no requested target passes, the plan fails `gate`. An environment a typo auto-created has none of that, and each host checks the run itself anyway.

**The staging dispatcher.** Staging has no approval, so only @deconfined may dispatch it: `github.triggering_actor` must be `deconfined`, and the run's `actor` and `triggering_actor` must both be `deconfined`, account id 71469756. Otherwise the plan fails `dispatcher`. This refuses a dispatch by a GitHub App or by a workflow's `GITHUB_TOKEN` on purpose, since a pushed branch workflow could dispatch Deploy on `main` with its own token. The staging host checks the same again.

**Provenance** ([above](#signed-build-provenance)). After the version, commit and digest are bound and before any early exit, the plan runs `gh attestation verify` and fails `unattested` unless `main`'s `publish.yml` signed this digest for this commit. Releases before 2.32.0 are refused.

**The staging capability check.** Staging needs a release whose `ops/deploy.sh` speaks Quadlet staging deploys. The plan reads that file at the target commit and requires the line `readonly CAPABILITIES="…"` to hold the words `quadlet` and `staging`; a comment naming them doesn't count. Otherwise staging is left out, and a staging-only run fails `below-floor`. The plan copies no floor number: the target's own declaration says what it speaks.

**What counts as a runtime change** (automatic runs only; a dispatch always proceeds): every changed path except `docs/`, `site/`, `tests/`, `test-plans/`, `.github/` (but `publish.yml` counts), top-level `*.md`, the development Compose files (`docker-compose.yml`, `.devbot`, `.tools`, `.build`), `.env.example`, `production.env.example`, `staging.env.example`, the Ansible pip pins (`ops/ansible/requirements*.txt`, which only CI and the operator's venv read; since 2.32.1) and `biome.json`, plus `package.json` when only its version line changed. `ops/quadlet/`, `ops/systemd/` and the rest of `ops/ansible/` are runtime paths. A merge of 300 files or more is refused as `compare-too-large`, as is a rollback across that many: GitHub's compare API lists at most 300 files, so the plan could neither show the host-side changes nor check the migrations (deploy such a release by hand). Without a runtime change the run ends with `deploy=false` and a quiet message: no approval request, and nothing on staging.

**The host-side list.** The summary lists this merge's files under `ops/`, `docker-compose.production.yml`, `production.env.example` and `staging.env.example`, and says where they run: on production's Docker host as a docker-group user, which is root-equivalent there; on the staging host as the unprivileged `tarubot` user under rootless Podman; and `ops/ansible/` as root when the playbook is applied. It names the targets the run deploys, and says that staging deploys beside the approval request without one.

**Settings.**

| Name | Kind | Where | Holds |
| --- | --- | --- | --- |
| `DEPLOY_ENABLED` | variable | repository only | Exactly `true`, lowercase, turns production on. The rollout and pause switch (below). |
| `STAGING_DEPLOY_ENABLED` | variable | repository only | Exactly `true` turns staging on, the same way (2.33.0). |
| `DEPLOY_HOST` | variable | `production`, `staging` | Each host's DNS name. It isn't secret, but the repository names no host (`deploy-workflow.test.ts` checks the workflow and `ops/deploy.sh`). Every deploy run's public log shows it (below). |
| `DEPLOY_KNOWN_HOSTS` | variable | `production`, `staging` | One line: `DEPLOY_HOST`, then `ssh-ed25519` and the host's key, from the host-key step (production's was checked against its SSHFP records); no trailing comment. The public log shows it too. |
| `DEPLOY_SSH_KEY` | secret | `production`, `staging` | Each host's own deploy key, forced on that host to `ops/deploy.sh` (production: no arguments; staging: `quadlet staging`). |
| `PUSHOVER_TOKEN`, `PUSHOVER_USER` | secrets | `notify` | The "TaruBot deploys" Pushover application and the owner's user key. |

**The switches are repository variables**: Settings → Secrets and variables → Actions → Variables → **Repository variables**, or `gh variable set DEPLOY_ENABLED --body true` (no `--env`), and the same for `STAGING_DEPLOY_ENABLED`. The value must be exactly `true`, lowercase. The plan job's condition compares strings without case, so `True` starts the plan, but the plan's own check doesn't: the target stays off (`paused`) and nothing asks for approval. For production, Pushover then says that `DEPLOY_ENABLED` must be exactly `true`. Never give an environment a copy. The `plan` job has no environment, so it can't see one, and the target stays off; inside a deploy job an environment variable overrides the repository's, so deleting the repository variable would no longer pause a request already waiting. The first automated run hit the first half on 2026-09-26: run 36242804814 was skipped because `DEPLOY_ENABLED` had been created in `production`, and after @deconfined moved it to the repository, run 36242986952 planned, waited for the approval and ended `already-live`.

**Rules.**
- **Re-runs are refused:** every job requires `run_attempt == 1`, and each host refuses a later attempt. Start a new run instead.
- **No concurrency group:** several approval requests may wait; an older one approved after a newer release is live ends as `superseded`, and each host's lock runs one deploy at a time.
- **A run's conclusion isn't production's result.** The two deploy jobs run side by side, so a run can fail on its staging job while production deployed. Whether production deployed a run is the `Deploy` job's conclusion together with the production approval, never the run's conclusion. Notify reads it that way, and so does the pull unit (2.34.0), which applies production's host configuration only from a run whose `Deploy` job succeeded after @deconfined's approval ([HOSTING.md](HOSTING.md#what-each-host-applies)).
- **Public data only:** the plan summary, the run log and approval comments are public. The hosts print only fixed `step`, `warning` and `result` lines; ssh's own messages stay in a private file on the runner. GitHub prints a step's `env:` values in its log and masks only secrets, so each deploy job's log shows `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`: the host names are public in every deploy run. The owner considers the names not secret; to hide them, both would have to become environment secrets, and the workflow and its test would read `secrets.` instead of `vars.`.
- **Publication stays separate:** `publish.yml` never deploys. Since 2.30.0 it publishes from `main` only (the `v*` tag trigger was dropped), so every tag a deploy trusts was built from `main`, and since 2.33.0 the plan verifies that for the digest itself.

The first `publish.yml` run after the 2.30.0 merge (run 36242066698) completed a run of this workflow that stopped at the `DEPLOY_ENABLED` gate; the variable has been set, at repository level only, since 2026-09-26. `STAGING_DEPLOY_ENABLED` stays unset until the owner turns staging on after the DevBot move ([HOSTING.md](HOSTING.md#owner-steps-before-the-move)).

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

**Staging (question 5 of REQUIREMENTS.md "Approved staging amendments (2026-09-26)").** The same limits hold for both targets: agents never approve deploys for either target; never change any deploy environment (`staging` included), its secrets or variables, or either switch (`DEPLOY_ENABLED`, `STAGING_DEPLOY_ENABLED`); never hold either deploy key; never enable, disable, cancel or re-run the Deploy workflow; and never push a workflow that does any of these. @deconfined withdrew question 5's "never dispatch" on 2026-09-27 ([#50](https://github.com/deconfined/tarubot/issues/50#issuecomment-5852502546)) and kept #41's clause: agents dispatch the Deploy workflow, for either target, only when @deconfined asks in that session. A staging dispatch must also come from @deconfined's own account (the plan and the staging host check the actor and triggering actor by login and id), so the read-only token, the agent's app or a workflow token can't start one.

By the rule and AGENTS.md, merging, approving, dispatching and every environment, secret and variable change are the owner's alone. Technically one path remains. The SSH key pushes as the owner, so it can push any branch but `main`, including one whose workflow asks for write permissions on its own `GITHUB_TOKEN`: the repository's default is read, and a same-repository workflow may raise it. Such a workflow can:
- dispatch, cancel and re-run runs, including Deploy on `main` (production still waits for the approval, and a staging dispatch is refused, because a workflow token isn't @deconfined);
- push release and `sha-` tags to `ghcr.io/deconfined/tarubot`, with any labels;
- read repository secrets such as `CLAUDE_CODE_OAUTH_TOKEN`;
- merge a pull request whose required checks pass (the ruleset asks for no review).

It can't reach the `production`, `staging` or `notify` environments, which accept only `main`. So the owner's approval, the staging dispatcher check and the written rule are what stop a deploy. The plan resolves the digest from the version tag (and checks that `sha-<commit>` is the same image), and the hosts check only that digest and the image's labels. Until 2.33.0 an approval of a normal-looking plan, with the real version and commit and an opaque digest, could therefore deploy an image a branch pushed. Since 2.33.0 the plan's provenance check refuses such a digest (`unattested`): only `main`'s `publish.yml` can sign one.

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
- `ops/ansible/requirements.txt` and `requirements-lint.txt`: hash-pinned with a header Dependabot can't rewrite. Alerts still cover them; regenerate them by hand as their headers describe.
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
