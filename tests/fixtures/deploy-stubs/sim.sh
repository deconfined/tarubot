#!/usr/bin/env bash
# The simulated Quadlet host behind the podman, systemctl, journalctl, systemd-run and generator
# stubs of tests/unit/deploy-script.test.ts. The stubs source it; the test also runs it directly
# (`sim.sh container …`, `sim.sh event …`) to set up the live bot. State lives in $SIM:
#
#   current            the id of the container named tarubot (empty: none)
#   c/<id>.json        its `podman container inspect` answer, shaped like the real one in
#                      tests/fixtures/deploy-podman/container.json
#   c/<id>.logs        its lines in the user journal (CONTAINER_ID_FULL=<id>)
#   events             Podman's event log, one JSON event a line, as `podman events --format json`
#   unit               tarubot.service's "ActiveState SubState"
#   nrestarts          tarubot.service's NRestarts
#   versions/<v>       "<commit> <index digest> <image id>" for each release
#   knob/<name>        what a scenario changes (each stub lists its own)
#   calls              the normalized calls that change something, in order
#   sleeps             every sleep the worker made, in seconds, one a line
#   runtime            every call to a runtime tool, one line each: "<tool> <arguments>"
#
# Container ids are 64 hex digits and image ids bare hex, as Podman shows them.
set -euo pipefail
S=$SIM
PODMAN_FIXTURES=${PODMAN_FIXTURES:-$(dirname "${BASH_SOURCE[0]}")/../deploy-podman}

knob() { if [[ -f $S/knob/$1 ]]; then cat "$S/knob/$1"; fi; }
record() { printf '%s\n' "$*" >>"$S/calls"; }
# Every runtime call, for the tests that separate the two runtimes and check arguments.
trace() { printf '%s\n' "$*" >>"$S/runtime"; }

# The release whose index digest is $1 (empty when none).
version_of() {
  local file commit digest image
  for file in "$S"/versions/*; do
    read -r commit digest image <"$file"
    if [[ $digest == "$1" ]]; then
      printf '%s' "${file##*/}"
      return 0
    fi
  done
  return 0
}

# The .env pin the unit would start: "<tag>" when the digest line names the same release, else
# "<tag>/<release of the digest>", so a half-written pin shows in the call log.
pin_of() {
  local env=$HOME/tarubot/.env tag digest named
  tag=$(sed -n 's/^TARUBOT_IMAGE_TAG=//p' "$env")
  digest=$(sed -n 's/^TARUBOT_IMAGE_DIGEST=//p' "$env")
  named=$(version_of "$digest")
  if [[ $named == "$tag" ]]; then printf '%s' "$tag"; else printf '%s/%s' "$tag" "${named:--}"; fi
}

# Append one event: status $1 for container $2 running release $3.
event() {
  local status=$1 id=$2 version=$3 when=${4:-} commit digest image
  read -r commit digest image <"$S/versions/$version"
  when=${when:-$(date +%s%N)}
  jq -nc --arg s "$status" --arg id "$id" --arg image "ghcr.io/deconfined/tarubot@$digest" \
    --arg v "$version" --arg c "$commit" --argjson ns "$when" \
    '{ID: $id, Image: $image, Name: "tarubot", Status: $s, time: ($ns / 1e9 | floor),
      timeNano: $ns, Type: "container", Attributes: {PODMAN_SYSTEMD_UNIT: "tarubot.service",
      "org.opencontainers.image.version": $v, "org.opencontainers.image.revision": $c}}' \
    >>"$S/events"
}

