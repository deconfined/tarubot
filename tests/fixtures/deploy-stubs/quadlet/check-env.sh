#!/usr/bin/env bash
# A stand-in for the fixture repository's ops/quadlet/check-env.sh (tests/unit/deploy-script.test.ts).
# `--syntax FILE` records "check-env --syntax"; the environment mode records which of the
# secret-bearing names tarubot.service's UnsetEnvironment= drops still reached it ("secrets=none"
# when the unset list was whole). Knobs: check_syntax and check_environment make them fail.
set -euo pipefail
# shellcheck source=tests/fixtures/deploy-stubs/sim.sh
source "$DEPLOY_STUBS/sim.sh"
if [[ ${1-} == --syntax ]]; then
  record "check-env --syntax"
  [[ ! -f $S/knob/check_syntax ]]
  exit
fi
seen=''
for name in BACKUP_STORAGE_ENDPOINT BACKUP_STORAGE_ACCESS_KEY BACKUP_STORAGE_SECRET_KEY \
  BACKUP_STORAGE_REGION HEALTHCHECKS_BACKUP_URL DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN \
  GITHUB_APP_PRIVATE_KEY GITHUB_REPORTS_TOKEN HEALTHCHECKS_PING_URL POSTGRES_PASSWORD \
  RESTORE_DATABASE_CA_CERT RESTORE_DATABASE_URL; do
  if [[ -n ${!name+x} ]]; then seen+=${seen:+,}$name; fi
done
record "check-env environment secrets=${seen:-none}"
[[ ! -f $S/knob/check_environment ]]
