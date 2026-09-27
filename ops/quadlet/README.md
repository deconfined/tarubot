# TaruBot's Quadlet unit

On the Podman hosts, TaruBot runs as a rootless Quadlet unit under the `tarubot` user's systemd. @deconfined decided this for [#50](https://github.com/deconfined/tarubot/issues/50) on 2026-09-26. The hosts have no Docker packages, no Docker context and no Podman API socket. Production keeps running under Compose on Docker until it is rebuilt (#50, the production rebuild), and Compose stays for local development and for self-hosters.

This directory is the part of the runtime that belongs to the release. The Ansible playbook in `ops/ansible/` sets up the host layer around it. `tests/unit/quadlet.test.ts` and `tests/unit/container-hardening.test.ts` keep it in step with the bot's service in `docker-compose.production.yml`.

**Status in 2.33.0.** The unit is complete: the secrets reach it as files (below), `ops/deploy.sh quadlet` and `quadlet staging` deploy it, `ops/backup.sh quadlet` backs it up, and the playbook's `start` tag creates the links and starts it for the first time. No host links it yet. Nobody runs the `start` tag in this release: the staging bot first starts at the DevBot move, and production at its rebuild (#50, the production rebuild).

## Files

| File | What it is |
| --- | --- |
| `units/tarubot.container` | The unit. Podman's generator turns it into `tarubot.service`. |
| `units/tarubot.env` | The settings every host's container gets, in Podman's env-file format. |
| `production/target.env`, `staging/target.env` | The settings that differ between the two targets. Both list the same names. |
| `production/tarubot.container.d/50-target.conf`, and the same under `staging/` | The target's drop-in. It adds the target's `target.env` after the base list and, on production, the GitHub App key's secret. It changes nothing else. |
| `check-env.sh` | The check of the settings. It prints names and line numbers, never values. |
| `secrets.sh` | Copies the secrets from `.env` into Podman secrets before every start, and checks them. It prints names only. |
| `run-tool.sh` | Runs one maintenance tool in a one-off container with the bot's own settings, secrets and hardening. |

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
2. **`UnsetEnvironment=` drops 14 names** before any of the unit's commands run, so they never reach Podman, conmon, pasta or the bot:
   - `ops/backup.sh`'s five settings;
   - the six secrets, which reach the bot as files instead (see "Secrets");
   - `POSTGRES_PASSWORD`, `RESTORE_DATABASE_URL` and `RESTORE_DATABASE_CA_CERT`, which a `.env` may hold and the bot never needs.

   `tests/unit/quadlet.test.ts` checks that every name in the settings templates is either in a list below or in this one, and that `ops/deploy.sh` and `run-tool.sh` use the same 14 names.
3. **Podman gets two lists**, `units/tarubot.env` and then the target's `target.env`:
   - `NAME=value` is a fixed value. The target's application ID and scoping are fixed this way, so `.env` can't change them.
   - A bare `NAME` copies the value systemd read, and only when it is set. Unset, the bot uses its own default, which equals Compose's.
   - A later file wins, but the two lists never name the same setting.
   - Podman reads each line literally, so the lists have no quotes, no inline comments and no `NAME*` lines. Podman would read `NAME*` as a prefix and pass every variable that starts with it.
4. **`EnvironmentHost=false` and `HttpProxy=false`** stop a `containers.conf` default from passing Podman's own environment into the container.

**Staging differs from production** only in `staging/target.env`: DevBot's application, `TARUBOT_ENVIRONMENT=staging`, DevBot's test guild, public test replies, and `TEST_PLAN_CHANNEL_ID` taken from `.env`. `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` are forced empty and staging never mounts the app's key, so `/suggest` stays off on staging whatever `.env` holds.

### check-env.sh

The unit runs it twice before every start, because systemd reads `.env` again on every start, crash restarts and reboots included. The playbook runs `--syntax` on every apply, and a deploy runs both before anything stops, the second through `systemd-run` with the unit's `EnvironmentFile=` and `UnsetEnvironment=`.

- **`check-env.sh --syntax FILE`** refuses lines that systemd and Compose read differently. The same `.env` moves between the two runtimes, and settings copies restore into either, so it must mean the same to both. It refuses:
  - `$` outside single quotes;
  - `\` anywhere, since Compose reads `\'` as a quote even inside single quotes;
  - an inline comment;
  - text after a closing quote;
  - `export`;
  - an indented assignment, or a line inside a quoted value that looks like one with a `_` in its name, because deploy.sh and backup.sh find settings with `^NAME=` (every name they read has a `_`, and base64 has none, so PEM lines pass);
  - a name assigned twice;
  - CRLF line endings.
