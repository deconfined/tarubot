# Deployment

Production currently uses Docker Compose. Staging has the OpenTofu/Ansible/rootless Quadlet path. This guide describes implemented behavior; the [replacement pipeline](PIPELINE.md#current-status) remains inactive. Use [configuration](CONFIGURATION.md) for settings, [the threat model](THREAT_MODEL.md) for trust decisions, and [AGENTS.md](../AGENTS.md) for the confirmed agent rule.

## Release flow

1. **Review:** CI/security checks and the owner's code-owner approval, then a merge commit. Ordinary maintenance keeps the application version.
2. **Publish:** an explicit version increase builds AMD64/ARM64 candidates, scans both exact runtime digests, signs the returned index digest and promotes `latest`. A failed scan blocks signing/promotion even if candidate tags exist. Existing version tags cannot be overwritten; manual Publish dispatches and reruns only verify.
3. **Deploy plan:** first confirm publication completed; maintenance runs stop before image or environment lookups and notification. Bind the released version, commit and digest; verify provenance; inspect migration and host changes since the previous version's published image commit. This includes accumulated changes when the final commit only bumps the version. The plan reads target and `notify` environment metadata and main-only branch policies. Production must require the owner alone, allow self-review and refuse admin bypass.
4. **Staging:** `host.yml` runs `site.yml` from the planned `main` head as root, then the release's `bot.yml` for the unprivileged `tarubot` account. Staging normally has no reviewer. A missing host gives `no-host`; an empty host without a Discord token can only be configured.
5. **Production:** the owner approves the `production` environment. The Compose job sends its constrained command over strict, pinned SSH; the host deploys the release and `notify` reports the outcome.

Production runs independently of staging. Before approval, review the target's actual deployed/tested evidence: green skipped steps, `no-host` and `configured` do not prove a running DevBot. Publication does not currently plan or apply infrastructure.

Automatic deployment needs the previous version's published image to establish the comparison baseline. If that image is missing or unreadable, it refuses rather than substitute the release commit's parent. The owner can inspect the full release history and use the existing explicit Deploy dispatch.

## Workflow inputs

Dispatch Deploy from `main` with an explicit release version:

| Target | Inputs / meaning |
| --- | --- |
| `production` | `action=deploy`; rollback also needs `rollback=true` and `from=<live version>` |
| `staging` | `deploy`: Configure then bot; `configure`: host only; `bot`: release only; `preflight`: Configure plus database/backup checks without Discord |

Quadlet has no automatic rollback. A previous-version staging `action=bot` dispatch requires verified unchanged live schema and a fenced writer. Missing or changed schema evidence calls for fix-forward or owner-controlled recovery. The playbook stops the writer and saves a private recovery boundary before replacing the unit. See [deployment outcomes](HOSTING.md#deployment-outcomes).

Normal Deploy requires signed publication; staging also needs the release's bot playbook. Re-runs are refused. Inspect uncertain host/database state before a fresh owner-authorized dispatch.

Production's `DEPLOY_ENABLED` variable must be exactly `true`. Staging has no switch; the owner pauses it by adding an environment reviewer. Per-target host jobs queue without cancelling waiting runs. See [CI/CD](CI_CD.md#signed-build-provenance) for provenance.

## First-host setup: owner checklist

These are owner actions, not a claim that setup is complete.

1. Protect `main`: signed commits, merge commits, required CI/security checks, code-owner approval and dismissal of stale approvals.
2. Create encrypted-state storage and scoped credentials. Configure main-only `infra-plan` with read-only access/no reviewer, and `infra` with write access/owner approval. Read their settings back at setup and after changes; infrastructure jobs do not self-check those settings.
3. Set matching shared infrastructure inputs. Follow [the first-apply runbook](../ops/tofu/README.md#the-first-apply). Existing-cluster adoption uses exact private settings, a separate approved import and read-only no-change verification; it must not mutate the cluster or build a host.
4. Generate Configure keys outside agent sessions. Store the private key in the target's `ANSIBLE_SSH_KEY`, public key in `TOFU_VARS.configure_keys`. Runners use batch SSH, so no passphrase. Never put a host private key in user data.
5. Set the host shape; dispatch Infrastructure and approve only the reviewed saved plan. cloud-init sets credentials; the host generates its own Ed25519 host key at first boot.
6. Require successful durable enrollment after the approved new-host Apply. For the current manual Host path, also verify that same key from the owner's machine, preferably against the provider console, and set `TARGET_HOST` and `TARGET_HOST_KEY` (`ssh-ed25519 <key>`). Never silently accept a changed key.
7. Dispatch staging `configure`. The first run upgrades/reboots the new host; the second must report `changed=0`.
8. Add staging database/CA, reports, heartbeat and backup settings, initially without a Discord token. Follow [staging settings](CONFIGURATION.md#staging-settings). Dispatch `preflight`; require `preflight-ok`, an enabled timer and a successful encrypted backup. Decrypt/restore it into a scratch database and verify it.
9. Move DevBot in a separate owner-approved window: equal schema heads, local bot stopped, owner-restored database, reset token only in `staging`, then `bot`. Verify health, commands and acceptance; never run the same application in both places.

Production's Quadlet cutover needs a separate reviewed change and owner-run window. Stop the old bot before starting its replacement.

Before rehearsing the replacement Host path, the owner supplies matching `TOFU_STATE_BUCKET`, `TOFU_STATE_ENDPOINT`, `TOFU_STATE_PASSPHRASE`, `TOFU_STATE_READ_ACCESS_KEY` and `TOFU_STATE_READ_SECRET_KEY` in the target environment. These give read-only access to the enrolled trust records; Host needs no provider token or infrastructure inputs. It requires complete trust with no pending enrollment, validates DNSSEC locally, and connects to a literal enrolled address with the stored key. Missing records or DNSSEC failure stops delivery.

## Boundaries

Infrastructure is dispatch-only with owner-approved Apply. It binds the encrypted saved plan to its backend, inputs and workflow run before writes; its full-plan policy decision is advisory. The release-integrated automatic path remains off and code-fenced before credentials. Do not enable `RELEASE_PIPELINE_ENABLED`; see [PIPELINE](PIPELINE.md) for the agreed flow and remaining gaps.
