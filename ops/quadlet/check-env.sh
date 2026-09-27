#!/bin/sh
# The check of the bot's settings on a Quadlet host (#50); ops/quadlet/secrets.sh checks the
# secrets. It prints setting names and line numbers, never a value, and exits 1 after naming every
# problem it found (64 on a usage error).
#
#   check-env.sh                Check the environment it runs in: systemd's reading of
#                               ~/tarubot/.env, after the unit's UnsetEnvironment=. tarubot.service
#                               runs it before every start (ExecStartPre), and a deploy runs it
#                               through `systemd-run --user -p EnvironmentFile=...
#                               -p UnsetEnvironment=...` before anything stops. The secrets are
#                               unset there, so ops/quadlet/secrets.sh checks those in .env itself.
#   check-env.sh --syntax FILE  Check FILE's lines for anything systemd's EnvironmentFile= and
#                               Compose's .env parser read differently. The file is the same one
#                               under both runtimes (settings copies restore into either), so it
#                               must mean the same to both.
#
# The list below is the only copy; tests/unit/quadlet.test.ts derives it from
# docker-compose.production.yml and the bot's own defaults. ops/quadlet/README.md has the layout.
set -eu

# Compose's ${NAME:-default} settings whose default isn't empty. Compose used the default for an
# empty value too, but the bot reads "" as it is: zod turns an empty number into 0 (which silently
# switches off the guest cooldown and live selectors) or refuses it at startup. An empty line must
# go instead, so the bot's default (equal to Compose's) applies.
readonly NOT_EMPTY='LOG_LEVEL ROSTER_INTERVAL_SECONDS PROFILE_INTERVAL_SECONDS VERIFICATION_SECONDS GUEST_COOLDOWN_SECONDS LODESTONE_REGION LODESTONE_CONCURRENCY LODESTONE_START_MS LODESTONE_TIMEOUT_MS LODESTONE_BODY_BYTES LODESTONE_REQUEST_TIMEOUT_MS LODESTONE_JOB_TIMEOUT_MS LODESTONE_ATTEMPTS LODESTONE_MAX_PAGES LODESTONE_SELECTOR_CHECK_SECONDS GITHUB_REPORTS_REPO'

# One problem, by name only, on stderr (the journal under systemd).
say() { printf 'check-env: %s\n' "$1" >&2; }

# The environment's settings. Each name comes from the fixed list above, never from input, so the
# eval only reads the variable that name gives. Compose's required settings (DATABASE_URL,
# DATABASE_CA_CERT, DISCORD_TOKEN) aren't checked here from 2.33.0: they are secrets, which the unit
# unsets before this runs, and `secrets.sh check` and `sync` require them from .env instead.
check_environment() {
  failed=0 value='' isset=''

  # The unit's Image= takes the digest as it is, so it must be one: sha256 and 64 hex digits.
  digest=${TARUBOT_IMAGE_DIGEST-}
  hex=${digest#sha256:}
  case $hex in
    "$digest" | *[!0-9a-f]*) hex= ;;
  esac
  if [ ${#hex} -ne 64 ]; then
    say "TARUBOT_IMAGE_DIGEST must be sha256: followed by 64 lowercase hex digits"
    failed=1
  fi

  # A deploy reads the writer-lease lines, which the bot logs at info.
  if [ -n "${LOG_LEVEL-}" ]; then
    case $LOG_LEVEL in
      trace | debug | info) ;;
      *)
        say "LOG_LEVEL must be trace, debug or info, which keep the writer-lease lines"
        failed=1
        ;;
    esac
  fi

  for name in $NOT_EMPTY; do
    eval "isset=\${$name+set} value=\${$name-}"
    if [ "$isset" = set ] && [ -z "$value" ]; then
      say "$name is set but empty; remove the line to use the default"
      failed=1
    fi
  done
  return "$failed"
}

