#!/usr/bin/env bash
# Owner-approved deploys over SSH (2.30.0, issue #41), with the Quadlet modes and the staging
# target (2.33.0, #50). REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)" and
# "Approved staging amendments (2026-09-26)" record the owner's decisions; docs/HOSTING.md
# "Automated deploys" has the flow, what each outcome means and what to do by hand.
#
# This is the forced command of a deploy key in the tarubot user's ~/.ssh/authorized_keys:
# restrict,command="<home>/tarubot/ops/deploy.sh[ <mode words>]", where <home> is what
# `getent passwd tarubot` names. The mode words say what the host is; nothing is detected:
#
#   (none)           Compose on Docker: today's production host (<home> is /opt/tarubot there).
#   quadlet          production as a rootless Quadlet unit, after its rebuild (#50, the production rebuild).
#   quadlet staging  the staging host, also a rootless Quadlet unit.
#
# Any other words print the usage line and exit 64 before a run directory, lock, git, Podman or
# systemd call. Copies up to 2.32.x exit 64 on any argument, so a Quadlet host never runs one.
# The Deploy workflow (.github/workflows/deploy.yml) connects from its production job only after
# the owner approves the run in GitHub, and from its staging job without an approval; sshd hands
# the client's command over in SSH_ORIGINAL_COMMAND. Exactly two forms are accepted, the v1
# command contract:
#
#   deploy   <version> <commit> <digest> <run>
#   rollback <version> <commit> <digest> <run> <from>
#
# Anything else prints the usage line and exits 64 without touching git, the runtime or a lock.
#
#   1. The entry starts one detached worker per run id, holding runs/<run>/lock, and follows its
#      public log. A reconnect with the same request attaches to the same run instead. A run
#      refused before its approval was confirmed starts over on the next request.
#   2. The worker asks GitHub's public API whether this exact run is active on main with the
#      mode's deploy job running and names this target, and asks again just before the first
#      change. On production (Compose or `quadlet`) the owner must have approved the run for the
#      `production` environment. Staging has no approval: its "Deploy staging" job must run, and a
#      dispatch must come from the owner. The key alone authorizes nothing.
#   3. It refuses while manual work looks in progress (the bot stopped, the pinned release not the
#      one running, a backup running, a changed clone), then compares the live release with the
#      target in git: no migration files added means a restart; added files mean stop, a fresh
#      ops/backup.sh dump, migrate.js in the new image, then start.
#   4. The image must be the digest the plan showed. The previous release comes back on its own
#      only when the new one provably never took the writer lease, or the migration did not
#      commit. Commands are registered (globally on production, in the test guild on staging)
#      and read back whenever a release is started or verified.
#
# Only fixed `step`, `warning` and `result` lines leave the host. Tool output stays in
# ~/.local/state/tarubot-deploy/runs/<run>/worker.log. The command format and the run directory
# layout (request, lock, step, public.log, worker.log, result) are a versioned contract: a change
# to either raises FLOOR to the release that makes it, because after a rollback an older copy of
# this script answers the current workflow.
#
# The Quadlet modes add a second contract, named by the word `quadlet` in CAPABILITIES below. A
# Quadlet host runs whichever release's copy is live, so every target there must speak it
# (QUADLET_FLOOR, and the word in the target's own CAPABILITIES line). It covers every surface
# this script or another release relies on:
#
#   - the mode words and the forced command above;
#   - the host layout: the clone at ~/tarubot with its .env; exactly two links in
#     ~/.config/containers/systemd, tarubot to ~/tarubot/ops/quadlet/units and tarubot-target to
#     ~/tarubot/ops/quadlet/<production|staging>; the unit tarubot.service and the container
#     tarubot; the pin, one unquoted TARUBOT_IMAGE_TAG=<version> and one
#     TARUBOT_IMAGE_DIGEST=sha256:<index digest> line in .env and no TARUBOT_IMAGE;
#   - the host lock /run/tarubot/host.lock (QUADLET_LOCK), a root-owned file from tmpfiles, opened
#     read-only and held with flock around every change, and its held-lock protocol: a caller
#     that already holds it runs the playbook with -e tarubot_host_lock_held=true, and the
#     playbook's own commands then don't lock it again (flock locks belong to an open file, so
#     they would wait on their caller);
#   - the CLIs, exit codes and output rules of ops/quadlet/check-env.sh (--syntax FILE, and the
#     environment mode run through systemd-run), ops/quadlet/secrets.sh (check|sync ENV [NAME...])
#     and ops/quadlet/run-tool.sh (TARGET DIGEST NAME COMMAND...);
#   - the Podman secret names and mount targets, SECRET_SETTINGS and UNSET_SETTINGS;
#   - what Quadlet's generator makes of the links, which q_quadlet_config checks before anything
#     stops: exactly one unit, ---tarubot.service---, whose ExecStart passes
#     --env-file %h/tarubot/ops/quadlet/units/tarubot.env and then
#     --env-file %h/tarubot/ops/quadlet/<target>/target.env, and ends with
#     ghcr.io/deconfined/tarubot@${TARUBOT_IMAGE_DIGEST}; and every file the generator loads, as
#     its "Loading source unit file" and "Loading source drop-in file" lines name them, comes from
#     units/ or <target>/;
#   - the container the unit makes, as q_hardened reads it back at preflight and after a start:
#     .HostConfig.ReadonlyRootfs true, no .HostConfig.CapAdd and no .EffectiveCaps,
#     no-new-privileges in .HostConfig.SecurityOpt, no .Mounts and no .HostConfig.Binds at all
#     (Podman shows the secrets only in .Config.Secrets), and no UNSET_SETTINGS name in
#     .Config.Env; and its health check, read as .State.Health.Status;
#   - the commands run in the bot's container (q_run_commands and q_register): on production
#     register.js --global; on staging register.js --guild "$TEST_GUILD_ID", with TEST_GUILD_ID
#     from the container's own environment (staging's target.env); then commands.js list;
#   - the labels PODMAN_SYSTEMD_UNIT=tarubot.service, io.tarubot.role=tool and
#     io.tarubot.role=backup; the backup unit tarubot-backup.service; and `ops/backup.sh quadlet`:
#     its argv, its exit status, its backup label and its last line (BACKUP_DONE);
#   - the journald evidence: Podman's start and died events for the container tarubot, and each
#     container's lines by CONTAINER_ID_FULL.
#
# An incompatible change to any of these replaces the word `quadlet` with a new one, so older
# copies refuse the target exactly (below-floor); a new feature adds its own word.
#
# The recovery rule also reads two of the bot's own log messages, both logged at info: "Modules
# loaded" (src/main.ts, before the bot asks for the writer lease) and "Database writer lease
# acquired" (src/application/lifecycle.ts). They are frozen. Bash has read this script before the
# clone moves to the target, so the live release's copy judges the new release's logs: a renamed
# message, or one logged below info, would let an older copy put the previous release back over
# the new one's writes. tests/unit/deploy-script.test.ts checks both sources.
set -Eeuo pipefail

# The oldest release whose ops/deploy.sh speaks this contract; older targets are refused.
readonly FLOOR=2.30.0
# The oldest release a Quadlet host may run (the Quadlet modes' own floor). The target must also
# declare the mode's words on its own CAPABILITIES line, in exactly this form.
readonly QUADLET_FLOOR=2.33.0
readonly CAPABILITIES="staging quadlet"
readonly CAPABILITY_LINE='^readonly CAPABILITIES="([a-z0-9]+( [a-z0-9]+)*)"$'
# Quadlet hosts: the root-owned host lock the playbook's tmpfiles line creates, which the 2.34.0
# pull unit will share, and Podman's generator, whose dry run shows what systemd will run.
readonly QUADLET_LOCK=/run/tarubot/host.lock
readonly GENERATOR=/usr/lib/systemd/system-generators/podman-system-generator
# The bot's secrets (sorted). On a Quadlet host they reach the bot as Podman secrets mounted as
# files, synced from .env before every start; src/config/secrets.ts, ops/quadlet/secrets.sh and
# tests/unit/quadlet.test.ts carry the same six.
readonly SECRET_SETTINGS='DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_REPORTS_TOKEN HEALTHCHECKS_PING_URL'
# What tarubot.service's [Service] UnsetEnvironment= drops after reading .env: ops/backup.sh's
# settings, the six secrets, and the other secret-bearing names a .env may hold. The unit, this
# list and ops/quadlet/run-tool.sh's must stay equal (tests/unit/quadlet.test.ts).
readonly UNSET_SETTINGS='BACKUP_STORAGE_ENDPOINT BACKUP_STORAGE_ACCESS_KEY BACKUP_STORAGE_SECRET_KEY BACKUP_STORAGE_REGION HEALTHCHECKS_BACKUP_URL DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_REPORTS_TOKEN HEALTHCHECKS_PING_URL POSTGRES_PASSWORD RESTORE_DATABASE_CA_CERT RESTORE_DATABASE_URL'
# The workflow job a staging run must have running (production's is "Deploy").
readonly STAGING_JOB='Deploy staging'
readonly REPO=deconfined/tarubot
readonly IMAGE=ghcr.io/deconfined/tarubot
# The one GitHub account whose approval of `production` authorizes a deploy, and who alone may
# dispatch a staging one, by login and by its numeric id, which a renamed or re-registered login
# can't take over.
readonly REVIEWER=deconfined
readonly REVIEWER_ID=71469756
readonly WORKFLOW=.github/workflows/deploy.yml
# The most workers that may run at once; a new run, or one starting over, beyond that is refused.
readonly MAX_WORKERS=4
readonly API=https://api.github.com
# The only PATH the entry and the worker use, whatever sshd passed.
readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin
readonly MAX_REQUEST=200
readonly VERSION='^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
# The v1 contract. deploy.yml carries the same three patterns (tests/unit/deploy-workflow.test.ts).
# Fields come from BASH_REMATCH: 1 is the version, 5 the commit, 6 the digest, 7 the run id and,
# for a rollback, 8 the live version it leaves.
readonly DEPLOY_FORM='^deploy ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19})$'
readonly ROLLBACK_FORM='^rollback ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19}) ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}))$'
readonly RESULT_FORM='^result outcome=(deployed|already-live|superseded|refused|recovered|needs-you) version=(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}) previous=((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})|-) path=(plain|migration|rollback|none) downtime=([0-9]{1,5}|-) commands=(registered|failed|skipped) backup=(daily/tarubot-[0-9]{8}T[0-9]{6}Z\.dump\.age|-) restore_point=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z|-) reason=([a-z0-9-]{1,40}|-)$'
readonly STEP_LINE='^step [a-z-]{1,20}$'
readonly WARNING_LINE='^warning [a-z0-9-]{1,40}$'
# Refusals that come before the approval is confirmed, and a worker that never started. Nothing
# happened in such a run, so the same request, or a new one for that run id, starts it over: a
# request sent before the approval, or a GitHub API failure, never blocks the approved run.
readonly RETRYABLE=' reason=(missing-tool|approval-unverified|not-approved|worker-not-started)$'
# The frozen log messages (see the header).
readonly LEASE_LINE='"msg":"Database writer lease acquired"'
readonly MODULES_LINE='"msg":"Modules loaded"'
# ops/backup.sh's last line names the object it uploaded to daily/ (either runtime).
readonly BACKUP_DONE='backup ok: tarubot-([0-9]{8}T[0-9]{6}Z) '

