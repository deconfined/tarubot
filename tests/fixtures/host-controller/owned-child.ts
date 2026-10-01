/**
 * Invented phase bytes for a real, local paused-child rehearsal. These declarations never
 * authenticate Git/event source or mint an execution grant; no play is parsed or executed.
 * Public cached software is read only by the explicitly invoked local rehearsal helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pins from "../../../ops/host-controller/pins.json" with { type: "json" };
import type { ControllerPublicBytes } from "../../../scripts/host-controller-closure.js";
import type { HostControllerPhaseInput } from "../../../scripts/host-controller.js";

export function inventedControllerPhase(): HostControllerPhaseInput {
  const configuration = [
    "ops/ansible/site.yml",
    "ops/ansible/vars/layout.yml",
    "ops/ansible/templates/dnf-automatic.conf.j2",
    "ops/ansible/files/dnf-automatic-timer-production.conf",
    "ops/ansible/files/sysctl-tarubot.conf",
    "ops/ansible/files/journald-tarubot.conf",
    "ops/ansible/files/multi-user-network-online.conf",
    "ops/ansible/files/tarubot-ipv6-online",
    "ops/ansible/files/tarubot-ipv6-online.service",
    "ops/ansible/files/sshd-00-tarubot.conf",
    "ops/ansible/files/polkit-10-tarubot.rules",
  ];
  const release = [
    "ops/ansible/bot.yml",
    "ops/ansible/accept.yml",
    "ops/ansible/vars/bot.yml",
    "ops/ansible/vars/targets/staging.yml",
    "ops/ansible/templates/bot/tarubot.env.j2",
    "ops/ansible/templates/bot/tarubot.container.j2",
    "ops/ansible/files/bot/tarubot-tool",
    "ops/ansible/files/bot/tarubot-backup",
    "ops/ansible/files/bot/tarubot-backup.service",
    "ops/ansible/files/bot/tarubot-backup.timer",
    "ops/age-recipients.txt",
  ];
  const copied = (paths: string[]) =>
    Object.fromEntries(
      paths.map((path) => [path, Buffer.from(`# Invented inactive controller fixture: ${path}\n`)]),
    );
  return {
    declaration: {
      schema: 1,
      purpose: "tarubot-host-controller-phase-v1",
      target: "staging",
      action: "deploy",
      phase: "site",
      phase_number: 0,
      accept_release: true,
      configuration: { commit: "a".repeat(40) },
      release: {
        version: "1.2.3",
        commit: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        config_commit: "a".repeat(40),
        publication_run: "701",
        schema_head: "101_fixture.sql",
      },
    },
    configuration_files: copied(configuration),
    release_files: copied(release),
  };
}
/** This fixture cache parameter is not accepted by the production native factory. */
export function cachedControllerPublicBytes(directory: string): ControllerPublicBytes {
  return {
    manifest: readFileSync(join(directory, "python-amd64-manifest.json")),
    config: readFileSync(join(directory, "python-amd64-config.json")),
    layers: pins.base.layers.map((_, index) =>
      readFileSync(join(directory, `python-layer-${index}.tar.gz`)),
    ),
    wheels: Object.fromEntries(
      pins.wheels.map((wheel) => [wheel.filename, readFileSync(join(directory, wheel.filename))]),
    ),
  };
}
