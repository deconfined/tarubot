/** Exercise the playbook's real assertions locally with invented records; no host or service runs. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { YAML } from "bun";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a playbook object.");
  return value as ObjectValue;
};

/** Copy just assertions from the target play: this fixture cannot copy a deploy or backup task. */
function assertions() {
  const source: unknown = YAML.parse(
    readFileSync(new URL("../../ops/ansible/accept.yml", import.meta.url), "utf8"),
  );
  if (!Array.isArray(source)) throw new Error("Expected acceptance plays.");
  const found = new Map<string, ObjectValue>();
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error("Expected playbook tasks.");
    for (const item of value) {
      const task = object(item);
      if (task["ansible.builtin.assert"] && typeof task.name === "string")
        found.set(task.name, {
          name: task.name,
          "ansible.builtin.assert": object(task["ansible.builtin.assert"]),
          no_log: true,
        });
      if (task.block) visit(task.block);
    }
  };
  for (const play of source) visit(object(play).tasks);
  return (name: string): ObjectValue => {
    const task = found.get(name);
    if (!task) throw new Error(`Missing acceptance assertion: ${name}`);
    return task;
  };
}

/** Expected refusals enter rescue, then the final assertion checks the actual accepted/refused result. */
function scenario(name: string, vars: ObjectValue, checks: ObjectValue[], accepted: boolean) {
  return {
    name: `Fixture ${name}`,
    vars,
    block: [
      ...checks.map((check) => ({ ...check, name: `${name}: ${check.name}` })),
      {
        name: "Record fixture acceptance",
        "ansible.builtin.set_fact": { fixture_accepted: true },
      },
    ],
    rescue: [
      {
        name: "Record fixture refusal",
        "ansible.builtin.set_fact": { fixture_accepted: false },
      },
    ],
    always: [
      {
        name: "Check the fixture outcome",
        "ansible.builtin.assert": {
          that: [`fixture_accepted == ${accepted ? "true" : "false"}`],
          quiet: true,
        },
      },
    ],
  };
}

const backup = (id: string, start: number, exit: number, edits: Record<string, string> = {}) => ({
  stdout_lines: Object.entries({
    ActiveState: "inactive",
    SubState: "dead",
    InvocationID: id,
    ExecMainStartTimestampMonotonic: `${start}`,
    ExecMainExitTimestampMonotonic: `${exit}`,
    ExecMainCode: "1",
    ExecMainStatus: "0",
    Result: "success",
    ...edits,
  }).map(([key, value]) => `${key}=${value}`),
});

/** Emit a builtin-only localhost playbook using the same conditions as real acceptance. */
export function acceptanceCheckFixtures() {
  const assertion = assertions();
  const baseline = backup("1".repeat(32), 100, 150);
  const completed = backup("2".repeat(32), 200, 300);
  const backupChecks = [
    assertion("Require a stopped backup and a readable invocation baseline"),
    assertion("Require a new successful completed backup invocation"),
  ];
  const backupCase = (
    name: string,
    result: typeof completed,
    accepted = false,
    before = baseline,
  ) =>
    scenario(
      name,
      { accept_backup_previous: before, accept_backup_completed: result },
      backupChecks,
      accepted,
    );
  const container = {
    Id: "a".repeat(64),
    Image: "b".repeat(64),
    RestartCount: 0,
    State: {
      Status: "running",
      Health: { Status: "healthy" },
      StartedAt: "2026-01-01T00:00:00.000000000Z",
    },
  };
  const stabilityChecks = [
    assertion("Require the candidate healthy and running"),
    assertion("Require the same healthy candidate after backup and the stability interval"),
  ];
  const stabilityCase = (name: string, result: ObjectValue, accepted = false, first = container) =>
    scenario(
      name,
      {
        accept_image: { stdout: JSON.stringify([{ Id: container.Image }]) },
        accept_first: { stdout: JSON.stringify([first]) },
        accept_last: { stdout: JSON.stringify([result]) },
      },
      stabilityChecks,
      accepted,
    );
  return [
    {
      name: "Check staging acceptance assertions against invented local evidence",
      hosts: "localhost",
      connection: "local",
      gather_facts: false,
      become: false,
      tasks: [
        backupCase("fresh successful encrypted backup", completed, true),
        backupCase("old successful backup no-op", baseline),
        backupCase("same invocation with changed timestamp", backup("1".repeat(32), 200, 300)),
        backupCase("new invocation with stale timestamp", backup("2".repeat(32), 100, 300)),
        backupCase(
          "still running backup",
          backup("2".repeat(32), 200, 300, { ActiveState: "activating" }),
        ),
        backupCase(
          "failed upload",
          backup("2".repeat(32), 200, 300, { Result: "exit-code", ExecMainStatus: "1" }),
        ),
        backupCase("signal termination", backup("2".repeat(32), 200, 300, { ExecMainCode: "2" })),
        backupCase("missing invocation", backup("", 200, 300)),
        backupCase("zero invocation", backup("0".repeat(32), 200, 300)),
        backupCase("unfinished execution", backup("2".repeat(32), 200, 0)),
        backupCase("exit before start", backup("2".repeat(32), 200, 199)),
        backupCase("missing execution start", {
          stdout_lines: completed.stdout_lines.filter(
            (line) => !line.startsWith("ExecMainStartTimestampMonotonic="),
          ),
        }),
        backupCase("duplicate invocation", {
          stdout_lines: [...completed.stdout_lines, `InvocationID=${"3".repeat(32)}`],
        }),
        backupCase(
          "backup races baseline",
          completed,
          false,
          backup("1".repeat(32), 100, 150, { ActiveState: "activating" }),
        ),
        stabilityCase("unchanged healthy process", container, true),
        stabilityCase("recreated container", { ...container, Id: "c".repeat(64) }),
        stabilityCase("same-ID manual restart", {
          ...container,
          State: { ...container.State, StartedAt: "2026-01-01T00:00:01.000000000Z" },
        }),
        stabilityCase("same-ID restart count changed", { ...container, RestartCount: 1 }),
        stabilityCase("unhealthy final process", {
          ...container,
          State: { ...container.State, Health: { Status: "unhealthy" } },
        }),
        stabilityCase("wrong final image", { ...container, Image: "d".repeat(64) }),
        stabilityCase("missing final process start", {
          ...container,
          State: { Status: "running", Health: { Status: "healthy" } },
        }),
      ],
    },
  ];
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3)
    throw new Error("Use: bun tests/fixtures/acceptance-checks.ts OUTPUT.yml");
  mkdirSync(dirname(destination), { recursive: true });
  // JSON is valid YAML and avoids serializer-generated anchors for shared assertion objects.
  // Bun's dotted module-key anchor names are not accepted by Ansible's YAML parser.
  writeFileSync(destination, JSON.stringify(acceptanceCheckFixtures(), null, 2));
}