# Write container $1 for release $2 with status $3, health $4, log mode $5 and hardening $6, from
# the captured inspect answer. Hardening: ok, rw (a writable root), cap (an added capability),
# bind (a bind mount), secretbind (a host file bind-mounted where a secret's file goes),
# secretvolume (a named volume there), nnp (no no-new-privileges), env (a secret in the
# environment). Podman itself lists secret mounts only in .Config.Secrets.
container() {
  local id=$1 version=$2 status=$3 health=$4 mode=$5 hardening=${6:-ok} commit digest image
  read -r commit digest image <"$S/versions/$version"
  jq --arg id "$id" --arg image "${image#sha256:}" --arg ref "ghcr.io/deconfined/tarubot@$digest" \
    --arg digest "$digest" --arg v "$version" --arg c "$commit" --arg status "$status" \
    --arg health "$health" --arg hardening "$hardening" '
      .[0].Id = $id | .[0].Image = $image | .[0].ImageName = $ref | .[0].ImageDigest = $digest
      | .[0].Config.Image = $ref | .[0].State.Status = $status
      | .[0].State.Running = ($status == "running") | .[0].State.Health.Status = $health
      | .[0].Config.Labels["org.opencontainers.image.version"] = $v
      | .[0].Config.Labels["org.opencontainers.image.revision"] = $c
      | if $hardening == "rw" then .[0].HostConfig.ReadonlyRootfs = false
        elif $hardening == "cap" then .[0].HostConfig.CapAdd = ["CAP_NET_ADMIN"]
          | .[0].EffectiveCaps = ["CAP_NET_ADMIN"]
        elif $hardening == "bind" then .[0].Mounts = [{Type: "bind", Source: "/srv",
          Destination: "/data", Options: ["rbind"], RW: true}]
          | .[0].HostConfig.Binds = ["/srv:/data:rprivate,rbind"]
        elif $hardening == "secretbind" then .[0].Mounts = [{Type: "bind",
          Source: "/srv/database_url", Destination: "/run/secrets/database_url",
          Options: ["rbind"], RW: false}]
          | .[0].HostConfig.Binds = ["/srv/database_url:/run/secrets/database_url:ro,rprivate,rbind"]
        elif $hardening == "secretvolume" then .[0].Mounts = [{Type: "volume", Name: "tokens",
          Source: "/home/tarubot/.local/share/containers/storage/volumes/tokens/_data",
          Destination: "/run/secrets/discord_token", Options: ["nosuid", "nodev", "rbind"],
          RW: false}]
          | .[0].HostConfig.Binds = ["tokens:/run/secrets/discord_token:ro,rprivate,nosuid,nodev,rbind"]
        elif $hardening == "nnp" then .[0].HostConfig.SecurityOpt = []
        elif $hardening == "env" then .[0].Config.Env += ["DISCORD_TOKEN=x"]
        else . end' "$PODMAN_FIXTURES/container.json" >"$S/c/$id.json"
  : >"$S/c/$id.logs"
  case $mode in
    lease) printf '%s\n' '{"level":30,"msg":"Modules loaded"}' \
      '{"level":30,"lock":714882494,"msg":"Database writer lease acquired"}' >>"$S/c/$id.logs" ;;
    waiting) printf '%s\n' '{"level":30,"msg":"Modules loaded"}' \
      '{"level":30,"msg":"Waiting for the database writer lease held by another TaruBot writer; readiness stays false."}' \
      >>"$S/c/$id.logs" ;;
    crash) printf '%s\n' 'error: DISCORD_TOKEN is required' >>"$S/c/$id.logs" ;;
  esac
}

# A new container id for each start.
next_id() {
  local n
  n=$(($(cat "$S/counter" 2>/dev/null || printf 0) + 1))
  printf '%s\n' "$n" >"$S/counter"
  printf 'c0ffee%058x' "$n"
}

# Stop the unit's container, as ExecStop's `podman rm -f` does: a died event and no container.
stop_current() {
  local id version
  id=$(cat "$S/current" 2>/dev/null || true)
  if [[ -n $id && -f $S/c/$id.json ]]; then
    if [[ -f $S/knob/lease_after_stop ]]; then
      printf '%s\n' '{"level":30,"msg":"Database writer lease acquired"}' >>"$S/c/$id.logs"
    fi
    version=$(jq -r '.[0].Config.Labels["org.opencontainers.image.version"]' "$S/c/$id.json")
    event died "$id" "$version"
    rm -f "$S/c/$id.json"
  fi
  : >"$S/current"
  printf 'inactive dead\n' >"$S/unit"
}

