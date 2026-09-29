# Sourced by the stand-ins for the backup scripts' tools (tests/unit/backup-quadlet.test.ts) and for
# tarubot-tool's podman (tests/unit/bot-play.test.ts). record
# TOOL ARG... keeps one call as a directory under $BACKUP_SIM/calls, named by the time in
# microseconds and the process id so the calls sort in the order they started: `tool` holds the
# tool's name, `argv` its arguments and `env` its environment (both NUL-separated), and $call names
# the directory for anything else a stand-in keeps.
record() {
  call="$BACKUP_SIM/calls/${EPOCHREALTIME/./}-$$"
  mkdir -p "$call"
  printf '%s' "$1" >"$call/tool"
  shift
  printf '%s\0' "$@" >"$call/argv"
  env -0 >"$call/env"
}
