#!/usr/bin/env bash
# A stand-in for the fixture repository's ops/quadlet/secrets.sh (tests/unit/deploy-script.test.ts):
# it records "secrets <check|sync> [NAME…]" when the file is the clone's .env ("secrets bad-path"
# otherwise). The knob secrets_check makes `check` fail.
set -euo pipefail
# shellcheck source=tests/fixtures/deploy-stubs/sim.sh
source "$DEPLOY_STUBS/sim.sh"
if [[ ${2-} != "$HOME/tarubot/.env" ]]; then
  record "secrets bad-path"
  exit 64
fi
record "secrets $1${3:+ ${*:3}}"
[[ $1 != check || ! -f $S/knob/secrets_check ]]
