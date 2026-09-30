# Deployment

This is the **implemented** pipeline. Production still uses Docker Compose; staging has the OpenTofu/Ansible/rootless Quadlet path. A green run with skipped steps, `no-host` or `configured` does not prove staging is running DevBot. Check the target job and its actual result. The [release-integrated infrastructure/safe-auto-apply specification](PIPELINE.md) is separate work, with explicit milestones and activation prerequisites.

## Release flow

1. **PR:** CI, security checks and the owner's code-owner review. Merge with a merge commit.
2. **Publish:** revalidate, build AMD64/ARM64 images, publish candidates to GHCR, scan both exact runtime digests, sign the returned index digest, then promote `latest`. A failed scan blocks signing/promotion even though candidate tags already exist.
3. **Deploy plan:** bind version, commit and digest; verify provenance; inspect runtime paths and schema changes. Documentation/test/CI-only changes do not request deployment.
4. **Staging:** `host.yml` runs `site.yml` from the planned `main` head as root, then the release's `bot.yml` as `tarubot`. It deploys without a reviewer when configured. No target host means an automatic `no-host`; no Discord token on an empty host means configure-only. Neither counts as a healthy bot deployment.
5. **Production:** the owner approves the `production` environment. The frozen Compose job sends its constrained deploy command over SSH; the host checks and deploys the release, and notify reports the outcome.

**Production is not currently gated on staging success.** Its job runs independently. The owner should review genuinely deployed/tested staging evidence before approving, rather than relying on the overall run colour. Publication and infrastructure are also separate: a release does not currently plan/apply OpenTofu.

## Workflow inputs

Dispatch Deploy from `main` with an explicit release version:

| Target | Inputs / meaning |
| --- | --- |
| `production` | `action=deploy` only; a rollback also needs `rollback=true` and `from=<live version>` |
| `staging` | `deploy`: Configure then bot; `configure`: host only; `bot`: release only; `preflight`: Configure plus database/backup checks without Discord |

Staging image rollback uses `action=bot`, not production's rollback inputs, **only after the owner verifies unchanged live schema and fences the writer**. On missing/changed schema evidence, fix forward or follow owner-controlled recovery. The playbook stops the old writer and persists a private recovery boundary before installing/starting the candidate; it does not automatically put anything back. Normal Deploy requires signed publication; staging also requires a release containing its bot playbook. Re-runs are refused: inspect uncertain outcomes before a fresh, owner-authorized dispatch.

Production's repository variable `DEPLOY_ENABLED` must be exactly `true`. Staging has no switch; the owner pauses it by adding an environment reviewer. Per-target host jobs queue rather than cancel waiting runs. See [CI/CD](CI_CD.md) for provenance and [HOSTING](HOSTING.md) for failures.

## First-host setup: owner checklist

These steps belong to the owner, not an agent. They are a procedure, not a claim that setup is complete.

1. Protect `main`: signed commits, merge commits only, required CI/security checks, one code-owner approval, stale approvals dismissed.
2. Create private encrypted-state storage and scoped read/write provider/storage credentials. Create `infra-plan` (read-only, no reviewer) and `infra` (write, owner approval), both accepting only `main`. Read their protection settings back once.
3. Set identical shared infrastructure inputs in both environments. Follow [the OpenTofu runbook](../ops/tofu/README.md#the-first-apply) for an import-only access-list plan before building any host. **The current module imports access lists, not the database cluster itself.** It must not provision a replacement cluster.
4. Generate each Configure key outside agent sessions. Store the private half in the target's `ANSIBLE_SSH_KEY`, public half in `TOFU_VARS.configure_keys`. No passphrase: runners use batch SSH. Never place a host private key in user data.
5. Add the host shape to `TOFU_VARS`; dispatch Infrastructure and approve only the reviewed saved plan. cloud-init sets root credentials and generates the host's own Ed25519 host key at first boot.
6. Verify the new host key from the owner's machine (prefer comparison with the provider console). Store `TARGET_HOST` and `TARGET_HOST_KEY` (`ssh-ed25519 <key>`) in the target environment. The current workflow uses this explicit pin, not automated TOFU/DNSSEC. Never silently accept a changed key.
7. Dispatch staging `configure`. First Configure upgrades/reboots a new host; the second must report `changed=0`.
8. Set staging's database/CA, reports, heartbeat and backup secrets, but no Discord token yet. `REPORTS_GITHUB_TOKEN` maps to the bot's reports setting; see [configuration](CONFIGURATION.md#staging-settings). Single-line values must contain no whitespace.
9. Dispatch `preflight`: expect `preflight-ok`, a successful encrypted backup and an enabled timer. Decrypt/restore the backup into a scratch database and verify it.
10. Move DevBot only in a separate approved window: equal schema heads, stopped local bot, owner-restored database, reset token placed only in `staging`, then `bot`. Verify a real healthy deploy, commands and acceptance; never run the same application locally and on staging.

Production's Quadlet cutover is not implemented here. It needs a separately reviewed change and owner-run window, with the old bot stopped before the new one starts. Do not follow the [archived production-move plan](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/DEPLOYMENT.md#phase-6-productions-move-2370-once) as if it had shipped.

## Boundaries

The infrastructure workflow binds the encrypted saved plan to its private backend/inputs and workflow run before writes, and emits an advisory full-plan policy decision. It is still dispatch-only with owner-approved Apply. Replacement release/safe-apply/acceptance components exist but their publisher hook defaults off and a **code-level admission fence blocks activation before credentials** until database adoption and durable SSH enrollment ship. Do not set `RELEASE_PIPELINE_ENABLED` now. See [implementation milestones](PIPELINE.md#implementation-milestones-and-acceptance) and the component details; no live acceptance or production cutover is claimed.

The agent rule was confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and widened to Infrastructure/every deployment environment. [AGENTS.md](../AGENTS.md) carries it verbatim. Agents hold no host-access key/environment secret, never approve or bypass a gate, and dispatch only when asked in that session. Environment, provider, token and key changes remain owner actions.
