#!/usr/bin/env bash
# Host keys and connections for the Deploy workflow's host jobs (2.37.0; REQUIREMENTS.md "Approved
# unified-pipeline amendments (2026-09-29)", decision 5), run on the GitHub runner. It replaces
# 2.36.0's TARGET_HOST and TARGET_HOST_KEY secrets and the owner's ssh-keyscan step: the job the
# owner approved pins each new host's key on first use, and every later connection accepts only
# that key.
#
# The pin store is one object per host key, beside OpenTofu's state in the state bucket:
#
#   tarubot/pins/<key>.json   {"host_key":"ssh-ed25519 <base64>","instance_id":"<Linode ID>",
#                              "ipv4":"<a.b.c.d>","ipv6":"<bare IPv6>"}
#
# A pin belongs to one Linode instance. A rebuilt host (a new instance) is scanned again, but the key
# pinned for an instance is never replaced; only its addresses are ever updated. Only prod's
# approval-gated read/write state key writes pins (every other Object Storage key is limited to its
# own bucket, an owner step); infra-plan and staging read them with the read-only key.
#
#   host.sh status       Deploy's Infrastructure plan job (infra-plan), after tofu-ci.sh summarize:
#                        which hosts the approving job must pin, from the saved plan
#                        ($RUNNER_TEMP/tofu/plan.json), the values (values.tfvars.json) and the
#                        store. The hosts of PIN_SCOPE (staging, prod or all) whose pin is missing,
#                        names another instance or has other addresses, plus every host the plan
#                        creates or replaces, go to the output pins_needed (space-separated keys).
#                        One summary line per host; an out-of-scope host without a matching pin
#                        gets a warning naming action=infra instead.
#   host.sh pin          a prod host job, after tofu-ci.sh adopt, apply (when the plan has
#                        changes) and output: exactly the hosts in PINS (the approved plan's
#                        pins_needed), each first checked against the adopted plan.json and
#                        OpenTofu's host_connection output ($RUNNER_TEMP/tofu/outputs.json). A new
#                        instance is scanned and its pin stored at once, before any login (the
#                        pending pin: a failed first Configure retries against the same key). Keys
#                        outside PINS are never read or written. Writes pinned= (the keys whose pin
#                        this job wrote).
#   host.sh connect KEY  every host job but Infrastructure's: the pinned host (staging or prod),
#                        probed as root with ANSIBLE_SSH_KEY, into $RUNNER_TEMP/ssh/key,
#                        known_hosts and inventory.json for Ansible. Exit 3: no pin for KEY yet, or
#                        this environment has no store settings (the caller decides what that
#                        means). Exit 1 writes reason= host-key, key-rejected, unreachable,
#                        pin-store or configure-key.
#
# Each subcommand reads the store with STATE_BUCKET and STATE_ENDPOINT (the environment's
# TOFU_STATE_BUCKET and TOFU_STATE_ENDPOINT) and the state key in AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY (infra-plan's and staging's TOFU_STATE_READ_*, prod's TOFU_STATE_WRITE_*),
# through curl's SigV4 signing at the bucket's virtual-hosted URL. The credentials and the URL reach
# curl in a config on stdin, never as arguments, and the script drops them and ANSIBLE_SSH_KEY from
# its environment before running anything, so no child process inherits them. A dotted bucket name
# is refused: its TLS name can't match the endpoint's wildcard certificate.
#
# IPv6 first: scans and logins use the host's IPv6 address when `ip -6 route get` finds a route,
# then IPv4 (GitHub's hosted runners have no IPv6). A scan that reaches both must get the same key
# from both, or nothing is stored. A host-key mismatch never falls back to the other family.
#
# The repository and its Actions logs are public. Every address, instance ID, host key and
# fingerprint this reads is masked (::add-mask::) before anything else prints, and none reaches a job
# output. curl's, ssh-keyscan's, ssh-keygen's and ssh's own output and every jq error go to private
# files under $RUNNER_TEMP/pin (or nowhere); the workflow's cleanup removes it and $RUNNER_TEMP/ssh.
# Nothing here traces its commands. tests/unit/host-pin.test.ts runs every subcommand against the
# stand-ins in tests/fixtures/host-pin.
set -Eeuo pipefail
set +o xtrace
umask 077
export LC_ALL=C

