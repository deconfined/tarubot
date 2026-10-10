#!/usr/bin/env bash
# GitHub-runner transport only; never install this on the application host.
# A job-local Unbound validates DNSSEC. OpenSSH must authenticate an Ed25519
# host key through SSHFP before it may use the separate deployment credential.
set -Eeuo pipefail
umask 077
dir=$(mktemp -d "${RUNNER_TEMP:?}/deploy-ssh.XXXXXX")
cleanup() {
  local rc=$?
  trap - EXIT
  # A second runner signal must not interrupt restoration already in progress.
  trap '' INT TERM
  if [[ -n ${ssh_job:-} ]]; then
    if kill -0 "$ssh_job" 2> /dev/null; then
      kill -TERM "$ssh_job" || rc=1
    fi
    # OpenSSH may return 255 when terminated; preserve the entry's signal status.
    wait "$ssh_job" || :
  fi
  if [[ -f $dir/resolv.conf.previous ]]; then
    sudo -n tee /etc/resolv.conf < "$dir/resolv.conf.previous" > /dev/null || rc=1
  fi
  if [[ -n ${resolver_job:-} ]]; then
    if sudo -n kill -0 -- "$resolver_job" 2> /dev/null; then
      sudo -n kill -TERM -- "$resolver_job" || rc=1
    fi
    if wait "$resolver_job"; then
      :
    else
      local status=$?
      [[ $status == 143 ]] || rc=1
    fi
  fi
  if [[ -n ${resolver_dir:-} ]]; then
    sudo -n rm -rf -- "$resolver_dir" || rc=1
  fi
  rm -rf -- "$dir"
  exit "$rc"
}
trap cleanup EXIT
# Say where delivery stopped in fixed sentences only: diagnostics stay in private files, and only
# the host entry's own step/result lines are relayed. The phase moves runner -> resolver -> ssh.
phase=runner
host_lines=0
result=''
steps_seen=false
# The host entry also says why it stopped (ops/deploy.sh public_reason, 2026-10-10). Only `reason`
# lines of exactly this shape are relayed, at most 20, and never one containing `::` or `%`, so a
# host can't make the runner print a workflow command; its private host log keeps every detail.
# Match in the C locale: under en_US.UTF-8, glibc's [A-Za-z] also matches letters such as é.
readonly reason_form="^reason [a-z][a-z-]{0,23}( [A-Za-z][A-Za-z0-9_-]{0,23}=(\"[A-Za-z0-9 _.,:;!?()/+=<>'-]{0,160}\"|[A-Za-z0-9._-]{1,64})){0,16}\$"
readonly reasons_doc='https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#reading-a-failed-delivery'
reasons=()
relayable() {
  local LC_ALL=C
  (( ${#1} <= 400 )) && [[ $1 =~ $reason_form && $1 != *::* && $1 != *%* ]]
}
# The last bare value of <key> on a relayed `reason <kind>` line, or nothing. Quoted text is set
# aside first, so a msg="... code=x" can't stand in for a key, and every value must fit a narrow
# pattern for its key before likely_cause may put it in a sentence; anything else reads as empty.
reason_value() {
  local LC_ALL=C line bare value='' allowed pattern=" $2=([^ ]+)" quoted='^([^"]*)"[^"]*"(.*)$'
  case $1:$2 in
    refused:code) allowed='^[a-z][a-z-]{0,31}$' ;;
    *:code | *:identityCode | *:schemaCode | *:readinessCode) allowed='^[A-Za-z0-9_]{1,40}$' ;;
    *:line) allowed='^[0-9]{1,6}$' ;;
    *:health) allowed='^[a-z]{1,16}$' ;;
    *:stage) allowed='^[a-z-]{1,24}$' ;;
    *:signal) allowed='^(HUP|INT|TERM|PIPE)$' ;;
    *:exit) allowed='^-?[0-9]{1,3}$' ;;
    *:check | *:step) allowed='^[a-z][a-z-]{0,31}$' ;;
    *:http) allowed='^(none|[1-5][0-9][0-9])$' ;;
    *:syntax) allowed='^invalid$' ;;
    *:writers) allowed='^(stopped|unconfirmed)$' ;;
    *:timeout | *:oom | *:running | *:live | *:ready | *:database | *:writerLease | *:discord) allowed='^(true|false)$' ;;
    *) allowed='^$' ;;
  esac
  for line in "${reasons[@]}"; do
    if [[ $line == "reason $1 "* ]]; then
      bare=$line
      while [[ $bare =~ $quoted ]]; do bare="${BASH_REMATCH[1]}Q${BASH_REMATCH[2]}"; done
      if [[ $bare =~ $pattern ]]; then value=${BASH_REMATCH[1]}; fi
    fi
  done
  if [[ $value =~ $allowed ]]; then printf '%s' "$value"; fi
  return 0
}
# Plain words for a recognisable reason set, from ops/deploy.sh's fixed checks; nothing if unsure.
likely_cause() {
  local refusal check step health running exited oom stage code flags='' timeout='' last=''
  if [[ $(reason_value entry syntax) == invalid ]]; then
    exited=$(reason_value entry line)
    echo "the host's installed deploy entry doesn't parse (a bash syntax error${exited:+ at line $exited}), so it isn't the reviewed ops/deploy.sh; reinstall it from a verified commit and check it with bash -n."
    return 0
  fi
  refusal=$(reason_value refused code)
  case $refusal in
    entry-target) echo "the host's authorized_keys command doesn't bind exactly one target (production or staging)." ;;
    request-form) echo "the host entry didn't accept this request's form." ;;
    target-mismatch) echo "the host's delivery key is bound to the other target." ;;
    state-directory) echo "the host entry couldn't create its private state directory." ;;
    lock-held) echo 'another delivery or the scheduled backup held the host lock.' ;;
    pending-present) echo "an earlier delivery's pending marker is still on the host; reconcile and clear it first." ;;
    current-invalid) echo "the host's recorded current state isn't a regular file." ;;
    current-target) echo "the host's recorded current state names no target, or the other one." ;;
    live-writer-count) echo "the host doesn't have exactly one bot container to replace." ;;
    downgrade) echo 'the requested version is older than the one running.' ;;
    same-version-mismatch) echo 'the requested version is already running from a different commit or image digest.' ;;
    scope-mismatch) echo "the new release's Discord application, guild or database scope differs from the running bot's." ;;
    live-reference) echo "the running bot names its image by tag, so an already-live request can't confirm it by digest." ;;
  esac
  if [[ -n $refusal ]]; then return 0; fi
  if [[ -n $(reason_value failed signal) ]]; then
    echo "the host entry was interrupted ($(reason_value failed signal))."
    return 0
  fi
  check=$(reason_value failed check)
  step=$(reason_value failed step)
  if [[ $(reason_value failed timeout) == true ]]; then timeout=' (it timed out)'; fi
  health=$(reason_value container health)
  running=$(reason_value container running)
  exited=$(reason_value container exit)
  oom=no
  if [[ $(reason_value container oom) == true ]]; then oom=yes; fi
  code=$(reason_value bot-error code)
  # Kept out of ${var:+...}: Bash would read its apostrophe as a quote even inside double quotes.
  if [[ -n $code ]]; then last=" (the bot's last error code: $code)"; fi
  case $check in
    readiness)
      if [[ $(reason_value readiness http) == none ]]; then flags+="; its health endpoint didn't answer"; fi
      if [[ $(reason_value readiness live) == false ]]; then flags+="; the process wasn't live"; fi
      if [[ $(reason_value readiness database) == false ]]; then flags+="; the database wasn't reachable"; fi
      if [[ $(reason_value readiness writerLease) == false ]]; then flags+="; it didn't hold the database writer lease"; fi
      if [[ $(reason_value readiness discord) == false ]]; then flags+="; Discord wasn't connected"; fi
      if [[ -z $flags && $(reason_value readiness ready) == false ]]; then flags="; it reported not ready"; fi
      echo "the new release didn't stay ready${flags:+: ${flags#; }}$last." ;;
    identity) echo "the running container's package or schema version isn't this release's." ;;
    schema-checksum)
      code=$(reason_value readiness schemaCode)
      echo "the database schema doesn't match this release's migrations${code:+ (code $code)}." ;;
    probe) echo "the observation probe couldn't run in the bot container${timeout}." ;;
    not-running) echo "the bot container exited with code ${exited:-unknown} (out of memory: $oom)$last." ;;
    container-restarted) echo 'the bot container restarted during observation.' ;;
    health)
      health=$(reason_value failed health)
      if [[ -n $health ]]; then echo "Docker's health check reported $health$last."
      else echo "Docker's health check failed$last."; fi ;;
    gone) echo 'the bot container disappeared during observation.' ;;
    inspect) echo "Docker couldn't inspect the bot container." ;;
    image-identity)
      if [[ $step == pull ]]; then echo "the pulled image's digest or labels aren't this release's."
      else echo "the running container isn't the requested image."; fi ;;
    labels) echo "the running container's version labels aren't this release's." ;;
    proxy-inspect | proxy-not-running | proxy-health | proxy-restart-policy | proxy-start | proxy-container)
      health=$(reason_value proxy health)
      echo "bundled Caddy didn't stay running and healthy${health:+ (health: $health)}." ;;
    proxy-files | proxy-pull | proxy-config) echo "bundled Caddy's image or configuration didn't validate." ;;
    proxy-stop) echo "the previous Caddy proxy couldn't be stopped." ;;
    compose-up)
      if [[ $running == false ]]; then
        echo "the bot container exited with code ${exited:-unknown} while starting (out of memory: $oom)$last."
      elif [[ $health == starting ]]; then
        echo "the bot container didn't become healthy within the start wait$last."
      elif [[ $health == unhealthy ]]; then
        echo "the bot container's health check failed while starting$last."
      else
        echo "Docker Compose couldn't start the new release${timeout}."
      fi ;;
    start-container | start-restart-policy) echo "the started bot container couldn't be identified, or it had a restart policy." ;;
    backup)
      stage=$(reason_value backup stage)
      echo "the pre-migration backup failed${stage:+ at its $stage stage}${timeout}; nothing was migrated." ;;
    migrate) echo "the database migration failed${code:+ (code $code)}${timeout}." ;;
    register) echo "Discord command registration failed${code:+ (code $code)}${timeout}." ;;
    stop-writers) echo "the running bot couldn't be confirmed stopped${timeout}." ;;
    pending-write) echo "the pending marker couldn't be written durably." ;;
    git-fetch) echo "the host couldn't fetch main from GitHub${timeout}." ;;
    commit-missing | commit-not-on-main) echo "the requested commit isn't on the host's fetched main." ;;
    worktree-exists | worktree-add) echo "the release worktree couldn't be created." ;;
    package-version) echo "the commit's package.json version isn't the requested version." ;;
    migrations) echo "the release's migration files are missing or misnamed." ;;
    image-pull) echo "the host couldn't pull the image digest${timeout}." ;;
    image-inspect) echo "Docker couldn't inspect the pulled image." ;;
    compose-config | compose-model) echo "the release's Compose model with the host's settings didn't validate." ;;
    candidate-scope) echo "the new release refused the host's settings for this target${code:+ (code $code)}." ;;
    web-settings) echo "the dashboard settings didn't validate for this release." ;;
    live-writer | live-inspect | live-health) echo "the running bot wasn't one running, healthy container${health:+ (health: $health)}, so there was no ordinary writer to replace." ;;
    live-labels | live-image | live-digest | live-image-id) echo "the running bot's image identity couldn't be confirmed." ;;
    live-scope) echo "the running bot's settings didn't pass the target scope check." ;;
    settings-file | settings-mode) echo "the host's central .env is missing, a symlink, or not mode 600 and owned by the deploy account." ;;
    host-tools) echo 'a required host tool (docker, git, jq, flock, timeout or sync) is missing.' ;;
    record-write | enable-restart | proxy-enable-restart | pending-clear) echo 'the release passed observation, but recording it or enabling its restart policy failed.' ;;
  esac
  return 0
}
failure_message() {
  local errors=$dir/ssh-errors status=${rc:-0}
  case "$phase" in
    runner) echo 'Delivery stopped on the runner before contacting the host; the host was not changed.' ;;
    resolver) echo "The runner's DNSSEC-validating resolver did not start; the host was not contacted." ;;
    *)
      if (( host_lines == 0 )); then
        # OpenSSH itself fails with 255; any other status came from the host's forced command.
        if (( status != 0 && status != 255 )); then
          echo "SSH authenticated, but the host's forced command did not start the deploy entry; the host was not changed."
        elif grep -q 'Host key verification failed' "$errors" 2> /dev/null; then
          echo "The host's SSH key was not authenticated by DNSSEC-signed SSHFP records; SSH stopped before offering the delivery key, so the deploy entry did not run."
        elif grep -qE '^ssh: Could not resolve hostname' "$errors" 2> /dev/null; then
          echo 'The deploy host name did not resolve under DNSSEC validation; the host was not contacted.'
        elif grep -q 'Permission denied (publickey' "$errors" 2> /dev/null; then
          echo 'The host refused the delivery key; its deploy entry did not run.'
        elif grep -qE '^ssh: connect to host .*: (Connection timed out|Connection refused|No route to host|Network is unreachable)' "$errors" 2> /dev/null; then
          echo 'The host did not accept an SSH connection; its deploy entry did not run.'
        else
          echo 'SSH ended before the host entry answered; check the host is reachable over SSH, then re-run.'
        fi
      elif (( ${results:-0} > 1 )); then
        echo 'The host entry returned more than one result; reconcile on the host before any new delivery.'
      else
        local cause log fence=''
        cause=$(likely_cause)
        printf -v log '%s/.local/state/tarubot-deploy/logs/%s-*.log' '~' "${request_id:-<request-id>}"
        if [[ $(reason_value fence writers) == unconfirmed ]]; then
          fence=" The entry couldn't confirm that every writer stopped: check the host now."
        fi
        case "$result" in
          'result deployed'|'result already-live')
            echo "The host reported '${result#result }', but the SSH session ended abnormally; check the running release and pending marker on the host before any new delivery." ;;
          'result refused') echo "${cause:+Likely cause: $cause }The host refused this delivery before stopping the writer, so nothing changed. Its private log on the host, if this run wrote one, is $log; see $reasons_doc. Fix the cause, then re-run or dispatch again." ;;
          'result needs-owner') echo "${cause:+Likely cause: $cause }The host stopped after the writer boundary and kept its pending marker; reconcile on the host before any new delivery.$fence Its private log on the host is $log; see $reasons_doc." ;;
          *) echo "The host entry stopped without a result; inspect its private log on the host ($log) and reconcile before a new delivery." ;;
        esac
      fi ;;
  esac
}
trap 'echo "::error::$(failure_message)"' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
exec 2> "$dir/errors"
# From here every check fails as a command, so the ERR trap always names where delivery stopped.
case "${TARGET:-}" in
  production) [[ ${REPO_PRODUCTION_DEPLOY_ENABLED:-} == true ]] ;;
  staging) [[ ${REPO_STAGING_DEPLOY_ENABLED:-} == true ]] ;;
  *) false ;;
