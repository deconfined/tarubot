/** Independent existing-cluster fence. These pure checks never contact a provider or read state. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { classifyPlan, inputs, requireClusterNoop } from "./infra-policy.js";
import { verifyAppliedPlan } from "./infra-control.js";

type Value = Record<string, unknown>;
function requireAdoption(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid-database-adoption-evidence");
}
function object(value: unknown): Value {
  requireAdoption(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function resources(plan: unknown): Value[] {
  const p = object(plan);
  requireAdoption(Array.isArray(p.resource_changes));
  return p.resource_changes.map(object);
}

/** Neither owner override switch permits a cluster mutation; import needs its separate operation. */
export function guardDatabaseClusters(plan: unknown, expected: unknown, importing = false): void {
  const v = inputs(expected);
  const configured = object(v.existing_databases);
  const found = new Set<string>();
  for (const r of resources(plan)) {
    if (
      r.type !== "linode_database_postgresql_v2" &&
      !(typeof r.address === "string" && r.address.startsWith("linode_database_postgresql_v2."))
    )
      continue;
    requireClusterNoop(r, v);
    requireAdoption(typeof r.index === "string" && !found.has(r.index));
    found.add(r.index);
    requireAdoption(importing || !object(r.change).importing);
  }
  requireAdoption(isDeepStrictEqual([...found].sort(), Object.keys(configured).sort()));
}

/** Adoption extends a completed baseline only with explicit current settings, never other intent. */
export function requireDatabaseAdoption(plan: unknown, expected: unknown, baseline: unknown): void {
  const v = inputs(expected);
  const previous = inputs(baseline);
  const { existing_databases: currentClusters, ...currentIntent } = v;
  const { existing_databases: previousClusters, ...previousIntent } = previous;
  requireAdoption(isDeepStrictEqual(currentIntent, previousIntent));
  const current = object(currentClusters);
  const prior = object(previousClusters);
  for (const [key, config] of Object.entries(prior))
    requireAdoption(isDeepStrictEqual(config, current[key]));
  const newKeys = Object.keys(current).filter((key) => !Object.hasOwn(prior, key));
  requireAdoption(newKeys.length > 0);
  guardDatabaseClusters(plan, v, true);
  // Using current intent as classifier baseline validates the full plan without treating this
  // deliberately reviewed map extension as an automatic intent change.
  const policy = classifyPlan(plan, v, v);
  requireAdoption(
    policy.decision === "review-required" && isDeepStrictEqual(policy.reasons, ["import"]),
  );
  const importedClusters = new Set<string>();
  for (const r of resources(plan)) {
    const change = object(r.change);
    requireAdoption(isDeepStrictEqual(change.actions, ["no-op"]));
    if (!change.importing) continue;
    requireAdoption(typeof r.index === "string" && newKeys.includes(r.index));
    const cluster = r.type === "linode_database_postgresql_v2";
    requireAdoption(cluster || r.type === "linode_database_access_controls");
    const importing = object(change.importing);
    requireAdoption(isDeepStrictEqual(Object.keys(importing), ["id"]));
    requireAdoption(
      importing.id === `${object(v.database_ids)[r.index]}${cluster ? "" : ":postgresql"}`,
    );
    if (cluster) importedClusters.add(r.index);
  }
  requireAdoption(isDeepStrictEqual([...importedClusters].sort(), newKeys.sort()));
}

/** Completion requires a separately refreshed, read-only no-change plan and exact applied state. */
export function verifyDatabaseAdoption(
  original: unknown,
  refreshed: unknown,
  shownState: unknown,
  expected: unknown,
  baseline: unknown,
): void {
  requireDatabaseAdoption(original, expected, baseline);
  guardDatabaseClusters(refreshed, expected);
  requireAdoption(classifyPlan(refreshed, expected, expected).decision === "no-changes");
  verifyAppliedPlan(original, shownState);
  verifyAppliedPlan(refreshed, shownState);
}

/** Shared private input comparison handles typed optional engine fields without losing intent. */
export function requirePlanInputs(plan: unknown, expected: unknown): void {
  const variables = object(object(plan).variables);
  const planned = Object.fromEntries(
    Object.entries(variables)
      .filter(([key]) => key !== "state_passphrase")
      .map(([key, entry]) => [key, object(entry).value]),
  );
  requireAdoption(isDeepStrictEqual(inputs(planned), inputs(expected)));
}

if (import.meta.main) {
  try {
    const [command, directory] = process.argv.slice(2);
    requireAdoption(process.argv.length === 4 && directory);
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
    const expected = read("values.tfvars.json");
    if (command === "validate") {
      inputs(expected);
    } else {
      const plan = read("plan.json");
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
      const adopting = event.inputs?.operation === "adopt";
      if (command === "inputs") requirePlanInputs(plan, expected);
      else if (command === "guard") {
        if (adopting) requireDatabaseAdoption(plan, expected, read("baseline-inputs.json"));
        else guardDatabaseClusters(plan, expected);
      } else {
        requireAdoption(command === "verify" && adopting);
        verifyDatabaseAdoption(
          plan,
          read("adoption-no-change.json"),
          read("applied-state.json"),
          expected,
          read("baseline-inputs.json"),
        );
      }
    }
  } catch {
    console.log(
      "::error::Existing-cluster adoption evidence is invalid; cluster mutations are never permitted.",
    );
    process.exitCode = 1;
  }
}