# ---------------------------------------------------------------------------------------------
# Output. The SSH client's stdout carries only what say prints; tool output goes to the logs.
# ---------------------------------------------------------------------------------------------

# The one writer of the client's stdout: the usage line (`say usage`), or a public line
# (`say line TEXT`) that matches one of the fixed forms. Anything else is dropped.
say() {
  if [[ $1 == usage ]]; then
    printf '%s\n' 'usage: deploy <version> <commit> <digest> <run> | rollback <version> <commit> <digest> <run> <from>'
    return 0
  fi
  if [[ $2 =~ $STEP_LINE || $2 =~ $WARNING_LINE || $2 =~ $RESULT_FORM ]]; then
    printf '%s\n' "$2"
  fi
}

# Print $2 when it is a valid token of kind $1, "-" when it is "-" and $3 is "dash", else "?".
token() {
  local pattern
  case $1 in
    version) pattern=$VERSION ;;
    int) pattern='^(0|[1-9][0-9]{0,4})$' ;;
    reason) pattern='^[a-z0-9-]{1,40}$' ;;
    step) pattern='^[a-z-]{1,20}$' ;;
    backup) pattern='^daily/tarubot-[0-9]{8}T[0-9]{6}Z\.dump\.age$' ;;
    stamp) pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' ;;
    *) pattern='^$' ;;
  esac
  if [[ -n $2 && $2 =~ $pattern ]] || [[ ${3-} == dash && $2 == - ]]; then
    printf '%s' "$2"
  else
    printf '?'
  fi
}

# A timestamped line in the current log: entry.log for the entry, worker.log for the worker.
log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2
}

# Append one public line to the run's public.log (the worker's only public output).
public() {
  printf '%s\n' "$1" >>"$RUN/public.log"
}

# Record the step the worker has reached, in the step file and the public log.
step() {
  printf '%s\n' "$1" >"$RUN/step"
  public "step $1"
  log "step $1"
}

# Write the result line (public) and then the result file, which ends the run. $1 is the outcome
# and $2 the reason token or "-"; the other fields come from the run's globals.
write_result() {
  local line
  line="result outcome=$1 version=$(token version "$V") previous=$(token version "$LIVE_V" dash)"
  line+=" path=$PATH_KIND downtime=$(token int "$DOWNTIME" dash) commands=$COMMANDS"
  line+=" backup=$(token backup "$BACKUP" dash) restore_point=$(token stamp "$RESTORE_POINT" dash)"
  line+=" reason=$(token reason "${2:--}" dash)"
  public "$line"
  printf '%s\n' "$1" >"$RUN/result.tmp"
  mv -f "$RUN/result.tmp" "$RUN/result"
  log "result: $1 (${2:--})"
}

# End the worker with a result. Its exit releases the run lock.
finish() {
  trap - ERR
  write_result "$1" "${2:--}"
  exit 0
}

# Nothing changed on the host. A clone already moved to the target goes back to the live commit.
refuse() {
  if ((STAGED)); then
    git reset --quiet --keep "$LIVE_C" || log "could not put the clone back at $LIVE_C"
    STAGED=0
  fi
  finish refused "$1"
}

# The host is in a state the owner has to look at; docs/HOSTING.md says what to do per reason.
needs_you() {
  finish needs-you "$1"
}

# A command failed where the script didn't expect it. In a subshell (a command substitution),
# only leave it; the caller sees the failure.
unexpected() {
  [[ $BASHPID == "${WORKER_PID-}" ]] || exit "$1"
  trap - ERR
  log "unexpected failure (status $1, line $2)"
  if ((CHANGED)); then needs_you unexpected-error; fi
  refuse unexpected-error
}

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

