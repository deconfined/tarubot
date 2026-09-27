#!/usr/bin/env bash
# The bot's secrets on a Quadlet host (#50, 2.33.0). ~/tarubot/.env stays the only place they are
# kept; this copies each one into the Podman secret the unit mounts as a file, so the value never
# enters an environment the bot, Podman, conmon or pasta can read (ops/quadlet/README.md,
# "Secrets"). It reads .env itself: the unit unsets the secrets before any of its commands run.
#
#   secrets.sh check ENV_FILE           Check ENV_FILE's lines (check-env.sh --syntax) and that the
#                                       required secrets aren't empty. Changes nothing.
#   secrets.sh sync ENV_FILE [NAME...]  The same checks, then copy each named setting (all six when
#                                       none is named) into its Podman secret, replacing the old
#                                       one. The nightly backup syncs only DATABASE_URL and
#                                       DATABASE_CA_CERT, so it never depends on the Discord token.
#
# tarubot.service runs `sync` before every start (ExecStartPre), ops/quadlet/run-tool.sh before
# every one-off tool, ops/backup.sh before every dump; a deploy and the playbook run `check`.
# Exit status: 0 done, 1 a problem, 64 a usage error. It prints nothing on stdout, and on stderr
# only setting names (secrets: NAME ...), never a value or a path. Values never pass through an
# argument or an environment variable: awk prints each one straight into `podman secret create`.
#
# This CLI, the secret names and the file format are part of deploy.sh's `quadlet` contract
# (ops/deploy.sh's header); an incompatible change replaces that capability word.
set -Eeuo pipefail
umask 077

# The six file-delivered settings, sorted. src/config/secrets.ts FILE_SETTINGS, ops/deploy.sh's
# SECRET_SETTINGS and tests/unit/quadlet.test.ts hold the same names. Each one's Podman secret is
# its name in lower case with dashes, after tarubot- (DATABASE_CA_CERT: tarubot-database-ca-cert),
# as units/tarubot.container and production's drop-in mount them.
readonly SETTINGS='DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_REPORTS_TOKEN HEALTHCHECKS_PING_URL'
# The ones the bot can't start without (Compose's ${NAME:?} settings). Without DATABASE_CA_CERT it
# would connect to the managed cluster without verifying its certificate.
readonly REQUIRED='DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN'

# check-env.sh, beside this script in the same release.
here=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly here

# One problem, by name only, on stderr (the journal under systemd).
say() { printf 'secrets: %s\n' "$1" >&2; }
usage() {
  say 'usage: secrets.sh check ENV_FILE | secrets.sh sync ENV_FILE [NAME...]'
  exit 64
}

# The settings file as systemd's EnvironmentFile= reads it, for the subset check-env.sh --syntax
# accepts (which this runs first, so nothing outside that subset reaches the parser):
#   - blank lines and "#" comments are skipped;
#   - an unquoted value loses its leading and trailing blanks;
#   - a value starting with " or ' runs to the same quote, which may be on a later line; the lines
#     join with a newline, and blanks after the closing quote are dropped;
#   - a name the file doesn't assign is empty.
# `parse value FILE NAME` prints NAME's value followed by one newline (Podman refuses an empty
# secret; src/config/secrets.ts removes that newline again). `parse empty FILE NAMES` prints each
# of the space-separated NAMES whose value is empty, one per line: names only.
parse() {
  LC_ALL=C awk -v mode="$1" -v names="$3" -v sq="'" '
    {
      if (quote != "") {
        end = index($0, quote)
        if (end) {
          value[key] = value[key] "\n" substr($0, 1, end - 1)
          quote = ""
        } else value[key] = value[key] "\n" $0
        next
      }
      if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
      key = substr($0, 1, index($0, "=") - 1)
      text = substr($0, index($0, "=") + 1)
      sub(/^[ \t]+/, "", text)
      first = substr(text, 1, 1)
      if (first == "\"" || first == sq) {
        text = substr(text, 2)
        end = index(text, first)
        if (end) value[key] = substr(text, 1, end - 1)
        else {
          value[key] = text
          quote = first
        }
        next
      }
      sub(/[ \t]+$/, "", text)
      value[key] = text
    }
    END {
      if (mode == "value") printf "%s\n", value[names]
      else {
        count = split(names, list, " ")
        for (i = 1; i <= count; i++) if (value[list[i]] == "") print list[i]
      }
    }
  ' "$2"
}

# The checks both commands share: the file's lines, then the required names among those selected.
check() {
  local file=$1 selected=$2 wanted='' name empty
  if ! "$here/check-env.sh" --syntax "$file"; then
    say 'the settings file failed check-env.sh --syntax; nothing was changed'
    exit 1
  fi
  for name in $REQUIRED; do
    case " $selected " in *" $name "*) wanted="$wanted $name" ;; esac
  done
  if ! empty=$(parse empty "$file" "${wanted# }"); then
    say 'the settings file could not be read; nothing was changed'
    exit 1
  fi
  if [ -n "$empty" ]; then
    for name in $empty; do say "$name is missing or empty in the settings file"; done
    say 'nothing was changed'
    exit 1
  fi
}

# The Podman secret a setting is copied into.
secret_of() {
  local lower=${1,,}
  printf 'tarubot-%s' "${lower//_/-}"
}

[ $# -ge 2 ] || usage
command=$1 file=$2
shift 2
case $command in
  check)
    [ $# -eq 0 ] || usage
    check "$file" "$SETTINGS"
    ;;
  sync)
    # Distinct names from the six, kept in the six's sorted order.
    selected=''
    for name in "$@"; do
      case " $SETTINGS " in *" $name "*) ;; *) usage ;; esac
      case " $selected " in *" $name "*) usage ;; esac
      selected="$selected $name"
    done
    if [ $# -eq 0 ]; then
      selected=$SETTINGS
    else
      ordered=''
      for name in $SETTINGS; do
        case " $selected " in *" $name "*) ordered="$ordered $name" ;; esac
      done
      selected=${ordered# }
    fi
    check "$file" "$selected"
    for name in $selected; do
      # podman prints the new secret's ID on stdout, which isn't this script's to print.
      if ! parse value "$file" "$name" | timeout 60 podman secret create --replace "$(secret_of "$name")" - >/dev/null; then
        say "$name could not be copied into its Podman secret"
        exit 1
      fi
    done
    ;;
  *) usage ;;
esac
