#!/usr/bin/env bash
# One maintenance tool in a one-off container on a Quadlet host (#50, 2.33.0), in the same
# configuration as the bot's own container: this release's setting lists, the target's list, the
# secrets as files, and the unit's hardening.
#
#   run-tool.sh TARGET DIGEST NAME COMMAND [ARG...]
#
#   TARGET   production or staging: the list (ops/quadlet/TARGET/target.env) and secrets to use.
#   DIGEST   the image index digest, sha256: and 64 lowercase hex digits; the image must be pulled.
#   NAME     tarubot- and up to 40 of a-z, 0-9 and -: both the transient unit's and the
#            container's name, so a stuck tool can be found and stopped by it.
#   COMMAND  what runs in the image, such as `bun dist/scripts/migrate.js`.
#
# It first copies the secrets from the clone's .env into their Podman secrets (secrets.sh sync; a
# failure exits 1), then runs the tool under the tarubot user's systemd, never in the caller's
# environment: systemd reads .env as the unit does and unsets the same 14 names, so no secret
# reaches systemd-run, Podman or conmon, and the container gets only the two lists. The tool's
# stdout and stderr pass through and its exit status is this script's; stdin is /dev/null. A usage
# error exits 64.
#
# deploy.sh runs the target release's own copy (the clone is at that release) for the migration,
# with its lock descriptor closed, and stops leftovers by the io.tarubot.role=tool label. This CLI
# is part of deploy.sh's `quadlet` contract; an incompatible change replaces that capability word.
# tests/unit/quadlet.test.ts pins every flag below to units/tarubot.container and the drop-ins.
set -Eeuo pipefail
umask 077

# The one repository the unit runs (units/tarubot.container Image=).
readonly IMAGE=ghcr.io/deconfined/tarubot
# units/tarubot.container's UnsetEnvironment=, exactly: ops/backup.sh's settings, the six secrets,
# and the three names a .env may hold that the bot never needs.
readonly UNSET_SETTINGS='BACKUP_STORAGE_ENDPOINT BACKUP_STORAGE_ACCESS_KEY BACKUP_STORAGE_SECRET_KEY BACKUP_STORAGE_REGION HEALTHCHECKS_BACKUP_URL DATABASE_CA_CERT DATABASE_URL DISCORD_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_REPORTS_TOKEN HEALTHCHECKS_PING_URL POSTGRES_PASSWORD RESTORE_DATABASE_CA_CERT RESTORE_DATABASE_URL'
# units/tarubot.container's Secret= values, in its order, then production's drop-in's own.
readonly SECRETS=(
  'tarubot-database-url,type=mount,target=/run/secrets/database_url,uid=1000,gid=1000,mode=0400'
  'tarubot-database-ca-cert,type=mount,target=/run/secrets/database_ca_cert,uid=1000,gid=1000,mode=0400'
  'tarubot-discord-token,type=mount,target=/run/secrets/discord_token,uid=1000,gid=1000,mode=0400'
  'tarubot-github-reports-token,type=mount,target=/run/secrets/github_reports_token,uid=1000,gid=1000,mode=0400'
  'tarubot-healthchecks-ping-url,type=mount,target=/run/secrets/healthchecks_ping_url,uid=1000,gid=1000,mode=0400'
)
readonly PRODUCTION_SECRETS=(
  'tarubot-github-app-private-key,type=mount,target=/run/secrets/github_app_private_key,uid=1000,gid=1000,mode=0400'
)

# This script's directory, and the clone it belongs to (~/tarubot on a host).
here=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
clone=$(cd -P -- "$here/../.." && pwd -P)
readonly here clone

say() { printf 'run-tool: %s\n' "$1" >&2; }
usage() {
  say 'usage: run-tool.sh production|staging sha256:DIGEST tarubot-NAME COMMAND [ARG...]'
  exit 64
}

[ $# -ge 4 ] || usage
target=$1 digest=$2 name=$3
shift 3
case $target in production | staging) ;; *) usage ;; esac
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || usage
[[ $name =~ ^tarubot-[a-z0-9-]{1,40}$ ]] || usage

if ! "$here/secrets.sh" sync "$clone/.env"; then
  say 'the secrets could not be synced from .env; the tool did not run'
  exit 1
fi

# The same mounts as the target's bot: every host's five, and production's GitHub App key.
secrets=()
for secret in "${SECRETS[@]}"; do secrets+=(--secret "$secret"); done
if [ "$target" = production ]; then
  for secret in "${PRODUCTION_SECRETS[@]}"; do secrets+=(--secret "$secret"); done
fi

# --expand-environment=no keeps systemd from reading $ in the tool's arguments. --read-only is
# what makes Podman mount the secret files read-only (README "What Podman generates"). The tool's
# output streams through the pipe; --log-driver=none keeps no copy of it in the journal.
exec systemd-run --user --pipe --wait --collect --quiet --expand-environment=no --unit="$name" \
  -p "EnvironmentFile=$clone/.env" -p "UnsetEnvironment=$UNSET_SETTINGS" -- \
  podman run --rm --name "$name" --label io.tarubot.role=tool --pull=never --log-driver=none \
  --env-host=false --http-proxy=false --read-only --read-only-tmpfs=false --cap-drop=all \
  --security-opt=no-new-privileges \
  --env-file "$clone/ops/quadlet/units/tarubot.env" \
  --env-file "$clone/ops/quadlet/$target/target.env" \
  "${secrets[@]}" \
  "$IMAGE@$digest" "$@" </dev/null