- **`check-env.sh`** checks the settings systemd read, after `UnsetEnvironment=`. It ignores the unset names, so from 2.33.0 `secrets.sh` checks the secrets instead. It requires:
  - a `TARUBOT_IMAGE_DIGEST` of the form `sha256:` and 64 hex digits;
  - `LOG_LEVEL` unset, or `trace`, `debug` or `info`;
  - no setting with a non-empty Compose default that is set but empty. Compose used the default for an empty value, but the bot reads `""` as it is, which silently switches off the guest cooldown and live selectors.

## Secrets

@deconfined decided on 2026-09-26 that secrets reach the bot as Podman secrets mounted as files, not as environment variables ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5851052487)). As a variable, a secret is readable by everything in the process, including every dependency, and by every child process. This landed in 2.33.0.

- **The secrets:** `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, `GITHUB_REPORTS_TOKEN`, `HEALTHCHECKS_PING_URL` and `GITHUB_APP_PRIVATE_KEY`. `src/config/secrets.ts`, `secrets.sh`, `ops/deploy.sh` and `tests/unit/quadlet.test.ts` hold the same list.
- **Where they're kept:** `~/tarubot/.env` stays the only place. Nothing else is ever edited: the procedure for writing `.env` over SSH, the encrypted settings copy and `scripts/host-env-backup.ts` don't change.
- **How they get to the bot:**

  | Setting | Podman secret | File in the bot | Mounted on |
  | --- | --- | --- | --- |
  | `DATABASE_URL` | `tarubot-database-url` | `/run/secrets/database_url` | both targets |
  | `DATABASE_CA_CERT` | `tarubot-database-ca-cert` | `/run/secrets/database_ca_cert` | both targets |
  | `DISCORD_TOKEN` | `tarubot-discord-token` | `/run/secrets/discord_token` | both targets |
  | `GITHUB_REPORTS_TOKEN` | `tarubot-github-reports-token` | `/run/secrets/github_reports_token` | both targets |
  | `HEALTHCHECKS_PING_URL` | `tarubot-healthchecks-ping-url` | `/run/secrets/healthchecks_ping_url` | both targets |
  | `GITHUB_APP_PRIVATE_KEY` | `tarubot-github-app-private-key` | `/run/secrets/github_app_private_key` | production only |

  1. The unit's third `ExecStartPre=` runs `secrets.sh sync ~/tarubot/.env` before every start. It copies each value into its Podman secret, replacing the old one.
  2. `units/tarubot.container` mounts every host's five with a `Secret=` line each (`type=mount`, `uid=1000,gid=1000,mode=0400`); production's drop-in adds the GitHub App key. uid and gid 1000 are the image's `bun` user, which the bot runs as.
  3. `units/tarubot.env` sets the fixed `NAME_FILE=/run/secrets/…` lines, and each target's list sets `GITHUB_APP_PRIVATE_KEY_FILE`: the file on production, empty on staging.
  4. The bot reads each file through `src/config/secrets.ts` and removes the one newline `secrets.sh` added. The maintenance tools, their deployment guard and the database's default CA read them the same way, so the tools work inside a Quadlet container too.
- **Out of the service's environment:** `[Service] EnvironmentFile=` loads all of `.env` into the environment of Podman, conmon and pasta, and conmon and pasta keep it for the container's lifetime. So `UnsetEnvironment=` names every secret, and `secrets.sh` reads `.env` itself rather than taking the values from the unit's environment.
- **Elsewhere nothing changes:** the plain variables keep working for local development, Compose and self-hosters. Setting both `NAME` and `NAME_FILE` is refused, and an empty `NAME_FILE` counts as unset.

**Where the values live on a host.** They are never on a tmpfs:

- **The store.** Podman's `file` driver keeps every secret in `~/.local/share/containers/storage/secrets/filedriver/secretsdata.json`, unencrypted (mode 600, in a mode-700 directory). It is exactly as sensitive as `.env`, and holds nothing `.env` doesn't. `podman secret inspect` doesn't show the values unless asked with `--showsecret`.
- **Each container's copy.** When a container is created, Podman copies each secret it mounts into the container's own data, `~/.local/share/containers/storage/overlay-containers/<id>/userdata/secrets/<secret>`. That copy is owned by uid 1000 inside the container with mode 0400, and bind-mounted at the target. It is removed with the container, and every start of the unit makes a new container.
- **Read-only.** Podman adds `ro` to that bind mount only because the container is read-only (`ReadOnly=true`, `--read-only`). Without it the mount is writable. So every container that mounts a secret must be read-only: the unit and `run-tool.sh` both are, and the tests check it.

### secrets.sh

- **`secrets.sh check ENV_FILE`** runs `check-env.sh --syntax` on the file, then requires `DATABASE_URL`, `DATABASE_CA_CERT` and `DISCORD_TOKEN` to be set and not empty. It changes nothing. A deploy and the playbook run it.
- **`secrets.sh sync ENV_FILE [NAME…]`** runs the same checks, then copies each named setting into its Podman secret with `podman secret create --replace`. With no names it copies all six, which the unit and `run-tool.sh` do. The nightly backup copies only `DATABASE_URL` and `DATABASE_CA_CERT`, so a blank Discord token never fails it. Only the required names among those given must be set.
- **The values:**
  - `secrets.sh` reads `.env` exactly as systemd does for the lines `check-env.sh --syntax` accepts. An unquoted value loses its surrounding blanks. A quoted value runs to its closing quote, across lines. A missing name is empty.
  - Each value is written followed by one newline. Podman refuses an empty secret ("secret data must be larger than 0 and less than 512000 bytes"), so an empty optional value is a lone newline, which the bot reads as empty.
  - awk prints each value straight into `podman secret create`, so no value is ever an argument or an environment variable.
- **Output:** exit 0 when done, 1 on a problem, 64 on a usage error. Nothing is printed on stdout, and stderr names settings only.

### run-tool.sh

`run-tool.sh TARGET DIGEST NAME COMMAND [ARG…]` runs one maintenance tool, for example the migration during a deploy:

1. It runs `secrets.sh sync ~/tarubot/.env`. A failure exits 1 and the tool doesn't run.
2. It runs `podman run --rm` of `ghcr.io/deconfined/tarubot@DIGEST` under `systemd-run --user --pipe --wait`, with the same `EnvironmentFile=` and 14-name `UnsetEnvironment=` as the unit:
   - the container gets the unit's hardening, its two lists for TARGET, and its secrets (six on production, five on staging);
   - it is named NAME and labelled `io.tarubot.role=tool`, so deploy.sh can stop a leftover one;
   - it keeps no log (`--log-driver=none`); the tool's output streams through the pipe.
3. The tool's exit status is the script's, and its stdin is `/dev/null`.

TARGET is `production` or `staging`, DIGEST is `sha256:` and 64 hex digits, and NAME is `tarubot-` and up to 40 of `a-z`, `0-9` and `-`. Anything else exits 64.

deploy.sh runs the target release's own copy, from the clone at that release, so a deploy never guesses another release's settings. The CLIs of `check-env.sh`, `secrets.sh` and `run-tool.sh`, the secret names and their files are part of deploy.sh's `quadlet` contract.

## What Podman generates

This was checked with Podman 5.8.2's generator, the version AlmaLinux 10.2 ships, on both layouts (again for 2.33.0's secrets). `ExecStart` for production is, wrapped here:

```text
/usr/bin/podman run --name tarubot --replace --rm --log-driver journald --cgroups=split
  --stop-timeout 30 --pull never --env-host=false --http-proxy=false --read-only-tmpfs=false
  --sdnotify=conmon -d --security-opt=no-new-privileges --cap-drop all --read-only
  --env-file %h/tarubot/ops/quadlet/units/tarubot.env
  --env-file %h/tarubot/ops/quadlet/production/target.env
  --secret tarubot-database-url,type=mount,target=/run/secrets/database_url,uid=1000,gid=1000,mode=0400
  --secret tarubot-database-ca-cert,type=mount,target=/run/secrets/database_ca_cert,uid=1000,gid=1000,mode=0400
  --secret tarubot-discord-token,type=mount,target=/run/secrets/discord_token,uid=1000,gid=1000,mode=0400
  --secret tarubot-github-reports-token,type=mount,target=/run/secrets/github_reports_token,uid=1000,gid=1000,mode=0400
  --secret tarubot-healthchecks-ping-url,type=mount,target=/run/secrets/healthchecks_ping_url,uid=1000,gid=1000,mode=0400
  --secret tarubot-github-app-private-key,type=mount,target=/run/secrets/github_app_private_key,uid=1000,gid=1000,mode=0400
  --health-cmd "[\"bun\",\"-e\",\"const\x20r=await\x20fetch('http://localhost:3000/health/ready');process.exit(r.ok?0:1)\"]"
  --health-interval 15s --health-on-failure none --health-retries 3 --health-start-period 60s
  --health-timeout 5s ghcr.io/deconfined/tarubot@${TARUBOT_IMAGE_DIGEST}
