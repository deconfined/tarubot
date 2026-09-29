#!/usr/bin/env bash
# The steps of .github/workflows/infra.yml ("Infrastructure", 2.36.0, issue #62), one phase per
# step, so the Plan and Apply jobs run the same code while each step's environment still holds only
# the secrets its phase needs. ci.yml's "Infrastructure checks" job runs the install phase too.
#
#   tofu-ci.sh install     the release in ../.opentofu-version, checked against ../opentofu.sha256
#                          (copied from that release's signature-verified SHA256SUMS), on GITHUB_PATH
#   tofu-ci.sh prepare     TOFU_VARS checked silently, every identifying value in it masked before
#                          anything else prints, then the private working files: the values, the
#                          backend settings and the replace target (TOFU_VARS, STATE_BUCKET,
#                          STATE_ENDPOINT, REPLACE)
#   tofu-ci.sh init        the backend from backend.hcl and the providers from the lock file
#                          (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, TF_VAR_state_passphrase)
#   tofu-ci.sh plan        a saved, encrypted plan (init's three, LINODE_TOKEN, CLOUDFLARE_API_TOKEN)
#   tofu-ci.sh summarize   the change list to the log, the run summary and the step's outputs, then
#                          the guards (TF_VAR_state_passphrase, ALLOW_DESTROY, ALLOW_ACCESS_REMOVAL)
#   tofu-ci.sh compare     Apply only: this plan's change list must equal the approved one (APPROVED)
#   tofu-ci.sh apply       Apply only: the saved plan (plan's five)
#
# The repository and its Actions logs are public. So nothing here prints OpenTofu's own output, a
# host name, an address, an ID or a key: prepare masks every such value inside TOFU_VARS before
# anything else prints (GitHub masks a secret only where its whole value appears), every tofu
# command writes to a private file under $RUNNER_TEMP/tofu, and diagnostics print only through
# diag.jq. The jq programs beside this script (shape, masks, summary, diag, applied) hold the rules;
# tests/unit/infra.test.ts runs them against sample plans and runs these phases with a stand-in tofu.
# Nothing here traces its commands, and the workflow's last step removes $RUNNER_TEMP/tofu.
set -Eeuo pipefail
umask 077

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# The module, ops/tofu, by its absolute path, so the phases don't depend on the working directory.
module=$(dirname -- "$here")
d=${RUNNER_TEMP:?}/tofu

fail() {
  echo "::error::$1"
  exit 1
}

