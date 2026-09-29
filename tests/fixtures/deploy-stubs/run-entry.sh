#!/usr/bin/env bash
# Runs ops/deploy.sh's entry in this shell for tests/unit/deploy-script.test.ts, with
# SSH_ORIGINAL_COMMAND from the environment and a short follow interval, in the Compose mode (the
# forced command's words are none). DEPLOY_SELF names the worker the entry would launch. Env:
# DEPLOY_SCRIPT, DEPLOY_STATE, DEPLOY_SELF.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
ROOT=/nonexistent STATE=$DEPLOY_STATE SELF=$DEPLOY_SELF
set_mode
sleep() { command sleep 0.05; }
install -d -m 700 "$STATE" "$STATE/runs"
entry