```

Staging's is the same with its own `target.env` and without the last `--secret`: the drop-in's `Secret=` is appended after the unit's. Quadlet also adds `Wants=` and `After=` on `podman-user-wait-network-online.service`, `KillMode=mixed`, `ExecStop=podman rm -v -f -i tarubot`, `Type=notify` and `SyslogIdentifier=%N`. `systemd-analyze verify` passes on the result.

Behaviour worth knowing, from podman-systemd.unit(5) and Podman's source:

- **The image pin.** Quadlet never escapes `$`, and systemd expands `${TARUBOT_IMAGE_DIGEST}` in `ExecStart` from `[Service] EnvironmentFile=`. systemd reads `.env` again before every start, so a re-pin needs no reload.
- **Paths.** Quadlet leaves a path that starts with `%` alone, and systemd expands `%h`. The drop-ins use `%h` because a relative path would resolve against the unit's directory, not the drop-in's.
- **The health check.** A JSON array for `--health-cmd` runs as an exec form, like Compose's `CMD` array. The array leaves out Docker's `CMD` word.
- **Starting.** `Notify=` stays at its default, so the unit is active once conmon reports the container running. deploy.sh waits for healthy itself, and `Notify=healthy` would kill a bot that is waiting for the writer lease.
- **Every start makes a new container** (`--replace --rm`), so restarts show in systemd's `NRestarts`, not in Podman's restart count.
- **Stopping.** `systemctl --user stop` doesn't survive a reboot: `[Install]` starts the unit at boot again. Masking it keeps it down.
- **Read-only.** `ReadOnlyTmpfs=false` leaves `/dev/shm` read-only as well, which is stricter than Docker. #51's write inventory is checked again on staging.
- **No auto-update.** With no `AutoUpdate=` key, the container has no `io.containers.autoupdate` label, and `podman auto-update` ignores it.

The secrets were checked on 2026-09-27 with rootless Podman 5.8.2 (`quay.io/podman/stable:v5.8.2`, privileged, dummy values), running `secrets.sh` and `run-tool.sh` for real against the published 2.32.0 image:

- **Who can read them.** With `--read-only --read-only-tmpfs=false --cap-drop=all` and `uid=1000,gid=1000,mode=0400`, each file is `-r-------- 1000 1000` and mounted `ro,nosuid,nodev,noexec`. The bot's `bun` user (uid 1000 in `oven/bun:1.4.2`) reads it. Root inside the container, having no capabilities, and any other uid get "Permission denied". Writing fails with "Read-only file system".
- **Read-only only with a read-only container.** The same mount in a container without `--read-only` is `rw`.
- **The bytes.** A file holds exactly what `secrets.sh` wrote: the value and one newline.
- **Replacing.** `podman secret create --replace` succeeds while a container uses the secret. That container keeps its own copy, even across `podman restart`; the next new container gets the new value. The unit makes a new container at every start, after `secrets.sh sync`.
- **Empty values.** Podman refuses an empty secret, exit 125, which is why `secrets.sh` adds the newline.
- **In `podman container inspect`.** The secrets are listed in `.Config.Secrets` as `{Name, ID, UID, GID, Mode}` (mode 0400 shows as 256). They aren't in `.Mounts` or `.HostConfig.Binds`, and no value is in `.Config.Env`. So `ops/deploy.sh`'s hardening read-back requires both mount lists to be empty: any entry, even one at `/run/secrets/<name>`, would be a host file or volume that could stand in for a secret.
- **The environment.** A `run-tool.sh` container on production had the five fixed `NAME_FILE` lines and the app key's, the target's fixed values and the bare names `.env` set. It had no secret, no `POSTGRES_PASSWORD` and no backup setting. Staging's had five secrets and an empty `GITHUB_APP_PRIVATE_KEY_FILE`.
- **Tools' output.** With `--log-driver=none`, an attached `podman run` still streams the tool's output, and `podman logs` has nothing to show.
- **The parser.** For a file `check-env.sh --syntax` accepts, `secrets.sh` gives the same bytes as systemd's own `EnvironmentFile=` (checked against systemd 259 with `systemd-run --user`), including blanks around unquoted values and quoted values across lines.
- **A default `/run/secrets` mount.** AlmaLinux's `containers-common` ships `/usr/share/containers/mounts.conf` with `/usr/share/rhel/secrets:/run/secrets`. Podman therefore mounts that directory, read-only in a read-only container, at `/run/secrets` in every container. On the staging host it holds only three subscription-manager links whose targets don't exist, so it adds nothing. The unit's secrets are file mounts inside it and don't clash with it.

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
