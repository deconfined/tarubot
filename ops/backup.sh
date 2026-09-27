#!/usr/bin/env bash
# Daily encrypted off-site backup of the bot's database (2.24.0; the owner's 2026-09-25 decision to
# make the host robust and disposable), on either runtime (2.33.0, #50). docs/HOSTING.md
# ("Backups and recovery") has the setup and the restore.
#
#   backup.sh           Compose on Docker: today's production host, from the tarubot user's
#                       crontab. pg_dump runs through the production Compose file's `backup`
#                       service, with the bot's DATABASE_URL and CA from the host's .env.
#   backup.sh quadlet   A rootless Quadlet host (staging now, production after its rebuild), from
#                       the release's systemd user timer (ops/systemd/tarubot-backup.timer starts
#                       tarubot-backup.service) and from deploy.sh's Quadlet migration path.
#
# Any other argument exits 64 before a setting is read or anything is sent.
#
#   1. pg_dump (custom format) runs in the pinned PostgreSQL 18 image. On a Quadlet host it is a
#      one-off `podman run`, as hardened as Compose's service: a read-only root with no tmpfs, no
#      capability and no new privilege. ops/quadlet/secrets.sh first copies DATABASE_URL and
#      DATABASE_CA_CERT from .env into their Podman secrets (only those two, so a blank Discord
#      token never stops a backup), and the container reads both as files mounted read-only under
#      /run/secrets, the same secrets and targets the bot's unit mounts. No value appears in an
#      argument or an environment variable of this script's commands. Inside the container,
#      pg_dump still takes the URL as its argument while it runs, as under Compose. The dump is
#      never a Quadlet unit: Quadlet runs its containers detached, with their output in a log,
#      which would keep the plaintext.
#   2. The dump streams straight into age, encrypted for ops/age-recipients.txt. The plaintext never
#      touches the disk, and the host holds no key that could decrypt what it wrote. On Podman the
#      dump container's log driver is `none`, like Compose's `logging: driver: none`: Podman stores
#      nothing, while an attached run still streams stdout through conmon. 2.33.0's check on a
#      local Podman 5.8.2 found that stream byte-exact, a multi-megabyte dump restorable, pull
#      progress kept off stdout, and a failing pg_dump's exit status returned by `podman run`, so
#      the passthrough driver (which hands the pipe itself to pg_dump) isn't needed.
#   3. curl uploads it to the Linode Object Storage bucket, signing with SigV4: daily/ every day,
#      and monthly/ on the 1st. The bucket's lifecycle rules expire old copies.
#   4. The host's .env is encrypted and uploaded as well (env/), keeping the off-host settings copy
#      current without the operator machine.
#   5. healthchecks.io hears /start, then success with the sizes, or /fail naming the failed step.
#
# Settings, read from the host's .env (single-line values): BACKUP_STORAGE_ENDPOINT (the bucket's
# URL, such as tarubot-backups.us-iad-18.linodeobjects.com; https:// is added when missing),
# BACKUP_STORAGE_ACCESS_KEY, BACKUP_STORAGE_SECRET_KEY, BACKUP_STORAGE_REGION (the SigV4 region,
# us-iad-2 by default; Linode accepts any) and HEALTHCHECKS_BACKUP_URL. Staging's .env names its
# own bucket, key and check under the same names, never production's. The bot's unit unsets all
# five (ops/quadlet/units/tarubot.container), so the bot never sees them.
# Secrets reach curl through --config on stdin, never through its arguments, which `ps` shows.
#
# `backup.sh quadlet` is part of ops/deploy.sh's `quadlet` contract (its header): its argv, its
# exit status (0 only once the dump and the settings copy are uploaded), the io.tarubot.role=backup
# label deploy.sh waits on, and its last stdout line, `<time> backup ok: tarubot-<stamp> (<n>
# bytes, settings <m> bytes)`, which deploy.sh's BACKUP_DONE reads. An incompatible change to any of
# them replaces that capability word.
set -Eeuo pipefail
umask 077

# The runtime comes from the one optional argument; nothing is detected.
case "$#:${1-}" in
  0:) readonly RUNTIME=compose ;;
  1:quadlet) readonly RUNTIME=quadlet ;;
  *)
    echo "usage: backup.sh [quadlet]" >&2
    exit 64
    ;;
esac

cd "$(dirname "$(readlink -f "$0")")/.."

readonly ENV_FILE=.env
readonly RECIPIENTS=ops/age-recipients.txt
compose() { docker compose -f docker-compose.production.yml "$@"; }
# Compose's backup image (postgres:18.4-alpine), fully qualified: Podman on EL enforces short-name
# resolution and has no terminal here to ask on. It is also pinned by its image index digest,
# because the container gets the database URL and CA and can reach the network, and a tag can
# move: every other image that sees a secret on a Quadlet host is pinned by digest too. Podman
# pulls by the digest and ignores the tag, which stays for the reader. A new PostgreSQL image is a
# release's change of this line. tests/unit/backup-quadlet.test.ts keeps the name and tag equal to
# Compose's and requires the digest.
readonly PG_IMAGE=docker.io/library/postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15

# One single-line setting from .env, without surrounding quotes; empty when unset.
setting() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

