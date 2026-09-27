#!/usr/bin/env bash
# Runs one ops/deploy.sh worker in this shell for tests/unit/deploy-script.test.ts, the way the
# entry would have launched it: the run directory, the request and the run lock on fd 8. Tools
# come from the test's PATH (the stubs first); the clock and sleep are replaced so windows and
# waits cost nothing, and the host lock waits 1 s instead of 300 s. Env: DEPLOY_SCRIPT,
# DEPLOY_ROOT, DEPLOY_STATE, REQUEST, SIM_NOW ("<day> <hour>").
#
# The Quadlet modes add DEPLOY_MODE (the forced command's words, "quadlet" or "quadlet staging"),
# the sandbox's host paths DEPLOY_HOST_LOCK, DEPLOY_LINGER_DIR and DEPLOY_RUNTIME_ROOT (main sets
# the real ones), and DEPLOY_REAL_LOCK_CHECK. In those modes sleep lets the simulated host's time
# pass (sim.sh tick), and the generator is the stand-in on PATH.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
ROOT=$DEPLOY_ROOT STATE=$DEPLOY_STATE SELF=$DEPLOY_SCRIPT
HOST_LOCK=${DEPLOY_HOST_LOCK:-/nonexistent/host.lock}
LINGER_DIR=${DEPLOY_LINGER_DIR:-/nonexistent/linger}
RUNTIME_ROOT=${DEPLOY_RUNTIME_ROOT:-/nonexistent/run}
now_utc() { printf '%s\n' "${SIM_NOW:-4 12}"; }
sleep() {
  if [[ -n ${DEPLOY_MODE-} ]]; then bash "$DEPLOY_STUBS/sim.sh" tick "$@"; fi
}
flock() {
  if [[ ${1-} == -w ]]; then command flock -w 1 "${@:3}"; else command flock "$@"; fi
}
# The real function runs "$GENERATOR" (a static test pins it); here the stand-in on PATH.
q_generate() { timeout 60 podman-system-generator --user --dryrun; }
# Sandbox files belong to the test user, not root, so passing scenarios trust a regular file that
# isn't a link; the lock tests keep the real check.
if [[ -z ${DEPLOY_REAL_LOCK_CHECK-} ]]; then
  q_lock_trusted() { [[ -f $1 && ! -L $1 ]]; }
fi
install -d -m 700 "$STATE" "$STATE/runs"
parse_request "$REQUEST"
RUN=$STATE/runs/$R
mkdir -p "$RUN"
printf '%s\n' "$REQUEST" >"$RUN/request"
exec 8>>"$RUN/lock"
flock -n 8
read -r -a words <<<"${DEPLOY_MODE-}"
worker "$ACTION" "$V" "$C" "$D" "$R" "$F" "${words[@]}"
