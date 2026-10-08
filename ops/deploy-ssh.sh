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
failure_message() {
  local errors=$dir/ssh-errors
  case "$phase" in
    runner) echo 'Delivery stopped on the runner before contacting the host; the host was not changed.' ;;
    resolver) echo "The runner's DNSSEC-validating resolver did not start; the host was not contacted." ;;
    *)
      if (( host_lines == 0 )); then
        if grep -q 'Host key verification failed' "$errors" 2> /dev/null; then
          echo "The host's SSH key was not authenticated by DNSSEC-signed SSHFP records; the host was not contacted."
        elif grep -qiE 'Could not resolve hostname|Name or service not known|Temporary failure in name resolution' "$errors" 2> /dev/null; then
          echo 'The deploy host name did not resolve under DNSSEC validation; the host was not contacted.'
        elif grep -q 'Permission denied' "$errors" 2> /dev/null; then
          echo 'The host refused the delivery key; its deploy entry did not run.'
        elif grep -qiE 'timed out|Connection refused|No route to host|Network is unreachable' "$errors" 2> /dev/null; then
          echo 'The host did not accept an SSH connection; its deploy entry did not run.'
        else
          echo 'SSH ended before the host entry answered; check the host is reachable over SSH, then re-run.'
        fi
      else
        case "$result" in
          'result refused') echo 'The host refused this delivery before stopping the writer, so nothing changed; its private host log says why. Fix the cause, then re-run or dispatch again.' ;;
          'result needs-owner') echo 'The host stopped after the writer boundary and kept its pending marker; reconcile on the host before any new delivery.' ;;
          *) echo 'The host entry stopped without a single result; inspect the private host log and reconcile before a new delivery.' ;;
        esac
      fi ;;
  esac
}
trap 'echo "::error::$(failure_message)"' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
exec 2> "$dir/errors"
case "${TARGET:?}" in
  production) [[ ${REPO_PRODUCTION_DEPLOY_ENABLED:-} == true ]] ;;
  staging) [[ ${REPO_STAGING_DEPLOY_ENABLED:-} == true ]] ;;
  *) exit 1 ;;
esac
command="deploy $TARGET ${VERSION:?} ${COMMIT:?} ${DIGEST:?} ${GITHUB_RUN_ID:?}"
form='^deploy (production|staging) (0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}) [0-9a-f]{40} sha256:[0-9a-f]{64} [1-9][0-9]{0,19}$'
[[ $command =~ $form ]]
host_form='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
# OpenSSH intentionally skips SSHFP for numeric addresses; there is no pin fallback.
[[ ${DEPLOY_HOST:?} =~ $host_form && ! $DEPLOY_HOST =~ ^[0-9.]+$ ]]
# Ubuntu 24.04's security backport fixes VerifyHostKeyDNS MITM CVE-2025-26465.
client_version=$(dpkg-query -W -f='${Version}' openssh-client)
dpkg --compare-versions "$client_version" ge '1:9.6p1-3ubuntu13.8'
[[ ${DEPLOY_SSH_KEY:?} == *'PRIVATE KEY'* ]]
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
      printf '%s\n' "$line" ;;
    'result deployed'|'result already-live'|'result refused'|'result needs-owner')
      result=$line
      results=$((results + 1))
      host_lines=$((host_lines + 1))
      printf '%s\n' "$line" ;;
  esac
done < "$dir/output"
[[ $rc == 0 && $results == 1 && ( $result == 'result deployed' || $result == 'result already-live' ) ]]
