---
title: Build and deploy pipeline
description: Run the repository's Linode, OpenTofu, Ansible and Podman delivery path from GitHub Actions.
sidebar:
  order: 4
---

The repository includes a **Build and deploy** workflow for its managed deployments. One GitHub Actions run verifies and publishes an image, prepares a Linode host with OpenTofu, configures AlmaLinux 10 with Ansible and starts TaruBot as a rootless Podman Quadlet service. The host keeps SELinux enforcing.

This path was added in 2.37.0. Existing installations keep their current deployment until their owner chooses to move them. The [Compose installation](/tarubot/deploy/install/) remains available for a self-hosted bot; the managed pipeline uses the deployment profiles defined in the repository and needs its owner's target configuration.

## Prepare the pipeline

The owner sets up the Linode account, managed PostgreSQL database and private infrastructure-state storage, with the existing Cloudflare DNS zone. The repository does not create those accounts or the database.

The selected GitHub environment, `staging` or `production`, holds its infrastructure, Ansible and bot credentials together, and accepts only reviewed code on `main`. Staging has no approval gate. Production requires the owner's approval once, covering provisioning, configuration and bot deployment in the same run. The earlier separate infrastructure environments are not needed by this path; the owner migrates their settings.

Keep secrets out of source files, workflow inputs and public logs. Hostnames such as `bot.example.org` and database connection details belong in private configuration. Both targets share the infrastructure state, so their configuration must describe all managed hosts and retained database access entries, including an existing installation during its move.

Keep the repository's required checks and owner review in place. See the [contributor deployment runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md) and [OpenTofu configuration](https://github.com/deconfined/tarubot/tree/main/ops/tofu) for the exact owner setup.

## Follow one workflow run

1. In GitHub Actions, start **Build and deploy** from `main`. Select the prepared **environment** and leave **rebuild** and **prepare_only** off for a normal deployment. Begin with `staging`.
2. The build verifies the source, publishes images for both supported architectures and signs provenance for their exact digest.
3. For production, approve the environment's deployment once. OpenTofu then plans and applies the Linode host, firewall, DNS and database access changes. Shared-state operations run one at a time.
4. The pipeline records a newly created host's first SSH public key in private storage. This is trust on first use. Later runs must match the retained key; a changed key stops the connection.
5. Ansible configures the host and deploys the build's verified image with the target's secrets. Migrations run before the new bot starts, then readiness is checked.
6. Check the workflow result, the bot's health and a backup restore. A failed stage stops the run and identifies what needs attention.

The host generates its own SSH host key. The pipeline never silently replaces an existing pin, and it keeps host keys, addresses and credentials out of public Actions logs. When adopting an existing host, its owner migrates the verified public key and instance ID into private pin storage first; a reused host with no retained pin is refused. Use **rebuild** only when deliberately replacing that target's host, after considering database access and downtime.

## Move an existing installation

Preparing a replacement host does not stop or move the running bot. First run the production target with **prepare_only** on and its Discord token absent. This is accepted only on a host with no installed bot unit. It provisions and configures the host, probes its database over verified TLS, runs one encrypted backup and enables its timer. It installs no bot unit, runs no migrations and registers no commands. Verify that preparation and rehearse a backup restore while the existing process keeps running; preparation does not certify schema compatibility.

The owner pauses the installation's earlier automatic deployment path and chooses the cutover window. Start the same workflow with **prepare_only** off and **rebuild** off, let its build finish and leave it waiting for production approval. While it waits, stop the old process and set the new Discord token in the production environment, then approve the waiting run. The protected job receives its environment secrets when it starts. Each production run has one owner approval. Preserve database access throughout the move, and keep a single process using that Discord application and database. Retiring the earlier deployment path is a separate owner step.

An unsuccessful deployment has no automatic rollback. Read the failed stage's summary, correct its cause and start a new run. Keep the existing SSH pin on retries. An older image does not undo migrations; use the [operations guidance](/tarubot/deploy/operations/) and [backup procedure](/tarubot/deploy/operations/#backup) when recovery needs database work.
