# TaruBot's Quadlet unit

On the Podman hosts, TaruBot runs as a rootless Quadlet unit under the `tarubot` user's systemd. @deconfined decided this for [#50](https://github.com/deconfined/tarubot/issues/50) on 2026-09-26. The hosts have no Docker packages, no Docker context and no Podman API socket. Production keeps running under Compose on Docker until it is rebuilt (#50 part 4), and Compose stays for local development and for self-hosters.

This directory is the part of the runtime that belongs to the release. The Ansible playbook in `ops/ansible/` sets up the host layer around it. `tests/unit/quadlet.test.ts` and `tests/unit/container-hardening.test.ts` keep it in step with the bot's service in `docker-compose.production.yml`.

**Status in 2.32.0.** The files ship, but no host links them yet, and the playbook never creates the links. The playbook's `start` tag, which makes them and starts the unit for the first time, arrives with 2.33.0 and first runs at the DevBot move. deploy.sh's and backup.sh's Quadlet paths also come in 2.33.0.

## Files

| File | What it is |
| --- | --- |
| `units/tarubot.container` | The unit. Podman's generator turns it into `tarubot.service`. |
| `units/tarubot.env` | The settings every host's container gets, in Podman's env-file format. |
| `production/target.env`, `staging/target.env` | The settings that differ between the two targets. Both list the same names. |
| `production/tarubot.container.d/50-target.conf`, and the same under `staging/` | The target's drop-in. It adds the target's `target.env` after the base list and changes nothing else. |
| `check-env.sh` | The one check of the settings. It prints names and line numbers, never values. |

Only `units/` holds files with a Quadlet extension, and no `*.d` directory sits under it. Quadlet reads every linked directory recursively and applies `[Install]` at the next boot, so a stray unit or drop-in there would reach every host.

## On a host

The `start` tag (2.33.0) makes two links:

- `~/.config/containers/systemd/tarubot` points to `~/tarubot/ops/quadlet/units`;
- `~/.config/containers/systemd/tarubot-target` points to `~/tarubot/ops/quadlet/production` or `~/tarubot/ops/quadlet/staging`.

Quadlet follows symbolic links in its search path, and it looks for `tarubot.container.d` in every directory it reads, so the target's drop-in applies (podman-systemd.unit(5), "Using symbolic links" and the drop-in rules). The links follow the clone, so `git reset --keep` to a release, including a rollback, brings back that release's own unit after a `daemon-reload`.

A host links exactly one target:

- **With no target**, the bot has no `DISCORD_APPLICATION_ID` and refuses to start. A lost link stops the bot rather than running under the wrong identity.
- **With both**, the two drop-ins share the name `50-target.conf`, and Quadlet merges only the first one it finds. The host then runs as one whole target, never a mix of the two. deploy.sh and the playbook still refuse a host with both links.

## How settings reach the bot

1. **systemd reads `~/tarubot/.env`** through `[Service] EnvironmentFile=`. The file stays as it is today, including the procedure for writing it over SSH and the encrypted settings copy. Quoted values may span lines, so the PEMs work, and no value appears on a command line.
2. **`UnsetEnvironment=` drops `ops/backup.sh`'s settings**, so they never reach Podman, conmon or the bot.
3. **Podman gets two lists**, `units/tarubot.env` and then the target's `target.env`:
   - `NAME=value` is a fixed value. The target's application ID and scoping are fixed this way, so `.env` can't change them.
   - A bare `NAME` copies the value systemd read, and only when it is set. Unset, the bot uses its own default, which equals Compose's.
   - A later file wins, but the two lists never name the same setting.
   - Podman reads each line literally, so the lists have no quotes, no inline comments and no `NAME*` lines. Podman would read `NAME*` as a prefix and pass every variable that starts with it.
4. **`EnvironmentHost=false` and `HttpProxy=false`** stop a `containers.conf` default from passing Podman's own environment into the container.

