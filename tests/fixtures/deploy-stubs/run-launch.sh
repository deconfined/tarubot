#!/usr/bin/env bash
# The detachment check for tests/unit/deploy-script.test.ts: start the stand-in worker through
# ops/deploy.sh's real launch while holding the run lock, then hang up this whole process group,
# as sshd's session teardown would. Env: DEPLOY_SCRIPT, DEPLOY_STATE, DEPLOY_SELF, REQUEST. The
# Compose mode: the forced command has no words, so launch appends none.
#
# The hangup waits (60 s at most) until the stand-in has written stub-started, which it does after
# setsid has exec'd it, in its own session when launch detaches it. Hanging up earlier could reach
# setsid's child before it left this group, which is slow under QEMU, and fail a launch that does
# detach. A worker left in this group still dies: the stand-in sleeps after stub-started, so the
# hangup lands before its stub-done.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
STATE=$DEPLOY_STATE SELF=$DEPLOY_SELF
set_mode
parse_request "$REQUEST"
RUN=$STATE/runs/$R
mkdir -p "$RUN"
exec 8>>"$RUN/lock"
flock -n 8
launch
exec 8>&-
for ((i = 0; i < 600; i++)); do
  if [[ -e $HOME/stub-started ]]; then break; fi
  sleep 0.1
done
kill -HUP 0
