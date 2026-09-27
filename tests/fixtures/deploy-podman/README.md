# Podman answers for the deploy tests

`tests/unit/deploy-script.test.ts` simulates a rootless Quadlet host (#50) with stubs for `podman`,
`systemctl`, `journalctl`, `systemd-run` and the Quadlet generator (`tests/fixtures/deploy-stubs`).
The stubs build their answers from these files, so the fields `ops/deploy.sh` reads have the shapes
a real Podman gives. They were captured on 2026-09-27 from Podman 5.8.2 (the version AlmaLinux 10.2
ships), run as `quay.io/podman/stable:v5.8.2` under Docker, with the public 2.32.0 image pulled by
its index digest:

- `container.json`: `podman container inspect` of a container started with the unit's flags
  (`--read-only --read-only-tmpfs=false --cap-drop all --security-opt=no-new-privileges
  --env-host=false --http-proxy=false`, two secrets mounted as files under `/run/secrets/`, a
  health check run once). The container's hostname and the overlay layer paths are replaced.
- `image.json`: `podman image inspect` of the image, by its index digest.
- `events.jsonl`: `podman events --stream=false --format json` for one container's start and
  died events, one JSON object a line.

What these show, and what the script relies on:

- Podman prints image and container ids as bare hex (Docker prefixes `sha256:`). A container's
  `Image` is the image's `Id`; its `ImageName` is the reference it was created from.
- After a pull by index digest, `RepoDigests` holds that digest and the platform manifest's, so
  `podman image inspect ghcr.io/deconfined/tarubot@<index digest>` answers.
- The health status is `State.Health.Status`.
- Secrets mounted as files appear in `Config.Secrets`, never in `Mounts` or `HostConfig.Binds`;
  neither does the default `/run/secrets` mount a host's `mounts.conf` may add (AlmaLinux lists
  `/usr/share/rhel/secrets:/run/secrets`). A bind mount appears in both `Mounts` and
  `HostConfig.Binds` (`source:destination:options`).
- With every capability dropped, `EffectiveCaps` is `null`; `HostConfig.CapAdd` lists added ones.
- `no-new-privileges` is an entry of `HostConfig.SecurityOpt`.
- `HostConfig.Tmpfs` stays `{}` even with `--read-only-tmpfs=true`, so it can't show the tmpfs
  mounts Podman adds; the script doesn't read it.
- An event's `Image` is the reference the container was created from
  (`ghcr.io/deconfined/tarubot@sha256:<index digest>` for a Quadlet unit), `ID` the full id, and
  `timeNano` its time. `--since` takes an RFC 3339 time with nanoseconds. These captures came from
  the file event backend; a Quadlet host must use journald (the script checks). Read-only on the
  staging host, whose Podman uses journald, its own events print in the same form.

The container ran as root inside the capture container, on the host network, so its `LogConfig`
and `NetworkSettings` differ from a rootless Quadlet unit's; the script reads neither.
