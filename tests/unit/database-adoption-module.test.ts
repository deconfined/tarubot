/** Existing-cluster module boundaries and typed private-input agreement; no provider or state. */
import { describe, expect, test } from "bun:test";
import { readFileSync, readlinkSync } from "node:fs";
import { inputs } from "../../scripts/infra-policy.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const main = read("ops/tofu/main.tf");
const variables = read("ops/tofu/variables.tf");
/** Read an HCL block by balanced braces so nested lifecycle/type blocks cannot hide fields. */
function block(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error("missing-module-declaration");
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let i = opening; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(opening + 1, i);
  }
  throw new Error("incomplete-module-declaration");
}
const cluster = block(main, 'resource "linode_database_postgresql_v2" "cluster"');
const adoption = block(variables, 'variable "existing_databases"');
const example = JSON.parse(read("ops/tofu/examples/example.tfvars.json"));
const config = {
  label: "invented-database",
  engine_id: "postgresql/17",
  region: "us-east",
  type: "g6-standard-1",
  cluster_size: 3,
  suspended: false,
  expected_encrypted: true,
  expected_ssl_connection: true,
  updates: { day_of_week: 2, duration: 4, frequency: "weekly", hour_of_day: 22 },
  private_network: null,
  engine_config: {},
};

describe("existing-cluster adoption module", () => {
  test("native validation tests reuse the same declarations without provider or import graphs", () => {
    const fixture = "ops/tofu/tests/fixtures/database-adoption-validation";
    expect(readlinkSync(new URL(`../../${fixture}/variables.tf`, import.meta.url))).toBe(
      "../../../variables.tf",
    );
    const nativeTests = read("ops/tofu/tests/database-adoption.tftest.hcl");
    const runs = [...nativeTests.matchAll(/run "[^"]+"/gu)];
    expect(runs).toHaveLength(11);
    expect(
      nativeTests.match(/source = "\.\/tests\/fixtures\/database-adoption-validation"/gu),
    ).toHaveLength(runs.length);
    expect(read(`${fixture}/variables.tf`)).toBe(variables);
    expect(read(`${fixture}/outputs.tf`)).not.toMatch(
      /\b(resource|provider|import|backend)\s+["{]/u,
    );
  });
  test("existing inputs keep an empty sensitive adoption map with explicit recorded settings", () => {
    expect(example.existing_databases).toEqual({});
    expect(adoption).toMatch(/default\s*=\s*\{\}/u);
    expect(adoption).toMatch(/nullable\s*=\s*false/u);
    expect(adoption).toMatch(/sensitive\s*=\s*true/u);
    for (const key of [
      "label",
      "engine_id",
      "region",
      "type",
      "cluster_size",
      "suspended",
      "expected_encrypted",
      "expected_ssl_connection",
    ])
      expect(adoption).toMatch(new RegExp(`\\b${key}\\s*=\\s*(string|number|bool)\\b`, "u"));
    expect(adoption).toContain("contains(keys(var.database_ids), k)");
    expect(adoption).toContain("must refer to distinct clusters");
    expect(adoption).toContain("d.engine_config != null");
    expect(adoption).toContain('d.updates.frequency == "weekly"');
    expect(adoption).toContain("d.private_network == null ? true");
    for (const key of ["private_network", "updates", "engine_config"])
      expect(adoption).toMatch(new RegExp(`\\b${key}\\s*=\\s*object\\(`, "u"));
  });
  test("typed engine fields and normalization agree without assigning provider defaults", () => {
    const declared = [
      ...adoption.matchAll(/\b(engine_config_[a-z_]+)\s*=\s*optional\((number|string|bool)\)/gu),
    ];
    expect(declared).toHaveLength(47);
    const privateInputs = inputs({
      ...example,
      database_ids: { primary: "100" },
      existing_databases: { primary: config },
    });
    const records = privateInputs.existing_databases as Record<
      string,
      { engine_config: Record<string, unknown> }
    >;
    const primary = records.primary;
    if (!primary) throw new Error("missing-invented-database-record");
    expect(Object.keys(primary.engine_config).sort()).toEqual(
      declared
        .map((m) => {
          const key = m[1];
          if (!key) throw new Error("missing-declared-engine-key");
          return key;
        })
        .sort(),
    );
    expect(Object.values(primary.engine_config).every((v) => v === null)).toBe(true);
    for (const [_, key] of declared) {
      expect(cluster).toContain(`var.existing_databases[each.key].engine_config.${key}`);
      expect(adoption).not.toMatch(new RegExp(`\\b${key}\\s*=\\s*optional\\([^)]*,`, "u"));
    }
    expect(cluster.match(/engine_config_[a-z_]+\s*=/gu)).toHaveLength(47);
  });
  test("adoption imports existing IDs and keeps the original access-list resource as sole writer", () => {
    expect(cluster).toContain("for_each = nonsensitive(toset(keys(var.existing_databases)))");
    const imports = [...main.matchAll(/import\s*\{[^}]+\}/gu)].map((m) => m[0]);
    const importing = imports.find((value) =>
      value.includes("to = linode_database_postgresql_v2.cluster[each.key]"),
    );
    expect(importing).toContain("for_each = nonsensitive(toset(keys(var.existing_databases)))");
    expect(importing).toContain("id = nonsensitive(var.database_ids[each.key])");
    const acl = block(main, 'resource "linode_database_access_controls" "db"');
    expect(acl).toContain("for_each = local.database_keys");
    expect(acl).toContain("tonumber(nonsensitive(var.database_ids[each.key]))");
    expect(acl).toContain("concat(local.host_access, var.db_allow_extra)");
    expect(cluster).toMatch(/prevent_destroy\s*=\s*true/u);
    expect(cluster).toContain("ignore_changes = [allow_list]");
    expect(cluster).not.toMatch(/\ballow_list\s*=/u);
    expect(acl).not.toContain("linode_database_postgresql_v2");
  });
  test("computed security observations are checked while credentials and fork creation stay unconfigured", () => {
    expect(cluster).toContain(
      "self.encrypted == var.existing_databases[each.key].expected_encrypted",
    );
    expect(cluster).toContain(
      "self.ssl_connection == var.existing_databases[each.key].expected_ssl_connection",
    );
    for (const key of [
      "root_password",
      "root_username",
      "ca_cert",
      "encrypted",
      "ssl_connection",
      "fork_source",
      "fork_restore_time",
    ])
      expect(cluster).not.toMatch(new RegExp(`^\\s*${key}\\s*=`, "mu"));
    const outputs = read("ops/tofu/outputs.tf");
    expect(outputs).not.toContain("linode_database_postgresql_v2");
    expect(read("ops/tofu/README.md")).toContain("Any import-plus-update is refused");
    expect(read("ops/tofu/README.md")).toContain("operation=adopt");
  });
});
