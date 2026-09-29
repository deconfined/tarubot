#!/usr/bin/env bash
# Calls one ops/deploy.sh function for tests/unit/deploy-script.test.ts: `call.sh FUNCTION ARGS…`
# exits with the function's status, and `call.sh parse REQUEST` prints the parsed fields.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
if [[ $1 == parse ]]; then
  parse_request "$2"
  printf '%s|%s|%s|%s|%s|%s\n' "$ACTION" "$V" "$C" "$D" "$R" "$F"
  exit 0
fi
"$@"