esac
# A re-run keeps GITHUB_RUN_ID, and the host entry names its release worktree after the request
# ID, so a re-run after a refusal at or past 'step fetch' would always be refused. Each attempt
# therefore sends its own ID: the run ID followed by the three-digit attempt (FORM allows 20 digits).
attempt=${GITHUB_RUN_ATTEMPT:-}
[[ $attempt =~ ^[1-9][0-9]{0,2}$ ]]
request_id="${GITHUB_RUN_ID:-}$(printf '%03d' "$attempt")"
command="deploy $TARGET ${VERSION:-} ${COMMIT:-} ${DIGEST:-} $request_id"
form='^deploy (production|staging) (0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}) [0-9a-f]{40} sha256:[0-9a-f]{64} [1-9][0-9]{0,19}$'
[[ $command =~ $form ]]
host_form='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
# OpenSSH intentionally skips SSHFP for numeric addresses; there is no pin fallback.
[[ ${DEPLOY_HOST:-} =~ $host_form && ! $DEPLOY_HOST =~ ^[0-9.]+$ ]]
# Ubuntu 24.04's security backport fixes VerifyHostKeyDNS MITM CVE-2025-26465.
client_version=$(dpkg-query -W -f='${Version}' openssh-client)
dpkg --compare-versions "$client_version" ge '1:9.6p1-3ubuntu13.8'
[[ ${DEPLOY_SSH_KEY:-} == *'PRIVATE KEY'* ]]
printf '%s\n' "$DEPLOY_SSH_KEY" > "$dir/key"
unset DEPLOY_SSH_KEY

