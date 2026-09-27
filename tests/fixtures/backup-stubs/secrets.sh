#!/usr/bin/env bash
# Stand-in for ops/quadlet/secrets.sh in tests/unit/backup-quadlet.test.ts, linked into the
# sandbox clone: it records the call and fails as the real one does for a missing secret, with its
# name only, when $BACKUP_SIM/knob/secrets exists.
set -euo pipefail
# shellcheck source=tests/fixtures/backup-stubs/record.sh
. "$(dirname "$(readlink -f "$0")")/record.sh"
record secrets.sh "$@"
if [[ -f $BACKUP_SIM/knob/secrets ]]; then
  echo 'secrets: DATABASE_URL is required and empty' >&2
  exit 1
fi