**Staging differs from production** only in `staging/target.env`: DevBot's application, `TARUBOT_ENVIRONMENT=staging`, DevBot's test guild, public test replies, and `TEST_PLAN_CHANNEL_ID` taken from `.env`. `GITHUB_APP_CLIENT_ID` is forced empty, so `/suggest` stays off on staging whatever `.env` holds.

### check-env.sh

The unit runs it twice before every start, because systemd reads `.env` again on every start, crash restarts and reboots included. The playbook runs `--syntax` on every apply, and from 2.33.0 a deploy runs both before anything stops.

- **`check-env.sh --syntax FILE`** refuses lines that systemd and Compose read differently. The same `.env` moves between the two runtimes, and settings copies restore into either, so it must mean the same to both. It refuses:
  - `$` outside single quotes;
  - `\` anywhere, since Compose reads `\'` as a quote even inside single quotes;
  - an inline comment;
  - text after a closing quote;
  - `export`;
  - an indented assignment, or a line inside a quoted value that looks like one with a `_` in its name, because deploy.sh and backup.sh find settings with `^NAME=` (every name they read has a `_`, and base64 has none, so PEM lines pass);
  - a name assigned twice;
  - CRLF line endings.
- **`check-env.sh`** checks the settings systemd read. It requires:
  - `DATABASE_URL`, `DATABASE_CA_CERT` and `DISCORD_TOKEN`, not empty;
  - a `TARUBOT_IMAGE_DIGEST` of the form `sha256:` and 64 hex digits;
  - `LOG_LEVEL` unset, or `trace`, `debug` or `info`;
  - no setting with a non-empty Compose default that is set but empty. Compose used the default for an empty value, but the bot reads `""` as it is, which silently switches off the guest cooldown and live selectors.

## Secrets