phase=resolver
# Trust only the OS-maintained root anchor, not an AD bit received over an
# untrusted network. Ubuntu confines /usr/sbin/unbound with its packaged
# AppArmor profile: daemon files must be root-owned under /var/lib/unbound.
# The runner key remains separate; both private directories are removed on exit.
resolver_dir=$(sudo -n mktemp -d /var/lib/unbound/deploy-ssh.XXXXXX)
cat <<EOF | sudo -n tee "$resolver_dir/unbound.conf" > /dev/null
server:
  interface: 127.0.0.1
  port: 53
  so-reuseport: no
  username: ""
  chroot: ""
  directory: "$resolver_dir"
  pidfile: "$resolver_dir/unbound.pid"
  logfile: "$resolver_dir/unbound.log"
  use-syslog: no
  verbosity: 0
  do-ip6: no
  module-config: "validator iterator"
  val-permissive-mode: no
  harden-dnssec-stripped: yes
  root-hints: "/usr/share/dns/root.hints"
  trust-anchor-file: "/usr/share/dns/root.key"
remote-control:
  control-enable: yes
  control-use-cert: no
  control-interface: "$resolver_dir/resolver-control"
EOF
# Redirect before exec so AppArmor never inherits a runner-temp diagnostic FD.
# sudo tracks the exec'd daemon directly for signal forwarding.
exec {resolver_output}> "$dir/resolver-start"
sudo -n unbound-checkconf "$resolver_dir/unbound.conf" >&"$resolver_output" 2>&1
exec {resolver_output}>&-
sudo -n sh -c 'exec /usr/sbin/unbound -d -c "$1" > "$2" 2>&1' \
  sh "$resolver_dir/unbound.conf" "$resolver_dir/resolver-start" &
