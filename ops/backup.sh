#!/usr/bin/env bash
# Compose-only encrypted database and settings backup. The owner supplies the
# private root .env, age recipients and offsite bucket credentials. No decryption
# key or plaintext dump is kept on the host. Deploy may select a worktree manifest
# using TARUBOT_COMPOSE_FILE while TARUBOT_ROOT keeps the settings central.
set -Eeuo pipefail
if (( $# != 0 )); then printf '%s\n' 'backup refused' >&2; exit 64; fi
umask 077
export LC_ALL=C
readonly ROOT=${TARUBOT_ROOT:-$HOME/tarubot}
readonly STATE=$HOME/.local/state/tarubot-deploy
readonly ENV_FILE=$ROOT/.env RECIPIENTS=$ROOT/ops/age-recipients.txt
[[ -f $ENV_FILE && ! -L $ENV_FILE && -O $ENV_FILE && $(stat -c '%a' "$ENV_FILE") == 600 ]]
mkdir -p "$STATE"
chmod 700 "$STATE"
# Deploy holds this same lock across stop, backup, migration and start. The held
# flag is private owner-controlled environment, never part of the SSH request.
if [[ ${TARUBOT_HOST_LOCK_HELD:-false} != true ]]; then
  exec 9>"$STATE/host.lock"
  flock -n 9 || { printf '%s\n' 'backup busy' >&2; exit 1; }
else
  [[ -e /proc/$$/fd/9 && $(readlink "/proc/$$/fd/9") == "$STATE/host.lock" ]]
  flock -n 9
fi
COMPOSE_FILE=${TARUBOT_COMPOSE_FILE:-}
if [[ -z $COMPOSE_FILE && -f $STATE/current ]]; then
  COMPOSE_FILE=$(jq -er '.worktree + "/docker-compose.production.yml"' "$STATE/current")
  export TARUBOT_IMAGE_DIGEST
  TARUBOT_IMAGE_DIGEST=$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' "$STATE/current")
fi
COMPOSE_FILE=${COMPOSE_FILE:-$ROOT/docker-compose.production.yml}
[[ -f $COMPOSE_FILE && -s $RECIPIENTS ]]
compose() {
  docker compose --project-name tarubot --project-directory "$ROOT" \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
# Read only named single-line backup settings, never source/eval the .env. Quoted
# values are supported, including curl config escaping; duplicates are refused.
setting() {
  local line value='' found=false
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$1="* ]]; then
      [[ $found == false ]] || return 1
      found=true
      value=${line#*=}
      if [[ $value == \"*\" || $value == \'*\' ]]; then value=${value:1:${#value}-2}; fi
      [[ $value != *$'\r'* ]] || return 1
    fi
  done <"$ENV_FILE"
  printf '%s' "$value"
}
ENDPOINT=$(setting BACKUP_STORAGE_ENDPOINT)
case "$ENDPOINT" in https://*) ;; *) ENDPOINT=https://$ENDPOINT ;; esac
ENDPOINT=${ENDPOINT%/}
REGION=$(setting BACKUP_STORAGE_REGION)
REGION=${REGION:-us-iad-2}
ACCESS_KEY=$(setting BACKUP_STORAGE_ACCESS_KEY)
SECRET_KEY=$(setting BACKUP_STORAGE_SECRET_KEY)
PING_URL=$(setting HEALTHCHECKS_BACKUP_URL)
[[ -n $ACCESS_KEY && -n $SECRET_KEY ]]
[[ $ENDPOINT =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$ ]]
[[ $REGION =~ ^[a-z0-9-]+$ ]]
[[ -z $PING_URL || $PING_URL =~ ^https://[A-Za-z0-9./_-]+$ ]]
config_value() {
  local value=$2
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s = "%s"\n' "$1" "$value"
}
notify() {
  [[ -n $PING_URL ]] || return 0
  config_value url "$PING_URL$1" |
    curl --config - --silent --show-error --fail --max-time 10 --retry 3 \
      --data-raw "$2" --output /dev/null || true
}
step=settings
work=
cleanup() {
  local code=$?
  trap - EXIT HUP INT TERM PIPE
  [[ -z $work ]] || rm -rf "$work"
  if (( code != 0 )); then
    notify /fail "backup failed at: $step"
    printf 'backup failed at: %s\n' "$step" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE
put() {
  config_value user "$ACCESS_KEY:$SECRET_KEY" |
    curl --config - --silent --show-error --fail --max-time 300 --retry 3 \
      --aws-sigv4 "aws:amz:$REGION:s3" --upload-file "$1" --output /dev/null \
      "$ENDPOINT/$2"
}
notify /start 'backup starting'
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
step=dump
compose run --rm --no-deps -T backup |
  age --encrypt --recipients-file "$RECIPIENTS" --output "$work/db.age"
db_bytes=$(stat -c %s "$work/db.age")
[[ $db_bytes -gt 4096 ]]
step=settings-copy
age --encrypt --recipients-file "$RECIPIENTS" --output "$work/env.age" "$ENV_FILE"
env_bytes=$(stat -c %s "$work/env.age")
[[ $env_bytes -gt 0 ]]
step=upload
put "$work/db.age" "daily/tarubot-$stamp.dump.age"
if [[ $(date -u +%d) == 01 ]]; then put "$work/db.age" "monthly/tarubot-$stamp.dump.age"; fi
put "$work/env.age" "env/tarubot-env-$stamp.age"
notify '' "daily/tarubot-$stamp.dump.age: $db_bytes bytes; env/tarubot-env-$stamp.age: $env_bytes bytes"
printf 'backup ok: tarubot-%s\n' "$stamp"
