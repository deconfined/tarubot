#!/usr/bin/env bash
# Install a reviewed copy at ~/.local/libexec/tarubot-deploy and use it as the
# deploy key's restricted forced command. Never point the key at a release worktree.
# The owner controls HOME, PATH and the clone's origin; sshd must not accept client
# environment overrides. No settings or deployment entry are changed by this script.
set -Eeuo pipefail

readonly FORM='^deploy (production|staging) ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19})$'
# The owner binds the target in authorized_keys, never in client environment.
# Validate before filesystem access, locks or subprocesses, including positional argv.
# Each refusal names a fixed code: ops/deploy-ssh.sh relays `reason` lines of one strict shape.
if (( $# != 1 )) || [[ $1 != production && $1 != staging ]]; then
  printf '%s\n' 'reason refused step=request code=entry-target' 'result refused'
  exit 64
fi
if [[ ! ${SSH_ORIGINAL_COMMAND-} =~ $FORM ]]; then
  printf '%s\n' 'reason refused step=request code=request-form' 'result refused'
  exit 64
fi
if [[ $1 != "${BASH_REMATCH[1]}" ]]; then
  printf '%s\n' 'reason refused step=request code=target-mismatch' 'result refused'
  exit 64
fi
readonly DEPLOY_TARGET=$1 VERSION=${BASH_REMATCH[2]} COMMIT=${BASH_REMATCH[6]}
readonly DIGEST=${BASH_REMATCH[7]} RUN=${BASH_REMATCH[8]}
readonly IMAGE=ghcr.io/deconfined/tarubot
readonly ROOT=$HOME/tarubot STATE=$HOME/.local/state/tarubot-deploy
readonly WORKTREE=$STATE/releases/$RUN-$COMMIT
readonly REF=$IMAGE@$DIGEST
readonly ENTRY=${BASH_SOURCE[0]}
export LC_ALL=C
umask 077
# Keep even setup errors off the SSH channel. fd 3 is the sole public output.
exec 3>&1 1>/dev/null 2>/dev/null
mkdir -p "$STATE/logs" "$STATE/releases" ||
  { printf '%s\n' 'reason refused step=preflight code=state-directory' 'result refused' >&3; exit 1; }
chmod 700 "$STATE" "$STATE/logs" "$STATE/releases" ||
  { printf '%s\n' 'reason refused step=preflight code=state-directory' 'result refused' >&3; exit 1; }
LOG=$STATE/logs/$RUN-$(date -u +%Y%m%dT%H%M%SZ || :)-$$.log
readonly LOG
exec >>"$LOG" 2>&1
boundary=false
finished=false
step=preflight
signal=''
# Public diagnostics (2026-10-10): the owner asked that a failed delivery say why. Each check sets
# FAILED_CHECK before it runs, so the EXIT trap can name the one that failed. LOG_MARK is where
# this step's output starts in the private log, and READINESS holds the observation probe's line.
FAILED_CHECK=''
LOG_MARK=0
READINESS=''
REASON=''
REASONS=()
# The only shape a diagnostic may take on the public channel; ops/deploy-ssh.sh enforces it again.
# `reason <kind>` then key=value pairs: bare values from a small set, quoted text in printable
# ASCII without quotes, %, #, backticks, @, $ or brackets, and never `::`, so a relayed line can't
# act as a workflow command. A line that doesn't fit leaves as `reason malformed`, never repaired.
readonly REASON_FORM="^reason [a-z][a-z-]{0,23}( [A-Za-z][A-Za-z0-9_-]{0,23}=(\"[A-Za-z0-9 _.,:;!?()/+=<>'-]{0,160}\"|[A-Za-z0-9._-]{1,64})){0,16}\$"
reason_line() {
  REASON="reason $1"
  if (( ${#REASON} > 400 )) || [[ ! $REASON =~ $REASON_FORM || $REASON == *::* ]]; then
    REASON='reason malformed'
  fi
}
public_reason() { reason_line "$1"; printf '%s\n' "$REASON" >&3; }
# The EXIT trap holds its reasons until the writer is fenced: a closed channel then can't stop it.
held_reason() { reason_line "$1"; REASONS+=("$REASON"); }
public_step() {
  step=$1
  FAILED_CHECK=''
  LOG_MARK=$(stat -c %s "$LOG") || LOG_MARK=0
  printf 'step %s\n' "$step" >&3
}
refuse() {
  finished=true
  public_reason "refused step=$step code=$1"
  printf '%s\n' 'result refused' >&3
  exit 1
}
compose() {
  TARUBOT_IMAGE_DIGEST=$DIGEST TARUBOT_RESTART_POLICY=no timeout --kill-after=10 300 docker compose \
    --project-name tarubot --project-directory "$WORKTREE" --env-file "$ROOT/.env" \
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
# Container facts, safe by construction: integers, booleans and Docker's own health word. Every
# jq pattern here anchors with \A and \z: Oniguruma's ^ and $ also match beside a newline, so a
# value ending in one would otherwise pass and split the line it's printed on.
readonly FACTS_JQ='
  def number($value; $pattern):
    ($value | tostring) as $text | if ($text | test($pattern)) then $text else "unknown" end;
  def instant: tostring | sub("\\.[0-9]+"; "") | (try fromdateiso8601 catch null);
  .[0] | select(type == "object")
  | (.State.StartedAt // "" | instant) as $start
  | (if .State.Running == true then now else (.State.FinishedAt // "" | instant) end) as $end
  | (if ($start | type) == "number" and ($end | type) == "number" and $start > 0 and $end >= $start
     then ($end - $start | floor) else null end) as $uptime
  | (.State.Health.Status // "none" | tostring) as $health
  | "\($kind) exit=\(number(.State.ExitCode; "\\A-?[0-9]{1,3}\\z")) oom=\(.State.OOMKilled == true)"
    + " restarts=\(number(.RestartCount; "\\A[0-9]{1,5}\\z"))"
    + " health=\(if ($health | test("\\A[a-z]{1,16}\\z")) then $health else "unknown" end)"
    + " running=\(.State.Running == true) uptime=\(number($uptime; "\\A[0-9]{1,9}\\z"))"
'
# The observation probe's flags as booleans, its HTTP status as a number and its codes only when
# they look like codes (ECONNREFUSED, 28P01, TokenInvalid, schema), never a message.
readonly READINESS_JQ='
  def code:
    if type == "string" and length <= 40 and
      test("\\A([A-Z][A-Z_]{1,39}|[A-Z][a-z]+([A-Z][a-z]+)*|[a-z][a-z_]{1,39}|[0-9A-Z]{5})\\z")
    then . else null end;
  select(type == "object")
  | "readiness identity=\(.identity == true) schema=\(.schema == true)"
    + (if (.http | type) == "number" and .http >= 100 and .http <= 599 and (.http | floor) == .http
       then " http=\(.http) live=\(.live == true) ready=\(.ready == true) database=\(.database == true)"
         + " writerLease=\(.writerLease == true) discord=\(.discord == true)"
       else " http=none" end)
    + ([("identityCode", "schemaCode", "readinessCode") as $key
        | (.[$key] | code) as $value | select($value != null) | " \($key)=\($value)"] | join(""))
'
# The bot's own last errors, from raw log lines: pino records at level 50 (error) or above and
# Bun's report of an uncaught error. Only the developer-fixed `msg`, a code-shaped code, an
# error class name and a named operation are kept, never err.message, a stack, a URL or user
# text. msg is cleaned anyway, and the order of the rules is part of their safety:
# 1. Bound the work first, dropping a word cut in two so no fragment of it survives.
# 2. Replace a whole word (space-delimited) holding any character outside the public set, a
#    control character or non-ASCII included. Never delete a character on its own: the pieces
#    around it would join into something no later rule recognises (Xk9$mQ2#pL7 -> Xk9mQ2pL7).
# 3. Then URLs, key=value values, dotted names and addresses, IPv6 addresses, long words, mixed
#    letter-and-digit words, and digit runs of six or more digits in all, even split by
#    separators (3000 0000 0000 0000 42). Whole words go before digit runs: the other order
#    would split a token into short fragments. IPv6 (a run of hex digits and two or more colons
#    holding a decimal digit, so `::add-mask` is left alone) goes before `::` is collapsed.
# 4. Collapse `::` and spaces, and cut to 120 characters only after everything is redacted.
# The patterns assume jq 1.7's regex behaviour; bot_errors checks that first (CLEAN_SAMPLE).
readonly BOT_ERRORS_JQ='
  def clean:
    tostring
    | if length > 4096 then .[0:4096] | sub("[^ ]*\\z"; "") else . end
    | gsub("(?<![^ ])[^ ]*[^A-Za-z0-9 _.,:;!?()/+=<>'"'"'-][^ ]*"; "<redacted>")
    | gsub("[A-Za-z][A-Za-z0-9+.-]*://[^ ]*"; "<url>")
    | gsub("(?<key>[A-Za-z_][A-Za-z0-9_]*)=[^ ]+"; "\(.key)=<redacted>")
    | gsub("[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+"; "<redacted>")
    | gsub("(?<![0-9A-Za-z_:])(?=[0-9A-Fa-f:]*[0-9])[0-9A-Fa-f]*(:[0-9A-Fa-f]*){2,}(?![0-9A-Za-z_:])"; "<ip>")
    | gsub("[A-Za-z0-9_+/=-]{24,}"; "<redacted>")
    | gsub("\\b(?=[A-Za-z_-]*[0-9])(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\\b"; "<redacted>")
    | gsub("(?<run>[0-9]+([ ._:/,-]{1,2}[0-9]+)*)";
        if ([.run | scan("[0-9]")] | length) >= 6 then "<n>" else .run end)
    | gsub(":{2,}"; ":")
    | gsub(" {2,}"; " ")
    | .[0:120]
    | sub("\\A +"; "")
    | sub(" +\\z"; "");
  def code:
    (if type == "number" then tostring else . end)
    | if type == "string" and length <= 40 and
        test("\\A([A-Z][A-Z_]{1,39}|[A-Z][a-z]+([A-Z][a-z]+)*|[a-z][a-z_]{1,39}|[0-9A-Z]{5}|[0-9]{1,5})\\z")
      then . else null end;
  def kind: if type == "string" and test("\\A[A-Z][A-Za-z]{1,39}\\z") then . else null end;
  def operation: if type == "string" and test("\\A[a-z][a-z-]{1,31}\\z") then . else null end;
  [inputs] as $lines
  | [range(0; $lines | length) as $i | $lines[$i] as $line
     | if ($line | startswith("{")) then
         ($line | fromjson? // null)
         | select(type == "object" and (.level | type) == "number" and .level >= 50)
         | (if (.err | type) == "object" then .err else {} end) as $err
         | {msg: (if (.msg | type) == "string" then (.msg | clean) else "" end),
            code: (($err.code // .code) | code),
            kind: (($err.type // $err.name // .source) | kind),
            operation: (.operation | operation)}
       elif ($line | test("^(error|Failure|[A-Z][A-Za-z0-9]{0,40}(Error|Exception)): ")) then
         {msg: "uncaught error",
          kind: ($line | capture("^(?<name>[A-Za-z0-9]+): ") | .name
                 | if . == "error" then "Error" else . end | kind),
          code: ([$lines[$i + 1:$i + 10][] | capture("\\A +code: \"(?<value>[^\"]{1,40})\",?\\z") | .value]
                 | first | code),
          operation: null}
       else empty end]
  | .[-3:][]
  | "bot-error" + (if .msg != "" then " msg=\"\(.msg)\"" else "" end)
    + (if .code then " code=\(.code)" else "" end) + (if .kind then " type=\(.kind)" else "" end)
    + (if .operation then " op=\(.operation)" else "" end)
'
# A fixed sample and what the cleaner must make of it. A jq or regex engine that cleans it any
# other way, fails or times out (an unsupported jq, say) gets no say: the bot's errors then leave
# only as `msg="unavailable"`, never as text cleaned by rules that may not hold.
readonly CLEAN_SAMPLE='{"level":50,"msg":"a https://h.example/x k=v h.example.org 2600:db8::1 aaaaaaaaaaaaaaaaaaaaaaaa abc123def456 3000 0000 42 p#w ok::ok  end ","code":"ECONNREFUSED\n"}'
readonly CLEAN_EXPECTED='bot-error msg="a <url> k=<redacted> <redacted> <ip> <redacted> <redacted> <n> <redacted> ok:ok end"'
# <container id> <kind> <seconds>
container_facts() {
  local snapshot
  [[ $1 =~ ^[0-9a-f]{12,64}$ ]] || return 0
  snapshot=$(timeout --kill-after=2 "$3" docker inspect "$1") || return 0
  jq -r --arg kind "$2" "$FACTS_JQ" <<<"$snapshot" || return 0
}
# <raw log text> <seconds>
bot_errors() {
  local line
  if [[ $(timeout --kill-after=2 "$2" jq -rRn "$BOT_ERRORS_JQ" <<<"$CLEAN_SAMPLE") != "$CLEAN_EXPECTED" ]]; then
    held_reason 'bot-error msg="unavailable"'
    return 0
  fi
  while IFS= read -r line; do
    held_reason "$line"
  done < <(timeout --kill-after=2 "$2" jq -rRn "$BOT_ERRORS_JQ" <<<"$1")
}
# This step's private log output, for the bot's own errors and backup.sh's failed stage.
step_output() { tail -c +"$((LOG_MARK + 1))" "$LOG" | tail -n 400; }
# Gather the public reasons for a failure before the writer is fenced, so container facts describe
# the failed release rather than this entry's own stop. finish calls it as `diagnose || :`, with
# HUP, INT and TERM ignored: nothing here can stop the trap or the fence after it. Every Docker
# and jq call is bounded, to 10 seconds past the writer boundary so the fence starts soon, and
# after a signal fencing starts at once.
diagnose() {
  local code=$1 check=${FAILED_CHECK:-unlabelled} extra='' id='' facts='' proxy='' probe='' text=''
  local wait=30
  if [[ $boundary == true ]]; then wait=10; fi
  if [[ $code == 124 || $code == 137 ]]; then extra+=' timeout=true'; fi
  if [[ -n $signal ]]; then
    held_reason "failed step=$step check=$check status=$code signal=$signal"
    return 0
  fi
  if [[ $check == probe && -n $READINESS ]]; then
    probe=${READINESS##*$'\n'}
    case $(jq -r '.check' <<<"$probe") in
      identity) check=identity ;;
      schema) check=schema-checksum ;;
      readiness) check=readiness ;;
    esac
  fi
  case $step in
    start | observe | record)
      id=$(timeout --kill-after=2 "$wait" docker ps -aq \
        --filter label=com.docker.compose.project=tarubot \
        --filter label=com.docker.compose.service=tarubot) ;;
    preflight) if [[ $check == live-inspect || $check == live-health ]]; then id=${CID:-}; fi ;;
  esac
  if [[ $id =~ ^[0-9a-f]{12,64}$ ]]; then
    facts=$(container_facts "$id" container "$wait")
    printf 'Bot container for diagnosis: %s\n' "$id"
  else id=''; fi
  if [[ $check == proxy-* ]]; then
    proxy=$(timeout --kill-after=2 "$wait" docker ps -aq \
      --filter label=com.docker.compose.project=tarubot \
      --filter label=com.docker.compose.service=caddy)
    proxy=$(container_facts "$proxy" proxy "$wait")
  fi
  if [[ $check == health && $facts =~ \ health=([a-z]+) ]]; then extra+=" health=${BASH_REMATCH[1]}"; fi
  if [[ $check == proxy-health && $proxy =~ \ health=([a-z]+) ]]; then extra+=" health=${BASH_REMATCH[1]}"; fi
  held_reason "failed step=$step check=$check status=$code$extra"
  # Bash parses as it runs: a line this entry can't parse ends it with status 2 when reached.
  if [[ $code == 2 ]]; then
    text=$(step_output | grep -m 1 -F -- "$ENTRY: line ")
    if [[ $text =~ ^.*:\ line\ ([0-9]{1,6}):\ syntax\ error ]]; then
      held_reason "entry syntax=invalid line=${BASH_REMATCH[1]}"
    fi
  fi
  if [[ -n $facts ]]; then held_reason "$facts"; fi
  if [[ -n $proxy ]]; then held_reason "$proxy"; fi
  if [[ -n $probe ]]; then
    text=$(jq -r "$READINESS_JQ" <<<"$probe")
    if [[ -n $text ]]; then held_reason "$text"; fi
  fi
  if [[ -n $id ]]; then
    text=$(timeout --kill-after=2 "$wait" docker logs --tail 200 "$id" 2>&1 | tail -c 262144)
    bot_errors "$text" "$wait"
  else
    case $step in
      preflight | pull | migrate | register) bot_errors "$(step_output)" "$wait" ;;
      backup)
        text=$(step_output | grep -E -x 'backup (failed at: [a-z-]{1,24}|refused|busy)' | tail -n 1)
        text=${text#backup }
        if [[ -n $text ]]; then held_reason "backup stage=${text#failed at: }"; fi ;;
    esac
  fi
  return 0
}
finish() {
  local code=$?
  trap - EXIT PIPE
  # Ignore HUP, INT and TERM from here to the end, as the runner's cleanup does: a dropped session
  # or a stop request during diagnosis must not end the entry before it fences the writer.
  trap '' HUP INT TERM
  if [[ $finished != true ]]; then
    printf 'Failure at %s (status %s)\n' "$step" "$code"
    diagnose "$code" || :
    if [[ $boundary == true ]]; then
      # The schema or Discord registration may already have changed. Never restart
      # an old writer; also stop a partially started target and migration one-offs.
      if stop_writers; then
        held_reason 'fence writers=stopped'
      else
        printf '%s\n' 'Owner must confirm that every writer is stopped.'
        held_reason 'fence writers=unconfirmed'
      fi
      if (( ${#REASONS[@]} > 0 )); then printf '%s\n' "${REASONS[@]}" >&3; fi
      printf '%s\n' 'result needs-owner' >&3
    else
      if (( ${#REASONS[@]} > 0 )); then printf '%s\n' "${REASONS[@]}" >&3; fi
      printf '%s\n' 'result refused' >&3
    fi
    (( code != 0 )) || code=1
  fi
  exit "$code"
}
trap finish EXIT
trap 'signal=HUP; exit 129' HUP
trap 'signal=INT; exit 130' INT
trap 'signal=TERM; exit 143' TERM
trap 'signal=PIPE; exit 141' PIPE
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
# Identify this entry and parse all of it before anything else (2026-10-10). Bash reads a script
# as it runs, so a damaged installed copy once got past the writer boundary before failing on its
# broken line. Only the hash and a line number leave the host, never the line's text.
FAILED_CHECK='entry-identity'
ENTRY_SUM=$(sha256sum <"$ENTRY") || ENTRY_SUM=''
ENTRY_SUM=${ENTRY_SUM%% *}
if [[ $ENTRY_SUM =~ ^[0-9a-f]{64}$ ]]; then
  public_reason "entry sha256=$ENTRY_SUM"
else
  public_reason 'entry sha256=unavailable'
fi
FAILED_CHECK='entry-syntax'
if ! ENTRY_SYNTAX=$("$BASH" -n "$ENTRY" 2>&1); then
  printf '%s\n' "$ENTRY_SYNTAX"
  if [[ $ENTRY_SYNTAX =~ :\ line\ ([0-9]{1,6}):\ syntax\ error ]]; then
    public_reason "entry syntax=invalid line=${BASH_REMATCH[1]}"
  else
    public_reason 'entry syntax=invalid'
  fi
  refuse entry-syntax
fi
FAILED_CHECK='host-tools'
for tool in docker git jq flock timeout sync; do command -v "$tool"; done
FAILED_CHECK='settings-file'
[[ -d $ROOT/.git && -f $ROOT/.env && ! -L $ROOT/.env ]]
FAILED_CHECK='settings-mode'
[[ $(stat -c '%a' "$ROOT/.env") == 600 && -O $ROOT/.env ]]
FAILED_CHECK='host-lock'
exec 9>"$STATE/host.lock"
flock -n 9 || refuse lock-held
[[ ! -e $STATE/pending && ! -L $STATE/pending ]] || refuse pending-present
if [[ -e $STATE/current || -L $STATE/current ]]; then
  [[ -f $STATE/current && ! -L $STATE/current ]] || refuse current-invalid
  jq -e --arg target "$DEPLOY_TARGET" '.target == $target' "$STATE/current" || refuse current-target
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
# Observation's identity, schema and readiness probe. It prints one JSON line of booleans, the
# health endpoint's HTTP status and short codes (never an error message) for the public reasons,
# and exits non-zero unless every check passed; each check runs, so the flags are all measured.
readonly OBSERVE_CHECK='
  const [version, schema] = process.argv.slice(-2);
  const out = {check: "ok", identity: false, schema: false};
  const code = (error) => typeof error?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(error.code)
    ? error.code : "unknown";
  const fail = (check) => { if (out.check === "ok") out.check = check; };
  let postgres;
  try {
    postgres = await import("./dist/src/infrastructure/postgres/database.js");
    out.identity = JSON.parse(await Bun.file("package.json").text()).version === version &&
      postgres.SCHEMA_VERSION === schema;
  } catch (error) { out.identityCode = code(error); }
  if (!out.identity) fail("identity");
  if (postgres) {
    try {
      const db = new postgres.Database(process.env.DATABASE_URL);
      try { await db.schema(schema); } finally { await db.close(); }
      out.schema = true;
    } catch (error) { out.schemaCode = code(error); }
  }
  if (!out.schema) fail("schema");
  try {
    const r = await fetch("http://localhost:3000/health/ready");
    out.http = r.status;
    const s = await r.json();
    for (const flag of ["live", "ready", "database", "writerLease", "discord"]) out[flag] = s?.[flag] === true;
  } catch (error) { out.readinessCode = code(error); }
  if (!(out.http >= 200 && out.http < 300 && out.live && out.ready && out.database &&
        out.writerLease && out.discord)) fail("readiness");
  console.log(JSON.stringify(out));
  process.exitCode = out.check === "ok" ? 0 : 1;
'
# One ordinary running writer is required. Bootstrap/recovery is owner work.
FAILED_CHECK='live-writer'
CID=$(bot_ids)
[[ $CID =~ ^[0-9a-f]{12,64}$ ]] || refuse live-writer-count
FAILED_CHECK='live-inspect'
LIVE=$(timeout --kill-after=5 30 docker inspect "$CID")
FAILED_CHECK='live-health'
jq -e 'length == 1 and .[0].State.Running == true and .[0].State.Health.Status == "healthy" and .[0].Config.Labels["com.docker.compose.oneoff"] == "False"' <<<"$LIVE"
FAILED_CHECK='live-labels'
LIVE_VERSION=$(jq -er '.[0].Config.Labels["org.opencontainers.image.version"]' <<<"$LIVE")
LIVE_COMMIT=$(jq -er '.[0].Config.Labels["org.opencontainers.image.revision"]' <<<"$LIVE")
[[ $LIVE_VERSION =~ ^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$ && $LIVE_COMMIT =~ ^[0-9a-f]{40}$ ]]
FAILED_CHECK='live-image'
LIVE_ID=$(jq -er '.[0].Image' <<<"$LIVE")
LIVE_IMAGE=$(timeout --kill-after=5 30 docker image inspect "$LIVE_ID")
# A successful durable record is authoritative for the index digest; first
# installation requires the running image to have one unambiguous upstream digest.
FAILED_CHECK='live-digest'
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
FAILED_CHECK='live-scope'
LIVE_SCOPE=$(timeout --kill-after=5 45 docker exec "$CID" bun -e "$SCOPE_CHECK" "$DEPLOY_TARGET")
FAILED_CHECK='version-order'
IFS=. read -r -a wanted <<<"$VERSION"
IFS=. read -r -a live <<<"$LIVE_VERSION"
for i in 0 1 2; do
  (( 10#${wanted[i]} >= 10#${live[i]} )) || refuse downgrade
  if (( 10#${wanted[i]} > 10#${live[i]} )); then break; fi
done
if [[ $VERSION == "$LIVE_VERSION" ]]; then
  [[ $COMMIT == "$LIVE_COMMIT" && $DIGEST == "$LIVE_DIGEST" ]] || refuse same-version-mismatch
fi
public_step fetch
FAILED_CHECK='git-fetch'
timeout --kill-after=10 120 git -C "$ROOT" fetch --no-tags origin main
FAILED_CHECK='commit-missing'
[[ $(git -C "$ROOT" cat-file -t "$COMMIT") == commit ]]
FAILED_CHECK='commit-not-on-main'
git -C "$ROOT" merge-base --is-ancestor "$COMMIT" FETCH_HEAD
FAILED_CHECK='worktree-exists'
[[ ! -e $WORKTREE ]]
FAILED_CHECK='worktree-add'
git -C "$ROOT" worktree add --detach "$WORKTREE" "$COMMIT"
FAILED_CHECK='package-version'
[[ $(jq -er .version "$WORKTREE/package.json") == "$VERSION" ]]
FAILED_CHECK='migrations'
SCHEMA=
for migration in "$WORKTREE"/migrations/[0-9][0-9][0-9]_*.sql; do
  [[ -f $migration && ${migration##*/} =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]
  SCHEMA=${migration##*/}
done
[[ -n $SCHEMA ]]
public_step pull
FAILED_CHECK='image-pull'
timeout --kill-after=10 180 docker pull "$REF"
FAILED_CHECK='image-inspect'
TARGET=$(timeout --kill-after=5 30 docker image inspect "$REF")
FAILED_CHECK='image-identity'
jq -e --arg ref "$REF" --arg version "$VERSION" --arg commit "$COMMIT" \
  'length == 1 and (.[0].RepoDigests | index($ref) != null) and .[0].Config.Labels["org.opencontainers.image.version"] == $version and .[0].Config.Labels["org.opencontainers.image.revision"] == $commit' <<<"$TARGET"
TARGET_ID=$(jq -er '.[0].Id' <<<"$TARGET")
[[ $TARGET_ID =~ ^sha256:[0-9a-f]{64}$ ]]
# Resolve the owner's selected profiles before adding backup: an explicit profile
# replaces COMPOSE_PROFILES, including a value read from the central dotenv.
FAILED_CHECK='compose-config'
SELECTED_CONFIG=$(compose config --format json)
WEB_PROFILE=false
BACKUP_PROFILES=(--profile backup)
if jq -e '.services | has("caddy")' <<<"$SELECTED_CONFIG" >/dev/null; then
  WEB_PROFILE=true
  BACKUP_PROFILES+=(--profile web)
fi
CONFIG=$(compose "${BACKUP_PROFILES[@]}" config --format json)
FAILED_CHECK='compose-model'
jq -e --arg wanted "$VERSION" --arg live "$LIVE_VERSION" --arg ref "$REF" --arg target "$DEPLOY_TARGET" \
  '.services.tarubot as $bot | .services.backup as $backup |
   $bot.image == $ref and $bot.environment.TARUBOT_ENVIRONMENT == $target and
   ($wanted == $live or $bot.restart == "no") and
   $backup.environment.DATABASE_URL == $bot.environment.DATABASE_URL and
   $backup.environment.DATABASE_CA_CERT == $bot.environment.DATABASE_CA_CERT and
   $backup.environment.PGSSLMODE == "verify-full" and ($backup.profiles | index("backup") != null)' <<<"$CONFIG"
FAILED_CHECK='candidate-scope'
CANDIDATE_SCOPE=$(compose run --rm --no-deps --pull never -T tarubot bun -e "$SCOPE_CHECK" "$DEPLOY_TARGET")
[[ $LIVE_SCOPE == "$CANDIDATE_SCOPE" ]] || refuse scope-mismatch
REGISTRATION_SCOPE=$(jq -er .registrationScope <<<"$CANDIDATE_SCOPE")
# Each sample checks the same container, unchanged restart counter, local image
# ID, requested immutable digest, labels, ready writer and actual schema checksum.
# Each check is named first, so a failure says which one (2026-10-10).
observe() {
  local snapshot
  FAILED_CHECK='gone'
  [[ $(bot_ids) == "$CID" ]]
  FAILED_CHECK='inspect'
  snapshot=$(timeout --kill-after=5 30 docker inspect "$CID")
  jq -e 'length == 1' <<<"$snapshot"
  FAILED_CHECK='not-running'
  jq -e '.[0].State.Running == true' <<<"$snapshot"
  FAILED_CHECK='container-restarted'
  jq -e --argjson restarts "$RESTARTS" '.[0].RestartCount == $restarts' <<<"$snapshot"
  FAILED_CHECK='image-identity'
  jq -e --arg id "$TARGET_ID" --arg ref "$REF" '.[0].Image == $id and .[0].Config.Image == $ref' <<<"$snapshot"
  FAILED_CHECK='labels'
  jq -e --arg version "$VERSION" --arg commit "$COMMIT" \
    '.[0].Config.Labels["org.opencontainers.image.version"] == $version and .[0].Config.Labels["org.opencontainers.image.revision"] == $commit' <<<"$snapshot"
  FAILED_CHECK='health'
  jq -e '.[0].State.Health.Status == "healthy"' <<<"$snapshot"
  # The probe exits non-zero on any failed check; its last line names which (see diagnose).
  FAILED_CHECK='probe'
  READINESS=''
  READINESS=$(timeout --kill-after=5 45 docker exec "$CID" bun -e "$OBSERVE_CHECK" "$VERSION" "$SCHEMA")
  jq -e '.check == "ok"' <<<"${READINESS##*$'\n'}"
  if [[ -n ${PROXY_CID:-} ]]; then
    FAILED_CHECK='proxy-inspect'
    snapshot=$(timeout --kill-after=5 30 docker inspect "$PROXY_CID")
    jq -e 'length == 1' <<<"$snapshot"
    FAILED_CHECK='proxy-not-running'
    jq -e '.[0].State.Running == true' <<<"$snapshot"
    FAILED_CHECK='proxy-health'
    jq -e '.[0].State.Health.Status == "healthy"' <<<"$snapshot"
    FAILED_CHECK='proxy-restart-policy'
    jq -e '.[0].HostConfig.RestartPolicy.Name == "no"' <<<"$snapshot"
  fi
  # Every check passed: a later failure must not be blamed on the last one.
  FAILED_CHECK=''
}
if [[ $VERSION == "$LIVE_VERSION" ]]; then
  FAILED_CHECK='live-image-id'
  [[ $TARGET_ID == "$LIVE_ID" ]]
  # Existing deployments may name a tag; never rewrite them as a side effect of
  # an already-live request. New deployments must name the exact digest.
  [[ $(jq -er '.[0].Config.Image' <<<"$LIVE") == "$REF" ]] || refuse live-reference
  RESTARTS=$(jq -er '.[0].RestartCount' <<<"$LIVE")
  public_step observe
  observe
  sleep 30
  observe
  FAILED_CHECK='record-write'
  durable_record "$STATE/current"
  FAILED_CHECK='enable-restart'
  timeout --kill-after=5 30 docker update --restart unless-stopped "$CID"
  finished=true
  printf '%s\n' 'result already-live' >&3
  exit 0
fi
# Only the candidate reads web modules; published running images may predate web.
# Default bot-only upgrades also remain compatible with those published images.
FAILED_CHECK='web-settings'
compose run --rm --no-deps --pull never -T tarubot bun -e '
  const proxy = process.argv.at(-1) === "true";
  if (process.env.WEB_PUBLIC_ORIGIN || proxy) {
    const {webSettings} = await import("./dist/src/web/settings.js");
    const web = webSettings(process.env);
    if (web.status === "invalid") throw Error(web.problems.join("; "));
    if (web.status === "on" &&
        web.settings.port === Number(process.env.HEALTH_PORT ?? 3000)) {
      throw Error("WEB_PORT must differ from HEALTH_PORT");
    }
    if (proxy && web.status !== "on") throw Error("Caddy requires WEB_PUBLIC_ORIGIN");
    if (proxy && web.status === "on" &&
        (!web.settings.secure || new URL(web.settings.origin).port)) {
      throw Error("Stock Caddy requires an HTTPS origin on public port 443");
    }
  }
' "$WEB_PROFILE"
if [[ $WEB_PROFILE == true ]]; then
  # Private worktrees inherit umask 077. This public template, and the offline
  # page shown while the bot can't answer (2.41.0), must be readable by Caddy
  # without DAC_OVERRIDE. Central settings and every other release file retain
  # their private permissions.
  FAILED_CHECK='proxy-files'
  chmod 644 "$WORKTREE/ops/Caddyfile"
  # chmod -R follows a symlinked argument, so only a real directory. An older
  # release without the page must still deploy under set -e.
  if [[ -d $WORKTREE/ops/offline && ! -L $WORKTREE/ops/offline ]]; then
    chmod -R a+rX -- "$WORKTREE/ops/offline"
  fi
  FAILED_CHECK='proxy-pull'
  compose pull caddy
  FAILED_CHECK='proxy-config'
  compose run --rm --no-deps --pull never -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi
# Set the trap boundary BEFORE writing pending: an uncertain fsync/write is never
# permission to continue an old writer. This marker is cleared only after success.
FAILED_CHECK='pending-write'
boundary=true
durable_record "$STATE/pending"
public_step stop
FAILED_CHECK='stop-writers'
stop_writers
public_step backup
FAILED_CHECK='backup'
# The caller selects the dump client even when a pinned payload inspects default config.
BACKUP_PROFILE_SELECTION=backup
if [[ $WEB_PROFILE == true ]]; then BACKUP_PROFILE_SELECTION+=,web; fi
COMPOSE_PROFILES=$BACKUP_PROFILE_SELECTION TARUBOT_ROOT=$ROOT \
  TARUBOT_COMPOSE_FILE=$WORKTREE/docker-compose.$DEPLOY_TARGET.yml \
  TARUBOT_IMAGE_DIGEST=$DIGEST TARUBOT_HOST_LOCK_HELD=true \
  timeout --kill-after=10 900 bash "$WORKTREE/ops/backup.sh" "$DEPLOY_TARGET"
public_step migrate
FAILED_CHECK='migrate'
# migrate.js uses the existing transactional migration/writer lease guard.
compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/migrate.js
public_step register
FAILED_CHECK='register'
if [[ $DEPLOY_TARGET == production ]]; then
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --global
else
  compose run --rm --no-deps --pull never -T tarubot bun dist/scripts/register.js --guild "$REGISTRATION_SCOPE"
fi
public_step start
FAILED_CHECK='compose-up'
compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 tarubot
FAILED_CHECK='start-container'
CID=$(bot_ids)
[[ $CID =~ ^[0-9a-f]{12,64}$ ]]
SNAPSHOT=$(timeout --kill-after=5 30 docker inspect "$CID")
RESTARTS=$(jq -er '.[0].RestartCount' <<<"$SNAPSHOT")
FAILED_CHECK='start-restart-policy'
jq -e '.[0].HostConfig.RestartPolicy.Name == "no"' <<<"$SNAPSHOT"
if [[ $WEB_PROFILE == true ]]; then
  # Compose health includes both Caddy's private admin and bot web readiness.
  # A failed startup/readiness check crosses the same pending/writer fence.
  FAILED_CHECK='proxy-start'
  compose up --detach --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 caddy
  FAILED_CHECK='proxy-container'
  PROXY_CID=$(timeout --kill-after=5 30 docker ps -q \
    --filter label=com.docker.compose.project=tarubot \
    --filter label=com.docker.compose.service=caddy)
  [[ $PROXY_CID =~ ^[0-9a-f]{12,64}$ ]]
else
  # Disabling the selected profile must not leave a previous proxy serving.
  # Stop by service label because a disabled/older model may not contain Caddy.
  FAILED_CHECK='proxy-stop'
  PROXY_IDS=$(timeout --kill-after=5 30 docker ps -q \
    --filter label=com.docker.compose.project=tarubot \
    --filter label=com.docker.compose.service=caddy)
  if [[ -n $PROXY_IDS ]]; then
    mapfile -t proxies <<<"$PROXY_IDS"
    timeout --kill-after=5 90 docker stop --time 40 "${proxies[@]}"
  fi
fi
public_step observe
observe
# Require sustained readiness, rather than a momentary successful health check.
for ((sample=0; sample<3; sample++)); do sleep 10; observe; done
public_step record
FAILED_CHECK='record-write'
durable_record "$STATE/current"
# Only a durably observed/accepted image may automatically resume after host loss.
# Keep pending until this update succeeds; failure still fences the writer.
if [[ -n ${PROXY_CID:-} ]]; then
  FAILED_CHECK='proxy-enable-restart'
  timeout --kill-after=5 30 docker update --restart unless-stopped "$PROXY_CID"
fi
FAILED_CHECK='enable-restart'
timeout --kill-after=5 30 docker update --restart unless-stopped "$CID"
FAILED_CHECK='pending-clear'
rm "$STATE/pending"
sync -f "$STATE"
boundary=false
finished=true
printf '%s\n' 'result deployed' >&3