# Start the unit on the release .env's digest names, by the knob up.<release>: healthy, unstable
# (systemd restarts it within the stability minute), unstable-id (a new container, NRestarts the
# same), fail-before-lease, fail-after-lease, fail-no-modules, start-empty (a start with no lines),
# crashloop-after-lease and crashloop-no-modules (two containers that died, the unit between
# restarts), or fail-no-container (the start fails before any container). Two modes cover the
# health check's start period, as a real bot spends most of its first minute: starting:<n> (health
# `starting` for n five-second sleeps, holding the lease, then healthy) and starting-forever
# (`starting` for good, waiting for a writer lease another bot holds). hardening.<release>
# changes the new container's hardening. Fails as systemctl would when the start fails.
start_unit() {
  local digest version mode id n
  digest=$(sed -n 's/^TARUBOT_IMAGE_DIGEST=//p' "$HOME/tarubot/.env")
  version=$(version_of "$digest")
  [[ -n $version ]] || return 1
  mode=$(knob "up.$version")
  mode=${mode:-healthy}
  if [[ $mode == fail-no-container ]]; then
    printf 'activating auto-restart\n' >"$S/unit"
    return 1
  fi
  case $mode in
    crashloop-*)
      for n in 1 2; do
        id=$(next_id)
        if [[ $mode == crashloop-after-lease ]]; then
          container "$id" "$version" exited unhealthy lease
        else
          container "$id" "$version" exited unhealthy crash
        fi
        event start "$id" "$version"
        event died "$id" "$version"
        rm -f "$S/c/$id.json"
      done
      : >"$S/current"
      printf 'activating auto-restart\n' >"$S/unit"
      return 0
      ;;
  esac
  id=$(next_id)
  case $mode in
    healthy | unstable | unstable-id)
      container "$id" "$version" running healthy lease "$(knob "hardening.$version")"
      ;;
    starting:*)
      container "$id" "$version" running starting lease
      printf '%s\n' "${mode#starting:}" >"$S/c/$id.starting"
      ;;
    starting-forever) container "$id" "$version" running starting waiting ;;
    fail-before-lease) container "$id" "$version" running unhealthy waiting ;;
    fail-after-lease) container "$id" "$version" running unhealthy lease ;;
    fail-no-modules) container "$id" "$version" running unhealthy crash ;;
    start-empty) container "$id" "$version" running unhealthy none ;;
  esac
  if [[ $mode == unstable || $mode == unstable-id ]]; then printf '%s\n' "$mode" >"$S/c/$id.unstable"; fi
  event start "$id" "$version"
  printf '%s\n' "$id" >"$S/current"
  printf 'active running\n' >"$S/unit"
}

# Time passing in the worker's sleeps. Each five-second poll brings a starting:<n> container one
# step nearer to healthy (sleeps counts them all). The stability minute (`sleep 60`), one check at
# a time: for unstable, systemd's NRestarts goes up (the container looks the same); for
# unstable-id, another container replaces it on the same count.
tick() {
  local id version n
  printf '%s\n' "${1-}" >>"$S/sleeps"
  id=$(cat "$S/current" 2>/dev/null || true)
  if [[ ${1-} == 5 && -n $id && -f $S/c/$id.starting ]]; then
    n=$(($(cat "$S/c/$id.starting") - 1))
    if ((n > 0)); then
      printf '%s\n' "$n" >"$S/c/$id.starting"
    else
      rm -f "$S/c/$id.starting"
      jq '.[0].State.Health.Status = "healthy"' "$S/c/$id.json" >"$S/c/$id.json.new"
      mv -f "$S/c/$id.json.new" "$S/c/$id.json"
    fi
  fi
  [[ ${1-} == 60 ]] || return 0
  [[ -n $id && -f $S/c/$id.unstable ]] || return 0
  if [[ $(cat "$S/c/$id.unstable") == unstable ]]; then
    n=$(cat "$S/nrestarts")
    printf '%s\n' "$((n + 1))" >"$S/nrestarts"
    rm -f "$S/c/$id.unstable"
    return 0
  fi
  version=$(jq -r '.[0].Config.Labels["org.opencontainers.image.version"]' "$S/c/$id.json")
  event died "$id" "$version"
  rm -f "$S/c/$id.json" "$S/c/$id.unstable"
  id=$(next_id)
  container "$id" "$version" running healthy lease
  event start "$id" "$version"
  printf '%s\n' "$id" >"$S/current"
}

# Run directly: one of the functions above with its arguments.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  "$@"
fi
