#!/usr/bin/env bash
# OpenTofu's steps in the Deploy workflow (2.37.0; first written for infra.yml in 2.36.0, issue
# #62), one phase per step, so each step's environment holds only the secrets its phase needs:
#   - Deploy's "Infrastructure plan" job (.github/workflows/deploy.yml, environment infra-plan, no
#     approval) runs install, backend, values, init, plan and summarize with the read-only *_READ_*
#     secrets and the one copy of TOFU_VARS, then keeps the encrypted saved plan as an artifact;
#   - the approving `prod` job (.github/workflows/host.yml, in both the Infrastructure and the Prod
#     call) runs install, backend, init, adopt, apply and output with prod's *_WRITE_* secrets. It
#     holds no TOFU_VARS: adopt takes the values from the saved plan itself;
#   - ci.yml's "Infrastructure checks" job runs install.
# The steps fill the state key and the tokens into the variables OpenTofu reads (AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, LINODE_TOKEN and CLOUDFLARE_API_TOKEN), and the state passphrase into
# TF_VAR_state_passphrase.
#
#   tofu-ci.sh install     the release in ../.opentofu-version, checked against ../opentofu.sha256
#                          (copied from that release's signature-verified SHA256SUMS), on GITHUB_PATH
#   tofu-ci.sh backend     the backend settings (backend.hcl) and TF_DATA_DIR in GITHUB_ENV
#                          (STATE_BUCKET, STATE_ENDPOINT)
#   tofu-ci.sh values      TOFU_VARS checked silently, every identifying value in it masked before
#                          anything else prints, then the private values file and the replace
#                          target (TOFU_VARS, REBUILD_TARGET: empty, staging or prod)
#   tofu-ci.sh init        the backend from backend.hcl and the providers from the lock file
#                          (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, TF_VAR_state_passphrase)
#   tofu-ci.sh plan        a saved, encrypted plan, without a state lock (init's three,
#                          LINODE_TOKEN, CLOUDFLARE_API_TOKEN)
#   tofu-ci.sh summarize   the change list to the log, the run summary and the step's outputs
#                          (changes, has_changes, and digest: the saved plan's SHA-256), then the
#                          guards (TF_VAR_state_passphrase, ALLOW_DESTROY, ALLOW_ACCESS_REMOVAL,
#                          REBUILD_TARGET)
#   tofu-ci.sh adopt       the saved plan fetched from the Infrastructure plan job must match that
#                          job's SHA-256 and change list; its own values, checked and masked, become
#                          this job's (DIGEST, APPROVED, HAS_CHANGES, TF_VAR_state_passphrase)
#   tofu-ci.sh apply       the adopted plan, only when it has changes; OpenTofu refuses it if the
#                          state changed since (init's three, LINODE_TOKEN, CLOUDFLARE_API_TOKEN)
#   tofu-ci.sh output      the state's outputs, host_connection among them, into a private file for
#                          ops/tofu/ci/host.sh pin (init's three)
#
# The repository and its Actions logs are public. So nothing here prints OpenTofu's own output, a
# host name, an address, an ID or a key: values and adopt mask every such value in the values
# before anything else prints (GitHub masks a secret only where its whole value appears), output
# masks the hosts' addresses and instance IDs first, every tofu command writes to a private file
# under $RUNNER_TEMP/tofu, and diagnostics print only through diag.jq. jq's own errors on plan,
# apply or output data go to a private file or nowhere, since they quote the value they failed on.
# The jq programs beside this script (shape, masks, summary, diag, applied) hold the rules;
# tests/unit/infra.test.ts runs them against sample plans and runs these phases with a stand-in
# tofu. Nothing reads the event payload: every input arrives through the step's env:, from values
# the Deploy plan job has already checked. There is no per-target guard: @deconfined approves the
# whole plan, whichever host it touches.
# Nothing here traces its commands, and each job's last step removes $RUNNER_TEMP/tofu; a host job
# also removes it right after host.sh pin, its last reader, before anything reaches the host.
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