# The credentials, kept in unexported shell variables: curl reads them from its config on stdin,
# and ssh-keyscan, ssh, jq and ssh-keygen never see them in their environment.
s3_id=${AWS_ACCESS_KEY_ID-}
s3_secret=${AWS_SECRET_ACCESS_KEY-}
configure_key=${ANSIBLE_SSH_KEY-}
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ANSIBLE_SSH_KEY

tofu_dir=${RUNNER_TEMP:?}/tofu
p=$RUNNER_TEMP/pin
ssh_dir=$RUNNER_TEMP/ssh

# A host key: a public word (the Tofu hosts map's keys), which may appear in logs and outputs.
KEY_RE='^(staging|prod)(-[0-9]{1,2})?$'
RETRY="The next approved run pins it (the plan will list it as needing a pin)."

# jq's checks of every value this reads: a pin, a host_connection entry and their parts. Callers
# discard jq's output and errors, which could quote the value.
JQ_DEFS='
def octet: "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
def v4: type == "string" and test("^(\(octet)[.]){3}\(octet)$");
def v6: type == "string" and test("^[0-9a-fA-F:]{2,39}$")
  and (if test("::") then
         (split("::") | length == 2)
         and ([split("::")[] | select(. != "") | split(":")[]] | all(length >= 1 and length <= 4) and length <= 7)
       else (split(":") | length == 8 and all(length >= 1 and length <= 4)) end);
def id: type == "string" and test("^[0-9]{1,20}$");
def hostkey: type == "string" and test("^ssh-ed25519 [A-Za-z0-9+/]{68}$");
def pin: type == "object" and keys == ["host_key", "instance_id", "ipv4", "ipv6"]
  and (.host_key | hostkey) and (.instance_id | id) and (.ipv4 | v4) and (.ipv6 | v6);
def conn: type == "object" and keys == ["instance_id", "ipv4", "ipv6"]
  and (.instance_id | id) and (.ipv4 | v4) and (.ipv6 | v6);
'

# A step output (none on a hand run, where GITHUB_OUTPUT is unset).
out() {
  if [[ -n ${GITHUB_OUTPUT-} ]]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi
}

# connect's failures name their reason (fail_reason) in the output reason=; status and pin set none.
fail_reason=""
fail() {
  if [[ -n $fail_reason ]]; then out reason "$fail_reason"; fi
  echo "::error::$1"
  exit 1
}

