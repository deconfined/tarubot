/**
 * The simple pipeline validates the complete configuration before replacing secrets or stopping
 * the bot. Execute its actual validation program with invented values, without Podman or network,
 * and protect the ordering that keeps failed startup from losing the pre-migration recovery point.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync, YAML } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeployment } from "../../src/config/deployment.js";

// These child Bun processes also run under QEMU when CI builds the arm64 image.
setDefaultTimeout(120_000);

const root = join(import.meta.dir, "../..");
type Mapping = Record<string, unknown>;
interface Task extends Mapping {
  name: string;
  block?: readonly Task[];
  always?: readonly Task[];
}
interface Target {
  tarubot_settings: Record<string, string>;
  tarubot_secrets: string[];
  tarubot_backup_settings: string[];
  tarubot_database: { user: string; names: string[] };
}
interface Input {
  settings: Record<string, string>;
  secrets: Record<string, string>;
  botSecrets: string[];
  backupSecrets: string[];
  database: Target["tarubot_database"];
  multiline: string[];
  prepareOnly: boolean;
}
const readYaml = (path: string): unknown => YAML.parse(readFileSync(join(root, path), "utf8"));
const play = (
  readYaml("ops/ansible/deploy.yml") as readonly {
    vars: { tb_validate_script: string };
    tasks: readonly Task[];
  }[]
)[0];
if (!play) throw new Error("The deployment playbook is empty.");

/** Remap the image's two module paths to source; every validation instruction stays unchanged. */
const validation = play.vars.tb_validate_script
  .replace("/app/dist/src/config/deployment.js", join(root, "src/config/deployment.ts"))
  .replace("/app/dist/src/config/env.js", join(root, "src/config/env.ts"));

/** One environment with a fabricated token carrying only the release's expected application ID. */
function input(target: "staging" | "production"): Input {
  const vars = readYaml(`ops/ansible/vars/targets/${target}.yml`) as Target;
  const identity = resolveDeployment(vars.tarubot_settings);
  return {
    settings: { HEALTH_PORT: "3000", ENABLE_EFFECTS: "true", ...vars.tarubot_settings },
    secrets: {
      DATABASE_URL: `postgresql://${vars.tarubot_database.user}:invented-password@db.example.org:27520/${vars.tarubot_database.names[0]}`,
      DATABASE_CA_CERT: "invented-ca",
      DISCORD_TOKEN: `${Buffer.from(identity.applicationId ?? "").toString("base64url")}.invented.signature`,
      GITHUB_REPORTS_TOKEN: "invented-reports-token",
      GITHUB_APP_CLIENT_ID: "",
      GITHUB_APP_PRIVATE_KEY: "",
      HEALTHCHECKS_PING_URL: "https://checks.example.org/bot",
      BACKUP_STORAGE_ENDPOINT: "backups.example.org",
      BACKUP_STORAGE_REGION: "example-region",
      BACKUP_STORAGE_ACCESS_KEY: "invented-access-key",
      BACKUP_STORAGE_SECRET_KEY: "invented-secret-key",
      HEALTHCHECKS_BACKUP_URL: "https://checks.example.org/backup",
    },
    botSecrets: vars.tarubot_secrets,
    backupSecrets: vars.tarubot_backup_settings,
    database: vars.tarubot_database,
    multiline: ["DATABASE_CA_CERT", "GITHUB_APP_PRIVATE_KEY"],
    prepareOnly: false,
  };
}

