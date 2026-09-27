#!/usr/bin/env bash
# A stand-in for the fixture repository's ops/quadlet/run-tool.sh (tests/unit/deploy-script.test.ts),
# called as `run-tool.sh TARGET DIGEST NAME COMMAND…`. It records
# "run-tool <target> <release of the digest> <name> pin=<.env's pin> <command>", plus " fd8" or
# " fd9" when the caller left the run or host lock open, then answers as migrate.js would. The
# knob migrate (ok, none, fail) picks the answer; oneoff makes podman list the tool's container.
set -euo pipefail
# shellcheck source=tests/fixtures/deploy-stubs/sim.sh
source "$DEPLOY_STUBS/sim.sh"
target=$1 digest=$2 name=$3
shift 3
fds=''
for fd in 8 9; do
  if { : >&"$fd"; } 2>/dev/null; then fds+=" fd$fd"; fi
done
record "run-tool $target $(version_of "$digest") $name pin=$(pin_of) $*$fds"
case $(knob migrate) in
  fail)
    printf 'A TaruBot writer holds the writer lease, so 1 pending migration(s) were not applied.\n'
    exit 1
    ;;
  none) printf 'Schema ready.\n' ;;
  *)
    printf 'Migration writer lease acquired at 2026-09-29 19:30:05.123456+00; applied 003_more.sql; committing at 2026-09-29 19:30:06.2+00.\n'
    printf 'Schema ready.\n'
    ;;
esac
