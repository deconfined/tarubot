#!/usr/bin/env bash
# Runs ops/deploy.sh's entry in this shell for tests/unit/deploy-script.test.ts, with
# SSH_ORIGINAL_COMMAND from the environment and a short follow interval. DEPLOY_SELF names the
# worker the entry would launch, and DEPLOY_MODE the forced command's words it hands on. Env:
# DEPLOY_SCRIPT, DEPLOY_STATE, DEPLOY_SELF, DEPLOY_MODE.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
ROOT=/nonexistent STATE=$DEPLOY_STATE SELF=$DEPLOY_SELF
read -r -a words <<<"${DEPLOY_MODE-}"
set_mode "${words[@]}"
sleep() { command sleep 0.05; }
install -d -m 700 "$STATE" "$STATE/runs"
entry