ENDPOINT=$(setting BACKUP_STORAGE_ENDPOINT)
case "$ENDPOINT" in "" | http://* | https://*) ;; *) ENDPOINT="https://$ENDPOINT" ;; esac
ENDPOINT=${ENDPOINT%/}
REGION=$(setting BACKUP_STORAGE_REGION)
REGION=${REGION:-us-iad-2}
ACCESS_KEY=$(setting BACKUP_STORAGE_ACCESS_KEY)
SECRET_KEY=$(setting BACKUP_STORAGE_SECRET_KEY)
PING_URL=$(setting HEALTHCHECKS_BACKUP_URL)

# Tell healthchecks.io how the run went: $1 is "", /start or /fail, $2 a short note. A ping that
# can't be delivered never fails the backup itself.
notify() {
  [ -n "$PING_URL" ] || return 0
  printf 'url = "%s%s"\n' "$PING_URL" "$1" |
    curl --config - --silent --show-error --fail --max-time 10 --retry 3 \
      --data-raw "$2" --output /dev/null || true
}

step=settings
trap 'notify /fail "backup failed at: $step"; echo "$(date -u +%FT%TZ) backup failed at: $step" >&2' ERR
for name in ENDPOINT ACCESS_KEY SECRET_KEY; do
  if [ -z "${!name}" ]; then
    echo "BACKUP_STORAGE_$name is not set in $ENV_FILE." >&2
    false
  fi
done
case "$ENDPOINT" in https://*) ;; *)
  echo "BACKUP_STORAGE_ENDPOINT must use https." >&2
  false
  ;;
esac
# Rootless Podman keeps its runtime state in the user's runtime directory. The user manager sets
# XDG_RUNTIME_DIR for the timer's service and deploy.sh's worker exports it; a shell without it
# gets /run/user/<uid>, which must be this user's own private directory (logind's, kept by
# lingering). The `|| true` keeps the ERR trap, which command substitutions inherit, from firing
# twice.
if [ "$RUNTIME" = quadlet ] && [ -z "${XDG_RUNTIME_DIR-}" ]; then
  uid=$(id -u)
  if [ "$(stat -c '%u %a %F' "/run/user/$uid" 2>/dev/null || true)" != "$uid 700 directory" ]; then
    echo "XDG_RUNTIME_DIR is not set, and /run/user/$uid is not this user's private directory." >&2
    false
  fi
  export XDG_RUNTIME_DIR="/run/user/$uid"
fi

# Upload file $1 to key $2 in the bucket; the credentials go to curl on stdin.
put() {
  printf 'user = "%s:%s"\n' "$ACCESS_KEY" "$SECRET_KEY" |
    curl --config - --silent --show-error --fail --max-time 300 --retry 3 \
      --aws-sigv4 "aws:amz:$REGION:s3" --upload-file "$1" --output /dev/null \
      "$ENDPOINT/$2"
}

notify /start "backup starting"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$RUNTIME" = quadlet ]; then
  # This release's secrets.sh reads .env itself and names settings only, never a value.
  step=secrets
  "$PWD/ops/quadlet/secrets.sh" sync "$PWD/.env" DATABASE_URL DATABASE_CA_CERT

  # The container's shell reads the URL from its secret file (single quotes: it expands there, not
  # here), and libpq reads the CA from its own. --read-only is what makes Podman mount both copies
  # read-only, and --read-only-tmpfs=false leaves no writable path: the job writes no file. The
  # label and name let deploy.sh's backup wait see the run. stdin is closed, so none of this
  # script's input reaches the container. `podman run` returns pg_dump's exit status, and pipefail
  # carries a failure into the ERR trap.
  step=dump
  podman run --rm --name "tarubot-backup-$stamp" --label io.tarubot.role=backup \
    --pull=missing --log-driver=none \
    --env-host=false --http-proxy=false --read-only --read-only-tmpfs=false --cap-drop=all \
    --security-opt=no-new-privileges \
    --secret tarubot-database-url,type=mount,target=/run/secrets/database_url,mode=0400 \
    --secret tarubot-database-ca-cert,type=mount,target=/run/secrets/database_ca_cert,mode=0400 \
    --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/database_ca_cert \
    --entrypoint sh "$PG_IMAGE" \
    -c 'exec pg_dump --format=custom --no-owner --no-privileges "$(cat /run/secrets/database_url)"' \
    </dev/null | age --encrypt --recipients-file "$RECIPIENTS" --output "$work/db.age"
else
  step=dump
  compose run --rm --no-deps -T backup | age --encrypt --recipients-file "$RECIPIENTS" --output "$work/db.age"
fi
db_bytes=$(stat -c %s "$work/db.age")
# A real custom-format dump of this database is far larger; a tiny file means pg_dump wrote nothing.
step="dump size ($db_bytes bytes)"
[ "$db_bytes" -gt 4096 ]

step=settings-copy
age --encrypt --recipients-file "$RECIPIENTS" --output "$work/env.age" "$ENV_FILE"
env_bytes=$(stat -c %s "$work/env.age")

step=upload
put "$work/db.age" "daily/tarubot-$stamp.dump.age"
if [ "$(date -u +%d)" = 01 ]; then put "$work/db.age" "monthly/tarubot-$stamp.dump.age"; fi
put "$work/env.age" "env/tarubot-env-$stamp.age"

notify "" "daily/tarubot-$stamp.dump.age: $db_bytes bytes; env/tarubot-env-$stamp.age: $env_bytes bytes"
echo "$(date -u +%FT%TZ) backup ok: tarubot-$stamp ($db_bytes bytes, settings $env_bytes bytes)"
