#!/usr/bin/env bash
# Calls one ops/deploy.sh function for tests/unit/deploy-script.test.ts: `call.sh FUNCTION ARGS…`
# exits with the function's status; `call.sh parse REQUEST` prints the parsed fields, and
# `call.sh mode WORDS…` what the forced command's words select (exit 64 when they select nothing).
# main's Quadlet host paths get their real values unless DEPLOY_HOST_LOCK, DEPLOY_LINGER_DIR or
# DEPLOY_RUNTIME_ROOT name a sandbox.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
HOST_LOCK=${DEPLOY_HOST_LOCK:-$QUADLET_LOCK}
LINGER_DIR=${DEPLOY_LINGER_DIR:-/var/lib/systemd/linger}
RUNTIME_ROOT=${DEPLOY_RUNTIME_ROOT:-/run/user}
if [[ $1 == parse ]]; then
  parse_request "$2"
  printf '%s|%s|%s|%s|%s|%s\n' "$ACTION" "$V" "$C" "$D" "$R" "$F"
  exit 0
fi
if [[ $1 == mode ]]; then
  shift
  set_mode "$@" || exit 64
  printf '%s|%s|%s|%s\n' "$MODE" "$TARGET" "$RT" "${MODE_WORDS[*]}"
  exit 0
fi
"$@"
