/** Run the deployed acceptance probe with real schema/secrets code and no network or database. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";
import type { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import { SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";

const root = (path: string) => new URL(`../../${path}`, import.meta.url);
// The same subprocess checks run under QEMU during the arm64 runtime-image build.
setDefaultTimeout(120_000);
const scratch = mkdtempSync(join(tmpdir(), "tarubot-acceptance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Validate only the play/task fields used here, while retaining nested runtime-user blocks. */
interface Task {
  name?: string | undefined;
  block?: Task[] | undefined;
  "ansible.builtin.command"?: { argv: string[] } | undefined;
}
const taskSchema: z.ZodType<Task> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    block: z.array(taskSchema).optional(),
    "ansible.builtin.command": z.object({ argv: z.array(z.string()) }).optional(),
  }),
);
const plays = z
  .array(z.object({ tasks: z.array(taskSchema) }))
  .parse(YAML.parse(readFileSync(root("ops/ansible/accept.yml"), "utf8")));
const tasks = (nested: Task[]): Task[] =>
  nested.flatMap((task) => [task, ...tasks(task.block ?? [])]);
const argv = (name: string) => {
  const task = tasks(plays.flatMap((play) => play.tasks)).find((task) => task.name === name);
  return z.array(z.string()).parse(task?.["ansible.builtin.command"]?.argv);
};
const probe = argv("Verify live readiness and the exact database schema without migration");
const databaseModule = root("src/infrastructure/postgres/database.ts").href;
const secretsModule = root("src/config/secrets.ts").href;
const checksum = createHash("sha256")
  .update(readFileSync(root(`migrations/${SCHEMA_VERSION}`)))
  .digest("hex");
const connection = "postgresql://probe:invented@example.org:5432/tarubot_test?sslmode=verify-full";
const ca = "invented-test-ca";
const connectionFile = join(scratch, "database-url");
const caFile = join(scratch, "database-ca");
writeFileSync(connectionFile, `${connection}\n`);
writeFileSync(caFile, `${ca}\n`);
const ready: Pick<
  ReturnType<ApplicationLifecycle["status"]>,
  "ready" | "database" | "discord" | "writerLease"
> = { ready: true, database: true, discord: true, writerLease: true };