# FILE's lines, read the way both parsers would. Each refusal names the line and, for an
# assignment, its setting. What the two parsers do (systemd 257 and Compose's dotenv parser):
#   - Unquoted, systemd keeps " # text" in the value and unescapes backslashes; Compose drops the
#     comment, keeps backslashes and expands $NAME.
#     A quote later in an unquoted value is literal to both (systemd enters a quoted value only
#     at its first character), so a password such as pa'sw passes unquoted.
#   - Double-quoted (may span lines), Compose expands $NAME and escapes; systemd expands nothing.
#   - Single-quoted (may span lines) is literal to both, except that Compose reads \' as a quote.
#   - After a closing quote, systemd appends any text to the value; Compose reads it as a new
#     assignment (or a comment).
#   - systemd ignores an `export NAME=` line and a line without "=", which Compose reads.
#   - ops/deploy.sh and ops/backup.sh find settings with ^NAME=, so an assignment starts its line,
#     no line inside a quoted value may look like one of theirs, and each name is assigned once.
#     Every name they read contains "_" (quadlet.test.ts checks it), and base64 never does, so
#     only a NAME= with "_" is refused inside a value: a PEM line such as "MIIB...==" passes.
check_syntax() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then
    say "cannot read the settings file"
    return 1
  fi
  # awk prints to stdout, sent to stderr here: opening /dev/stderr fails when it is the journal's
  # socket.
  LC_ALL=C awk -v sq="'" '
    function refuse(why) {
      printf "check-env: line %d%s: %s\n", NR, (key == "" ? "" : " (" key ")"), why
      bad = 1
    }
    # The part of a quoted value on this line. Returns the quote still open at the end of the
    # line, or "" once the value closes.
    function quoted(text, open,    end, part) {
      end = index(text, open)
      part = end ? substr(text, 1, end - 1) : text
      if (index(part, "\\")) refuse("a backslash, which the two parsers unescape differently")
      if (open == "\"" && index(part, "$"))
        refuse("a $ outside single quotes, which Compose expands and systemd does not")
      if (!end) return open
      if (substr(text, end + 1) !~ /^[ \t]*$/) refuse("text after the closing quote")
      return ""
    }
    BEGIN { quote = ""; bad = 0 }
    {
      # Inside a quoted value, refusals name the setting the value belongs to.
      if (quote == "") key = ""
      if (index($0, "\r")) refuse("a carriage return (CRLF line endings)")
      if (quote != "") {
        if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/ && substr($0, 1, index($0, "=") - 1) ~ /_/)
          refuse("a line inside a quoted value that the host scripts would read as a setting")
        quote = quoted($0, quote)
        next
      }
      if ($0 ~ /^[ \t]*$/ || $0 ~ /^[ \t]*#/) next
      if ($0 ~ /^[ \t]*export[ \t]/) {
        refuse("an export prefix, which makes systemd ignore the line")
        next
      }
      if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        refuse("not NAME=value at the start of the line, a # comment or a blank line")
        next
      }
      key = substr($0, 1, index($0, "=") - 1)
      if (key in seen) refuse("assigned again (first on line " seen[key] ")")
      else seen[key] = NR
      value = substr($0, index($0, "=") + 1)
      sub(/^[ \t]+/, "", value)
      first = substr(value, 1, 1)
      if (first == "\"" || first == sq) {
        opened = NR
        quote = quoted(substr(value, 2), first)
        next
      }
      if (index(value, "\\")) refuse("a backslash, which the two parsers unescape differently")
      if (index(value, "$"))
        refuse("a $ outside single quotes, which Compose expands and systemd does not")
      if (value ~ /[ \t]#/)
        refuse("an inline comment, which Compose drops and systemd keeps in the value")
    }
    END {
      if (quote != "") {
        printf "check-env: line %d (%s): a quoted value that never closes\n", opened, key
        bad = 1
      }
      exit bad
    }
  ' "$1" >&2
}

case $# in
  0)
    if check_environment; then exit 0; fi
    ;;
  2)
    if [ "$1" != --syntax ]; then
      say "usage: check-env.sh [--syntax FILE]"
      exit 64
    fi
    if check_syntax "$2"; then exit 0; fi
    ;;
  *)
    say "usage: check-env.sh [--syntax FILE]"
    exit 64
    ;;
esac
exit 1
