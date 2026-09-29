#!/usr/bin/env bash
# Reconcile one environment using the existing shared Linode/DNS/access-list state. Plan and
# apply stay on one runner after that environment's approval, so no artifact or duplicate values
# need to cross an approval job. Provider output remains private because Actions logs are public.
set -Eeuo pipefail
umask 077

fail() { echo "::error::$1"; exit 1; }
[[ ${TARGET-} == staging || ${TARGET-} == production ]] || fail 'environment must be staging or production.'
[[ ${REBUILD-} == true || ${REBUILD-} == false ]] || fail 'rebuild must be true or false.'
[[ -n ${LINODE_TOKEN-} && -n ${CLOUDFLARE_API_TOKEN-} ]] || fail 'Set LINODE_TOKEN and CLOUDFLARE_API_TOKEN in the selected environment.'
[[ -n ${AWS_ACCESS_KEY_ID-} && -n ${AWS_SECRET_ACCESS_KEY-} ]] || fail 'Set TOFU_STATE_ACCESS_KEY and TOFU_STATE_SECRET_KEY in the selected environment.'

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
helper=$root/ops/tofu/ci/tofu-ci.sh
module=$root/ops/tofu
d=${RUNNER_TEMP:?}/tofu
bash "$helper" prepare
export TF_DATA_DIR=$d/data
if ! jq -e --arg target "$TARGET" '.hosts[$target].role == $target' "$d/values.tfvars.json" >/dev/null 2>&1; then
  fail 'TOFU_VARS must contain the selected environment host with its matching role.'
fi
if [[ $REBUILD == true ]]; then
  printf 'linode_instance.host["%s"]' "$TARGET" >"$d/replace"
fi
bash "$helper" init
bash "$helper" plan
ALLOW_DESTROY=$REBUILD ALLOW_ACCESS_REMOVAL=$REBUILD bash "$helper" summarize

# The state owns both environments. A selected run must not resize, delete or replace another
# host, nor change its firewall or DNS. Shared access-list updates are allowed, but a removal
# without an explicit rebuild was already refused by summarize.
if ! jq -e --arg target "$TARGET" '
  all(.resource_changes[]?;
    (.change.actions == ["no-op"] or .change.actions == ["read"])
    or (.type == "linode_database_access_controls" and .name == "db"
        and (.change.actions == ["update"] or .change.actions == ["create"]))
    or (.index == $target and
        ((.type == "linode_instance" and .name == "host")
         or (.type == "linode_firewall" and .name == "host")
         or (.type == "cloudflare_dns_record" and (.name == "a" or .name == "aaaa")))))
  ' "$d/plan.json" >/dev/null 2>&1; then
  fail 'The plan changes resources outside the selected environment; preserve the other hosts in TOFU_VARS.'
fi

# Apply even a resource no-op: adding a sensitive connection output must reach state before the
# following output command can hand it to Ansible. OpenTofu applies the same saved plan.
AUTOMATE_HOST_PIN=true bash "$helper" apply
if ! tofu -chdir="$module" output -json >"$d/outputs.json" 2>"$d/output.stderr"; then
  fail 'Could not read the provisioned host connection from OpenTofu.'
fi
echo "Infrastructure ready for $TARGET."
