#!/usr/bin/env bash
# Runs one ops/deploy.sh worker in this shell for tests/unit/deploy-script.test.ts, the way the
# entry would have launched it in the Compose mode: the run directory, the request and the run lock
# on fd 8. Tools come from the test's PATH (the stubs first); the clock and sleep are replaced so
# windows and waits cost nothing, and the host lock waits 1 s instead of 300 s. Env:
# DEPLOY_SCRIPT, DEPLOY_ROOT, DEPLOY_STATE, REQUEST, SIM_NOW ("<day> <hour>").
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
ROOT=$DEPLOY_ROOT STATE=$DEPLOY_STATE SELF=$DEPLOY_SCRIPT
# main sets these for the retired Quadlet modes; no Compose path reads them.
HOST_LOCK=/nonexistent/host.lock LINGER_DIR=/nonexistent/linger RUNTIME_ROOT=/nonexistent/run
now_utc() { printf '%s\n' "${SIM_NOW:-4 12}"; }
sleep() { :; }
flock() {
  if [[ ${1-} == -w ]]; then command flock -w 1 "${@:3}"; else command flock "$@"; fi
}
install -d -m 700 "$STATE" "$STATE/runs"
parse_request "$REQUEST"
RUN=$STATE/runs/$R
mkdir -p "$RUN"
printf '%s\n' "$REQUEST" >"$RUN/request"
exec 8>>"$RUN/lock"
flock -n 8
worker "$ACTION" "$V" "$C" "$D" "$R" "$F"