/** Run the exact program with stdin, as the playbook runs it in its no-network container. */
function validate(payload: Input) {
  const result = spawnSync({
    cmd: [process.execPath, "-e", validation],
    cwd: root,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return { code: result.exitCode, stdout, stderr, result: JSON.parse(stdout) as Mapping };
}

/** Include always tasks, which must still report the boundary after a failed startup. */
const flatten = (tasks: readonly Task[]): Task[] =>
  tasks.flatMap((task) => [task, ...flatten(task.block ?? []), ...flatten(task.always ?? [])]);
const tasks = flatten(play.tasks);
const moduleArgs = (task: Task, name: string): Mapping => (task[name] ?? {}) as Mapping;

describe("pipeline settings validation", () => {
  test("both environments pass the release's configuration and database guards", () => {
    for (const target of ["staging", "production"] as const) {
      const payload = input(target);
      const run = validate(payload);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.result.botSecrets).toEqual(payload.botSecrets);
      expect(run.result.settings).toMatchObject({ TARUBOT_ENVIRONMENT: target });
      // Only settings and mount names come back; a secret never becomes a result or argument.
      for (const name of [...payload.botSecrets, ...payload.backupSecrets])
        expect(run.stdout).not.toContain(payload.secrets[name] ?? "missing-secret");
    }
  });

  test("preparing production needs only the database and backup settings", () => {
    const payload = input("production");
    payload.prepareOnly = true;
    for (const name of ["DISCORD_TOKEN", "GITHUB_REPORTS_TOKEN", "HEALTHCHECKS_PING_URL"])
      payload.secrets[name] = "";
    const run = validate(payload);
    expect(run.code).toBe(0);
    expect(run.result.botSecrets).toEqual(["DATABASE_CA_CERT", "DATABASE_URL"]);
    payload.secrets.DATABASE_URL =
      payload.secrets.DATABASE_URL?.replace(":27520/", ":27521/") ?? "";
    expect(validate(payload).result).toEqual({ error: "DATABASE_URL" });
  });

  test("pool ports and query identity overrides fail before the bot can be stopped", () => {
    for (const url of [
      "postgresql://tarubot_staging:invented-password@db.example.org:27521/tarubot_staging",
      "postgresql://tarubot_staging:invented-password@db.example.org:27520/tarubot_staging?user=other",
      "postgresql://other:invented-password@db.example.org:27520/tarubot_staging",
    ]) {
      const payload = input("staging");
      payload.secrets.DATABASE_URL = url;
      const run = validate(payload);
      expect(run.code).toBe(1);
      expect(run.result).toEqual({ error: "DATABASE_URL" });
      expect(`${run.stdout}${run.stderr}`).not.toContain("invented-password");
      expect(`${run.stdout}${run.stderr}`).not.toContain("db.example.org");
    }
  });

  test("missing settings and tokens from another application fail by setting name only", () => {
    for (const setting of ["DISCORD_TOKEN", "DATABASE_URL", "BACKUP_STORAGE_SECRET_KEY"]) {
      const payload = input("staging");
      payload.secrets[setting] = "";
      expect(validate(payload).result).toEqual({ error: setting });
    }
    const payload = input("staging");
    payload.secrets.DISCORD_TOKEN = `${Buffer.from("invented-application").toString("base64url")}.secret.signature`;
    const run = validate(payload);
    expect(run.code).toBe(1);
    expect(run.result).toEqual({ error: "DISCORD_TOKEN" });
    expect(run.stdout).not.toContain(payload.secrets.DISCORD_TOKEN);
  });

  test("production mounts the App key only when both App settings are configured", () => {
    const payload = input("production");
    payload.secrets.GITHUB_APP_CLIENT_ID = "invented-client-id";
    expect(validate(payload).result).toEqual({ error: "GITHUB_APP_PRIVATE_KEY" });
    payload.secrets.GITHUB_APP_PRIVATE_KEY = "invented-key\nwith-another-line";
    const run = validate(payload);
    expect(run.code).toBe(0);
    expect(run.result.botSecrets).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(run.stdout).not.toContain("invented-key");
    payload.secrets.GITHUB_APP_CLIENT_ID = "";
    expect(validate(payload).result).toEqual({ error: "GITHUB_APP_CLIENT_ID" });
  });

  test("stray whitespace and invalid backup URLs never print their values", () => {
    for (const [setting, value] of [
      ["DATABASE_URL", "secret URL\n"],
      ["HEALTHCHECKS_BACKUP_URL", "http://secret.example.org/backup"],
      ["BACKUP_STORAGE_ENDPOINT", "http://secret.example.org/bucket"],
    ]) {
      if (!setting || value === undefined) throw new Error("Missing test setting.");
      const payload = input("staging");
      payload.secrets[setting] = value;
      const run = validate(payload);
      expect(run.code).toBe(1);
      expect(run.result).toEqual({ error: setting });
      expect(`${run.stdout}${run.stderr}`).not.toContain(value.trim());
    }
  });
});

describe("deployment failure boundaries", () => {
  test("configuration and migration checks finish before secret replacement or shutdown", () => {
    const validationIndex = tasks.findIndex((task) =>
      task.name.startsWith("Refuse invalid settings"),
    );
    const migrationIndex = tasks.findIndex((task) => task.name.startsWith("Refuse rollback"));
    const writes = tasks.flatMap((task, index) => {
      const argv = moduleArgs(task, "ansible.builtin.command").argv;
      const systemd = moduleArgs(task, "ansible.builtin.systemd_service");
      return (Array.isArray(argv) && argv.includes("secret")) || systemd.state === "stopped"
        ? [index]
        : [];
    });
    expect(validationIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(validationIndex);
    expect(writes.length).toBeGreaterThan(0);
    for (const index of writes) expect(index).toBeGreaterThan(migrationIndex);
    const validationTask = tasks.find((task) => task.name.startsWith("Validate the complete"));
    expect(validationTask?.no_log).toBe(true);
    expect(moduleArgs(validationTask as Task, "ansible.builtin.command").argv).toContain(
      "--network=none",
    );
    expect(moduleArgs(validationTask as Task, "ansible.builtin.command").stdin).toBeString();
  });

  test("the recovery point is persisted before startup and reported even after failure", () => {
    const stopped = tasks.findIndex(
      (task) => moduleArgs(task, "ansible.builtin.systemd_service").state === "stopped",
    );
    const captured = tasks.findIndex((task) => task.name.startsWith("Capture the recovery"));
    const persisted = tasks.findIndex((task) =>
      String(moduleArgs(task, "ansible.builtin.copy").dest ?? "").endsWith("/recovery-point"),
    );
    const reported = tasks.findIndex((task) => task.name.startsWith("Report the point"));
    const start = tasks.findIndex((task) => task.name.startsWith("Reload and start"));
    expect(stopped).toBeGreaterThan(-1);
    expect(captured).toBeGreaterThan(stopped);
    expect(persisted).toBeGreaterThan(captured);
    expect(start).toBeGreaterThan(persisted);
    expect(reported).toBeGreaterThan(start);
    const deployment = play.tasks.find((task) => task.block !== undefined);
    expect(deployment?.always?.some((task) => task.name.startsWith("Report the point"))).toBe(true);
    expect(readFileSync(join(root, "ops/ansible/deploy.yml"), "utf8")).not.toContain(
      "InactiveEnterTimestamp",
    );
  });

  test("preparation cannot stop or start a bot or register commands", () => {
    for (const name of [
      "Stop the previous",
      "Reload and start",
      "Wait for readiness",
      "Register and verify",
    ])
      expect(tasks.find((task) => task.name.startsWith(name))?.when).toContain("not tb_prepare");
    const probe = tasks.find((task) => task.name.startsWith("Verify the database connection"));
    if (!probe) throw new Error("Missing preparation probe.");
    expect(probe?.when).toBe("tb_prepare");
    expect((probe.vars as Mapping).tb_probe).toContain("SELECT 1");
    expect((probe.vars as Mapping).tb_probe).not.toContain("migrate");
    expect(tasks.find((task) => task.name.startsWith("Prove one encrypted backup"))?.when).toBe(
      "tb_prepare",
    );
  });
});
