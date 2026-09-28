#!/usr/bin/env bash
# The sourced script reads the sandbox values set below, which ShellCheck can't see.
# shellcheck disable=SC2034
# Runs one tarubot-host-config command in this shell for tests/unit/host-config.test.ts. It sources
# the script and sets main's mutable copies to a sandbox instead of calling main, which is what
# sets the host's real paths and the production URLs. Tools come from the test's PATH (the stubs in
# tests/fixtures/host-config/stubs first); the clock is $SIM_NOW, and the host lock's 300 s and the
# private lock's 60 s waits take HC_LOCK_WAIT seconds (1 by default), so contention costs nothing.
#
# Env: HC_SCRIPT (the script), HC_ROOT (the sandbox's /, which is also LAYOUT_TOP), HC_REMOTE and
# HC_REMOTE_PROTOCOL (the fixture remote, file:// by default), SIM_NOW (epoch seconds), and
# optionally HC_OWNER_UID, HC_API_DEADLINE, HC_PAUSE_WAIT and HC_LOCK_WAIT.
#
#   run.sh <command> [args...]    run, apply-now, status, pause, resume, bootstrap or apply
#   run.sh settings-check FILE    settings_read on FILE alone: prints the role, or exits 78
#   run.sh signers-check FILE     the same, printing the signers read ("<type> <key>" lines) and
#                                 digest=<the sha256 passed as tarubot_pull_signers>
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$HC_SCRIPT"
REMOTE=$HC_REMOTE
REMOTE_PROTOCOL=${HC_REMOTE_PROTOCOL:-file}
API_BASE=http://api.test
API_PROTO='=http'
PING_PROTO='=http'
STATE_DIR=$HC_ROOT/var/lib/tarubot-config
CLONE=$STATE_DIR/repo
HOME_DIR=$STATE_DIR/home
SETTINGS=$HC_ROOT/etc/tarubot/host.yml
PING_FILE=$HC_ROOT/etc/tarubot/host-config.env
LOCK=$HC_ROOT/run/tarubot/host.lock
LAYOUT_TOP=$HC_ROOT
OWNER_UID=${HC_OWNER_UID:-$(id -u)}
API_DEADLINE=${HC_API_DEADLINE:-180}
PAUSE_WAIT=${HC_PAUSE_WAIT:-5}
now() { printf '%s\n' "$SIM_NOW"; }
flock() {
  if [[ ${1-} == -w && (${2-} == 300 || ${2-} == 60) ]]; then
    command flock -w "${HC_LOCK_WAIT:-1}" "${@:3}"
  else
    command flock "$@"
  fi
}
umask 077
command=$1
shift
case $command in
  run) cmd_run "$@" ;;
  apply-now) cmd_apply_now "$@" ;;
  status) cmd_status "$@" ;;
  pause) cmd_pause "$@" ;;
  resume) cmd_resume "$@" ;;
  bootstrap) cmd_bootstrap "$@" ;;
  apply) cmd_apply "$@" ;;
  settings-check)
    SETTINGS=$1
    if settings_read; then printf '%s\n' "$ROLE"; else exit 78; fi
    ;;
  signers-check)
    SETTINGS=$1
    settings_read || exit 78
    for key in "${SIGNER_KEYS[@]}"; do printf '%s\n' "$key"; done
    printf 'digest=%s\n' "$SIGNERS_DIGEST"
    ;;
  *) exit 2 ;;
esac
