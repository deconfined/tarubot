/** The single environment entry point and its saved-plan handoff, exercised without credentials
 * or infrastructure. The real wrapper runs against the same stand-in Tofu as the legacy tests. */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";

setDefaultTimeout(120_000);
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");
const expr = (name: string) => `\${{ ${name} }}`;
const step = z
  .object({
    name: z.string(),
    id: z.string().optional(),
    if: z.string().optional(),
    run: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const pipeline = z
  .object({
    on: z
      .object({ workflow_dispatch: z.object({ inputs: z.record(z.string(), z.unknown()) }) })
      .strict(),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({
      group: z.string(),
      "cancel-in-progress": z.boolean(),
      queue: z.string(),
    }),
    jobs: z
      .object({
        build: z.object({ uses: z.string(), if: z.string() }).passthrough(),
        deploy: z
          .object({
            needs: z.string(),
            if: z.string(),
            environment: z.string(),
            concurrency: z.object({
              group: z.string(),
              "cancel-in-progress": z.boolean(),
              queue: z.string(),
            }),
            steps: z.array(step),
          })
          .passthrough(),
      })
      .strict(),
  })
  .passthrough()
  .parse(YAML.parse(read(".github/workflows/pipeline.yml")));
const { build, deploy } = pipeline.jobs;
const named = (name: string) => {
  const found = deploy.steps.find((s) => s.name === name);
  if (!found) throw new Error(`Missing pipeline step ${name}`);
  return found;
};

describe("one build and deploy invocation", () => {
  test("dispatches only from main, with one selected environment gate and the reusable publisher", () => {
    expect(Object.keys(pipeline.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(pipeline.on.workflow_dispatch.inputs).sort()).toEqual([
      "environment",
      "prepare_only",
      "rebuild",
    ]);
    expect(build.uses).toBe("./.github/workflows/publish.yml");
    for (const job of [build, deploy]) {
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.if).toContain("github.run_attempt == '1'");
    }
    expect(deploy.needs).toBe("build");
    expect(deploy.environment).toBe(
      expr("inputs.environment == 'production' && 'production' || 'staging'"),
    );
    expect(pipeline.permissions).toEqual({});
    expect(pipeline.concurrency).toEqual({
      group: "infra",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(deploy.concurrency.group).toBe(`host-${expr("inputs.environment")}`);
  });

  test("uses the build's digest and source commit through provisioning, connection, configuration and deploy", () => {
    const verify = named("Verify the build digest");
    expect(verify.env?.DIGEST).toBe(expr("needs.build.outputs.digest"));
    expect(verify.run).toContain('--source-digest "$COMMIT"');
    expect(verify.run).toContain("/.github/workflows/publish.yml@refs/heads/main");
    const names = deploy.steps.map((s) => s.name);
    expect(names.indexOf("Verify the build digest")).toBeLessThan(
      names.indexOf("Provision the environment"),
    );
    expect(names.indexOf("Provision the environment")).toBeLessThan(
      names.indexOf("Establish the host connection"),
    );
    expect(names.indexOf("Establish the host connection")).toBeLessThan(
      names.indexOf("Configure AlmaLinux 10"),
    );
    expect(names.indexOf("Configure AlmaLinux 10")).toBeLessThan(
      names.indexOf("Deploy the bot with Podman"),
    );
    const bot = named("Deploy the bot with Podman");
    expect(bot.env?.DIGEST).toBe(expr("needs.build.outputs.digest"));
    expect(bot.env?.COMMIT).toBe(expr("github.sha"));
    expect(bot.env?.PREPARE_ONLY).toBe(expr("inputs.prepare_only"));
    expect(bot.run).toContain("deploy.yml");
    // The new path neither looks up mutable tags nor uploads private plans/state/inventory.
    const source = read(".github/workflows/pipeline.yml");
    expect(source).not.toMatch(
      /upload-artifact|download-artifact|TARGET_HOST_KEY|infra-plan|WRITE_TOKEN|READ_TOKEN/u,
    );
    const clean = named("Remove runner credentials and private files");
    expect(clean.if).toBe("always()");
    for (const path of ["pipeline-host", "tofu", "ansible"])
      expect(clean.run).toContain(`/${path}"`);
  });
});

/** Invented topology retains both hosts, so changes to the unselected host are observable. */
const values = JSON.parse(read("ops/tofu/examples/example.tfvars.json"));
values.hosts.production = {
  ...values.hosts.staging,
  role: "production",
  fqdn: "production.example.org",
};
values.configure_keys.production = values.configure_keys.staging;
const host = (target: string, actions: string[] = ["no-op"]) => ({
  address: `linode_instance.host["${target}"]`,
  mode: "managed",
  type: "linode_instance",
  name: "host",
  index: target,
  change: {
    actions,
    before: { ipv4: ["192.0.2.20"], ipv6: "2001:db8::20/128" },
    after: { ipv4: ["192.0.2.20"], ipv6: "2001:db8::20/128" },
    after_unknown: {},
  },
});
const database = (before: string[], after: string[]) => ({
  address: 'linode_database_access_controls.db["primary"]',
  mode: "managed",
  type: "linode_database_access_controls",
  name: "db",
  index: "primary",
  change: {
    actions: ["update"],
    before: { allow_list: before },
    after: { allow_list: after },
    after_unknown: {},
  },
});

/** Run the actual orchestration with fake provider commands; every file is disposable. */
function reconcile(changes: unknown[], options: { rebuild?: boolean; applyFails?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "tarubot-pipeline-test-"));
  try {
    writeFileSync(join(d, "plan.json"), JSON.stringify({ resource_changes: changes }));
    writeFileSync(
      join(d, "outputs.json"),
      JSON.stringify({
        host_connection: {
          sensitive: true,
          value: { staging: { instance_id: "123", address: "192.0.2.20" } },
        },
      }),
    );
    writeFileSync(join(d, "event.json"), JSON.stringify({ inputs: { environment: "staging" } }));
    for (const name of ["env", "output", "path", "summary"]) writeFileSync(join(d, name), "");
    if (options.applyFails) writeFileSync(join(d, "exit.apply"), "1");
    const result = Bun.spawnSync(["bash", root("ops/pipeline/infra.sh")], {
      env: {
        PATH: `${root("tests/fixtures/infra")}:${process.env.PATH}`,
        RUNNER_TEMP: d,
        STUB: d,
        GITHUB_EVENT_PATH: join(d, "event.json"),
        GITHUB_ENV: join(d, "env"),
        GITHUB_OUTPUT: join(d, "output"),
        GITHUB_PATH: join(d, "path"),
        GITHUB_STEP_SUMMARY: join(d, "summary"),
        TARGET: "staging",
        REBUILD: options.rebuild ? "true" : "false",
        TOFU_VARS: JSON.stringify(values),
        LINODE_TOKEN: "fixture-linode",
        CLOUDFLARE_API_TOKEN: "fixture-cloudflare",
        AWS_ACCESS_KEY_ID: "fixture-access",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        STATE_BUCKET: "example-state",
        STATE_ENDPOINT: "https://s3.example.org",
        TF_VAR_state_passphrase: "fixture-encryption-passphrase-32-characters",
      },
    });
    const calls = readdirSync(join(d, "calls"))
      .sort()
      .map((n) => readFileSync(join(d, "calls", n), "utf8"));
    return {
      exit: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls,
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe.skipIf(!Bun.which("jq"))("selected-environment infrastructure handoff", () => {
  test("applies the same saved plan even with no resource changes, then reads private connection outputs", () => {
    const result = reconcile([host("staging"), host("production")]);
    expect(result.exit).toBe(0);
    expect(result.calls.map((c) => c.split("\n")[1])).toEqual([
      "init",
      "plan",
      "show",
      "apply",
      "output",
    ]);
    expect(result.calls[3]).toMatch(/apply\n-input=false\n-json\n.*\/plan.bin\n$/u);
    expect(result.stdout).not.toContain("192.0.2.20");
    expect(result.stderr).toBe("");
  });

  test("rejects another environment's change before apply", () => {
    const result = reconcile([host("staging"), host("production", ["update"])]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("outside the selected environment");
    expect(result.calls.some((c) => c.includes("\napply\n"))).toBe(false);
  });

  test("rebuild replaces only the selected instance and automates the ensuing pin", () => {
    const result = reconcile([host("staging", ["delete", "create"]), host("production")], {
      rebuild: true,
    });
    expect(result.exit).toBe(0);
    expect(result.calls[1]).toContain('-replace=linode_instance.host["staging"]\n');
    expect(result.stdout).toContain("the pipeline will establish and retain its SSH host pin");
    expect(result.stdout).not.toContain("pin its host key from your own machine");
  });

  test("rejects accidental destruction and access-list removal on ordinary runs", () => {
    for (const changes of [
      [host("staging", ["delete"])],
      [host("staging"), database(["192.0.2.30/32"], [])],
    ]) {
      const result = reconcile(changes);
      expect(result.exit).toBe(1);
      expect(result.calls.some((c) => c.includes("\napply\n"))).toBe(false);
    }
  });

  test("a failed apply never hands a connection to Ansible", () => {
    const result = reconcile([host("staging")], { applyFails: true });
    expect(result.exit).toBe(1);
    expect(result.calls.some((c) => c.includes("\noutput\n"))).toBe(false);
  });
});
