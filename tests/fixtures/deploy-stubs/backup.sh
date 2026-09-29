#!/usr/bin/env bash
# The fixture repository's ops/backup.sh for tests/unit/deploy-script.test.ts: it records the call
# ("backup") and prints the real script's last line, or fails when $SIM/knob/backup exists.
set -euo pipefail
printf 'backup\n' >>"$SIM/calls"
if [[ -f $SIM/knob/backup ]]; then exit 1; fi
printf '2026-09-29T19:30:00Z backup ok: tarubot-20260929T193000Z (5000 bytes, settings 100 bytes)\n'