install() {
  local v bin
  v=$(<"$module/.opentofu-version")
  [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "ops/tofu/.opentofu-version must hold X.Y.Z."
  bin=$RUNNER_TEMP/tofu-bin
  mkdir -p -- "$bin"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$bin/tofu_${v}_linux_amd64.zip" \
    "https://github.com/opentofu/opentofu/releases/download/v${v}/tofu_${v}_linux_amd64.zip"
  (cd -- "$bin" && sha256sum --check --strict --quiet "$module/opentofu.sha256")
  unzip -q -o "$bin/tofu_${v}_linux_amd64.zip" tofu -d "$bin"
  echo "$bin" >>"$GITHUB_PATH"
}

prepare() {
  mkdir -p -- "$d"
  # The shape check prints nothing of the value: jq's own messages could quote it. Values reach jq
  # through printf (a shell builtin) and a pipe, never an argument or a temporary file.
  if ! printf '%s' "${TOFU_VARS-}" | jq -e -f "$here/shape.jq" >/dev/null 2>&1; then
    fail "TOFU_VARS must be one JSON object with exactly the keys hosts, root_keys, configure_keys, root_password_hash, cloudflare_zone_id, database_ids and db_allow_extra, in the shape of ops/tofu/examples/example.tfvars.json."
  fi
  printf '%s' "${TOFU_VARS-}" | jq -c -f "$here/masks.jq" >"$d/masks.json"
  local m
  while IFS= read -r m; do
    echo "::add-mask::$m"
  done < <(jq -r '.[]' "$d/masks.json")
  # From here on every identifying value prints as ***.

  printf '%s' "${TOFU_VARS-}" | jq -c . >"$d/values.tfvars.json"

  # The backend's bucket and endpoint (partial configuration; ops/tofu/versions.tf).
  [[ ${STATE_BUCKET-} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "TOFU_STATE_BUCKET must be an Object Storage bucket name."
  [[ ${STATE_ENDPOINT-} =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || fail "TOFU_STATE_ENDPOINT must be the bucket's https:// endpoint, with no path (ops/tofu/README.md)."
  {
    printf 'bucket         = "%s"\n' "${STATE_BUCKET-}"
    printf 'endpoints      = { s3 = "%s" }\n' "${STATE_ENDPOINT-}"
    printf 'use_path_style = false\n'
  } >"$d/backend.hcl"

  # The replace input: exactly one configured host's instance, never echoed back.
  if [[ -n ${REPLACE-} ]]; then
    if ! [[ ${REPLACE-} =~ ^linode_instance\.host\[\"((staging|production)(-[0-9]{1,2})?)\"\]$ ]] ||
      ! jq -e --arg k "${BASH_REMATCH[1]}" '.hosts | has($k)' "$d/values.tfvars.json" >/dev/null; then
      fail "replace must be exactly linode_instance.host[\"<key>\"], naming a host in TOFU_VARS."
    fi
  fi
  printf '%s' "${REPLACE-}" >"$d/replace"

  # Provider downloads and the backend's settings stay under $d, which the last step removes.
  echo "TF_DATA_DIR=$d/data" >>"$GITHUB_ENV"
  echo "Prepared the values for $(jq -r '.hosts | length' "$d/values.tfvars.json") host(s) and $(jq -r '.database_ids | length' "$d/values.tfvars.json") access list(s)."
}

# The state's credentials and passphrase, which init, plan and apply need.
state_settings() {
  [[ -n ${AWS_ACCESS_KEY_ID-} && -n ${AWS_SECRET_ACCESS_KEY-} ]] || fail "TOFU_STATE_ACCESS_KEY and TOFU_STATE_SECRET_KEY must be set in the infra environment."
  # The step's env: sets it under the name OpenTofu reads (var.state_passphrase).
  local passphrase=${TF_VAR_state_passphrase-}
  ((${#passphrase} >= 16)) || fail "TOFU_STATE_PASSPHRASE must be at least 16 characters."
}

# The provider tokens, which plan and apply need.
provider_tokens() {
  [[ -n ${LINODE_TOKEN-} && -n ${CLOUDFLARE_API_TOKEN-} ]] || fail "LINODE_TOKEN and CLOUDFLARE_API_TOKEN must be set in the infra environment."
}

init() {
  state_settings
  # Its output can name the bucket and the endpoint, so it goes to a private file.
  local rc=0
  tofu -chdir="$module" init -input=false -lockfile=readonly -backend-config="$d/backend.hcl" >"$d/init.log" 2>&1 || rc=$?
  ((rc == 0)) || fail "init failed (exit $rc): check the infra environment's TOFU_STATE_* secrets (a wrong passphrase fails here too)."
  echo "init ok"
}

plan() {
  state_settings
  provider_tokens
  local args replace rc=0
  args=(-chdir="$module" plan -input=false -json -var-file="$d/values.tfvars.json" -out="$d/plan.bin")
  replace=$(<"$d/replace")
  if [[ -n $replace ]]; then args+=("-replace=$replace"); fi
  # OpenTofu's JSON messages go to a private file; on a failure only the filtered diagnostics print.
  tofu "${args[@]}" >"$d/plan.jsonl" 2>"$d/plan.stderr" || rc=$?
  if ((rc != 0)); then
    echo "::error::plan failed (exit $rc). Its diagnostics, with names, numbers and addresses left out:"
    jq -rR --slurpfile masks "$d/masks.json" -f "$here/diag.jq" "$d/plan.jsonl" || true
    exit 1
  fi
  echo "plan ok"
}

summarize() {
  local rc=0 has_changes delimiter refuse=0 action address counts
  tofu -chdir="$module" show -json "$d/plan.bin" >"$d/plan.json" 2>"$d/show.stderr" || rc=$?
  ((rc == 0)) || fail "show failed (exit $rc)"
  jq -r --slurpfile vars "$d/values.tfvars.json" -f "$here/summary.jq" "$d/plan.json" >"$d/changes.txt"
  if [[ -s $d/changes.txt ]]; then has_changes=true; else has_changes=false; fi

  {
    echo "### Infrastructure plan"
    echo
    if [[ $has_changes == true ]]; then
      echo "| Change | Resource | Access list |"
      echo "|---|---|---|"
      while read -r action address counts; do
        echo "| $action | \`$address\` | ${counts:-} |"
      done <"$d/changes.txt"
    else
      echo "No changes."
    fi
  } >>"$GITHUB_STEP_SUMMARY"
  if [[ $has_changes == true ]]; then
    echo "The plan's changes:"
    cat -- "$d/changes.txt"
  else
    echo "No changes."
  fi

  # The Apply job compares its own list with this one, so it goes out whole, under a random
  # delimiter no change line can hold.
  delimiter="changes_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    echo "changes<<$delimiter"
    cat -- "$d/changes.txt"
    echo "$delimiter"
    echo "has_changes=$has_changes"
  } >>"$GITHUB_OUTPUT"

  # The guards: a change this can't name is never applied; a delete or replace needs
  # allow_destroy; a removed access-list entry needs allow_access_removal.
  if grep -qE '^\? |^[a-z-]+ \?( |$)' "$d/changes.txt"; then
    echo "::error::The plan holds a change this workflow can't name (shown as ?); it is never applied."
    refuse=1
  fi
  if grep -qE '^(delete|replace) ' "$d/changes.txt" && [[ ${ALLOW_DESTROY-} != true ]]; then
    echo "::error::The plan deletes or replaces a resource; dispatch again with allow_destroy if you meant it."
    refuse=1
  fi
  if grep -qE ' -[1-9][0-9]*$' "$d/changes.txt" && [[ ${ALLOW_ACCESS_REMOVAL-} != true ]]; then
    echo "::error::The plan removes an entry from a database access list; dispatch again with allow_access_removal if you meant it."
    refuse=1
  fi
  exit "$refuse"
}

compare() {
  # Apply applies only what was approved: this job's own saved plan, and only when its change
  # list equals the one the Plan job showed. GitHub drops a job output that looks like a secret,
  # so an empty approved list is refused rather than taken as "no changes".
  [[ -n ${APPROVED-} ]] || fail "The Plan job's change list didn't arrive, so there is nothing approved to compare with; dispatch a new run."
  local current
  current=$(<"$d/changes.txt")
  [[ $current == "${APPROVED-}" ]] || fail "This plan differs from the one approved in the Plan job; nothing was applied. Dispatch a new run."
  echo "The plan equals the approved one."
}

apply() {
  state_settings
  provider_tokens
  local rc=0 action address line
  # Prints only the apply's counts, the filtered diagnostics on a failure, and one line per host
  # built or rebuilt: no key, name, address or ID. The owner then pins the new host's key from
  # their own machine.
  tofu -chdir="$module" apply -input=false -json "$d/plan.bin" >"$d/apply.jsonl" 2>"$d/apply.stderr" || rc=$?
  jq -rR -f "$here/applied.jq" "$d/apply.jsonl" || true
  if ((rc != 0)); then
    echo "::error::apply failed (exit $rc). Its diagnostics, with names, numbers and addresses left out:"
    jq -rR --slurpfile masks "$d/masks.json" -f "$here/diag.jq" "$d/apply.jsonl" || true
    exit 1
  fi
  while read -r action address _; do
    if [[ $action =~ ^(create|replace)$ && $address =~ ^linode_instance\.host\[\"((staging|production)(-[0-9]{1,2})?)\"\]$ ]]; then
      line="built ${BASH_REMATCH[1]} (${BASH_REMATCH[2]}): pin its host key from your own machine (ops/tofu/README.md, Pinning a new host key)"
      echo "$line"
      echo "- $line" >>"$GITHUB_STEP_SUMMARY"
    fi
  done <"$d/changes.txt"
}

case ${1-} in
  install | prepare | init | plan | summarize | compare | apply)
    (($# == 1)) || fail "usage: tofu-ci.sh install|prepare|init|plan|summarize|compare|apply"
    "$1"
    ;;
  *) fail "usage: tofu-ci.sh install|prepare|init|plan|summarize|compare|apply" ;;
esac
