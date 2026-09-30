#!/usr/bin/env bash
# The steps of .github/workflows/infra.yml ("Infrastructure", 2.36.0, issue #62), one phase per
# step, so the Plan and Apply jobs run the same code while each step's environment still holds only
# the secrets its phase needs. ci.yml's "Infrastructure checks" job runs the install phase too.
# The Plan job fills the state key and the tokens from the `infra-plan` environment's read-only
# *_READ_* secrets, and the Apply job from `infra`'s *_WRITE_* ones, into the variables OpenTofu
# reads (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, LINODE_TOKEN and CLOUDFLARE_API_TOKEN).
#
#   tofu-ci.sh install     the release in ../.opentofu-version, checked against ../opentofu.sha256
#                          (copied from that release's signature-verified SHA256SUMS), on GITHUB_PATH
#   tofu-ci.sh prepare     TOFU_VARS checked silently, every identifying value in it masked before
#                          anything else prints, then the private working files: the values, the
#                          backend settings and the replace target (TOFU_VARS, STATE_BUCKET,
#                          STATE_ENDPOINT, and the replace input from the event payload)
#   tofu-ci.sh init        the backend from backend.hcl and the providers from the lock file
#                          (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, TF_VAR_state_passphrase)
#   tofu-ci.sh plan        Plan only: a saved, encrypted plan, without a state lock (init's three,
#                          LINODE_TOKEN, CLOUDFLARE_API_TOKEN)
#   tofu-ci.sh summarize   Plan only: the change list to the log, the run summary and the step's
#                          outputs with the saved plan's SHA-256, then the guards
#                          (TF_VAR_state_passphrase, ALLOW_DESTROY, ALLOW_ACCESS_REMOVAL)
#   tofu-ci.sh compare     Apply only: the saved plan fetched from the Plan job must match that
#                          job's SHA-256 and change list, and have been planned with this job's
#                          TOFU_VARS (DIGEST, APPROVED, TF_VAR_state_passphrase)
#   tofu-ci.sh apply       Apply only: that saved plan, which OpenTofu refuses if the state changed
#                          since (plan's five)
#
# The repository and its Actions logs are public. So nothing here prints OpenTofu's own output, a
# host name, an address, an ID or a key: prepare masks every such value inside TOFU_VARS before
# anything else prints (GitHub masks a secret only where its whole value appears), every tofu
# command writes to a private file under $RUNNER_TEMP/tofu, and diagnostics print only through
# diag.jq. jq's own errors on plan or apply output go to a private file or nowhere, since they
# quote the value they failed on. The jq programs beside this script (shape, masks, summary, diag,
# applied) hold the rules; tests/unit/infra.test.ts runs them against sample plans and runs these
# phases with a stand-in tofu.
# Nothing here traces its commands, and the workflow's last step removes $RUNNER_TEMP/tofu.
# The Bun policy helper adds an advisory full-plan classification and a keyed handoff binding.
# This does not enable unattended Apply or change the owner's existing review gate.
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

  # The replace input: exactly one configured host's instance, never echoed back. It is read from
  # the event payload, not the step's env:, because the runner prints a step's env: values in the
  # clear before the step runs, so a mistyped host name or address would reach the public log.
  local replace
  replace=$(jq -r '.inputs.replace // ""' "${GITHUB_EVENT_PATH:?}" 2>/dev/null) || fail "The dispatch's inputs couldn't be read from the event payload."
  if [[ -n $replace ]]; then
    if ! [[ $replace =~ ^linode_instance\.host\[\"((staging|production)(-[0-9]{1,2})?)\"\]$ ]] ||
      ! jq -e --arg k "${BASH_REMATCH[1]}" '.hosts | has($k)' "$d/values.tfvars.json" >/dev/null; then
      fail "replace must be exactly linode_instance.host[\"<key>\"], naming a host in TOFU_VARS."
    fi
  fi
  printf '%s' "$replace" >"$d/replace"

  # Provider downloads and the backend's settings stay under $d, which the last step removes.
  echo "TF_DATA_DIR=$d/data" >>"$GITHUB_ENV"
  echo "Prepared the values for $(jq -r '.hosts | length' "$d/values.tfvars.json") host(s) and $(jq -r '.database_ids | length' "$d/values.tfvars.json") access list(s)."
}

# The state's credentials and passphrase, which init, plan and apply need.
state_settings() {
  [[ -n ${AWS_ACCESS_KEY_ID-} && -n ${AWS_SECRET_ACCESS_KEY-} ]] || fail "The state key must be set: TOFU_STATE_READ_ACCESS_KEY and TOFU_STATE_READ_SECRET_KEY in infra-plan, TOFU_STATE_WRITE_ACCESS_KEY and TOFU_STATE_WRITE_SECRET_KEY in infra."
  # The step's env: sets it under the name OpenTofu reads (var.state_passphrase). It is the only
  # key to the saved plan, a one-day artifact anyone signed in to GitHub can download from this
  # public repository, so it must be long (ops/tofu/variables.tf holds the same minimum).
  local passphrase=${TF_VAR_state_passphrase-}
  ((${#passphrase} >= 32)) || fail "TOFU_STATE_PASSPHRASE must be at least 32 characters."
}

# The provider tokens, which plan and apply need; $1 is the message naming their secrets.
provider_tokens() {
  [[ -n ${LINODE_TOKEN-} && -n ${CLOUDFLARE_API_TOKEN-} ]] || fail "$1"
}

init() {
  state_settings
  # Its output can name the bucket and the endpoint, so it goes to a private file.
  local rc=0
  tofu -chdir="$module" init -input=false -lockfile=readonly -backend-config="$d/backend.hcl" >"$d/init.log" 2>&1 || rc=$?
  ((rc == 0)) || fail "init failed (exit $rc): check the environment's TOFU_STATE_* secrets (a wrong passphrase fails here too)."
  echo "init ok"
}

plan() {
  state_settings
  provider_tokens "LINODE_READ_TOKEN and CLOUDFLARE_READ_TOKEN must be set in the infra-plan environment."
  local args replace rc=0
  # The Plan job's state key is read-only, so the plan takes no state lock (-lock=false). The
  # backend configures none today (no use_lockfile); this keeps a later one from making Plan
  # write. The concurrency group still serializes runs.
  args=(-chdir="$module" plan -input=false -lock=false -json -var-file="$d/values.tfvars.json" -out="$d/plan.bin")
  replace=$(<"$d/replace")
  if [[ -n $replace ]]; then args+=("-replace=$replace"); fi
  # OpenTofu's JSON messages go to a private file; on a failure only the filtered diagnostics print.
  tofu "${args[@]}" >"$d/plan.jsonl" 2>"$d/plan.stderr" || rc=$?
  if ((rc != 0)); then
    echo "::error::plan failed (exit $rc). Its diagnostics, with names, numbers and addresses left out:"
    jq -rR --slurpfile masks "$d/masks.json" -f "$here/diag.jq" "$d/plan.jsonl" 2>/dev/null || true
    exit 1
  fi
  echo "plan ok"
}

# The saved plan's change list, from `tofu show -json` through summary.jq, into $d/changes.txt.
changes() {
  local rc=0
  tofu -chdir="$module" show -json "$d/plan.bin" >"$d/plan.json" 2>"$d/show.stderr" || rc=$?
  ((rc == 0)) || fail "show failed (exit $rc): a TOFU_STATE_PASSPHRASE other than the one that made the plan fails here too."
  # jq's own errors quote the value they failed on, so they go to a private file.
  jq -r --slurpfile vars "$d/values.tfvars.json" -f "$here/summary.jq" "$d/plan.json" >"$d/changes.txt" 2>"$d/summary.stderr" ||
    fail "The change list couldn't be built from the saved plan; nothing was applied."
}

summarize() {
  local has_changes delimiter digest refuse=0 action address counts
  changes
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

  # The Apply job checks the saved plan it fetches against this list and the plan's SHA-256, so
  # the list goes out whole, under a random delimiter no change line can hold.
  delimiter="changes_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)
  # Bind private backend/inputs, run, code and plan bytes without publishing a dictionary hash
  # of the backend's identifying values. Only the passphrase-keyed digest leaves the runner.
  local binding decision
  binding=$(bun "$module/../../scripts/infra-policy.ts" binding "$d" 2>"$d/binding.stderr") ||
    fail "The plan handoff couldn't be bound to this run and backend; nothing was applied."
  bun "$module/../../scripts/infra-policy.ts" classify "$d" >"$d/policy.json" 2>"$d/policy.stderr" ||
    fail "The infrastructure policy couldn't read its evidence; nothing was applied."
  decision=$(jq -er '.decision | select(. == "invalid" or . == "review-required" or . == "safe" or . == "no-changes")' "$d/policy.json" 2>/dev/null) ||
    fail "The infrastructure policy returned no recognized decision."
  printf '\nAdvisory safe-plan policy: `%s`. The owner-approved Apply gate remains required.\n' "$decision" >>"$GITHUB_STEP_SUMMARY"
  {
    echo "changes<<$delimiter"
    cat -- "$d/changes.txt"
    echo "$delimiter"
    echo "has_changes=$has_changes"
    echo "digest=$digest"
    echo "binding=$binding"
    echo "policy_decision=$decision"
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
  # A failed comparison must never retain an earlier successful marker.
  rm -f -- "$d/verified.binding"
  # Apply applies only what was reviewed: the Plan job's saved plan, byte for byte, and only when
  # its change list is the one the Plan job showed. GitHub drops a job output that looks like a
  # secret, so a missing digest or an empty list is refused rather than taken as "no changes".
  [[ ${DIGEST-} =~ ^[0-9a-f]{64}$ ]] || fail "The Plan job's digest didn't arrive, so there is nothing reviewed to compare with; dispatch a new run."
  [[ -n ${APPROVED-} ]] || fail "The Plan job's change list didn't arrive, so there is nothing reviewed to compare with; dispatch a new run."
  [[ -f $d/plan.bin ]] || fail "The saved plan didn't arrive (the artifact is kept one day); dispatch a new run."
  local digest current
  digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)
  [[ $digest == "${DIGEST-}" ]] || fail "The saved plan isn't the file the Plan job made; nothing was applied. Dispatch a new run."
  [[ ${BINDING-} =~ ^[0-9a-f]{64}$ ]] || fail "The Plan job's handoff binding didn't arrive; nothing was applied."
  local binding
  binding=$(bun "$module/../../scripts/infra-policy.ts" binding "$d" 2>"$d/binding.stderr") ||
    fail "The plan handoff couldn't be checked; nothing was applied."
  [[ $binding == "${BINDING-}" ]] || fail "The plan's backend, inputs, run or code differs from Plan; nothing was applied."
  changes
  current=$(<"$d/changes.txt")
  [[ $current == "${APPROVED-}" ]] || fail "The saved plan's changes differ from the ones the Plan job showed; nothing was applied. Dispatch a new run."
  # The saved plan carries the values it was planned with, infra-plan's TOFU_VARS, and applies
  # those; this job masked and listed the changes with infra's copy. The change list reads only
  # hosts and db_allow_extra, so a key or hash set in one copy alone would otherwise pass unseen.
  jq -e --slurpfile v "$d/values.tfvars.json" '(.variables | map_values(.value) | del(.state_passphrase)) == $v[0]' "$d/plan.json" >/dev/null 2>&1 ||
    fail "TOFU_VARS in infra differs from the value the Plan job planned with (infra-plan's); nothing was applied. Set the same value in both and dispatch a new run."
  printf '%s' "$binding" >"$d/verified.binding"
  echo "The saved plan is the reviewed one."
}

apply() {
  state_settings
  provider_tokens "LINODE_WRITE_TOKEN and CLOUDFLARE_WRITE_TOKEN must be set in the infra environment."
  # Recheck immediately before the provider write; directly invoking Apply cannot skip Compare.
  local binding verified
  [[ -f $d/verified.binding ]] || fail "Apply has no successful plan comparison; nothing was applied."
  verified=$(<"$d/verified.binding")
  binding=$(bun "$module/../../scripts/infra-policy.ts" binding "$d" 2>"$d/binding.stderr") ||
    fail "The plan handoff couldn't be rechecked; nothing was applied."
  [[ $binding == "$verified" ]] || fail "The plan handoff changed after comparison; nothing was applied."
  local rc=0 action address line
  # The saved plan alone, with no option that could change it: OpenTofu applies exactly what it
  # holds, and refuses it as "Saved plan is stale" if the state changed since the Plan job read it.
  # Prints only the apply's counts, the filtered diagnostics on a failure, and one line per host
  # built or rebuilt: no key, name, address or ID. The owner then pins the new host's key from
  # their own machine.
  tofu -chdir="$module" apply -input=false -json "$d/plan.bin" >"$d/apply.jsonl" 2>"$d/apply.stderr" || rc=$?
  jq -rR -f "$here/applied.jq" "$d/apply.jsonl" 2>/dev/null || true
  if ((rc != 0)); then
    echo "::error::apply failed (exit $rc); a stale plan fails here too, so dispatch a new run. Its diagnostics, with names, numbers and addresses left out:"
    jq -rR --slurpfile masks "$d/masks.json" -f "$here/diag.jq" "$d/apply.jsonl" 2>/dev/null || true
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
