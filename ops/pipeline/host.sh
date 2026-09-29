#!/usr/bin/env bash
# Connect the reviewed, successfully applied OpenTofu plan to Ansible. The caller supplies private
# `tofu output -json` and `tofu show -json` files, after Apply: no address goes through a job output.
# A newly created/replaced instance may establish its public SSH key once. Later runs reuse the
# bucket's pin for that instance ID and refuse a changed key; even a create plan cannot repin the
# same instance. The pipeline's infrastructure concurrency group protects this read/write pair.
# All connection material stays under RUNNER_TEMP/pipeline-host; the caller removes it after Ansible.
set -Eeuo pipefail
umask 077
fail() { echo "::error::$1"; exit 1; }
(($# == 3)) || fail "usage: host.sh staging|production OUTPUTS_JSON SAVED_PLAN_JSON"
target=$1
[[ $target == staging || $target == production ]] || fail "Unknown deployment environment."
outputs=$2
plan=$3
d=${RUNNER_TEMP:?}/pipeline-host
mkdir -p -- "$d"
chmod 700 -- "$d"
# Failure leaves no usable private key. Success retains it only until the caller's cleanup step.
trap 'rc=$?; if ((rc != 0)); then rm -f -- "$d/key"; fi' EXIT

if ! jq -e --arg target "$target" '
  .host_connection.value[$target] as $h
  | ($h.instance_id | type == "string" and test("^[0-9]{1,20}$"))
    and ($h.address | type == "string" and test("^[0-9]{1,3}([.][0-9]{1,3}){3}$")
      and (split(".") | all(.[]; tonumber <= 255)))
' "$outputs" >/dev/null 2>&1; then fail "OpenTofu returned no valid connection for the selected environment."; fi
address=$(jq -r --arg target "$target" '.host_connection.value[$target].address' "$outputs")
instance=$(jq -r --arg target "$target" '.host_connection.value[$target].instance_id' "$outputs")
echo "::add-mask::$address"
# IDs can occur inside tool errors too. Every external command below still keeps its errors private.
echo "::add-mask::$instance"

[[ ${STATE_BUCKET-} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "The state bucket is missing or malformed."
[[ ${STATE_ENDPOINT-} =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || fail "The state endpoint is missing or malformed."
prefix=${STATE_PIN_PREFIX:-tarubot/hosts}
[[ $prefix =~ ^[a-z0-9][a-z0-9/_-]*[a-z0-9]$ && $prefix != *//* ]] || fail "The host pin prefix is malformed."
# Curl's config syntax quotes the credentials. Reject line breaks and escape quotes and
# backslashes rather than putting either credential in curl's process arguments.
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [[ -n ${!name-} && ${!name} != *[$'\r\n']* ]] || fail "The state storage credentials are missing or malformed."
done
url="https://${STATE_BUCKET}.${STATE_ENDPOINT#https://}/$prefix/$target.json"
storage() {
  local user=${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}
  user=${user//\\/\\\\}
  user=${user//\"/\\\"}
  printf 'user = "%s"\nurl = "%s"\n' "$user" "$url" |
    curl --config - --silent --max-time 30 --connect-timeout 10 --retry 2 \
      --aws-sigv4 aws:amz:us-east-1:s3 --write-out '%{http_code}' "$@" 2>"$d/storage.stderr"
}
status=$(storage --output "$d/stored.json") || fail "The retained host pin could not be read."
case $status in
  200)
    jq -e 'type == "object" and keys == ["host_key", "instance_id"]
      and (.instance_id | type == "string" and test("^[0-9]{1,20}$"))
      and (.host_key | type == "string" and test("^ssh-ed25519 [A-Za-z0-9+/]{68}$"))' \
      "$d/stored.json" >/dev/null 2>&1 || fail "The retained host pin is malformed; nothing was repinned."
    ;;
  404) ;;
  *) fail "The retained host pin could not be read; nothing was repinned." ;;
esac

new_pin=true
key=
if [[ $status == 200 ]] && [[ $(jq -r '.instance_id' "$d/stored.json") == "$instance" ]]; then
  new_pin=false
  key=$(jq -r '.host_key' "$d/stored.json")
else
  # A missing pin or an old instance ID never authorizes a scan by itself: the reviewed plan must
  # create this exact managed instance. A no-op/update cannot silently adopt an existing host.
  jq -e --arg address "linode_instance.host[\"$target\"]" '
    any(.resource_changes[]?; .address == $address and .mode == "managed"
      and .type == "linode_instance" and .name == "host"
      and (.change.actions == ["create"] or .change.actions == ["delete", "create"]
        or .change.actions == ["create", "delete"]))
  ' "$plan" >/dev/null 2>&1 || fail "This instance has no retained pin and was not created by the reviewed plan."
  # A socket/key can appear before cloud-init has finished. Each scan has a five-second timeout;
  # 30 attempts bound this wait to five minutes. stdout and the server banner remain private.
  for ((attempt = 0; attempt < 30; attempt++)); do
    if ssh-keyscan -T 5 -t ed25519 "$address" >"$d/scanned" 2>"$d/keyscan.stderr"; then
      key=$(awk '$2 == "ssh-ed25519" && NF == 3 { print $2 " " $3 }' "$d/scanned" | sort -u)
      [[ $key =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}$ ]] && break
    fi
    key=
    if ((attempt < 29)); then sleep 5; fi
  done
  [[ -n $key ]] || fail "The new host did not offer one Ed25519 host key in time."
fi
echo "::add-mask::${key#ssh-ed25519 }"
ssh-keygen -E sha256 -lf - <<<"$key" >"$d/fingerprint" 2>"$d/keygen.stderr" || fail "The host key is invalid."
fingerprint=$(awk '{ print $2 }' "$d/fingerprint")
echo "::add-mask::${fingerprint#SHA256:}"
private_key=${ANSIBLE_SSH_KEY-}
printf '%s\n' "${private_key//$'\r'/}" >"$d/key"
unset ANSIBLE_SSH_KEY private_key
ssh-keygen -y -P '' -f "$d/key" >/dev/null 2>"$d/keygen.stderr" || fail "ANSIBLE_SSH_KEY must be a private key without a passphrase."
printf 'target %s\n' "$key" >"$d/known_hosts"
ssh_args=(-F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$d/known_hosts"
  -o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=target -o HostKeyAlgorithms=ssh-ed25519
  -o CheckHostIP=no -o UpdateHostKeys=no -o AddressFamily=any -o ConnectTimeout=5
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=FATAL)
# Authenticate with the candidate/retained key before storing anything. A changed retained key is
# refused by SSH, never by a keyscan comparison that might accidentally authorize its replacement.
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if timeout 10 ssh "${ssh_args[@]}" -i "$d/key" "root@$address" true >"$d/ssh.log" 2>&1; then
    ready=true
    break
  fi
  if ((attempt < 29)); then sleep 5; fi
done
[[ $ready == true ]] || fail "SSH did not become ready with the retained host key and Configure key."
if [[ $new_pin == true ]]; then
  # Authentication establishes the pin even if cloud-init later fails or times out. The next
  # reviewed plan can then retry this same instance without authorizing another first-key scan.
  jq -n --arg instance "$instance" --arg key "$key" '{instance_id: $instance, host_key: $key}' >"$d/pin.json"
  status=$(storage --upload-file "$d/pin.json" --header 'Content-Type: application/json' --output "$d/storage-response") ||
    fail "The new host pin could not be retained; deployment stopped."
  [[ $status == 200 || $status == 201 || $status == 204 ]] || fail "The new host pin could not be retained; deployment stopped."
fi
rc=0
# --wait includes package installation; timeout also bounds a connected but hung cloud-init run.
timeout 600 ssh "${ssh_args[@]}" -i "$d/key" "root@$address" 'cloud-init status --wait' >"$d/cloud-init.log" 2>&1 || rc=$?
[[ $rc == 0 || $rc == 2 ]] || fail "cloud-init did not finish successfully in time."
# The inventory uses the same checked SSH arguments as the readiness probes, under public alias
# `target`. Its path alone may be a job output; its contents must never leave the private runner.
args=$(printf '%s\n' "${ssh_args[@]}" | jq -Rs 'split("\n")[:-1] | map(@sh) | join(" ")')
jq -n --arg host "$address" --arg keyfile "$d/key" --argjson args "$args" '{all: {hosts: {target: {
  ansible_host: $host, ansible_user: "root", ansible_ssh_private_key_file: $keyfile,
  ansible_ssh_common_args: $args}}}}' >"$d/inventory.json"
if [[ -n ${GITHUB_OUTPUT-} ]]; then printf 'inventory=%s/inventory.json\n' "$d" >>"$GITHUB_OUTPUT"; fi
echo "The provisioned host is ready for Ansible with its retained SSH pin."