@deconfined decided on 2026-09-26 that secrets reach the bot as Podman secrets mounted as files, not as environment variables ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5851052487)). As a variable, a secret is readable by everything in the process, including every dependency. This lands with the Quadlet runtime in 2.33.0 (#50 part 2), together with `_FILE` support in `src/config/env.ts`. Until then the lists pass no secret at all, so the unit can't run a bot yet. No host links it before 2.33.0.

- **The secrets:** `DISCORD_TOKEN`, `DATABASE_URL`, `DATABASE_CA_CERT`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_REPORTS_TOKEN` and `HEALTHCHECKS_PING_URL`. `tests/unit/quadlet.test.ts` holds the same list. It checks that the lists plus these names give exactly Compose's settings, and it refuses any of them in a list.
- **Where they're kept:** `~/tarubot/.env` stays the only place. Rootless Podman's secret store is no safer at rest, so it isn't a second place to edit. A pre-start step copies each value into its Podman secret at every start, replacing the old one.
- **Where they go:**
  - `units/tarubot.container` gains a `Secret=` line for each secret every host has, mounted read-only and readable only by the bot, under `/run/secrets/`.
  - `units/tarubot.env` gains the fixed `NAME_FILE=/run/secrets/…` lines that tell the bot where to read them.
  - `production/tarubot.container.d/` gains the GitHub App key. Staging never gets it.
- **Out of the service's environment:** `[Service] EnvironmentFile=` loads all of `.env` into the environment of Podman, conmon and pasta, and conmon and pasta keep it for the container's lifetime. So `UnsetEnvironment=` also names every secret, as it names the backup settings today, and the pre-start step reads `.env` itself rather than taking the values from the unit's environment. `tests/unit/quadlet.test.ts` will require both.
- **What stays:** `check-env.sh` still checks the required ones in `.env`. The plain variables keep working for local development and Compose self-hosters. The settings copy and `scripts/host-env-backup.ts` don't change.

## What Podman generates

This was checked with Podman 5.8.2's generator, the version AlmaLinux 10.2 ships, on both layouts. `ExecStart` for production is, wrapped here:

```text
/usr/bin/podman run --name tarubot --replace --rm --log-driver journald --cgroups=split
  --stop-timeout 30 --pull never --env-host=false --http-proxy=false --read-only-tmpfs=false
  --sdnotify=conmon -d --security-opt=no-new-privileges --cap-drop all --read-only
  --env-file %h/tarubot/ops/quadlet/units/tarubot.env
  --env-file %h/tarubot/ops/quadlet/production/target.env
  --health-cmd "[\"bun\",\"-e\",\"const\x20r=await\x20fetch('http://localhost:3000/health/ready');process.exit(r.ok?0:1)\"]"
  --health-interval 15s --health-on-failure none --health-retries 3 --health-start-period 60s
  --health-timeout 5s ghcr.io/deconfined/tarubot@${TARUBOT_IMAGE_DIGEST}
```

Quadlet also adds `Wants=` and `After=` on `podman-user-wait-network-online.service`, `KillMode=mixed`, `ExecStop=podman rm -v -f -i tarubot`, `Type=notify` and `SyslogIdentifier=%N`. `systemd-analyze verify` passes on the result.

Behaviour worth knowing, from podman-systemd.unit(5) and Podman's source:

- **The image pin.** Quadlet never escapes `$`, and systemd expands `${TARUBOT_IMAGE_DIGEST}` in `ExecStart` from `[Service] EnvironmentFile=`. systemd reads `.env` again before every start, so a re-pin needs no reload.
- **Paths.** Quadlet leaves a path that starts with `%` alone, and systemd expands `%h`. The drop-ins use `%h` because a relative path would resolve against the unit's directory, not the drop-in's.
- **The health check.** A JSON array for `--health-cmd` runs as an exec form, like Compose's `CMD` array. The array leaves out Docker's `CMD` word.
- **Starting.** `Notify=` stays at its default, so the unit is active once conmon reports the container running. deploy.sh waits for healthy itself, and `Notify=healthy` would kill a bot that is waiting for the writer lease.
- **Every start makes a new container** (`--replace --rm`), so restarts show in systemd's `NRestarts`, not in Podman's restart count.
- **Stopping.** `systemctl --user stop` doesn't survive a reboot: `[Install]` starts the unit at boot again. Masking it keeps it down.
- **Read-only.** `ReadOnlyTmpfs=false` leaves `/dev/shm` read-only as well, which is stricter than Docker. #51's write inventory is checked again on staging.
- **No auto-update.** With no `AutoUpdate=` key, the container has no `io.containers.autoupdate` label, and `podman auto-update` ignores it.

To see the generated unit on a host (as tarubot):

```sh
/usr/lib/systemd/system-generators/podman-system-generator --user --dryrun
```

It must print one `tarubot.service` and nothing else. A dry run that finds no unit still exits 0, so check the output, not only the exit status.

To run the same check from a checkout, without a host: build the layout in a Podman 5.8.2 container, save each target's dry-run output as `production.txt` and `staging.txt` in one directory, and name that directory in `QUADLET_DRYRUN` when running `bun test tests/unit/quadlet.test.ts`. The test then compares the generated `ExecStart` with the unit and Compose, flag by flag. Without `QUADLET_DRYRUN` it skips that part.

```sh
mkdir -p .cache/quadlet
for target in production staging; do
  docker run --rm -v "$PWD/ops:/src/ops:ro" quay.io/podman/stable:v5.8.2 sh -c '
    set -e; export HOME=/home/t; d=$HOME/.config/containers/systemd
    mkdir -p $HOME/tarubot $d; cp -r /src/ops $HOME/tarubot/
    ln -s $HOME/tarubot/ops/quadlet/units $d/tarubot
    ln -s $HOME/tarubot/ops/quadlet/'"$target"' $d/tarubot-target
    /usr/lib/systemd/system-generators/podman-system-generator --user --dryrun' \
    >".cache/quadlet/$target.txt"
done
QUADLET_DRYRUN=.cache/quadlet bun test tests/unit/quadlet.test.ts
```
