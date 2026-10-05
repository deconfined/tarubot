#!/usr/bin/env bash
# Install a reviewed copy at ~/.local/libexec/tarubot-deploy and use it as the
# deploy key's restricted forced command. Never point the key at a release worktree.
# The owner controls HOME, PATH and the clone's origin; sshd must not accept client
# environment overrides. No settings or deployment entry are changed by this script.
set -Eeuo pipefail

readonly FORM='^deploy (production|staging) ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19})$'
# The owner binds the target in authorized_keys, never in client environment.
# Validate before filesystem access, locks or subprocesses, including positional argv.
if (( $# != 1 )) || [[ $1 != production && $1 != staging ]] ||
  [[ ! ${SSH_ORIGINAL_COMMAND-} =~ $FORM ]]; then
  printf '%s\n' 'result refused'
  exit 64
fi
if [[ $1 != "${BASH_REMATCH[1]}" ]]; then printf '%s\n' 'result refused'; exit 64; fi
readonly DEPLOY_TARGET=$1 VERSION=${BASH_REMATCH[2]} COMMIT=${BASH_REMATCH[6]}
readonly DIGEST=${BASH_REMATCH[7]} RUN=${BASH_REMATCH[8]}
readonly IMAGE=ghcr.io/deconfined/tarubot
readonly ROOT=$HOME/tarubot STATE=$HOME/.local/state/tarubot-deploy
readonly WORKTREE=$STATE/releases/$RUN-$COMMIT
readonly REF=$IMAGE@$DIGEST
export LC_ALL=C
umask 077
# Keep even setup errors off the SSH channel. fd 3 is the sole public output.
exec 3>&1 1>/dev/null 2>/dev/null
mkdir -p "$STATE/logs" "$STATE/releases" || { printf '%s\n' 'result refused' >&3; exit 1; }
chmod 700 "$STATE" "$STATE/logs" "$STATE/releases"
exec >>"$STATE/logs/$RUN-$(date -u +%Y%m%dT%H%M%SZ)-$$.log" 2>&1
boundary=false
finished=false
step=preflight
public_step() { step=$1; printf 'step %s\n' "$step" >&3; }
refuse() { finished=true; printf '%s\n' 'result refused' >&3; exit 1; }
compose() {
  TARUBOT_IMAGE_DIGEST=$DIGEST TARUBOT_RESTART_POLICY=no timeout --kill-after=10 300 docker compose \
    --project-name tarubot --project-directory "$ROOT" --env-file "$ROOT/.env" \
    -f "$WORKTREE/docker-compose.$DEPLOY_TARGET.yml" "$@"
}
bot_ids() {
  timeout --kill-after=5 30 docker ps -aq \
    --filter label=com.docker.compose.project=tarubot \
    --filter label=com.docker.compose.service=tarubot
}
stop_writers() {
  local ids running
  ids=$(bot_ids) || return 1
  if [[ -n $ids ]]; then
    local -a containers
    mapfile -t containers <<<"$ids"
    timeout --kill-after=5 90 docker stop --time 40 "${containers[@]}" || return 1
  fi
  running=$(timeout --kill-after=5 30 docker ps -q \
    --filter label=com.docker.compose.project=tarubot \
    --filter label=com.docker.compose.service=tarubot) || return 1
  [[ -z $running ]]
}
finish() {
  local code=$?
  trap - EXIT HUP INT TERM PIPE
  if [[ $finished != true ]]; then
    printf 'Failure at %s (status %s)\n' "$step" "$code"
    if [[ $boundary == true ]]; then
      # The schema or Discord registration may already have changed. Never restart
      # an old writer; also stop a partially started target and migration one-offs.
      stop_writers || printf '%s\n' 'Owner must confirm that every writer is stopped.'
      printf '%s\n' 'result needs-owner' >&3
    else
      printf '%s\n' 'result refused' >&3
    fi
    (( code != 0 )) || code=1
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE
# Write then fsync the file and containing filesystem before crossing the boundary.
durable_record() {
  local destination=$1
  jq -n --arg target "$DEPLOY_TARGET" --arg version "$VERSION" --arg commit "$COMMIT" --arg digest "$DIGEST" \
    --arg run "$RUN" --arg worktree "$WORKTREE" --arg schema "$SCHEMA" \
    '{target:$target,version:$version,commit:$commit,digest:$digest,run:$run,worktree:$worktree,schema:$schema}' \
    >"$destination.tmp"
  sync -f "$destination.tmp"
  mv "$destination.tmp" "$destination"
  sync -f "$STATE"
}
public_step preflight
for tool in docker git jq flock timeout sync; do command -v "$tool"; done
[[ -d $ROOT/.git && -f $ROOT/.env && ! -L $ROOT/.env ]]
[[ $(stat -c '%a' "$ROOT/.env") == 600 && -O $ROOT/.env ]]
exec 9>"$STATE/host.lock"
flock -n 9 || refuse
[[ ! -e $STATE/pending && ! -L $STATE/pending ]] || refuse
if [[ -e $STATE/current || -L $STATE/current ]]; then
  [[ -f $STATE/current && ! -L $STATE/current ]] || refuse
  jq -e --arg target "$DEPLOY_TARGET" '.target == $target' "$STATE/current" || refuse
fi
# These compiled guards only inspect settings: no Database, Discord client or
# writer lease is constructed. Declare the future registration/database scope.
readonly SCOPE_CHECK='
  const target = process.argv.at(-1);
  const {assertToolScope,databaseIdentity} = await import("./dist/src/config/deployment.js");
  const {secretSetting} = await import("./dist/src/config/secrets.js");
  const registrationScope = target === "production" ? "global" : process.env.TEST_GUILD_ID;
  const deployment = assertToolScope(process.env, {
    tool: "deploy preflight", guilds: target === "staging" ? [registrationScope] : [],
    discord: "write", databases: ["DATABASE_URL"],
    globalCommands: target === "production", registerScope: registrationScope
  });
  if (deployment.name !== target || process.env.TARUBOT_ENVIRONMENT !== target) throw Error("target");
  console.log(JSON.stringify({
    target: deployment.name, applicationId: deployment.applicationId,
    guilds: deployment.guilds, registrationScope: deployment.registrationScope,
    database: databaseIdentity(secretSetting(process.env, "DATABASE_URL"))
  }));
'
# One ordinary running writer is required. Bootstrap/recovery is owner work.
CID=$(bot_ids)
[[ $CID =~ ^[0-9a-f]{12,64}$ ]] || refuse
LIVE=$(timeout --kill-after=5 30 docker inspect "$CID")
jq -e 'length == 1 and .[0].State.Running == true and .[0].State.Health.Status == "healthy" and .[0].Config.Labels["com.docker.compose.oneoff"] == "False"' <<<"$LIVE"
LIVE_VERSION=$(jq -er '.[0].Config.Labels["org.opencontainers.image.version"]' <<<"$LIVE")
LIVE_COMMIT=$(jq -er '.[0].Config.Labels["org.opencontainers.image.revision"]' <<<"$LIVE")
[[ $LIVE_VERSION =~ ^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$ && $LIVE_COMMIT =~ ^[0-9a-f]{40}$ ]]
LIVE_ID=$(jq -er '.[0].Image' <<<"$LIVE")
LIVE_IMAGE=$(timeout --kill-after=5 30 docker image inspect "$LIVE_ID")
# A successful durable record is authoritative for the index digest; first
# installation requires the running image to have one unambiguous upstream digest.
if [[ -f $STATE/current ]]; then
  jq -e --arg version "$LIVE_VERSION" --arg commit "$LIVE_COMMIT" \
    '.version == $version and .commit == $commit and (.digest | test("^sha256:[0-9a-f]{64}$"))' "$STATE/current"
  LIVE_DIGEST=$(jq -er .digest "$STATE/current")
  jq -e --arg ref "$IMAGE@$LIVE_DIGEST" '.[0].RepoDigests | index($ref) != null' <<<"$LIVE_IMAGE"
else
  LIVE_REF=$(jq -er --arg prefix "$IMAGE@sha256:" \
    '[.[0].RepoDigests[] | select(startswith($prefix))] | if length == 1 then .[0] else error("ambiguous live digest") end' <<<"$LIVE_IMAGE")
  LIVE_DIGEST=${LIVE_REF#"$IMAGE@"}
  [[ $LIVE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]]
fi
LIVE_SCOPE=$(timeout --kill-after=5 45 docker exec "$CID" bun -e "$SCOPE_CHECK" "$DEPLOY_TARGET")
IFS=. read -r -a wanted <<<"$VERSION"
IFS=. read -r -a live <<<"$LIVE_VERSION"
for i in 0 1 2; do
  (( 10#${wanted[i]} >= 10#${live[i]} )) || refuse
  if (( 10#${wanted[i]} > 10#${live[i]} )); then break; fi
done
if [[ $VERSION == "$LIVE_VERSION" ]]; then
  [[ $COMMIT == "$LIVE_COMMIT" && $DIGEST == "$LIVE_DIGEST" ]] || refuse
fi
public_step fetch
timeout --kill-after=10 120 git -C "$ROOT" fetch --no-tags origin main
[[ $(git -C "$ROOT" cat-file -t "$COMMIT") == commit ]]
git -C "$ROOT" merge-base --is-ancestor "$COMMIT" FETCH_HEAD
[[ ! -e $WORKTREE ]]
git -C "$ROOT" worktree add --detach "$WORKTREE" "$COMMIT"
[[ $(jq -er .version "$WORKTREE/package.json") == "$VERSION" ]]
SCHEMA=
for migration in "$WORKTREE"/migrations/[0-9][0-9][0-9]_*.sql; do
  [[ -f $migration && ${migration##*/} =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]
  SCHEMA=${migration##*/}
done
[[ -n $SCHEMA ]]
public_step pull
timeout --kill-after=10 180 docker pull "$REF"
TARGET=$(timeout --kill-after=5 30 docker image inspect "$REF")
jq -e --arg ref "$REF" --arg version "$VERSION" --arg commit "$COMMIT" \
  'length == 1 and (.[0].RepoDigests | index($ref) != null) and .[0].Config.Labels["org.opencontainers.image.version"] == $version and .[0].Config.Labels["org.opencontainers.image.revision"] == $commit' <<<"$TARGET"
TARGET_ID=$(jq -er '.[0].Id' <<<"$TARGET")
[[ $TARGET_ID =~ ^sha256:[0-9a-f]{64}$ ]]
# Compose omits inactive profiles from config; inspect the client without starting it.
CONFIG=$(compose --profile backup config --format json)
jq -e --arg wanted "$VERSION" --arg live "$LIVE_VERSION" --arg ref "$REF" --arg target "$DEPLOY_TARGET" \
  '.services.tarubot as $bot | .services.backup as $backup |
   $bot.image == $ref and $bot.environment.TARUBOT_ENVIRONMENT == $target and
   ($wanted == $live or $bot.restart == "no") and
   $backup.environment.DATABASE_URL == $bot.environment.DATABASE_URL and
   $backup.environment.DATABASE_CA_CERT == $bot.environment.DATABASE_CA_CERT and
   $backup.environment.PGSSLMODE == "verify-full" and ($backup.profiles | index("backup") != null)' <<<"$CONFIG"
CANDIDATE_SCOPE=$(compose run --rm --no-deps --pull never -T tarubot bun -e "$SCOPE_CHECK" "$DEPLOY_TARGET")
[[ $LIVE_SCOPE == "$CANDIDATE_SCOPE" ]] || refuse
REGISTRATION_SCOPE=$(jq -er .registrationScope <<<"$CANDIDATE_SCOPE")
# Each sample checks the same container, unchanged restart counter, local image
# ID, requested immutable digest, labels, ready writer and actual schema checksum.
observe() {
  local snapshot
  [[ $(bot_ids) == "$CID" ]]
  snapshot=$(timeout --kill-after=5 30 docker inspect "$CID")
  jq -e --arg id "$TARGET_ID" --arg ref "$REF" --arg version "$VERSION" \
    --arg commit "$COMMIT" --argjson restarts "$RESTARTS" \
    'length == 1 and .[0].Image == $id and .[0].Config.Image == $ref and .[0].RestartCount == $restarts and .[0].State.Running == true and .[0].State.Health.Status == "healthy" and .[0].Config.Labels["org.opencontainers.image.version"] == $version and .[0].Config.Labels["org.opencontainers.image.revision"] == $commit' <<<"$snapshot"
  timeout --kill-after=5 45 docker exec "$CID" bun -e '
    const [version,schema] = process.argv.slice(-2);
    const {Database,SCHEMA_VERSION} = await import("./dist/src/infrastructure/postgres/database.js");
    if (JSON.parse(await Bun.file("package.json").text()).version !== version || SCHEMA_VERSION !== schema) throw Error("identity");
    const db = new Database(process.env.DATABASE_URL);
    try { await db.schema(schema); } finally { await db.close(); }
    const r = await fetch("http://localhost:3000/health/ready");
    const s = await r.json();
    if (!r.ok || !s.live || !s.ready || !s.database || !s.writerLease || !s.discord) throw Error("not ready");
  ' "$VERSION" "$SCHEMA"
}
if [[ $VERSION == "$LIVE_VERSION" ]]; then
  [[ $TARGET_ID == "$LIVE_ID" ]]
  # Existing deployments may name a tag; never rewrite them as a side effect of
  # an already-live request. New deployments must name the exact digest.
  [[ $(jq -er '.[0].Config.Image' <<<"$LIVE") == "$REF" ]] || refuse
  RESTARTS=$(jq -er '.[0].RestartCount' <<<"$LIVE")
  public_step observe
  observe
  sleep 30
  observe
  durable_record "$STATE/current"
  timeout --kill-after=5 30 docker update --restart unless-stopped "$CID"
  finished=true
  printf '%s\n' 'result already-live' >&3
  exit 0
fi
# Set the trap boundary BEFORE writing pending: an uncertain fsync/write is never
# permission to continue an old writer. This marker is cleared only after success.
boundary=true
durable_record "$STATE/pending"
public_step stop
stop_writers
public_step backup
TARUBOT_ROOT=$ROOT TARUBOT_COMPOSE_FILE=$WORKTREE/docker-compose.$DEPLOY_TARGET.yml \
  TARUBOT_IMAGE_DIGEST=$DIGEST TARUBOT_HOST_LOCK_HELD=true \
  timeout --kill-after=10 900 bash "$WORKTREE/ops/backup.sh" "$DEPLOY_TARGET"
public_step migrate
# migrate.js uses the existing transactional migration/writer lease guard.
compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/migrate.js
public_step register
if [[ $DEPLOY_TARGET == production ]]; then
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --global
else
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --guild "$REGISTRATION_SCOPE"
fi
public_step start
compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 tarubot
CID=$(bot_ids)
[[ $CID =~ ^[0-9a-f]{12,64}$ ]]
SNAPSHOT=$(timeout --kill-after=5 30 docker inspect "$CID")
RESTARTS=$(jq -er '.[0].RestartCount' <<<"$SNAPSHOT")
jq -e '.[0].HostConfig.RestartPolicy.Name == "no"' <<<"$SNAPSHOT"
public_step observe
observe
# Require sustained readiness, rather than a momentary successful health check.
for ((sample=0; sample<3; sample++)); do sleep 10; observe; done
public_step record
durable_record "$STATE/current"
# Only a durably observed/accepted image may automatically resume after host loss.
# Keep pending until this update succeeds; failure still fences the writer.
timeout --kill-after=5 30 docker update --restart unless-stopped "$CID"
rm "$STATE/pending"
sync -f "$STATE"
boundary=false
finished=true
printf '%s\n' 'result deployed' >&3