backend() {
  mkdir -p -- "$d"
  # The backend's bucket and endpoint (partial configuration; ops/tofu/versions.tf). A bucket name
  # with a dot is refused: with virtual-hosted addressing its TLS name can't match the endpoint's
  # certificate, and ops/tofu/ci/host.sh keeps the host pins in the same bucket the same way.
  [[ ${STATE_BUCKET-} =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail "TOFU_STATE_BUCKET must be an Object Storage bucket name of a-z, 0-9 and '-', with no dot."
  [[ ${STATE_ENDPOINT-} =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || fail "TOFU_STATE_ENDPOINT must be the bucket's https:// endpoint, with no path (ops/tofu/README.md)."
  {
    printf 'bucket         = "%s"\n' "${STATE_BUCKET-}"
    printf 'endpoints      = { s3 = "%s" }\n' "${STATE_ENDPOINT-}"
    printf 'use_path_style = false\n'
  } >"$d/backend.hcl"
  # Provider downloads and the backend's settings stay under $d, which the last step removes.
  echo "TF_DATA_DIR=$d/data" >>"$GITHUB_ENV"
  echo "Wrote the backend settings."
}

# Masks every identifying value in a values file ($1, which shape.jq has already accepted) before
# anything else prints, and keeps the list for diag.jq.
mask_values() {
  jq -c -f "$here/masks.jq" "$1" >"$d/masks.json" 2>/dev/null || fail "The values couldn't be masked; nothing else ran."
  local m
  while IFS= read -r m; do
    echo "::add-mask::$m"
  done < <(jq -r '.[]' "$d/masks.json")
  # From here on every identifying value prints as ***.
}

values() {
  mkdir -p -- "$d"
  # The shape check prints nothing of the value: jq's own messages could quote it. Values reach jq
  # through printf (a shell builtin) and a pipe, never an argument, and land only in private files.
  if ! printf '%s' "${TOFU_VARS-}" | jq -e -f "$here/shape.jq" >/dev/null 2>&1; then
    fail "TOFU_VARS must be one JSON object with exactly the keys hosts, root_keys, configure_keys, root_password_hash, cloudflare_zone_id, database_ids and db_allow_extra, in the shape of ops/tofu/examples/example.tfvars.json."
  fi
  printf '%s' "${TOFU_VARS-}" | jq -c . >"$d/values.tfvars.json"
  mask_values "$d/values.tfvars.json"

  # The rebuild target, from the Deploy plan job's `rebuild` output (the boolean rebuild input and
  # the dispatch's target, never free text): empty, or one of the two plain host keys, which must
  # be in TOFU_VARS. Only that instance is replaced; a -N host can't be rebuilt this way.
  local target=${REBUILD_TARGET-} replace=""
  if [[ -n $target ]]; then
    if ! [[ $target =~ ^(staging|prod)$ ]] ||
      ! jq -e --arg k "$target" '.hosts | has($k)' "$d/values.tfvars.json" >/dev/null 2>&1; then
      fail "REBUILD_TARGET must be empty, staging or prod, naming a host in TOFU_VARS."
    fi
    replace="linode_instance.host[\"$target\"]"
  fi
  printf '%s' "$replace" >"$d/replace"
  echo "Read the values for $(jq -r '.hosts | length' "$d/values.tfvars.json") host(s) and $(jq -r '.database_ids | length' "$d/values.tfvars.json") access list(s)."
}

# The state's credentials and passphrase, which init, plan, apply and output need.
state_settings() {
  [[ -n ${AWS_ACCESS_KEY_ID-} && -n ${AWS_SECRET_ACCESS_KEY-} ]] || fail "The state key must be set: TOFU_STATE_READ_ACCESS_KEY and TOFU_STATE_READ_SECRET_KEY in infra-plan, TOFU_STATE_WRITE_ACCESS_KEY and TOFU_STATE_WRITE_SECRET_KEY in prod."
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
  [[ -f $d/backend.hcl ]] || fail "The backend settings are missing: run the backend phase first."
  # Its output can name the bucket and the endpoint, so it goes to a private file.
  local rc=0
  tofu -chdir="$module" init -input=false -lockfile=readonly -backend-config="$d/backend.hcl" >"$d/init.log" 2>&1 || rc=$?
  ((rc == 0)) || fail "init failed (exit $rc): check the environment's TOFU_STATE_* secrets (a wrong passphrase fails here too)."
  echo "init ok"
}

plan() {
  state_settings
  provider_tokens "LINODE_READ_TOKEN and CLOUDFLARE_READ_TOKEN must be set in the infra-plan environment."
  [[ -f $d/values.tfvars.json && -f $d/replace ]] || fail "The values are missing: run the values phase first."
  local args replace rc=0
  # The Infrastructure plan job's state key is read-only, so the plan takes no state lock
  # (-lock=false). The backend configures none today (no use_lockfile); this keeps a later one
  # from making the plan write.
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

# The saved plan as `tofu show -json` reads it, into the private $d/plan.json. host.sh reads it too:
# status in the Infrastructure plan job, and pin after adopt.
show_plan() {
  local rc=0
  tofu -chdir="$module" show -json "$d/plan.bin" >"$d/plan.json" 2>"$d/show.stderr" || rc=$?
  ((rc == 0)) || fail "show failed (exit $rc): a TOFU_STATE_PASSPHRASE other than the one that made the plan fails here too."
}

# The saved plan's change list, from $d/plan.json through summary.jq, into $d/changes.txt.
change_list() {
  # jq's own errors quote the value they failed on, so they go to a private file.
  jq -r --slurpfile vars "$d/values.tfvars.json" -f "$here/summary.jq" "$d/plan.json" >"$d/changes.txt" 2>"$d/summary.stderr" ||
    fail "The change list couldn't be built from the saved plan; nothing was applied."
}

# The rebuild allowance, read privately from $d/plan.json (jq -e: true or nothing) and never
# printed. It holds when the plan replaces the target's instance ($t) and every entry the plan
# removes from any database access list is that instance's own old IPv6 /128 or IPv4 /32 (its
# change.before). The removed entries are found the way summary.jq counts them: against the extras
# and every host whose new addresses are known. Anything else, such as a db_allow_extra entry that
# drifted away or another host's entry, still needs allow_access_removal.
# shellcheck disable=SC2016 # The $names belong to jq.
readonly REBUILD_REMOVALS='
def unknown: if type == "boolean" then . else tostring | contains("true") end;
def instance($rc; $k): [$rc[] | select(.type == "linode_instance" and .name == "host" and .index == $k and (has("deposed") | not))][0].change;
$vars[0] as $v
| [.resource_changes[]?] as $rc
| instance($rc; $t) as $old
| select($old != null and ($old.actions == ["delete", "create"] or $old.actions == ["create", "delete"]))
| [ ($old.before.ipv6 | strings | split("/")[0] | select(test("^[0-9A-Fa-f:]+$")) + "/128"),
    ($old.before.ipv4 | arrays | .[0] | strings | select(test("^[0-9.]+$")) + "/32")
  ] as $own
| [ $v.hosts | keys[] as $k
    | instance($rc; $k) as $c
    | if $c == null or $c.after == null or ($c.after_unknown.ipv4 // false | unknown) or ($c.after_unknown.ipv6 // false | unknown)
      then empty
      else ((($c.after.ipv6 // "?") | split("/")[0]) + "/128"), ((($c.after.ipv4 // ["?"])[0]) + "/32")
      end
  ] as $hosts
| ($v.db_allow_extra + $hosts) as $known
| [ $rc[] | select(.type == "linode_database_access_controls") | .change
    | (.before.allow_list // []) as $b
    | if .actions == ["delete"] then $b[]
      elif (.after_unknown.allow_list // false | unknown) or .after.allow_list == null then ($b - $known)[]
      else ($b - .after.allow_list)[]
      end
  ] as $removed
| ($own | length) == 2 and all($removed[]; . as $r | any($own[]; . == $r))
'

summarize() {
  local has_changes delimiter digest refuse=0 action address counts others
  local target=${REBUILD_TARGET-} expected=""
  # The rebuild target must be the one the values phase planned with.
  if [[ -n $target ]]; then
    [[ $target =~ ^(staging|prod)$ ]] || fail "REBUILD_TARGET must be empty, staging or prod."
    expected="linode_instance.host[\"$target\"]"
  fi
  [[ -f $d/replace ]] || fail "The values are missing: run the values phase first."
  [[ $(<"$d/replace") == "$expected" ]] || fail "REBUILD_TARGET differs from the one the values phase planned with; nothing was applied."
  show_plan
  change_list
  if [[ -s $d/changes.txt ]]; then has_changes=true; else has_changes=false; fi

  {
    echo "### Infrastructure plan"
    echo
    if [[ -n $target ]]; then
      echo "Rebuild: approving replaces the \`$target\` host's instance."
      echo
    fi
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

  # The approving job checks the saved plan it fetches against this list and the plan's SHA-256,
  # so the list goes out whole, under a random delimiter no change line can hold.
  delimiter="changes_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)
  {
    echo "changes<<$delimiter"
    cat -- "$d/changes.txt"
    echo "$delimiter"
    echo "has_changes=$has_changes"
    echo "digest=$digest"
  } >>"$GITHUB_OUTPUT"

  # The guards: a change this can't name is never applied; a delete or replace needs
  # allow_destroy; a removed access-list entry needs allow_access_removal. A rebuild alone allows
  # exactly its own instance's replace and the removal of that instance's two old entries.
  if grep -qE '^\? |^[a-z-]+ \?( |$)' "$d/changes.txt"; then
    echo "::error::The plan holds a change this workflow can't name (shown as ?); it is never applied."
    refuse=1
  fi
  # Every delete or replace but the rebuild's own (grep -v reads all its input: no early exit, so
  # no broken pipe under pipefail).
  others=$(grep -E '^(delete|replace) ' "$d/changes.txt" | grep -vxF "replace $expected" || true)
  if [[ -n $others && ${ALLOW_DESTROY-} != true ]]; then
    echo "::error::The plan deletes or replaces a resource; dispatch again with allow_destroy if you meant it."
    refuse=1
  fi
  if grep -qE ' -[1-9][0-9]*$' "$d/changes.txt" && [[ ${ALLOW_ACCESS_REMOVAL-} != true ]]; then
    if [[ -z $target ]]; then
      echo "::error::The plan removes an entry from a database access list; dispatch again with allow_access_removal if you meant it."
      refuse=1
    elif jq -e --arg t "$target" --slurpfile vars "$d/values.tfvars.json" "$REBUILD_REMOVALS" "$d/plan.json" >/dev/null 2>&1; then
      echo "The access-list removals are the rebuilt host's own two old entries."
      echo "- The access-list removals are the rebuilt host's own two old entries." >>"$GITHUB_STEP_SUMMARY"
    else
      echo "::error::The plan removes a database access-list entry other than the rebuilt host's own two old ones; dispatch again with allow_access_removal if you meant it."
      refuse=1
    fi
  fi
  exit "$refuse"
}

adopt() {
  # The approving job applies only what was shown: the Infrastructure plan job's saved plan, byte
  # for byte, and only when its change list is the one that job showed. GitHub drops a job output
  # that looks like a secret, so a missing digest, a missing has_changes or an empty list beside
  # has_changes=true is refused rather than taken as "no changes". HAS_CHANGES=false with an empty
  # list is the pins-only case: nothing to apply, and the plan's prior state still tells host.sh
  # which instance each host must be.
  rm -f -- "$d/adopted"
  [[ ${DIGEST-} =~ ^[0-9a-f]{64}$ ]] || fail "The Infrastructure plan job's digest didn't arrive, so there is nothing shown to adopt; dispatch a new run."
  case ${HAS_CHANGES-} in
    true) [[ -n ${APPROVED-} ]] || fail "The Infrastructure plan job's change list didn't arrive, so there is nothing shown to adopt; dispatch a new run." ;;
    false) [[ -z ${APPROVED-} ]] || fail "The Infrastructure plan job listed changes but reported none; nothing was applied. Dispatch a new run." ;;
    *) fail "The Infrastructure plan job's has_changes didn't arrive, so there is nothing shown to adopt; dispatch a new run." ;;
  esac
  [[ -f $d/plan.bin ]] || fail "The saved plan didn't arrive (the artifact is kept one day); dispatch a new run."
  local digest current
  digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)
  [[ $digest == "${DIGEST-}" ]] || fail "The saved plan isn't the file the Infrastructure plan job made; nothing was applied. Dispatch a new run."
  show_plan
  # The values the plan was made with (infra-plan's TOFU_VARS, the only copy) become this job's:
  # the saved plan carries every one, the sensitive ones too. They are checked quietly and masked
  # before anything else prints. The passphrase is left out: it is this job's own secret.
  jq -c '.variables | map_values(.value) | del(.state_passphrase)' "$d/plan.json" >"$d/values.tfvars.json" 2>/dev/null ||
    fail "The saved plan's values couldn't be read; nothing was applied. Dispatch a new run."
  jq -e -f "$here/shape.jq" "$d/values.tfvars.json" >/dev/null 2>&1 ||
    fail "The saved plan's values aren't in TOFU_VARS's shape; nothing was applied. Dispatch a new run."
  mask_values "$d/values.tfvars.json"
  change_list
  current=$(<"$d/changes.txt")
  [[ $current == "${APPROVED-}" ]] || fail "The saved plan's changes differ from the ones the Infrastructure plan job showed; nothing was applied. Dispatch a new run."
  # apply takes only this file, and only once it has been adopted here.
  printf '%s\n' "$digest" >"$d/adopted"
  if [[ $HAS_CHANGES == true ]]; then
    echo "The saved plan is the one shown before the approval."
  else
    echo "The saved plan is the one shown before the approval; it has no changes to apply."
  fi
}

apply() {
  state_settings
  provider_tokens "LINODE_WRITE_TOKEN and CLOUDFLARE_WRITE_TOKEN must be set in the prod environment."
  # Only the adopted file, and only when it has something to apply.
  [[ -f $d/adopted && -f $d/plan.bin ]] || fail "The saved plan hasn't been adopted (run the adopt phase first); nothing was applied."
  [[ $(<"$d/adopted") == "$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)" ]] || fail "The saved plan hasn't been adopted (run the adopt phase first); nothing was applied."
  [[ -s $d/changes.txt ]] || fail "The adopted plan has no changes, so there is nothing to apply."
  local rc=0 action address line
  # The saved plan alone, with no option that could change it: OpenTofu applies exactly what it
  # holds, and refuses it as "Saved plan is stale" if the state changed since the Infrastructure
  # plan job read it. Prints only the apply's counts, the filtered diagnostics on a failure, and one
  # line per host built or rebuilt: no key, name, address or ID. host.sh pin then pins its key.
  tofu -chdir="$module" apply -input=false -json "$d/plan.bin" >"$d/apply.jsonl" 2>"$d/apply.stderr" || rc=$?
  jq -rR -f "$here/applied.jq" "$d/apply.jsonl" 2>/dev/null || true
  if ((rc != 0)); then
    echo "::error::apply failed (exit $rc); a stale plan fails here too, so dispatch a new run. Its diagnostics, with names, numbers and addresses left out:"
    jq -rR --slurpfile masks "$d/masks.json" -f "$here/diag.jq" "$d/apply.jsonl" 2>/dev/null || true
    exit 1
  fi
  while read -r action address _; do
    if [[ $action =~ ^(create|replace)$ && $address =~ ^linode_instance\.host\[\"((staging|prod)(-[0-9]{1,2})?)\"\]$ ]]; then
      line="built ${BASH_REMATCH[1]} (${BASH_REMATCH[2]}): this job pins its host key next"
      echo "$line"
      echo "- $line" >>"$GITHUB_STEP_SUMMARY"
    fi
  done <"$d/changes.txt"
}

# `tofu output -json` with host_connection.value always an object: {} when the state holds no
# host_connection yet (no apply since the output was added, or no host at all). Anything else that
# isn't an object is an error.
readonly HOST_CONNECTION='
if has("host_connection") then . else . + {host_connection: {sensitive: true, value: {}}} end
| if (.host_connection.value | type) == "object" then . else error("host_connection") end
'

output() {
  state_settings
  mkdir -p -- "$d"
  local rc=0 m
  # The state's outputs, the sensitive ones included, into a private file: host_connection holds
  # each host's instance ID and addresses, which ops/tofu/ci/host.sh pin reads.
  tofu -chdir="$module" output -json >"$d/outputs.raw.json" 2>"$d/output.stderr" || rc=$?
  ((rc == 0)) || fail "output failed (exit $rc): check the environment's TOFU_STATE_* secrets."
  # A state with no hosts yet may hold no host_connection at all, which reads as no hosts; any other
  # value that isn't an object is refused. jq's errors stay private.
  jq -c "$HOST_CONNECTION" "$d/outputs.raw.json" >"$d/outputs.json" 2>"$d/outputs.stderr" ||
    fail "The state's host_connection output couldn't be read; no host was pinned."
  rm -f -- "$d/outputs.raw.json"
  # Every address and instance ID is masked before anything else prints; host.sh masks again what
  # it uses.
  while IFS= read -r m; do
    echo "::add-mask::$m"
  done < <(jq -r '.host_connection.value[] | objects | (.instance_id, .ipv4, .ipv6) | strings | select(length >= 6)' "$d/outputs.json" 2>/dev/null)
  echo "Read the connections of $(jq -r '.host_connection.value | length' "$d/outputs.json" 2>/dev/null) host(s)."
}

case ${1-} in
  install | backend | values | init | plan | summarize | adopt | apply | output)
    (($# == 1)) || fail "usage: tofu-ci.sh install|backend|values|init|plan|summarize|adopt|apply|output"
    "$1"
    ;;
  *) fail "usage: tofu-ci.sh install|backend|values|init|plan|summarize|adopt|apply|output" ;;
esac