resolver_job=$!
# A private Unix control socket proves this invocation's resolver is ready.
# Never switch DNS to an unrelated listener after a bind/startup failure.
ready=false
for ((attempt=0; attempt<20; attempt++)); do
  if timeout 1 sudo -n unbound-control -c "$resolver_dir/unbound.conf" status > "$dir/resolver-status" 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
[[ $ready == true ]]
# Preserve the existing file/symlink and restore its contents even on failure.
cp -L /etc/resolv.conf "$dir/resolv.conf.previous"
printf 'nameserver 127.0.0.1\noptions edns0 trust-ad\n' |
  sudo -n tee /etc/resolv.conf > /dev/null

phase=ssh
rc=0
# wait is interruptible; a foreground ssh would defer INT/TERM traps.
ssh -F /dev/null -T -4 -i "$dir/key" -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o BatchMode=yes -o VerifyHostKeyDNS=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null \
  -o UpdateHostKeys=no -o CheckHostIP=no -o HostKeyAlgorithms=ssh-ed25519 \
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
  -o LogLevel=ERROR "tarubot@$DEPLOY_HOST" "$command" \
  < /dev/null > "$dir/output" 2> "$dir/ssh-errors" &
ssh_job=$!
wait "$ssh_job" || rc=$?
unset ssh_job
results=0
while IFS= read -r line; do
  case "$line" in
    'step preflight'|'step fetch'|'step pull'|'step stop'|'step backup'|'step migrate'|'step register'|'step start'|'step observe'|'step record')
      host_lines=$((host_lines + 1))
      steps_seen=true
      printf '%s\n' "$line" ;;
    'result deployed'|'result already-live'|'result refused'|'result needs-owner')
      result=$line
      results=$((results + 1))
      host_lines=$((host_lines + 1))
      printf '%s\n' "$line" ;;
    'reason '*)
      # Anything malformed, oversized or past the cap is dropped, never repaired.
      if (( ${#reasons[@]} < 20 )) && relayable "$line"; then
        reasons+=("$line")
        host_lines=$((host_lines + 1))
      fi ;;
  esac
done < "$dir/output"
diagnostics=false
for line in "${reasons[@]}"; do
  if [[ $line != 'reason entry sha256='* ]]; then diagnostics=true; fi
done
if [[ $diagnostics == true ]]; then
  echo 'Host diagnostics (reported by the host entry; its private log on the host has the detail):'
  printf '  %s\n' "${reasons[@]}"
fi
# Compare the hash the host entry reports for itself with ops/deploy.sh beside this transport, the
# workflow commit's (2026-10-10). The report is the host's own claim, and the installed entry may
# legitimately be an older reviewed version, so a match is worded as a claim and a difference only
# warns. The release commit's copy isn't compared: the shallow checkout holds only the workflow's.
reported=''
for line in "${reasons[@]}"; do
  if [[ $line == 'reason entry sha256='* ]]; then reported=${line#reason entry sha256=}; break; fi
done
expected=''
if entry_sum=$(sha256sum 2> /dev/null < "$(dirname -- "${BASH_SOURCE[0]}")/deploy.sh"); then
  entry_sum=${entry_sum%% *}
  if [[ $entry_sum =~ ^[0-9a-f]{64}$ ]]; then expected=$entry_sum; fi
fi
commit='<commit>'
if [[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then commit=$GITHUB_SHA; fi
if [[ -z $reported ]]; then
  if [[ -n $expected && $steps_seen == true ]]; then
    echo "The host's deploy entry didn't report its sha256, so it predates that check or isn't the reviewed entry; compare it on the host with the workflow commit's ops/deploy.sh (sha256 $expected)."
  fi
elif [[ ! $reported =~ ^[0-9a-f]{64}$ ]]; then
  echo "The host's deploy entry didn't report a usable sha256, so it wasn't compared with the workflow commit's ops/deploy.sh${expected:+ (sha256 $expected)}."
elif [[ -z $expected ]]; then
  echo "The host reports its deploy entry's sha256 as $reported; there is no ops/deploy.sh beside this transport to compare it with."
elif [[ $reported == "$expected" ]]; then
  echo "The host reports its deploy entry's sha256 as $reported, the same as the workflow commit's ops/deploy.sh; verify on the host if in doubt."
else
  echo "::warning::The host reports its deploy entry's sha256 as $reported, which is not the workflow commit's ops/deploy.sh (sha256 $expected). Reinstall it from that commit with \`git show $commit:ops/deploy.sh\` if that wasn't intended."
fi
[[ $rc == 0 && $results == 1 && ( $result == 'result deployed' || $result == 'result already-live' ) ]]