/** Replace deployment paths only; Database.schema and secretSetting still run their real bodies. */
function runProbe(
  options: {
    status?: unknown;
    httpStatus?: number;
    requestedSchema?: string;
    appliedSchema?: string;
    appliedChecksum?: string;
    queryFailure?: boolean;
  } = {},
) {
  const trace = join(scratch, `trace-${crypto.randomUUID()}`);
  writeFileSync(trace, "");
  const script = probe[5]
    ?.replace("/app/dist/src/infrastructure/postgres/database.js", databaseModule)
    .replace("/app/dist/src/config/secrets.js", secretsModule);
  if (!script) throw new Error("Acceptance probe is missing.");
  const setup = `
    import { appendFileSync } from 'node:fs';
    import { Database as ProbeDatabase } from ${JSON.stringify(databaseModule)};
    const record = value => appendFileSync(${JSON.stringify(trace)}, value + '\\n');
    globalThis.fetch = async url => {
      if (String(url) !== 'http://localhost:3000/health/ready') throw new Error('unexpected-probe');
      record('ready');
      return Response.json(${JSON.stringify(options.status ?? ready)}, { status: ${options.httpStatus ?? 200} });
    };
    ProbeDatabase.prototype.query = async function(statement) {
      if (!statement.startsWith('SELECT version,checksum FROM schema_migrations')) throw new Error('unexpected-query');
      if (this.pool.options.connectionString !== ${JSON.stringify(connection.split("?")[0])}) throw new Error('file-url-not-loaded');
      if (this.pool.options.ssl.ca !== ${JSON.stringify(ca)} || this.pool.options.ssl.rejectUnauthorized !== true) throw new Error('file-ca-not-loaded');
      record('schema');
      if (${options.queryFailure ?? false}) throw new Error('invented-query-failure');
      return [{ version: ${JSON.stringify(options.appliedSchema ?? SCHEMA_VERSION)}, checksum: ${JSON.stringify(options.appliedChecksum ?? checksum)} }];
    };
    ProbeDatabase.prototype.close = async function() { record('close'); await this.pool.end(); };
    ProbeDatabase.prototype.migrate = async () => { throw new Error('migration-not-permitted'); };
  `;
  const result = Bun.spawnSync(
    [process.execPath, "-e", `${setup}\n${script}`, options.requestedSchema ?? SCHEMA_VERSION],
    {
      cwd: fileURLToPath(root("")),
      env: { DATABASE_URL_FILE: connectionFile, DATABASE_CA_CERT_FILE: caFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    trace: readFileSync(trace, "utf8").trim().split("\n"),
    stderr: result.stderr.toString(),
  };
}

describe("private target acceptance probe", () => {
  test("the Bun evaluation receives the schema argument and verifies mounted database settings", () => {
    expect(probe.slice(0, 5)).toEqual(["podman", "exec", "tarubot", "bun", "-e"]);
    expect(probe[6]).toBe("{{ tarubot_schema_head }}");
    const result = runProbe();
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.trace).toEqual(["ready", "schema", "close"]);
  });

  test.each(Object.keys(ready))("missing %s readiness refuses before any schema query", (field) => {
    const status: Record<string, unknown> = { ...ready };
    delete status[field];
    const result = runProbe({ status });
    expect(result.exitCode).not.toBe(0);
    expect(result.trace).toEqual(["ready"]);
  });

  test("HTTP failure and truthy readiness substitutes refuse acceptance", () => {
    for (const options of [{ httpStatus: 503 }, { status: { ...ready, writerLease: "true" } }]) {
      const result = runProbe(options);
      expect(result.exitCode).not.toBe(0);
      expect(result.trace).toEqual(["ready"]);
    }
  });

  test("a requested schema from another build refuses before opening the database", () => {
    const result = runProbe({ requestedSchema: "999_invented.sql" });
    expect(result.exitCode).not.toBe(0);
    expect(result.trace).toEqual(["ready"]);
  });

  test("live head/checksum/query failures close the read-only database probe", () => {
    for (const options of [
      { appliedSchema: "999_invented.sql" },
      { appliedChecksum: "0".repeat(64) },
      { queryFailure: true },
    ]) {
      const result = runProbe(options);
      expect(result.exitCode).not.toBe(0);
      expect(result.trace).toEqual(["ready", "schema", "close"]);
    }
  });

  test("command discovery explicitly selects the acceptance candidate", () => {
    expect(argv("Read back the command inventory")).toEqual([
      "{{ accept_home }}/.local/bin/tarubot-tool",
      "--image",
      "ghcr.io/deconfined/tarubot@{{ tarubot_digest }}",
      "commands.js",
      "list",
    ]);
  });

  test("fresh live readiness/schema evidence follows the interval and precedes completion", () => {
    const names = tasks(plays.flatMap((play) => play.tasks)).map((task) => task.name);
    const recheck = "Recheck live readiness and the exact schema after the stability interval";
    expect(argv(recheck)).toEqual(probe);
    const ordered = [
      "Observe a no-restart stability interval after the acceptance work",
      recheck,
      "Read the running container again",
      "Require the same healthy candidate after backup and the stability interval",
      "Mark completed target acceptance",
    ];
    const indexes = ordered.map((name) => names.indexOf(name));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual(indexes.toSorted((left, right) => left - right));
  });
});

const release = {
  version: "2.36.6",
  commit: "1".repeat(40),
  config_commit: "1".repeat(40),
  digest: `sha256:${"a".repeat(64)}`,
  publication_run: "1234",
  schema_head: SCHEMA_VERSION,
};
const acceptance = {
  schema: 1,
  target: "staging",
  outcome: "accepted",
  release,
  checks: {
    image: true,
    database: true,
    discord: true,
    writer_lease: true,
    schema: true,
    commands: true,
    timer: true,
    backup: true,
    stability: true,
  },
};

/** Start with an empty success-output file so failed parsing can never preserve an earlier result. */
function runEvidence(contents: string) {
  const directory = mkdtempSync(join(scratch, "evidence-"));
  const output = join(directory, "output");
  writeFileSync(join(directory, "acceptance.json"), contents);
  writeFileSync(output, "");
  const result = Bun.spawnSync(
    [process.execPath, fileURLToPath(root("scripts/release-acceptance.ts"))],
    {
      env: {
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        VERSION: release.version,
        COMMIT: release.commit,
        DIGEST: release.digest,
        PUBLICATION_RUN: release.publication_run,
        SCHEMA_HEAD: release.schema_head,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    output: readFileSync(output, "utf8"),
    diagnostics: result.stdout.toString() + result.stderr.toString(),
  };
}

describe("acceptance output admission", () => {
  test("only bound complete evidence emits reusable workflow success", () => {
    const result = runEvidence(JSON.stringify(acceptance));
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("accepted=true\n");
    expect(result.diagnostics).toBe("");
  });

  test("invalid, incomplete or different-release evidence stays private and emits no success", () => {
    const sentinel = "invented-private-evidence";
    for (const contents of [
      sentinel,
      JSON.stringify({ ...acceptance, outcome: sentinel }),
      JSON.stringify({ ...acceptance, checks: { ...acceptance.checks, backup: false } }),
      JSON.stringify({ ...acceptance, release: { ...release, publication_run: "4321" } }),
    ]) {
      const result = runEvidence(contents);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.diagnostics).toContain("promotion is blocked");
      expect(result.diagnostics).not.toContain(sentinel);
    }
  });
});
