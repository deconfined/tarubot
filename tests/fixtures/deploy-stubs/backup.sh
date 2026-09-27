#!/usr/bin/env bash
# The fixture repository's ops/backup.sh for tests/unit/deploy-script.test.ts: it records the call
# and prints the real script's last line, or fails when $SIM/knob/backup exists. With no argument
# (Compose) it records "backup"; with `quadlet` it records "backup quadlet", plus " fd8" or " fd9"
# when the caller left the run or host lock open for the dump's container to inherit.
set -euo pipefail
if [[ ${1-} == quadlet ]]; then
  line='backup quadlet'
  for fd in 8 9; do
    if { : >&"$fd"; } 2>/dev/null; then line+=" fd$fd"; fi
  done
  printf '%s\n' "$line" >>"$SIM/calls"
else
  printf 'backup\n' >>"$SIM/calls"
fi
if [[ -f $SIM/knob/backup ]]; then exit 1; fi
printf '2026-09-29T19:30:00Z backup ok: tarubot-20260929T193000Z (5000 bytes, settings 100 bytes)\n'