# Read the forced command's mode words (above) into MODE (compose, quadlet or staging), TARGET
# (production or staging), RT (the prefix of the runtime's functions: "" for Compose, q_ for
# Quadlet) and MODE_WORDS, which the entry hands to the worker. False for any other words.
set_mode() {
  if (($# == 0)); then
    MODE=compose TARGET=production RT=''
  elif (($# == 1)) && [[ $1 == quadlet ]]; then
    MODE=quadlet TARGET=production RT=q_
  elif (($# == 2)) && [[ $1 == quadlet && $2 == staging ]]; then
    MODE=staging TARGET=staging RT=q_
  else
    return 1
  fi
  MODE_WORDS=("$@")
}

# Parse one request (the whole SSH_ORIGINAL_COMMAND) into ACTION V C D R F; false if it isn't
# exactly one of the two forms. Runs under LC_ALL=C, so lengths are bytes and [0-9] is ASCII.
parse_request() {
  local req=$1
  ((${#req} <= MAX_REQUEST)) || return 1
  if [[ $req =~ $DEPLOY_FORM ]]; then
    ACTION=deploy V=${BASH_REMATCH[1]} C=${BASH_REMATCH[5]} D=${BASH_REMATCH[6]}
    R=${BASH_REMATCH[7]} F=-
  elif [[ $req =~ $ROLLBACK_FORM ]]; then
    ACTION=rollback V=${BASH_REMATCH[1]} C=${BASH_REMATCH[5]} D=${BASH_REMATCH[6]}
    R=${BASH_REMATCH[7]} F=${BASH_REMATCH[8]}
  else
    return 1
  fi
}

# True when version $1 is older than version $2 (both already match VERSION).
version_lt() {
  local -a a b
  local i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    ((a[i] == b[i])) && continue
    ((a[i] < b[i]))
    return
  done
  return 1
}

# What `git diff --name-status --no-renames LIVE C -- migrations/` (in $1) means: none, added
# (only new files, the migration path) or changed (an applied migration was edited or removed).
migration_kind() {
  local line
  if [[ -z $1 ]]; then
    printf none
    return 0
  fi
  while IFS= read -r line; do
    if [[ $line != A$'\t'migrations/* ]]; then
      printf changed
      return 0
    fi
  done <<<"$1"
  printf added
}

# The container logs are the writer-lease evidence, so they must be written at info or below.
# $1 is the .env value of LOG_LEVEL (empty when unset; Compose then uses info).
log_level_ok() {
  local value=$1
  value=${value#\"} value=${value%\"} value=${value#\'} value=${value%\'}
  case $value in "" | trace | debug | info) return 0 ;; *) return 1 ;; esac
}

# The restore point from migrate.js's output ($1): the lease time, normalized to UTC with
# microseconds; "-" when nothing was applied or the time can't be read.
restore_point() {
  local line raw stamp
  line=$(grep -m 1 '^Migration writer lease acquired at ' <<<"$1") || line=
  raw=${line#Migration writer lease acquired at }
  raw=${raw%%;*}
  if [[ -n $line ]] && stamp=$(date -u -d "$raw" +%Y-%m-%dT%H:%M:%S.%6NZ 2>/dev/null); then
    printf '%s' "$stamp"
  else
    printf -- -
  fi
}

# Day of week (1 is Monday) and hour, in UTC. Tests replace it.
now_utc() {
  date -u '+%u %H'
}

# The managed cluster's weekly maintenance: Tuesdays 19:00-23:00 UTC (docs/HOSTING.md).
in_maintenance_window() {
  local day hour
  read -r day hour < <(now_utc)
  [[ $day == 2 ]] && ((10#$hour >= 19 && 10#$hour < 23))
}

# One value from inspect JSON ($1, Docker's or Podman's) by jq filter $2; empty when null or
# unreadable.
field() {
  jq -r "($2) // empty" <<<"$1" 2>/dev/null || true
}

# The GitHub REST API, anonymously (the repository is public).
api() {
  curl -fsS --max-time 20 --retry 2 -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "$API/repos/$REPO/$1"
}

# docker compose on the production file in the clone, bounded by timeout(1): $1 is the limit in
# seconds. A TARUBOT_IMAGE_TAG set for the call overrides the .env pin (Compose prefers the
# environment), so nothing is pinned until the target has proven itself.
compose() {
  local limit=$1
  shift
  timeout "$limit" docker compose -f "$ROOT/docker-compose.production.yml" \
    --project-directory "$ROOT" "$@"
}

# Pin .env to release $1 (temporary file and rename, mode 600), as the manual procedure does.
# Multi-line quoted values such as the CA pass through unchanged.
pin_env() {
  local tmp
  tmp=$(mktemp "$ROOT/.env.XXXXXX") || return 1
  if ! awk -v v="$1" '/^TARUBOT_IMAGE_TAG=/ { print "TARUBOT_IMAGE_TAG=" v; next } { print }' \
    "$ROOT/.env" >"$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$ROOT/.env"; then
    rm -f "$tmp"
    return 1
  fi
  [[ $(grep -c '^TARUBOT_IMAGE_TAG=' "$ROOT/.env") == 1 ]] &&
    grep -qx "TARUBOT_IMAGE_TAG=$1" "$ROOT/.env"
}

# ---------------------------------------------------------------------------------------------
# Entry: parse, then start or attach to the run's worker and follow its public log.
# ---------------------------------------------------------------------------------------------

entry() {
  trap 'exit 1' ERR
  local req=${SSH_ORIGINAL_COMMAND-}
  if ! parse_request "$req"; then
    say usage
    log "refused request: $(printf '%s' "$req" | tr -c 'A-Za-z0-9 ._:-' '?' | cut -c1-200)"
    exit 64
  fi
  prune
  RUN=$STATE/runs/$R
  if [[ ! -d $RUN ]] && too_many_workers; then refuse_unstarted; fi
  mkdir -p "$RUN"
  exec 8>>"$RUN/lock"
  if flock -n 8; then
    if retryable "$RUN"; then
      if too_many_workers; then refuse_unstarted; fi
      start_over
    fi
    if [[ -f $RUN/request && $(<"$RUN/request") != "$req" ]]; then conflict; fi
    if [[ -f $RUN/result ]]; then
      exec 8>&-
      replay
    fi
    if [[ -f $RUN/step ]]; then
      worker_died
      exec 8>&-
      replay
    fi
    printf '%s\n' "$req" >"$RUN/request"
    : >>"$RUN/public.log"
    log "run $R: $ACTION $V started"
    launch
  elif [[ -f $RUN/request && $(<"$RUN/request") != "$req" ]]; then
    conflict
  fi
  exec 8>&-
  follow
}

# The run id already carries another request, and that run counts: it is running, or it got past
# the approval check. Refused like a malformed request.
conflict() {
  say usage
  log "run $R already carries a different request"
  exit 64
}

# True when MAX_WORKERS workers already hold their run locks (a run with no result whose lock
# is taken).
too_many_workers() {
  local dir count=0
  for dir in "$STATE"/runs/*/; do
    [[ -f ${dir}lock && ! -f ${dir}result ]] || continue
    if ! flock -n "${dir}lock" true; then count=$((count + 1)); fi
  done
  ((count >= MAX_WORKERS))
}

# Refuse a run while too many workers run, before it gets a run directory or a worker. Nothing
# changed, and the workflow reports the reason.
refuse_unstarted() {
  say line "result outcome=refused version=$V previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=too-many-runs"
  log "run $R: refused, $MAX_WORKERS workers already run"
  exit 1
}

# True when run directory $1 ended refused before its approval was confirmed (RETRYABLE).
retryable() {
  local line
  [[ -f $1/result && -f $1/public.log && $(<"$1/result") == refused ]] || return 1
  line=$(grep -E '^result ' "$1/public.log" | tail -n 1) || return 1
  [[ $line =~ $RESULT_FORM && $line =~ $RETRYABLE ]]
}

# Called while holding the run lock: clear a retryable run so it starts from the beginning, for
# the same request or a new one. worker.log keeps the earlier attempt.
start_over() {
  log "run $R: starting over after a refusal before the approval was confirmed"
  rm -f -- "$RUN/result" "$RUN/step" "$RUN/request"
  : >"$RUN/public.log"
}

# Start the worker in its own session, so it outlives this SSH session, with a clean environment:
# nothing sshd accepted reaches Compose's interpolation or Podman. It inherits fd 8 and so the run
# lock. The forced command's mode words follow the request's fields; with none (Compose), the
# worker gets exactly the seven arguments it always had.
launch() {
  env -i HOME="$HOME" PATH="$SAFE_PATH" LC_ALL=C \
    setsid -f "$SELF" __worker "$ACTION" "$V" "$C" "$D" "$R" "$F" "${MODE_WORDS[@]}" \
    </dev/null >>"$RUN/worker.log" 2>&1
}

# Print public.log's complete lines after byte OFFSET, and move OFFSET past them.
emit_new() {
  local line size
  [[ -f $RUN/public.log ]] || return 0
  # A run that started over has a new, shorter log: read it from its beginning.
  size=$(stat -c %s "$RUN/public.log") || return 0
  if ((size < OFFSET)); then OFFSET=0; fi
  while IFS= read -r line; do
    say line "$line"
    OFFSET=$((OFFSET + ${#line} + 1))
  done < <(tail -c "+$((OFFSET + 1))" "$RUN/public.log")
}

# Exit by the run's outcome: 0 when production runs the requested release (or a newer one).
exit_by_result() {
  case $(<"$RUN/result") in
    deployed | already-live | superseded) exit 0 ;;
    *) exit 1 ;;
  esac
}

# The run is over: print its whole public log and exit by its outcome.
replay() {
  OFFSET=0
  emit_new
  exit_by_result
}

# Follow a running worker's public log every 2 s until its result. A free run lock with no result
# means the worker is gone.
follow() {
  OFFSET=0
  while :; do
    emit_new
    if [[ -f $RUN/result ]]; then
      emit_new
      exit_by_result
    fi
    exec 7>>"$RUN/lock"
    if flock -n 7; then
      [[ -f $RUN/result ]] || worker_died
      exec 7>&-
      emit_new
      exit_by_result
    fi
    exec 7>&-
    sleep 2
  done
}

# Called while holding the run lock, with no result: a worker that wrote a step died (a host
# reboot, the OOM killer, a kill) and the owner finishes by hand (docs/HOSTING.md, "When the
# worker dies"). Without a step file it never started, so nothing changed.
worker_died() {
  local last
  LIVE_V=- PATH_KIND=none DOWNTIME=- COMMANDS=skipped BACKUP=- RESTORE_POINT=-
  if [[ -f $RUN/step ]]; then
    last=$(<"$RUN/step")
    public "step $(token step "$last")"
    write_result needs-you worker-died
  else
    write_result refused worker-not-started
  fi
}

# Remove finished runs after 90 days, and retryable ones (nothing happened in them) after 10
# minutes; entry.log keeps a line for each run's start.
prune() {
  local dir
  while IFS= read -r -d '' dir; do
    [[ -f $dir/result ]] || continue
    if retryable "$dir" || [[ -n $(find "$dir" -maxdepth 0 -mtime +90) ]]; then rm -rf -- "$dir"; fi
  done < <(find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -mmin +10 -print0)
}

# Keep entry.log to its last megabyte.
trim_log() {
  local file=$STATE/entry.log
  if [[ -f $file ]] && (($(stat -c %s "$file") > 1048576)); then
    tail -c 1048576 "$file" >"$file.tmp" && mv -f "$file.tmp" "$file"
  fi
}

# ---------------------------------------------------------------------------------------------
# Worker: preflight (nothing changes), classification, then one path.
# ---------------------------------------------------------------------------------------------

worker() {
  local req="$1 $2 $3 $4 $5"
  # The request's six fields, then the forced command's mode words (none for Compose).
  (($# >= 6 && $# <= 8)) || exit 64
  set_mode "${@:7}" || exit 64
  if [[ $1 == rollback ]]; then req+=" $6"; elif [[ $6 != - ]]; then exit 64; fi
  parse_request "$req" || exit 64
  [[ $ACTION == "$1" ]] || exit 64
  RUN=$STATE/runs/$R
  [[ -d $RUN ]] || exit 64
  exec 2>>"$RUN/worker.log"
  # fd 8 is the run lock, inherited from the entry: the same open file, so this is a no-op.
  if ! { : >&8; } 2>/dev/null || ! flock -n 8; then
    log "the run lock is not held"
    exit 70
  fi
  WORKER_PID=$BASHPID
  LIVE_V=- LIVE_C='' LIVE_IMAGE='' CID='' PROJECT='' PIN='' TARGET_ID=''
  LIVE_CID='' PIN_DIGEST='' MARK='' START_FAILED=0
  PATH_KIND=none DOWNTIME=- COMMANDS=skipped BACKUP=- RESTORE_POINT=-
  STAGED=0 CHANGED=0 CLOCK=$SECONDS
  trap 'unexpected "$?" "$LINENO"' ERR
  cd "$ROOT"
  step preflight
  preflight
  classify
  # The run is checked again just before the first change: a cancel, or a deploy job that ended,
  # during the waits, the fetch and the pull stops the worker while nothing has changed. RT picks
  # the runtime's own function by its name ("" for Compose, q_ for Quadlet); no text is run.
  case $PATH_KIND in
    none)
      check_run_active
      "${RT}already_live"
      ;;
    plain | rollback)
      "${RT}stage"
      check_run_active
      "${RT}restart_path"
      ;;
    migration)
      "${RT}stage"
      check_run_active
      "${RT}migration_path"
      ;;
  esac
  needs_you unexpected-error
}

# The host lock keeps deploys (and, on a Quadlet host, the playbook's user-manager commands) from
# overlapping. Compose keeps its lock in the state directory. A Quadlet host's lock is the
# root-owned /run/tarubot/host.lock, which the 2.34.0 pull unit, running as root, will hold around
# the playbook: it must never open a file tarubot could replace, so it isn't under this user's
# home, and this script opens it read-only (flock needs no write access).
preflight() {
  check_approval
  if [[ $MODE == compose ]]; then
    exec 9>>"$STATE/lock"
  else
    q_lock_trusted "$HOST_LOCK" || refuse host
    exec 9<"$HOST_LOCK" || refuse host
  fi
  flock -w 300 9 || refuse busy
  check_clone
  "${RT}check_env"
  "${RT}check_host"
  "${RT}read_live"
  "${RT}wait_for_backup"
  "${RT}check_target"
}

# The run must be this repository's deploy.yml, active on main, first attempt, titled with exactly
# this target, and the mode's deploy job must be running (after that job fails, the run stays in
# progress while notify runs). Unreadable answers fail closed.
#   - Production modes (Compose and quadlet) need the run in_progress, a dispatch titled
#     "Deploy <V>" or "Deploy <V> rollback from <F>", and the Deploy job running.
#   - Staging needs a dispatch title ending " to staging" and the "Deploy staging" job running,
#     and accepts the run status `waiting` too: in an automatic run, production's Deploy job may
#     wait for its approval while staging's runs, and GitHub may then report the whole run as
#     waiting. The job, path, branch, repository, attempt and title checks stay decisive. A staging
#     dispatch must also come from the owner (check_dispatcher).
# An automatic run (workflow_run) is titled "Deploy <commit>" in every mode and only deploys.
check_run_active() {
  local run jobs title also=in_progress
  run=$(api "actions/runs/$R") || refuse approval-unverified
  jobs=$(api "actions/runs/$R/jobs") || refuse approval-unverified
  jq -e 'type == "object"' <<<"$run" >/dev/null 2>&1 || refuse approval-unverified
  jq -e '.jobs | type == "array"' <<<"$jobs" >/dev/null 2>&1 || refuse approval-unverified
  if [[ $ACTION == rollback ]]; then title="Deploy $V rollback from $F"; else title="Deploy $V"; fi
  if [[ $MODE == staging ]]; then
    title+=" to staging"
    also=waiting
  fi
  jq -e --arg wf "$WORKFLOW" --arg repo "$REPO" --arg action "$ACTION" --arg commit "$C" \
    --arg title "$title" --arg also "$also" '
      .path == $wf and .head_branch == "main" and .head_repository.full_name == $repo
      and (.status == "in_progress" or .status == $also) and .run_attempt == 1
      and ((.event == "workflow_run" and $action == "deploy" and .display_title == ("Deploy " + $commit))
        or (.event == "workflow_dispatch" and .display_title == $title))' \
    <<<"$run" >/dev/null 2>&1 || refuse not-approved
  if [[ $MODE == staging ]]; then
    check_dispatcher "$run"
    jq -e --arg job "$STAGING_JOB" 'any(.jobs[]; .name == $job and .status == "in_progress")' \
      <<<"$jobs" >/dev/null 2>&1 || refuse not-approved
  else
    jq -e 'any(.jobs[]; .name == "Deploy" and .status == "in_progress")' \
      <<<"$jobs" >/dev/null 2>&1 || refuse not-approved
  fi
}

# Staging has no approval, so a dispatch ($1 is the run's answer) must come from the owner: both
# the account the run belongs to (actor) and the one that started this attempt (triggering_actor),
# by login and numeric id. That refuses a dispatch by a GitHub App or GITHUB_TOKEN too. An
# automatic run follows a successful publish of main, which the workflow's plan checks.
check_dispatcher() {
  jq -e --arg who "$REVIEWER" --argjson id "$REVIEWER_ID" '
      .event == "workflow_run"
      or (.event == "workflow_dispatch"
        and .actor.login == $who and .actor.id == $id
        and .triggering_actor.login == $who and .triggering_actor.id == $id)' \
    <<<"$1" >/dev/null 2>&1 || refuse not-approved
}

# The run is active (above) and, on production, the owner approved it for production, matched by
# login and numeric id. Staging has no approval to query.
check_approval() {
  local approvals
  if ! command -v jq >/dev/null || ! command -v curl >/dev/null; then refuse missing-tool; fi
  check_run_active
  if [[ $MODE == staging ]]; then
    log "run $R: an automatic run, or dispatched by $REVIEWER, for staging"
    return 0
  fi
  approvals=$(api "actions/runs/$R/approvals") || refuse approval-unverified
  jq -e 'type == "array"' <<<"$approvals" >/dev/null 2>&1 || refuse approval-unverified
  jq -e --arg who "$REVIEWER" --argjson id "$REVIEWER_ID" '
      any(.[]; .state == "approved" and .user.login == $who and .user.id == $id
        and any(.environments[]?; .name == "production"))' \
    <<<"$approvals" >/dev/null 2>&1 || refuse not-approved
  log "run $R: approved by $REVIEWER for production"
}

# The clone must be on main with no tracked change, as the manual procedure leaves it.
check_clone() {
  local branch dirty
  branch=$(git symbolic-ref --quiet --short HEAD) || refuse clone-not-clean
  dirty=$(git status --porcelain --untracked-files=no) || refuse clone-not-clean
  [[ $branch == main && -z $dirty ]] || refuse clone-not-clean
}

# .env: a private regular file with exactly one plain pin, no image override, and a log level
# that keeps the lease evidence.
check_env() {
  local pins level
  [[ -f .env && ! -L .env ]] || refuse env-file
  [[ $(stat -c %a .env) == 600 ]] || refuse env-file
  pins=$(grep -c '^TARUBOT_IMAGE_TAG=' .env) || pins=0
  PIN=$(sed -n 's/^TARUBOT_IMAGE_TAG=//p' .env)
  [[ $pins == 1 && $PIN =~ $VERSION ]] || refuse env-file
  if grep -q '^TARUBOT_IMAGE=.' .env; then refuse env-file; fi
  level=$(sed -n 's/^LOG_LEVEL=//p' .env | tail -n 1)
  log_level_ok "$level" || refuse log-level
}

# Docker answers (every bare docker call is bounded by timeout(1), as compose() is, so a hung
# daemon takes the caller's failure branch) and / has 2 GB free.
check_host() {
  local avail
  timeout 60 docker info >/dev/null 2>&1 || refuse host
  avail=$(df --output=avail -B1 / | tail -n 1 | tr -d ' ') || refuse host
  if ! [[ $avail =~ ^[0-9]+$ ]] || ((avail < 2147483648)); then refuse host; fi
}

# The live release: the one tarubot container, running (or restarting), its labels, and the pin.
read_live() {
  local ids json status
  ids=$(compose 60 ps -a -q tarubot) || refuse host
  [[ $ids =~ ^[0-9a-f]{12,64}$ ]] || refuse bot-not-running
  CID=$ids
  json=$(timeout 60 docker inspect "$CID") || refuse bot-not-running
  status=$(field "$json" '.[0].State.Status')
  [[ $status == running || $status == restarting ]] || refuse bot-not-running
  LIVE_V=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]')
  LIVE_C=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]')
  LIVE_IMAGE=$(field "$json" '.[0].Image')
  PROJECT=$(field "$json" '.[0].Config.Labels["com.docker.compose.project"]')
  if ! [[ $LIVE_V =~ $VERSION && $LIVE_C =~ ^[0-9a-f]{40}$ &&
    $LIVE_IMAGE =~ ^sha256:[0-9a-f]{64}$ && $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    LIVE_V=-
    refuse live-unknown
  fi
  [[ $PIN == "$LIVE_V" ]] || refuse manual-change-in-progress
}

# Wait up to 300 s for a running `backup` container (the nightly dump, about 6 s, or one run by
# hand). The waits here and on the host lock stay short so that a slow run still reports to the
# workflow before its reconnect deadline.
wait_for_backup() {
  local i running
  for ((i = 0; i <= 30; i++)); do
    running=$(timeout 60 docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter label=com.docker.compose.service=backup) || refuse host
    [[ -z $running ]] && return 0
    ((i < 30)) && sleep 10
  done
  refuse busy
}

# The target commit is on main and carries the requested version, at or above the floor.
check_target() {
  local version
  timeout 120 git fetch --quiet origin main || refuse fetch-failed
  git merge-base --is-ancestor "$C" origin/main || refuse not-on-main
  version=$(git show "$C:package.json" | jq -r .version) || refuse version-mismatch
  [[ $version == "$V" ]] || refuse version-mismatch
  if version_lt "$V" "$FLOOR"; then refuse below-floor; fi
}

# Git alone decides the path: a healthy live container proves the schema matches LIVE_C's.
classify() {
  local changes
  if [[ $ACTION == deploy ]]; then
    if version_lt "$V" "$LIVE_V"; then finish superseded; fi
    if [[ $V == "$LIVE_V" ]]; then
      [[ $C == "$LIVE_C" ]] || refuse commit-mismatch
      return 0
    fi
    git merge-base --is-ancestor "$LIVE_C" "$C" || refuse not-descendant
    changes=$(git diff --name-status --no-renames "$LIVE_C" "$C" -- migrations/) ||
      refuse not-descendant
    case $(migration_kind "$changes") in
      none) PATH_KIND=plain ;;
      added) PATH_KIND=migration ;;
      *) refuse applied-migration-changed ;;
    esac
  else
    [[ $LIVE_V == "$F" ]] || refuse live-changed
    version_lt "$V" "$LIVE_V" || refuse rollback-not-older
    git diff --quiet "$C" "$LIVE_C" -- migrations/ || refuse rollback-across-migration
    PATH_KIND=rollback
  fi
}

# Pull the target without pinning it, prove it is the approved digest, and move the clone to it.
stage() {
  local json
  step pull
  TARUBOT_IMAGE_TAG=$V compose 600 pull --quiet tarubot || refuse pull-failed
  json=$(timeout 60 docker image inspect "$IMAGE:$V") || refuse digest-mismatch
  jq -e --arg digest "$IMAGE@$D" '.[0].RepoDigests | any(.[]; . == $digest)' \
    <<<"$json" >/dev/null 2>&1 || refuse digest-mismatch
  [[ $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$V" &&
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') == "$C" ]] ||
    refuse label-mismatch
  TARGET_ID=$(field "$json" '.[0].Id')
  [[ $TARGET_ID =~ ^sha256:[0-9a-f]{64}$ ]] || refuse label-mismatch
  git reset --quiet --keep "$C" || refuse clone-reset
  STAGED=1
  # A new required ${VAR:?} that the host's .env lacks stops here, before anything stops.
  TARUBOT_IMAGE_TAG=$V compose 60 config --quiet || refuse compose-config
}

# The running release is the target: check its health and register its commands.
already_live() {
  local json
  json=$(timeout 60 docker inspect "$CID") || needs_you live-unhealthy
  [[ $(field "$json" '.[0].State.Health.Status') == healthy ]] || needs_you live-unhealthy
  commands_then already-live
}

# No migration: Compose replaces the container (the old bot stops first and frees the lease).
# Every `up` names the tarubot service: a profile-gated service added later (such as the v3 web
# proxy, issue #43) never starts with, or fails, a bot deploy. Today it is equivalent to a bare `up`.
restart_path() {
  step up
  CHANGED=1
  CLOCK=$SECONDS
  if TARUBOT_IMAGE_TAG=$V compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    verify_started
    commands_then deployed
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  recover_restart
}

# Migration files added: stop, back up, migrate in the new image, start.
migration_path() {
  local out ok=0
  if in_maintenance_window; then
    public "warning db-maintenance-window"
    log "the migration runs during the cluster's Tuesday maintenance window"
  fi
  step stop
  CHANGED=1
  CLOCK=$SECONDS
  compose 90 stop tarubot || restore_previous stop-failed previous-failed
  step backup
  if out=$(timeout 900 "$ROOT/ops/backup.sh"); then ok=1; fi
  log "ops/backup.sh: ${out//$'\n'/ | }"
  if ((ok)) && [[ $out =~ $BACKUP_DONE ]]; then
    BACKUP=daily/tarubot-${BASH_REMATCH[1]}.dump.age
  else
    restore_previous backup-failed previous-failed
  fi
  step migrate
  ok=0
  if out=$(TARUBOT_IMAGE_TAG=$V compose 600 run --rm --no-deps -T tarubot bun dist/scripts/migrate.js); then
    ok=1
  fi
  log "migrate.js: ${out//$'\n'/ | }"
  if ((ok)) && [[ $'\n'$out$'\n' == *$'\nSchema ready.\n'* ]]; then
    RESTORE_POINT=$(restore_point "$out")
    # The old image can't run on the new schema, so the pin moves at once.
    pin_env "$V" || needs_you pin-failed
    step migrated
  else
    stop_one_offs
    restore_previous migration-failed migration-may-have-committed
  fi
  step up
  if compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    verify_started
    commands_then deployed
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you new-release-failed
}

# A migrate.js left running (the timeout) holds its transaction open; stopping it rolls it back.
stop_one_offs() {
  local ids
  local -a list
  ids=$(timeout 60 docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.oneoff=True \
    --filter label=com.docker.compose.service=tarubot) || ids=
  if [[ -n $ids ]]; then
    mapfile -t list <<<"$ids"
    timeout 60 docker stop "${list[@]}" || log "could not stop the migrate.js container"
  fi
}

# `up --wait` passed, so the target answered readiness and held the writer lease. It must be the
# approved image and still be healthy a minute later; either way .env pins it now.
verify_started() {
  local json restarts
  CID=$(compose 60 ps -a -q tarubot) || CID=
  json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
  if [[ $(field "$json" '.[0].Image') != "$TARGET_ID" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') != "$V" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') != "$C" ]]; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you image-mismatch
  fi
  restarts=$(field "$json" '.[0].RestartCount')
  sleep 60
  json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
  if [[ $(field "$json" '.[0].RestartCount') != "$restarts" ||
    $(field "$json" '.[0].State.Status') != running ||
    $(field "$json" '.[0].State.Health.Status') != healthy ]]; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you unstable
  fi
  pin_env "$V" || needs_you pin-failed
}

# Register the release's commands globally and read them back (the token stays on the host).
run_commands() {
  step commands
  if compose 120 exec -T tarubot bun dist/scripts/register.js --global &&
    compose 180 exec -T tarubot bun dist/scripts/commands.js list; then
    COMMANDS=registered
    return 0
  fi
  COMMANDS=failed
  return 1
}

# Finish with outcome $1 once the commands are registered, or ask for a retry.
commands_then() {
  if "${RT}run_commands"; then finish "$1"; fi
  needs_you commands-failed
}

# What Compose shows for the tarubot service after a failed start. TC_STATE is "none" (ps lists
# no container), "previous" (exactly one, on the live release's image), "target" (exactly one, on
# the target's image) or "unknown": ps or inspect failed, several containers (Compose stopped in
# the middle of a recreate), or another image. TC_ID names the container for previous and target.
target_container() {
  local ids json image
  TC_STATE=unknown TC_ID=''
  ids=$(compose 60 ps -a -q tarubot) || return 0
  if [[ -z $ids ]]; then
    TC_STATE=none
    return 0
  fi
  [[ $ids =~ ^[0-9a-f]{12,64}$ ]] || return 0
  json=$(timeout 60 docker inspect "$ids" 2>/dev/null) || return 0
  image=$(field "$json" '.[0].Image')
  if [[ -n $image && $image == "$TARGET_ID" ]]; then
    TC_STATE=target TC_ID=$ids
  elif [[ -n $image && $image == "$LIVE_IMAGE" ]]; then
    TC_STATE=previous TC_ID=$ids
  fi
}

# The writer-lease evidence for the target's container $1: EV_LEASE counts "Database writer lease
# acquired" lines, and EV_COMPLETE says the logs were readable and reached "Modules loaded", which
# main.ts logs before it can ask for the lease. No container id is incomplete evidence.
evidence() {
  local logs
  EV_LEASE=0 EV_COMPLETE=0
  [[ -n $1 ]] || return 0
  logs=$(timeout 60 docker logs "$1" 2>&1) || return 0
  EV_COMPLETE=1
  EV_LEASE=$(grep -c -F "$LEASE_LINE" <<<"$logs") || EV_LEASE=0
  grep -q -F "$MODULES_LINE" <<<"$logs" || EV_COMPLETE=0
  log "evidence for $1: $EV_LEASE lease lines, complete=$EV_COMPLETE"
}

# The restart or rollback did not come up. The previous release returns only when the target
# never got a container, or its container provably never held the writer lease. Otherwise the
# target stays for the owner, with .env pinned to it when Compose showed its container; when
# Compose showed no single container of either release, nothing is guessed and nothing is pinned.
recover_restart() {
  target_container
  case $TC_STATE in
    none | previous) restore_previous did-not-start previous-failed ;;
    target) ;;
    *)
      log "Compose showed no single container of either release; nothing restored or pinned"
      needs_you lease-evidence-incomplete
      ;;
  esac
  evidence "$TC_ID"
  if ((!EV_COMPLETE)); then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you lease-evidence-incomplete
  fi
  if ((EV_LEASE > 0)); then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you new-release-took-lease
  fi
  if ! compose 90 stop tarubot; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you lease-evidence-incomplete
  fi
  # Count again: the lease may have come between the first count and the stop.
  evidence "$TC_ID"
  if ((!EV_COMPLETE || EV_LEASE > 0)); then
    TARUBOT_IMAGE_TAG=$V compose 300 up -d tarubot || log "could not start $V again"
    pin_env "$V" || log "could not pin .env to $V"
    if ((EV_LEASE > 0)); then needs_you new-release-took-lease; fi
    needs_you lease-evidence-incomplete
  fi
  restore_previous did-not-start previous-failed
}

# Put the previous release back: the clone at its commit, the unchanged .env, `up --wait`, and
# the previous image healthy. Its own Compose file decides what runs (--remove-orphans drops a
# service only the target's file had). $1 is the reason when it is back, $2 when it isn't.
restore_previous() {
  local json
  git reset --quiet --keep "$LIVE_C" || log "could not put the clone back at $LIVE_C"
  STAGED=0
  if compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    CID=$(compose 60 ps -a -q tarubot) || CID=
    json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
    if [[ $(field "$json" '.[0].Image') == "$LIVE_IMAGE" &&
      $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$LIVE_V" &&
      $(field "$json" '.[0].State.Health.Status') == healthy ]]; then
      finish recovered "$1"
    fi
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you "$2"
}

# ---------------------------------------------------------------------------------------------
# Quadlet worker (`quadlet`, `quadlet staging`): the same steps on a rootless Quadlet host. Each
# q_ function below is the twin of the Compose function without the prefix, or a helper only this
# path needs. They call podman, systemctl --user, journalctl --user, systemd-run --user and the
# generator, each bounded by timeout(1), and never docker or Compose; nothing here connects to a
# remote Podman or its API socket. The Compose-path cleanup release deletes the Compose twins.
# ---------------------------------------------------------------------------------------------

# The runtime directory systemd gives the user (RUNTIME_ROOT is /run/user; tests use a sandbox).
q_runtime_dir() {
  printf '%s/%s' "$RUNTIME_ROOT" "$(id -u)"
}

# True when systemd keeps this user's manager running without a login (lingering), which the
# health-check timers, the unit's start at boot and systemctl --user need.
q_lingering() {
  [[ -e $LINGER_DIR/$USER ]]
}

# True when $1 is a lock file only root could have put there: a regular file, not a link, owned by
# uid 0 (tmpfiles creates it in the root-owned /run/tarubot).
q_lock_trusted() {
  [[ -f $1 && ! -L $1 && $(stat -c %u "$1") == 0 ]]
}

# The user's session, derived here because env -i cleared it, and exported so that podman,
# systemctl, journalctl, systemd-run and the release's scripts inherit it. Without it rootless
# Podman uses another runroot and sees no containers, and systemctl --user can't reach the user
# manager. The runtime directory must be the user's own, mode 700.
q_session() {
  local dir
  USER=$(id -un) || return 1
  dir=$(q_runtime_dir) || return 1
  [[ -d $dir && ! -L $dir && $(stat -c '%u %a' "$dir") == "$(id -u) 700" ]] || return 1
  export USER XDG_RUNTIME_DIR=$dir DBUS_SESSION_BUS_ADDRESS=unix:path=$dir/bus
}

# .env: a private regular file with exactly one plain tag pin and one plain digest pin (the image
# index digest), no image override, no file form of a secret (the release fixes where the bot
# reads them; .env holds the values), and a log level that keeps the lease evidence.
q_check_env() {
  local count level name
  [[ -f .env && ! -L .env ]] || refuse env-file
  [[ $(stat -c %a .env) == 600 ]] || refuse env-file
  count=$(grep -c '^TARUBOT_IMAGE_TAG=' .env) || count=0
  PIN=$(sed -n 's/^TARUBOT_IMAGE_TAG=//p' .env)
  [[ $count == 1 && $PIN =~ $VERSION ]] || refuse env-file
  count=$(grep -c '^TARUBOT_IMAGE_DIGEST=' .env) || count=0
  PIN_DIGEST=$(sed -n 's/^TARUBOT_IMAGE_DIGEST=//p' .env)
  [[ $count == 1 && $PIN_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || refuse env-file
  if grep -q '^TARUBOT_IMAGE=.' .env; then refuse env-file; fi
  for name in $SECRET_SETTINGS; do
    if grep -q "^${name}_FILE=" .env; then refuse env-file; fi
  done
  level=$(sed -n 's/^LOG_LEVEL=//p' .env | tail -n 1)
  log_level_ok "$level" || refuse log-level
}

# The host is the one the mode names, set up as the playbook leaves it:
#   - the session (above), and the clone at ~/tarubot, where the unit's %h paths look;
#   - Podman answers, with journald as its event logger (the evidence reads it);
#   - the user manager answers (running, or degraded by a failed unit such as a backup), and the
#     user lingers;
#   - no Podman API socket, and the user journal returns an entry;
#   - 2 GB free where Podman keeps images (rootless storage lives under the home, not on /);
#   - exactly the mode's two links in ~/.config/containers/systemd.
q_check_host() {
  local logger state graph avail
  q_session || refuse host
  [[ $(readlink -f "$HOME/tarubot") == "$(readlink -f "$ROOT")" ]] || refuse host
  logger=$(timeout 60 podman info --format '{{.Host.EventLogger}}' 2>/dev/null) || refuse host
  [[ $logger == journald ]] || refuse host
  state=$(timeout 60 systemctl --user show -p SystemState --value 2>/dev/null) || refuse host
  [[ $state == running || $state == degraded ]] || refuse host
  q_lingering || refuse host
  [[ ! -e $XDG_RUNTIME_DIR/podman/podman.sock ]] || refuse host
  timeout 60 journalctl --user -n 1 -o json --no-pager 2>/dev/null |
    jq -e 'type == "object"' >/dev/null 2>&1 || refuse host
  graph=$(timeout 60 podman info --format '{{.Store.GraphRoot}}' 2>/dev/null) || refuse host
  [[ $graph == /* ]] || refuse host
  avail=$(df --output=avail -B1 "$graph" | tail -n 1 | tr -d ' ') || refuse host
  if ! [[ $avail =~ ^[0-9]+$ ]] || ((avail < 2147483648)); then refuse host; fi
  q_links_ok || refuse host
}

# Exactly two entries in ~/.config/containers/systemd, both links into the clone: tarubot to
# ops/quadlet/units and tarubot-target to ops/quadlet/<target>. A copy instead of a link would go
# stale on the next release; a second target, or anything else there, would reach the generator.
q_links_ok() {
  local dir=$HOME/.config/containers/systemd names
  names=$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort) || return 1
  [[ $names == $'tarubot\ntarubot-target' && -L $dir/tarubot && -L $dir/tarubot-target ]] ||
    return 1
  [[ $(readlink -f "$dir/tarubot") == "$(readlink -f "$ROOT/ops/quadlet/units")" ]] || return 1
  [[ $(readlink -f "$dir/tarubot-target") == "$(readlink -f "$ROOT/ops/quadlet/$TARGET")" ]]
}

# tarubot.service's ActiveState and SubState, as "active running"; false when unreadable.
q_unit_state() {
  local out active sub
  out=$(timeout 60 systemctl --user show -p ActiveState -p SubState tarubot.service) || return 1
  active=$(sed -n 's/^ActiveState=//p' <<<"$out")
  sub=$(sed -n 's/^SubState=//p' <<<"$out")
  [[ $active =~ ^[a-z-]+$ && $sub =~ ^[a-z-]+$ ]] || return 1
  printf '%s %s' "$active" "$sub"
}

# The container's hardening reads back as the unit declares it (container inspect JSON in $1): a
# read-only root, no added and no effective capabilities, no-new-privileges, no bind or volume
# mount at all, and none of UNSET_SETTINGS in its environment. It catches a containers.conf
# default the generator's output can't show. Podman lists secret mounts only in .Config.Secrets,
# never in .Mounts or .HostConfig.Binds (tests/fixtures/deploy-podman), so any mount there, even
# one at /run/secrets/<name>, is something else: a host path that could stand in for a secret.
q_hardened() {
  jq -e --arg unset "$UNSET_SETTINGS" '
      ($unset | split(" ")) as $names | .[0]
      | .HostConfig.ReadonlyRootfs == true
        and ((.HostConfig.CapAdd // []) | length == 0)
        and ((.EffectiveCaps // []) | length == 0)
        and any(.HostConfig.SecurityOpt[]?; . == "no-new-privileges")
        and ((.Mounts // []) | length == 0)
        and ((.HostConfig.Binds // []) | length == 0)
        and all(.Config.Env[]?; split("=")[0] as $name | any($names[]; . == $name) | not)' \
    <<<"$1" >/dev/null 2>&1
}

# The live release: tarubot.service active, or activating (systemd between restarts, Compose's
# `restarting`) after one re-read; the pinned image's labels, which the tag pin must match; and the
# unit's one container, running on the pinned image with its hardening. While the unit is
# activating there may be no container, and the pinned image alone names the live release.
q_read_live() {
  local state ids json
  state=$(q_unit_state) || refuse host
  if [[ $state == activating\ * ]]; then
    sleep 5
    state=$(q_unit_state) || refuse host
  fi
  [[ $state == active\ * || $state == activating\ * ]] || refuse bot-not-running
  json=$(timeout 60 podman image inspect "$IMAGE@$PIN_DIGEST" 2>/dev/null) || refuse live-unknown
  LIVE_V=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]')
  LIVE_C=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]')
  LIVE_IMAGE=$(field "$json" '.[0].Id')
  if ! [[ $LIVE_V =~ $VERSION && $LIVE_C =~ ^[0-9a-f]{40}$ && $LIVE_IMAGE =~ ^[0-9a-f]{64}$ ]]; then
    LIVE_V=-
    refuse live-unknown
  fi
  [[ $PIN == "$LIVE_V" ]] || refuse manual-change-in-progress
  ids=$(timeout 60 podman ps -a -q --no-trunc --filter label=PODMAN_SYSTEMD_UNIT=tarubot.service) ||
    refuse host
  if [[ -z $ids && $state == activating\ * ]]; then
    log "tarubot.service is $state with no container; the pinned image names the live release"
    return 0
  fi
  [[ $ids =~ ^[0-9a-f]{64}$ ]] || refuse bot-not-running
  LIVE_CID=$ids
  json=$(timeout 60 podman container inspect "$LIVE_CID") || refuse bot-not-running
  [[ $(field "$json" '.[0].State.Status') == running ]] || refuse bot-not-running
  [[ $(field "$json" '.[0].Image') == "$LIVE_IMAGE" ]] || refuse manual-change-in-progress
  q_hardened "$json" || refuse hardening-mismatch
}

# Wait up to 300 s while a backup runs: its dump container (labelled io.tarubot.role=backup) or
# the nightly tarubot-backup.service, which is `activating` while its one-shot runs. Any other
# answer from is-active (inactive, failed, an unknown unit, or its failure) means no backup.
q_wait_for_backup() {
  local i running active
  for ((i = 0; i <= 30; i++)); do
    running=$(timeout 60 podman ps -q --filter label=io.tarubot.role=backup) || refuse host
    active=$(timeout 60 systemctl --user is-active tarubot-backup.service 2>/dev/null) || true
    [[ -z $running && $active != active && $active != activating ]] && return 0
    ((i < 30)) && sleep 10
  done
  refuse busy
}

# Compose's checks, then the Quadlet contract: the target is at or above QUADLET_FLOOR and its
# own ops/deploy.sh declares every word of this mode on its CAPABILITIES line (a comment or any
# other form doesn't count). The words, never a copied number, say what the target speaks.
q_check_target() {
  local line words word
  check_target
  if version_lt "$V" "$QUADLET_FLOOR"; then refuse below-floor; fi
  line=$(git show "$C:ops/deploy.sh" 2>/dev/null | grep -E "$CAPABILITY_LINE") ||
    refuse below-floor
  [[ $line =~ $CAPABILITY_LINE ]] || refuse below-floor
  words=" ${BASH_REMATCH[1]} "
  for word in "${MODE_WORDS[@]}"; do
    [[ $words == *" $word "* ]] || refuse below-floor
  done
  log "target $V declares:$words(this copy: $CAPABILITIES)"
}

# Pull the target by the approved digest without pinning it, prove its labels, and move the clone
# to it. Then, before anything stops, the target's own configuration must hold on this host: what
# the generator makes of the links, and the settings (the protection `compose config` gives).
# Either refusal puts the clone back.
q_stage() {
  local json
  step pull
  timeout 600 podman pull --quiet "$IMAGE@$D" || refuse pull-failed
  json=$(timeout 60 podman image inspect "$IMAGE@$D") || refuse digest-mismatch
  jq -e --arg digest "$IMAGE@$D" '.[0].RepoDigests | any(.[]; . == $digest)' \
    <<<"$json" >/dev/null 2>&1 || refuse digest-mismatch
  [[ $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$V" &&
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') == "$C" ]] ||
    refuse label-mismatch
  TARGET_ID=$(field "$json" '.[0].Id')
  [[ $TARGET_ID =~ ^[0-9a-f]{64}$ ]] || refuse label-mismatch
  git reset --quiet --keep "$C" || refuse clone-reset
  STAGED=1
  q_quadlet_config || refuse quadlet-config
  # The target's checks: the file's lines, then what systemd reads from it (with the unit's own
  # UnsetEnvironment=), then the secrets secrets.sh will sync. All print names, never values.
  timeout 60 "$ROOT/ops/quadlet/check-env.sh" --syntax "$ROOT/.env" || refuse settings-missing
  timeout 120 systemd-run --user --pipe --wait --collect --quiet --expand-environment=no \
    -p EnvironmentFile="$ROOT/.env" -p "UnsetEnvironment=$UNSET_SETTINGS" -- \
    "$ROOT/ops/quadlet/check-env.sh" </dev/null || refuse settings-missing
  timeout 60 "$ROOT/ops/quadlet/secrets.sh" check "$ROOT/.env" || refuse settings-missing
}

# Podman's generator, dry run, on the host's real search path; its unit output on stdout and what
# it loaded on stderr. A function, so tests can run a stand-in.
q_generate() {
  timeout 60 "$GENERATOR" --user --dryrun
}

# What systemd will run after the next reload, from the clone now at C through the links: exactly
# one generated unit, tarubot.service (a dry run that finds nothing still exits 0), whose
# ExecStart passes the base list and then the mode's target.env and ends with the pinned image;
# and no unit or drop-in loaded from anywhere but the clone's two directories, where Quadlet would
# merge a stray drop-in or let a stray unit shadow the clone's. The dry run names each file it
# loads ("Loading source unit file …"); a generator that stops doing so is refused too, since a
# stray could then pass unseen.
q_quadlet_config() {
  local out headers start loaded file root lists
  root=$(readlink -f "$ROOT")
  lists=" --env-file %h/tarubot/ops/quadlet/units/tarubot[.]env (.* )?--env-file %h/tarubot/ops/quadlet/$TARGET/target[.]env "
  out=$(q_generate 2>&1) || return 1
  headers=$(grep -E '^---.*---$' <<<"$out") || return 1
  [[ $headers == ---tarubot.service--- ]] || return 1
  start=$(grep -E '^ExecStart=' <<<"$out") || return 1
  [[ $start != *$'\n'* && $start =~ $lists ]] || return 1
  [[ $start == *" $IMAGE@\${TARUBOT_IMAGE_DIGEST}" ]] || return 1
  loaded=$(sed -nE 's/^.*: Loading source (unit|drop-in) file (.*)$/\2/p' <<<"$out")
  grep -qxF "$root/ops/quadlet/units/tarubot.container" <<<"$loaded" || return 1
  while IFS= read -r file; do
    [[ $file == "$root/ops/quadlet/units/"* || $file == "$root/ops/quadlet/$TARGET/"* ]] ||
      return 1
  done <<<"$loaded"
}

# The running release is the target: the approved digest is the pinned one, and the bot is
# healthy; register its commands.
q_already_live() {
  local json
  [[ $D == "$PIN_DIGEST" ]] || refuse digest-mismatch
  json=$(timeout 60 podman container inspect "$LIVE_CID" 2>/dev/null) || needs_you live-unhealthy
  [[ $(field "$json" '.[0].State.Health.Status') == healthy ]] || needs_you live-unhealthy
  commands_then already-live
}

# The start of the evidence window: Podman's events from now on (the host clock journald uses).
q_mark() {
  MARK=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
}

# Pin .env to release $1 with image index digest $2: both lines rewritten in one temporary file
# and rename, mode 600. Multi-line quoted values such as the CA pass through unchanged.
q_pin_env() {
  local tmp
  tmp=$(mktemp "$ROOT/.env.XXXXXX") || return 1
  if ! awk -v v="$1" -v d="$2" '
      /^TARUBOT_IMAGE_TAG=/ { print "TARUBOT_IMAGE_TAG=" v; next }
      /^TARUBOT_IMAGE_DIGEST=/ { print "TARUBOT_IMAGE_DIGEST=" d; next }
      { print }' "$ROOT/.env" >"$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$ROOT/.env"; then
    rm -f "$tmp"
    return 1
  fi
  q_pinned "$1" "$2"
}

# True when .env pins exactly release $1 at digest $2, one line each.
q_pinned() {
  [[ $(grep -c '^TARUBOT_IMAGE_TAG=' "$ROOT/.env") == 1 &&
    $(grep -c '^TARUBOT_IMAGE_DIGEST=' "$ROOT/.env") == 1 ]] &&
    grep -qx "TARUBOT_IMAGE_TAG=$1" "$ROOT/.env" && grep -qx "TARUBOT_IMAGE_DIGEST=$2" "$ROOT/.env"
}

# No migration: pin the target, reload and restart the unit (the old bot stops first and frees the
# lease). The pin moves first because systemd starts whatever .env names, a reboot included.
q_restart_path() {
  step up
  q_mark
  CHANGED=1
  CLOCK=$SECONDS
  if ! q_pin_env "$V" "$D"; then
    # Nothing restarted: while .env still holds the live pin, nothing changed on the host.
    if q_pinned "$LIVE_V" "$PIN_DIGEST"; then refuse pin-failed; fi
    needs_you pin-failed
  fi
  # A reload that fails leaves systemd's view unknown: the live release goes back the full way.
  timeout 60 systemctl --user daemon-reload || q_restore_previous did-not-start previous-failed
  if timeout 300 systemctl --user restart tarubot.service; then
    if q_wait_healthy; then
      DOWNTIME=$((SECONDS - CLOCK))
      q_verify_started
      commands_then deployed
    fi
  else
    START_FAILED=1
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  q_recover_restart
}

# Migration files added: stop, back up, migrate in the new image with the target's own
# configuration, pin, then start. Until "Schema ready." .env names the old release, so a reboot
# brings back the old release on the old schema.
q_migration_path() {
  local out ok=0
  if in_maintenance_window; then
    public "warning db-maintenance-window"
    log "the migration runs during the cluster's Tuesday maintenance window"
  fi
  step stop
  CHANGED=1
  CLOCK=$SECONDS
  timeout 90 systemctl --user stop tarubot.service || q_restore_previous stop-failed previous-failed
  step backup
  # fds 8 and 9 (the run and host locks) stay with this worker: the dump's and the tool's
  # containers may leave a conmon behind, which must never hold a lock.
  if out=$(timeout 900 "$ROOT/ops/backup.sh" quadlet 8>&- 9<&-); then ok=1; fi
  log "ops/backup.sh: ${out//$'\n'/ | }"
  if ((ok)) && [[ $out =~ $BACKUP_DONE ]]; then
    BACKUP=daily/tarubot-${BASH_REMATCH[1]}.dump.age
  else
    q_restore_previous backup-failed previous-failed
  fi
  step migrate
  ok=0
  if out=$(timeout 600 "$ROOT/ops/quadlet/run-tool.sh" "$TARGET" "$D" "tarubot-migrate-$R" \
    bun dist/scripts/migrate.js 8>&- 9<&-); then
    ok=1
  fi
  log "migrate.js: ${out//$'\n'/ | }"
  if ((ok)) && [[ $'\n'$out$'\n' == *$'\nSchema ready.\n'* ]]; then
    RESTORE_POINT=$(restore_point "$out")
    # The old image can't run on the new schema, so the pin moves at once.
    q_pin_env "$V" "$D" || needs_you pin-failed
    step migrated
  else
    q_stop_one_offs
    q_restore_previous migration-failed migration-may-have-committed
  fi
  step up
  if timeout 60 systemctl --user daemon-reload &&
    timeout 300 systemctl --user start tarubot.service && q_wait_healthy; then
    DOWNTIME=$((SECONDS - CLOCK))
    q_verify_started
    commands_then deployed
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you new-release-failed
}

# A migrate.js left running (the timeout) holds its transaction open; stopping its container rolls
# it back. Stopping systemd-run's transient unit instead would leave conmon's container running.
q_stop_one_offs() {
  local ids
  local -a list
  ids=$(timeout 60 podman ps -q --filter label=io.tarubot.role=tool) || ids=
  if [[ -n $ids ]]; then
    mapfile -t list <<<"$ids"
    timeout 60 podman stop "${list[@]}" || log "could not stop the migrate.js container"
  fi
}

# Wait up to 180 s (Compose's --wait-timeout) for the unit's container to report healthy. An
# unhealthy one, one that is gone, or a new one (systemd restarted it) fails at once.
q_wait_healthy() {
  local i json id='' now
  for ((i = 0; i < 36; i++)); do
    json=$(timeout 60 podman container inspect tarubot 2>/dev/null) || return 1
    now=$(field "$json" '.[0].Id')
    [[ -n $id ]] || id=$now
    [[ -n $now && $now == "$id" ]] || return 1
    case $(field "$json" '.[0].State.Health.Status') in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

# The target answered its health check, so it held the writer lease. It must be the approved
# image with its hardening, and a minute later the same container (systemd's NRestarts unchanged:
# every restart makes a new container, so Podman's own count stays 0), running and healthy. .env
# already pins it.
q_verify_started() {
  local json restarts
  json=$(timeout 60 podman container inspect tarubot 2>/dev/null) || json='[]'
  CID=$(field "$json" '.[0].Id')
  if [[ $(field "$json" '.[0].Image') != "$TARGET_ID" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') != "$V" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') != "$C" ]]; then
    needs_you image-mismatch
  fi
  q_hardened "$json" || needs_you hardening-mismatch
  restarts=$(q_restarts) || restarts=
  sleep 60
  json=$(timeout 60 podman container inspect tarubot 2>/dev/null) || json='[]'
  if ! [[ $restarts =~ ^[0-9]+$ ]] || [[ $(q_restarts) != "$restarts" ||
    $(field "$json" '.[0].Id') != "$CID" ||
    $(field "$json" '.[0].State.Status') != running ||
    $(field "$json" '.[0].State.Health.Status') != healthy ]]; then
    needs_you unstable
  fi
}

# How often systemd has restarted tarubot.service.
q_restarts() {
  timeout 60 systemctl --user show -p NRestarts --value tarubot.service
}

# Register the release's commands and read them back, in the running bot's own container.
q_run_commands() {
  step commands
  if q_register && timeout 180 podman exec tarubot bun dist/scripts/commands.js list; then
    COMMANDS=registered
    return 0
  fi
  COMMANDS=failed
  return 1
}

# Production registers globally. Staging registers in the test guild its target.env fixes, read
# by the container's shell from the container's environment, not by this one.
q_register() {
  if [[ $TARGET == staging ]]; then
    timeout 120 podman exec tarubot sh -c 'exec bun dist/scripts/register.js --guild "$TEST_GUILD_ID"'
  else
    timeout 120 podman exec tarubot bun dist/scripts/register.js --global
  fi
}

# The writer-lease evidence for the target (the twin of target_container and evidence). Every
# systemd restart makes a new --rm container, so a listing can't show that the target never ran;
# Podman's event log (journald) can, from MARK on:
#   - the live container's `died` event is the positive control: without it the log isn't
#     showing what happened;
#   - the target's containers are the `start` events on "$IMAGE@$D";
#   - each one's lines, read by CONTAINER_ID_FULL, must include "Modules loaded", and the lease
#     lines are counted over all of them.
# EV_STATE is none (a readable log with the control, no target start, and a start that failed),
# target (at least one target start; EV_COMPLETE and EV_LEASE as for Compose) or unknown
# (anything unreadable or inconsistent).
q_evidence() {
  local events starts id lines count
  EV_STATE=unknown EV_LEASE=0 EV_COMPLETE=0
  events=$(timeout 60 podman events --stream=false --since "$MARK" --filter container=tarubot \
    --filter event=start --filter event=died --format json 2>/dev/null) || return 0
  jq -e -s --arg id "$LIVE_CID" 'any(.[]; .Status == "died" and .ID == $id and $id != "")' \
    <<<"$events" >/dev/null 2>&1 || return 0
  starts=$(jq -r -s --arg image "$IMAGE@$D" \
    '[.[] | select(.Status == "start" and .Image == $image) | .ID] | unique | .[]' \
    <<<"$events" 2>/dev/null) || return 0
  if [[ -z $starts ]]; then
    if ((START_FAILED)); then EV_STATE=none; fi
    log "evidence: no container of $V since $MARK ($EV_STATE)"
    return 0
  fi
  EV_STATE=target EV_COMPLETE=1
  while IFS= read -r id; do
    if ! [[ $id =~ ^[0-9a-f]{64}$ ]]; then
      EV_STATE=unknown
      return 0
    fi
    if ! lines=$(timeout 60 journalctl --user "CONTAINER_ID_FULL=$id" -o cat -q --no-pager); then
      EV_COMPLETE=0
      continue
    fi
    count=$(grep -c -F "$LEASE_LINE" <<<"$lines") || count=0
    EV_LEASE=$((EV_LEASE + count))
    grep -q -F "$MODULES_LINE" <<<"$lines" || EV_COMPLETE=0
  done <<<"$starts"
  log "evidence for $V since $MARK: $EV_LEASE lease lines, complete=$EV_COMPLETE"
}

# The restart or rollback did not come up. Compose's rule: the previous release returns only when
# the target never ran, or its containers provably never held the writer lease. The one
# difference: .env already names the target, so a target left for the owner stays pinned, and
# when the evidence is unreadable nothing is restored while .env names the target.
q_recover_restart() {
  q_evidence
  case $EV_STATE in
    none) q_restore_previous did-not-start previous-failed ;;
    target) ;;
    *)
      log "Podman's event log gave no clear account of the target; nothing restored"
      needs_you lease-evidence-incomplete
      ;;
  esac
  if ((!EV_COMPLETE)); then needs_you lease-evidence-incomplete; fi
  if ((EV_LEASE > 0)); then needs_you new-release-took-lease; fi
  if ! timeout 90 systemctl --user stop tarubot.service; then
    needs_you lease-evidence-incomplete
  fi
  # Count again: the lease may have come between the first count and the stop.
  q_evidence
  if [[ $EV_STATE != target ]] || ((!EV_COMPLETE || EV_LEASE > 0)); then
    timeout 60 systemctl --user start --no-block tarubot.service || log "could not start $V again"
    if ((EV_LEASE > 0)); then needs_you new-release-took-lease; fi
    needs_you lease-evidence-incomplete
  fi
  q_restore_previous did-not-start previous-failed
}

# Put the previous release back: the clone at its commit, .env pinned to it again (the tag and
# digest read at preflight; left alone when it still holds them), a reload, a restart, and the
# previous image healthy. $1 is the reason when it is back, $2 when it isn't.
q_restore_previous() {
  local json
  git reset --quiet --keep "$LIVE_C" || log "could not put the clone back at $LIVE_C"
  STAGED=0
  if { q_pinned "$LIVE_V" "$PIN_DIGEST" || q_pin_env "$LIVE_V" "$PIN_DIGEST"; } &&
    timeout 60 systemctl --user daemon-reload &&
    timeout 300 systemctl --user restart tarubot.service && q_wait_healthy; then
    DOWNTIME=$((SECONDS - CLOCK))
    json=$(timeout 60 podman container inspect tarubot 2>/dev/null) || json='[]'
    if [[ $(field "$json" '.[0].Image') == "$LIVE_IMAGE" &&
      $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$LIVE_V" &&
      $(field "$json" '.[0].State.Health.Status') == healthy ]]; then
      finish recovered "$1"
    fi
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you "$2"
}

main() {
  # First, before anything is created: the state and logs stay private, and so does everything
  # git writes into the clone during a deploy, this script included when a release changes it.
  # The umask of sshd's session (the host user's is 0002) would leave those files group-writable.
  # The worker also starts through main, so it gets the same mask.
  umask 077
  export LC_ALL=C PATH=$SAFE_PATH
  SELF=$(readlink -f "$0")
  ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
  STATE=$HOME/.local/state/tarubot-deploy
  # A Quadlet host's fixed paths (tests point them at a sandbox).
  HOST_LOCK=$QUADLET_LOCK LINGER_DIR=/var/lib/systemd/linger RUNTIME_ROOT=/run/user
  install -d -m 700 "$STATE" "$STATE/runs"
  trim_log
  exec 2>>"$STATE/entry.log"
  # The detached worker: the request's six fields and the mode words (worker checks them). The
  # worker always exits.
  if [[ ${1-} == __worker ]]; then
    (($# >= 7 && $# <= 9)) || exit 64
    shift
    worker "$@"
  fi
  # The forced command's own words, before any run directory, lock, git or runtime call.
  if ! set_mode "$@"; then
    say usage
    log "unknown mode words"
    exit 64
  fi
  entry
}

# Only a direct run starts main; tests source the file for its functions. Bash reads this whole
# compound command before running it, so the clone moving under the script can't change what runs.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
  exit
fi
