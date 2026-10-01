/** Complete invented imports and interrupted completion; no provider credentials or remote state. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardDatabaseClusters,
  requireDatabaseAdoption,
  requirePlanInputs,
  verifyDatabaseAdoption,
} from "../../scripts/database-adoption.js";
import {
  InfrastructureRecords,
  RecordCodec,
  stateEvidence,
  type ControlStore,
} from "../../scripts/infra-control.js";
import { controlPhase } from "../../scripts/infra-control-cli.js";
import { handoffBinding, inputs } from "../../scripts/infra-policy.js";
import { releaseInputs, releasePlan } from "../fixtures/infra/release.js";

const config = {
  label: "example-database",
  engine_id: "postgresql/17",
  region: "us-east",
  type: "g6-standard-1",
  cluster_size: 1,
  suspended: false,
  expected_encrypted: true,
  expected_ssl_connection: true,
  updates: { day_of_week: 2, duration: 4, frequency: "weekly", hour_of_day: 22 },
  private_network: null,
  engine_config: {},
};
const expected = { ...releaseInputs, existing_databases: { primary: config } };
type Value = Record<string, unknown>;
type Fixture = ReturnType<typeof releasePlan>;
type Resource = Fixture["resource_changes"][number] & { change: { importing?: unknown } };
type Plan = Omit<Fixture, "variables" | "resource_changes"> & {
  variables: Record<string, { value: unknown }>;
  resource_changes: Resource[];
  resource_drift?: unknown[];
};
function resource(p: Plan, index: number): Resource {
  const r = p.resource_changes.at(index);
  if (!r) throw new Error("missing-invented-resource");
  return r;
}
function adopting(): Plan {
  const p: Plan = releasePlan();
  p.variables.existing_databases = { value: expected.existing_databases };
  const { expected_encrypted, expected_ssl_connection, engine_config: _, ...settings } = config;
  const values = {
    ...settings,
    id: "100",
    encrypted: expected_encrypted,
    ssl_connection: expected_ssl_connection,
    allow_list: releaseInputs.db_allow_extra,
    root_password: "invented-unchanged-value",
  };
  const cluster = {
    address: 'linode_database_postgresql_v2.cluster["primary"]',
    mode: "managed",
    type: "linode_database_postgresql_v2",
    name: "cluster",
    index: "primary",
    provider_name: "registry.opentofu.org/linode/linode",
    change: {
      actions: ["no-op"],
      before: structuredClone(values),
      after: structuredClone(values),
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
      importing: { id: "100" },
    },
  };
  p.resource_changes.push(cluster);
  const { change, ...r } = cluster;
  p.planned_values.root_module.resources.push({ ...r, values: change.after });
  return p;
}
function refreshed(p = adopting()): Plan {
  const next = structuredClone(p);
  for (const r of next.resource_changes) delete r.change.importing;
  return next;
}
function shown(p = adopting()) {
  return { format_version: "1.0", terraform_version: "1.12.6", values: p.planned_values };
}
function edit(p: Plan, index: number, patch: Value) {
  Object.assign(resource(p, index).change.after, patch);
  const planned = p.planned_values.root_module.resources[index];
  if (!planned) throw new Error("missing-invented-planned-resource");
  planned.values = structuredClone(resource(p, index).change.after);
}

describe("independent import-only cluster fence", () => {
  test("typed optional nulls compare exactly while unknown or mistyped settings are refused", () => {
    const typed = inputs(expected);
    const p = adopting();
    p.variables.existing_databases = { value: typed.existing_databases };
    expect(() => requirePlanInputs(p, expected)).not.toThrow();
    for (const engine_config of [
      { unexpected: null },
      { engine_config_pg_jit: "false" },
      { engine_config_pg_timezone: 0 },
      { engine_config_work_mem: "4" },
      null,
    ])
      expect(() =>
        inputs({ ...expected, existing_databases: { primary: { ...config, engine_config } } }),
      ).toThrow();
    for (const patch of [
      { extra_setting: null },
      { expected_encrypted: "true" },
      { cluster_size: undefined },
      { private_network: undefined },
    ])
      expect(() =>
        inputs({ ...expected, existing_databases: { primary: { ...config, ...patch } } }),
      ).toThrow();
    expect(() => inputs({ ...releaseInputs, existing_databases: null })).toThrow();
  });
  test("legacy inputs stay supported; adoption requires a separate reviewed map extension", () => {
    expect(() => guardDatabaseClusters(releasePlan(), releaseInputs)).not.toThrow();
    expect(() => requireDatabaseAdoption(adopting(), expected, releaseInputs)).not.toThrow();
    expect(() => guardDatabaseClusters(adopting(), expected)).toThrow();
    expect(() => guardDatabaseClusters(refreshed(), expected)).not.toThrow();
    expect(() => requireDatabaseAdoption(adopting(), expected, null)).toThrow();
    expect(() => requireDatabaseAdoption(adopting(), expected, expected)).toThrow();
    expect(() => requireDatabaseAdoption(releasePlan(), expected, releaseInputs)).toThrow();
  });
  test("every cluster action other than no-op is refused, regardless of owner override switches", () => {
    for (const actions of [
      ["create"],
      ["update"],
      ["delete"],
      ["forget"],
      ["delete", "create"],
      ["create", "delete"],
    ]) {
      const p = adopting();
      resource(p, -1).change.actions = actions;
      expect(() => guardDatabaseClusters(p, expected, true)).toThrow();
      expect(() => requireDatabaseAdoption(p, expected, releaseInputs)).toThrow();
    }
  });
  test("identity, expected security/settings and unknown values must agree independently", () => {
    for (const patch of [
      { id: "999" },
      { label: "other" },
      { engine_id: "postgresql/18" },
      { cluster_size: 3 },
      { region: "other" },
      { suspended: true },
      { encrypted: false },
      { ssl_connection: false },
      { updates: { ...config.updates, hour_of_day: 1 } },
      { private_network: {} },
      { unrecognized_control: true },
    ]) {
      const p = adopting();
      // Duplicated views alone cannot satisfy intent: both before and after are made equal.
      edit(p, p.resource_changes.length - 1, patch);
      resource(p, -1).change.before = structuredClone(resource(p, -1).change.after);
      expect(() => requireDatabaseAdoption(p, expected, releaseInputs)).toThrow();
    }
    const p = adopting();
    resource(p, -1).change.after_unknown = { root_password: true };
    expect(() => requireDatabaseAdoption(p, expected, releaseInputs)).toThrow();
  });
  test("imports cannot bundle host/ACL/output/drift or ignored input changes", () => {
    for (const kind of ["host", "acl", "output", "drift", "keys", "extras", "zone"]) {
      const p = adopting();
      const v = structuredClone(expected);
      if (kind === "host") {
        resource(p, 0).change.actions = ["update"];
        edit(p, 0, { label: "example-renamed" });
        v.hosts.staging.label = "example-renamed";
      }
      if (kind === "acl") {
        resource(p, 4).change.actions = ["update"];
        edit(p, 4, { allow_list: [...releaseInputs.db_allow_extra, "192.0.2.10/32"] });
      }
      if (kind === "output") Object.assign(p.output_changes.hosts ?? {}, { actions: ["update"] });
      if (kind === "drift") p.resource_drift = [{}];
      if (kind === "keys") v.root_keys = ["changed-invented-key"];
      if (kind === "extras") v.db_allow_extra = ["203.0.113.10/32"];
      if (kind === "zone") v.cloudflare_zone_id = "f".repeat(32);
      p.variables = Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value }]));
      expect(() => requireDatabaseAdoption(p, v, releaseInputs)).toThrow();
    }
  });
  test("only exact expected cluster and optional matching ACL imports are allowed", () => {
    const p = adopting();
    resource(p, 4).change.importing = { id: "100:postgresql" };
    expect(() => requireDatabaseAdoption(p, expected, releaseInputs)).not.toThrow();
    for (const importing of [
      { id: "999" },
      { id: "100", unknown: false },
      { identity: { id: "100" } },
    ]) {
      const bad = adopting();
      resource(bad, -1).change.importing = importing;
      expect(() => requireDatabaseAdoption(bad, expected, releaseInputs)).toThrow();
    }
    const bad = adopting();
    resource(bad, 0).change.importing = { id: "200" };
    expect(() => requireDatabaseAdoption(bad, expected, releaseInputs)).toThrow();
  });
  test("completion requires separate complete no-change and exact known applied values", () => {
    expect(() =>
      verifyDatabaseAdoption(adopting(), refreshed(), shown(), expected, releaseInputs),
    ).not.toThrow();
    for (const bad of [
      adopting(),
      { ...refreshed(), errored: true },
      { ...refreshed(), resource_drift: [{}] },
      { ...refreshed(), resource_changes: [] },
    ])
      expect(() =>
        verifyDatabaseAdoption(adopting(), bad, shown(), expected, releaseInputs),
      ).toThrow();
    const actual = shown();
    const cluster = actual.values.root_module.resources.at(-1);
    if (!cluster) throw new Error("missing-invented-cluster");
    cluster.values.id = "999";
    expect(() =>
      verifyDatabaseAdoption(adopting(), refreshed(), actual, expected, releaseInputs),
    ).toThrow();
    expect(() => requirePlanInputs(adopting(), expected)).not.toThrow();
    expect(() => requirePlanInputs(adopting(), releaseInputs)).toThrow();
  });
});

describe("private adoption journal completion", () => {
  const scratch = mkdtempSync(join(tmpdir(), "database-adoption-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  test("import begins from completed baseline and remains pending until no-change verification", async () => {
    const store: ControlStore & { data: Map<string, Uint8Array> } = {
      data: new Map(),
      async read(key) {
        return this.data.get(key) ?? null;
      },
      async write(key, bytes) {
        this.data.set(key, bytes);
      },
    };
    const passphrase = "invented adoption control passphrase with sufficient entropy";
    // The protected job supplies authority; the actual encrypted records retain import pending
    // until the separate read-only refresh verifies no remote database change.
    const journal = new InfrastructureRecords(store, new RecordCodec(passphrase, "a".repeat(64)));
    const raw = {
      version: 4,
      terraform_version: "1.12.6",
      lineage: "11111111-1111-4111-8111-111111111111",
      serial: 1,
      resources: [],
    };
    const state = stateEvidence(raw);
    const run = { commit: "1".repeat(40), run: "1234" };
    const initial = await journal.begin(
      await journal.inspect(state),
      releaseInputs,
      run,
      "b".repeat(64),
      "baseline",
    );
    await journal.finish(initial, state);
    const write = (name: string, value: unknown) =>
      writeFileSync(join(scratch, name), JSON.stringify(value));
    writeFileSync(join(scratch, "backend.hcl"), "invented private backend");
    writeFileSync(join(scratch, "plan.bin"), "invented encrypted import plan");
    write("event.json", { inputs: { operation: "adopt" } });
    write("values.tfvars.json", expected);
    write("state.json", raw);
    write("plan.json", adopting());
    const env = {
      CONTROL_RECORDS_ENABLED: "true",
      TF_VAR_state_passphrase: passphrase,
      GITHUB_SHA: run.commit,
      GITHUB_RUN_ID: run.run,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: join(scratch, "event.json"),
    };
    await controlPhase("read", scratch, env, journal);
    writeFileSync(join(scratch, "verified.binding"), handoffBinding(scratch, env));
    await controlPhase("begin", scratch, env, journal);
    const advanced = { ...raw, serial: 2 };
    write("state.json", advanced);
    write("applied-state.json", shown());
    await expect(controlPhase("finish", scratch, env, journal)).rejects.toThrow();
    await expect(journal.inspect(stateEvidence(advanced))).rejects.toThrow();
    write("adoption-no-change.json", refreshed());
    await controlPhase("finish", scratch, env, journal);
    expect((await journal.inspect(stateEvidence(advanced))).inputs).toEqual(expected);
    expect(readFileSync(join(scratch, "control-ticket.json"), "utf8")).not.toContain(config.label);
  });
});