# A line for the run's summary (none on a hand run).
summary() {
  if [[ -n ${GITHUB_STEP_SUMMARY-} ]]; then printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

# Masks a value for the rest of the job. Actions masks only the exact string, so each form this
# script holds is masked as it is held.
mask() {
  if [[ -n ${1-} ]]; then echo "::add-mask::$1"; fi
}

# Masks a host key's base64 and its SHA-256 fingerprint; fails unless ssh-keygen reads the key.
mask_key() {
  local key=$1 fingerprint
  mask "${key#ssh-ed25519 }"
  ssh-keygen -E sha256 -lf - <<<"$key" >"$p/fingerprint" 2>"$p/keygen.stderr" || return 1
  fingerprint=$(awk 'NR == 1 { print $2 }' "$p/fingerprint")
  [[ $fingerprint == SHA256:?* ]] || return 1
  mask "${fingerprint#SHA256:}"
}

# The store's settings. Returns 3 when any of the four is empty (no store in this environment);
# fails when one is set but malformed.
store_settings() {
  if [[ -z ${STATE_BUCKET-} || -z ${STATE_ENDPOINT-} || -z $s3_id || -z $s3_secret ]]; then return 3; fi
  [[ $STATE_BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] ||
    fail "TOFU_STATE_BUCKET must be an Object Storage bucket name without a dot (a dotted name can't match the endpoint's TLS certificate)."
  [[ $STATE_ENDPOINT =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] ||
    fail "TOFU_STATE_ENDPOINT must be the bucket's https:// endpoint, with no path."
  # curl's config quotes the credentials; a line break would end the quoted value.
  [[ $s3_id != *[$'\r\n']* && $s3_secret != *[$'\r\n']* ]] ||
    fail "The state key's TOFU_STATE_*_ACCESS_KEY and TOFU_STATE_*_SECRET_KEY must each be one line."
}

# One request to the pin store for host key $1: a GET into the private file $2, or a PUT of the file
# $3. Prints the HTTP status (000 when curl got none). The URL and the credentials go to curl in a
# config on stdin; its errors go to a private file.
storage() {
  local key=$1 body=$2 upload=${3-} user url
  local args=(--config - --silent --show-error --proto "=https" --tlsv1.2 --connect-timeout 10
    --max-time 30 --retry 2 --max-filesize 65536 --aws-sigv4 aws:amz:us-east-1:s3
    --write-out '%{http_code}' --output "$body")
  if [[ -n $upload ]]; then args+=(--upload-file "$upload" --header 'Content-Type: application/json'); fi
  url="https://${STATE_BUCKET}.${STATE_ENDPOINT#https://}/tarubot/pins/$key.json"
  user="$s3_id:$s3_secret"
  user=${user//\\/\\\\}
  user=${user//\"/\\\"}
  printf 'user = "%s"\nurl = "%s"\n' "$user" "$url" | curl "${args[@]}" 2>>"$p/curl.stderr" || true
}

# Reads host key $1's pin into pin_status (found, none, unreadable or malformed), pin_code (the
# HTTP status) and, when found, pin_key, pin_id, pin_v4 and pin_v6, each masked.
read_pin() {
  local key=$1
  pin_key="" pin_id="" pin_v4="" pin_v6=""
  rm -f -- "${p:?}/$key.get"
  pin_code=$(storage "$key" "$p/$key.get")
  pin_code=${pin_code:-000}
  case $pin_code in
    200) ;;
    404)
      pin_status=none
      return 0
      ;;
    *)
      pin_status=unreadable
      return 0
      ;;
  esac
  if ! jq -s -e "$JQ_DEFS length == 1 and (.[0] | pin)" "$p/$key.get" >/dev/null 2>&1; then
    pin_status=malformed
    return 0
  fi
  IFS=$'\t' read -r pin_key pin_id pin_v4 pin_v6 < <(jq -r '[.host_key, .instance_id, .ipv4, .ipv6] | @tsv' "$p/$key.get")
  mask "$pin_id"
  mask "$pin_v4"
  mask "$pin_v6"
  if ! mask_key "$pin_key"; then
    pin_status=malformed
    return 0
  fi
  pin_status=found
}

# Whether this runner has a route to address $2 of family $1 (6 or 4).
routed() {
  ip "-$1" route get "$2" >/dev/null 2>&1
}

# Scans the host at IPv6 $1 and IPv4 $2 for its one ed25519 key, into scanned. Each round asks every
# routed family, IPv6 first; one answering family is enough, and two must agree. Rounds repeat every
# 10 seconds for up to 5 minutes.
scan() {
  local v6=$1 v4=$2 fam addr n line attempt deadline=$((SECONDS + 300))
  local -a found
  scanned=
  for ((attempt = 1; ; attempt++)); do
    found=()
    for fam in 6 4; do
      if [[ $fam == 6 ]]; then addr=$v6; else addr=$v4; fi
      routed "$fam" "$addr" || continue
      ssh-keyscan -T 5 -t ed25519 "$addr" >"$p/scan$fam" 2>"$p/scan$fam.stderr" || true
      # One line per key, `<address> ssh-ed25519 <base64>`; banner comments start with #.
      n=$(awk '$1 !~ /^#/ && $2 == "ssh-ed25519"' "$p/scan$fam" | wc -l)
      ((n > 0)) || continue
      ((n == 1)) || fail "The host offered more than one ed25519 host key on one address; nothing was stored. $RETRY"
      line=$(awk '$1 !~ /^#/ && $2 == "ssh-ed25519" { print (NF == 3 ? $2 " " $3 : "-") }' "$p/scan$fam")
      if ! [[ $line =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}$ ]] || ! mask_key "$line"; then
        fail "The host offered a malformed ed25519 host key; nothing was stored. $RETRY"
      fi
      found+=("$line")
    done
    if ((${#found[@]} == 2)) && [[ ${found[0]} != "${found[1]}" ]]; then
      fail "the host's IPv6 and IPv4 addresses offered different host keys; nothing was stored. $RETRY"
    fi
    if ((${#found[@]} > 0)); then
      scanned=${found[0]}
      return 0
    fi
    if ((SECONDS >= deadline || attempt >= 30)); then
      fail "The host offered no ed25519 host key on either address within 5 minutes; nothing was stored. $RETRY"
    fi
    sleep 10
  done
}

# The saved plan's view of host key $1: whether it creates or replaces the instance, and the
# instance it found in the state (empty for none), as `<true|false> <id>`.
planned() {
  jq -r --arg a "linode_instance.host[\"$1\"]" '
    ([.prior_state.values.root_module.resources[]?
      | select(.address == $a and .mode == "managed") | .values.id | tostring][0] // "") as $prior
    | ([.resource_changes[]?
      | select(.address == $a and .mode == "managed" and (has("deposed") | not))
      | .change.actions | any(. == "create")] | any) as $created
    | "\($created) \($prior)"' "$tofu_dir/plan.json" 2>/dev/null
}

status() {
  local scope=${PIN_SCOPE-} key rc=0 created prior prior_v4 prior_v6 in_scope needed line
  local -a keys=() lines=() warnings=() need=()
  [[ $scope =~ ^(staging|prod|all)$ ]] || fail "PIN_SCOPE must be staging, prod or all."
  store_settings || rc=$?
  ((rc == 0)) || fail "The pin store isn't set: TOFU_STATE_BUCKET, TOFU_STATE_ENDPOINT, TOFU_STATE_READ_ACCESS_KEY and TOFU_STATE_READ_SECRET_KEY must be set in infra-plan."
  [[ -f $tofu_dir/plan.json && -f $tofu_dir/values.tfvars.json ]] || fail "The saved plan's plan.json and values.tfvars.json are missing: run tofu-ci.sh values and summarize first."
  mkdir -p -- "$p"
  mapfile -t keys < <(jq -r '.hosts | keys[]' "$tofu_dir/values.tfvars.json" 2>/dev/null)
  for key in "${keys[@]}"; do
    [[ $key =~ $KEY_RE ]] || fail "A host key in TOFU_VARS isn't staging or prod, optionally with -N."
  done

  # Every instance ID and address the state holds, masked before anything prints.
  while IFS= read -r line; do mask "$line"; done < <(jq -r '
    .prior_state.values.root_module.resources[]?
    | select(.mode == "managed" and .type == "linode_instance")
    | .values | (.id | tostring), (.ipv4[]? // empty), ((.ipv6 // "") | ., split("/")[0])
    | select(type == "string" and length > 0)' "$tofu_dir/plan.json" 2>/dev/null)

  # Everything is read first (read_pin masks each pin), and only then printed.
  for key in "${keys[@]}"; do
    read -r created prior < <(planned "$key") || fail "The saved plan couldn't be read."
    if [[ $scope == all || ${key%%-*} == "$scope" ]]; then in_scope=true; else in_scope=false; fi
    if [[ $created == true ]]; then
      need+=("$key")
      lines+=("$key: new host — approving trusts its host key on first use")
      continue
    fi
    [[ -n $prior ]] || fail "The saved plan neither keeps nor builds $key's instance."
    IFS=$'\t' read -r prior_v4 prior_v6 < <(jq -r --arg a "linode_instance.host[\"$key\"]" '
      [.prior_state.values.root_module.resources[]? | select(.address == $a and .mode == "managed")][0].values
      | [(.ipv4[0]? // "-"), ((.ipv6 // "-") | split("/")[0])] | @tsv' "$tofu_dir/plan.json" 2>/dev/null)
    read_pin "$key"
    case $pin_status in
      unreadable) fail "The pin store couldn't be read for $key (HTTP $pin_code)." ;;
      malformed) fail "$key's stored pin is malformed: delete tarubot/pins/$key.json with your own bucket credentials, then dispatch again." ;;
    esac
    # What the host needs: nothing, its addresses updated, or its key pinned for this instance.
    if [[ $pin_status == found && $pin_id == "$prior" ]]; then
      if [[ $pin_v4 == "$prior_v4" && $pin_v6 == "$prior_v6" ]]; then needed=none; else needed=addresses; fi
    else
      needed=key
    fi
    if [[ $needed == none ]]; then
      lines+=("$key: pinned")
    elif [[ $in_scope == false ]]; then
      # Another target's host: never scanned in this run, and the approving job never writes its pin.
      if [[ $needed == key ]]; then line="has no pin for its current instance"; else line="has other addresses than its pin"; fi
      warnings+=("$key $line, and this run leaves it alone: dispatch action=infra to pin it")
    elif [[ $needed == key ]]; then
      need+=("$key")
      lines+=("$key: no pin for its current instance — approving trusts its host key on first use")
    else
      need+=("$key")
      lines+=("$key: addresses changed — approving updates its pin, not its key")
    fi
  done

  summary "### Host keys"
  summary ""
  if ((${#keys[@]} == 0)); then
    echo "No hosts in TOFU_VARS."
    summary "No hosts."
  fi
  for line in "${lines[@]}"; do
    echo "$line"
    summary "- $line"
  done
  for line in "${warnings[@]}"; do
    echo "::warning::$line"
    summary "- **Warning:** $line"
  done
  out pins_needed "${need[*]}"
}

pin() {
  local rc=0 code key created prior id v4 v6 word host_key what
  local -a words=() list=() written=() lines=()
  local -A seen=() conn_id=() conn_v4=() conn_v6=()
  [[ ${PINS-} =~ ^[a-z0-9\ -]*$ ]] || fail "PINS must be host keys separated by spaces."
  read -ra words <<<"${PINS-}"
  for word in "${words[@]}"; do
    [[ $word =~ $KEY_RE ]] || fail "PINS may name only host keys: staging or prod, optionally with -N."
    if [[ -z ${seen[$word]-} ]]; then
      seen[$word]=1
      list+=("$word")
    fi
  done
  if ((${#list[@]} == 0)); then
    echo "No host key to pin."
    out pinned ""
    return 0
  fi
  store_settings || rc=$?
  ((rc == 0)) || fail "The pin store isn't set: TOFU_STATE_BUCKET, TOFU_STATE_ENDPOINT, TOFU_STATE_WRITE_ACCESS_KEY and TOFU_STATE_WRITE_SECRET_KEY must be set in prod."
  [[ -f $tofu_dir/outputs.json && -f $tofu_dir/plan.json ]] || fail "OpenTofu's outputs.json and the adopted plan.json are missing: run tofu-ci.sh adopt and output first."
  mkdir -p -- "$p"

  # Each host's connection from OpenTofu, checked and masked before anything else prints.
  for key in "${list[@]}"; do
    jq -e --arg k "$key" "$JQ_DEFS"'(.host_connection.value // {}) | type == "object" and has($k) and (.[$k] | conn)' \
      "$tofu_dir/outputs.json" >/dev/null 2>&1 ||
      fail "OpenTofu's host_connection output has no valid entry for $key."
    IFS=$'\t' read -r id v4 v6 < <(jq -r --arg k "$key" '.host_connection.value[$k] | [.instance_id, .ipv4, .ipv6] | @tsv' "$tofu_dir/outputs.json")
    mask "$id"
    mask "$v4"
    mask "$v6"
    conn_id[$key]=$id
    conn_v4[$key]=$v4
    conn_v6[$key]=$v6
  done

  # Each instance must be the one the approved plan expects: a new one where it creates or replaces
  # the host, the same one everywhere else. Otherwise the state moved since the plan.
  for key in "${list[@]}"; do
    read -r created prior < <(planned "$key") || fail "The adopted plan couldn't be read."
    if [[ $created == true ]]; then
      [[ ${conn_id[$key]} != "$prior" ]] || fail "$key: the host changed since the plan; dispatch again."
    else
      [[ -n $prior && ${conn_id[$key]} == "$prior" ]] || fail "$key: the host changed since the plan; dispatch again."
    fi
  done

  for key in "${list[@]}"; do
    id=${conn_id[$key]} v4=${conn_v4[$key]} v6=${conn_v6[$key]}
    read_pin "$key"
    case $pin_status in
      unreadable) fail "The pin store couldn't be read for $key (HTTP $pin_code); nothing was written. $RETRY" ;;
      malformed) fail "$key's stored pin is malformed; nothing was written. Delete tarubot/pins/$key.json with your own bucket credentials, then dispatch action=infra." ;;
    esac
    if [[ $pin_status == found && $pin_id == "$id" ]]; then
      if [[ $pin_v4 == "$v4" && $pin_v6 == "$v6" ]]; then
        lines+=("$key: pinned already")
        continue
      fi
      # The same instance at other addresses: the key it was pinned with stays; nothing is scanned.
      host_key=$pin_key
      what="$key: addresses updated in its pin; its key is unchanged"
    else
      # A new instance, or none pinned yet: trust on first use, stored before any login.
      scan "$v6" "$v4"
      host_key=$scanned
      what="$key: host key pinned on first use"
    fi
    jq -cjn --arg k "$host_key" --arg i "$id" --arg a "$v4" --arg b "$v6" \
      '{host_key: $k, instance_id: $i, ipv4: $a, ipv6: $b}' >"$p/$key.put"
    code=$(storage "$key" "$p/$key.response" "$p/$key.put")
    if [[ $code == 403 ]]; then
      fail "The pin store refused to store $key's pin (HTTP 403): only prod's read/write state key (TOFU_STATE_WRITE_*) can write pins. $RETRY"
    fi
    [[ $code =~ ^(200|201|204)$ ]] || fail "$key's pin couldn't be stored (HTTP ${code:-000}). $RETRY"
    written+=("$key")
    lines+=("$what")
  done

  summary "### Host keys"
  summary ""
  for what in "${lines[@]}"; do
    echo "$what"
    summary "- $what"
  done
  out pinned "${written[*]}"
}

connect() {
  local key=${1-} rc=0 fam addr af attempt deadline connected="" args
  [[ $key =~ ^(staging|prod)$ ]] || fail "usage: host.sh connect staging|prod"
  fail_reason="pin-store"
  store_settings || rc=$?
  if ((rc == 3)); then
    echo "No pin store in this environment: TOFU_STATE_BUCKET, TOFU_STATE_ENDPOINT and the state key are unset."
    exit 3
  fi
  mkdir -p -- "$p" "$ssh_dir"
  chmod 700 -- "$ssh_dir"
  read_pin "$key"
  case $pin_status in
    none)
      echo "No pin for $key yet: its host key is pinned by the first approved run that builds it."
      exit 3
      ;;
    unreadable) fail "The pin store couldn't be read for $key (HTTP $pin_code)." ;;
    malformed) fail "$key's stored pin is malformed: delete tarubot/pins/$key.json with your own bucket credentials, then dispatch action=infra." ;;
  esac

  # root's Configure key, removed again if this fails. Carriage returns from a key pasted on another
  # system would break it.
  fail_reason="configure-key"
  trap 'if (($? != 0)); then rm -f -- "${ssh_dir:?}/key"; fi' EXIT
  printf '%s\n' "${configure_key//$'\r'/}" >"$ssh_dir/key"
  configure_key=""
  grep -q 'PRIVATE KEY' "$ssh_dir/key" || fail "ANSIBLE_SSH_KEY isn't set in the $key environment."
  # ssh runs with BatchMode, so a key with a passphrase could never be unlocked.
  ssh-keygen -y -P '' -f "$ssh_dir/key" >/dev/null 2>"$p/keygen.stderr" ||
    fail "ANSIBLE_SSH_KEY must be an OpenSSH private key without a passphrase."
  # The pinned key under the alias `target`, the inventory's one host, so no file names the host.
  printf 'target %s\n' "$pin_key" >"$ssh_dir/known_hosts"

  # Only the pinned ed25519 key is accepted. LogLevel=FATAL keeps ssh's error-level messages out of
  # its log, above all the "REMOTE HOST IDENTIFICATION HAS CHANGED" banner with the offered key's
  # fingerprint; a key other than the pin then ends as "Host key verification failed.", and a
  # refused Configure key as "Permission denied". The log stays private either way.
  local -a opts=(-F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts"
    -o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=target -o HostKeyAlgorithms=ssh-ed25519
    -o CheckHostIP=no -o UpdateHostKeys=no -o ConnectTimeout=10 -o LogLevel=FATAL)
  # Each round tries IPv6 when routed, then IPv4. No route, a refusal or a timeout (all silent at
  # LogLevel=FATAL) moves on to the next family, then the next round, every 10 seconds for up to 5
  # minutes. A host-key mismatch or a refused key ends the run at once.
  deadline=$((SECONDS + 300))
  for ((attempt = 1; ; attempt++)); do
    for fam in 6 4; do
      if [[ $fam == 6 ]]; then addr=$pin_v6 af=inet6; else addr=$pin_v4 af=inet; fi
      routed "$fam" "$addr" || continue
      rc=0
      timeout 15 ssh "${opts[@]}" -o "AddressFamily=$af" -i "$ssh_dir/key" "root@$addr" true >"$p/ssh.log" 2>&1 || rc=$?
      if ((rc == 0)); then
        connected=$fam
        break 2
      fi
      if grep -q 'Host key verification failed' "$p/ssh.log"; then
        fail_reason="host-key"
        fail "$key offered a host key other than its pin (Host key verification failed); the other address family wasn't tried. If the host was rebuilt outside a Deploy run, delete tarubot/pins/$key.json with your own bucket credentials and dispatch action=infra."
      fi
      if grep -q 'Permission denied' "$p/ssh.log"; then
        fail_reason="key-rejected"
        fail "$key refused ANSIBLE_SSH_KEY (Permission denied): root's authorized_keys doesn't hold the $key environment's Configure key."
      fi
    done
    if ((SECONDS >= deadline || attempt >= 30)); then
      fail_reason=unreachable
      fail "$key didn't answer SSH over IPv6 or IPv4 within 5 minutes."
    fi
    sleep 10
  done

  fail_reason=""
  # The inventory: the address that answered, with the probe's own options and the matching
  # AddressFamily, plus 2.36.0's keepalives. Each option is shell-quoted for Ansible's shlex.
  if [[ $connected == 6 ]]; then addr=$pin_v6 af=inet6; else addr=$pin_v4 af=inet; fi
  args=$(printf '%s\0' "${opts[@]}" -o "AddressFamily=$af" -o ServerAliveInterval=15 -o ServerAliveCountMax=4 |
    jq -Rs 'split("\u0000")[:-1] | map(@sh) | join(" ")')
  jq -n --arg host "$addr" --arg keyfile "$ssh_dir/key" --argjson args "$args" '{all: {hosts: {target: {
      ansible_host: $host,
      ansible_user: "root",
      ansible_ssh_private_key_file: $keyfile,
      ansible_ssh_common_args: $args}}}}' >"$ssh_dir/inventory.json"
  if [[ $connected == 6 ]]; then echo "Connected to $key over IPv6."; else echo "Connected to $key over IPv4."; fi
}

case ${1-} in
  status | pin)
    (($# == 1)) || fail "usage: host.sh status | pin | connect staging|prod"
    "$1"
    ;;
  connect)
    (($# == 2)) || fail "usage: host.sh status | pin | connect staging|prod"
    connect "$2"
    ;;
  *) fail "usage: host.sh status | pin | connect staging|prod" ;;
esac
