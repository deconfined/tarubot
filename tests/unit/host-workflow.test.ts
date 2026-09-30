/**
 * The reusable "Host" workflow (.github/workflows/host.yml): Deploy's one host job since 2.37.0
 * (REQUIREMENTS.md "Approved unified-pipeline amendments (2026-09-29)"; staging's since 2.36.0,
 * issue #62). deploy.yml calls it three ways: Infrastructure (`prod`, OpenTofu and pins only),
 * Staging and Prod. tests/unit/deploy-workflow.test.ts pins the calls; this file pins the job.
 *
 * - Shape: the eleven inputs and twelve outputs, one job in the caller's environment, first attempts
 *   from main only, one concurrency group per environment that queues every waiting run and never
 *   cancels, least permissions, every ${{ }} through env:, no tracing and no verbose or diffing
 *   ansible-playbook, the pinned checkouts and artifact download, the steps in order with their
 *   conditions (OpenTofu only with tofu, the apply only with apply, connect before Configure), and
 *   each secret in the one step that needs it: the infrastructure write tokens only in the apply
 *   step, the state write key only where OpenTofu runs or where connect picks it by environment,
 *   no TOFU_VARS anywhere, and the bot's 11 secrets plus /suggest's client ID in the Bot step.
 * - Behavior: the step scripts run here with simulated docker and ansible-playbook
 *   (tests/fixtures/host-workflow), host.sh's own stand-ins for the pin store, ssh-keyscan, ssh and
 *   ip (tests/fixtures/host-pin, used read-only), the real host.sh, jq and ssh-keygen: the request
 *   check, the connection and its masks (before anything else prints), the no-host rule (a merge
 *   on staging green, prod and dispatches red), the pin key chosen by environment, a prod job that
 *   pins a new host and then connects to it, the Infrastructure call, the release commit taken
 *   from the image, Configure and the Bot step for each action, the summary and its outputs (the
 *   rollback named after unhealthy and restart-failed), OpenTofu's files removed right after the
 *   pin step (both playbooks run without them), and the cleanup. The public-log rules come first: masks before any other output, no address, ID,
 *   host key or fingerprint outside a mask, no secret in any argument, and only plain characters
 *   in the log and the outputs.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");
const STUBS = root("tests/fixtures/host-workflow");
/** host.sh's own stand-ins (tests/unit/host-pin.test.ts), copied read-only into each box. */
const PIN_STUBS = root("tests/fixtures/host-pin");
const hasJq = Bun.which("jq") !== null;
/** host.sh reads keys with OpenSSH's ssh-keygen, as a runner has it. */
const canConnect = hasJq && Bun.which("ssh-keygen") !== null;

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

const step = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    if: z.string().optional(),
    uses: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    run: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    "working-directory": z.string().optional(),
  })
  .strict();
const input = z
  .object({
    description: z.string(),
    type: z.enum(["string", "boolean"]),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.boolean()]).optional(),
  })
  .strict();
const output = z.object({ description: z.string(), value: z.string() }).strict();
const workflow = z
  .object({
    name: z.literal("Host"),
    on: z
      .object({
        workflow_call: z
          .object({
            inputs: z.record(z.string(), input),
            outputs: z.record(z.string(), output),
          })
          .strict(),
      })
      .strict(),
    permissions: z.record(z.string(), z.string()),
    jobs: z
      .object({
        host: z
          .object({
            name: z.string(),
            if: z.string(),
            "runs-on": z.string(),
            "timeout-minutes": z.number(),
            environment: z.string(),
            concurrency: z
              .object({
                group: z.string(),
                "cancel-in-progress": z.boolean(),
                queue: z.literal("max"),
              })
              .strict(),
            permissions: z.record(z.string(), z.string()),
            defaults: z.object({ run: z.object({ shell: z.literal("bash") }).strict() }).strict(),
            env: z.record(z.string(), z.string()),
            outputs: z.record(z.string(), z.string()),
            steps: z.array(step),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const text = read(".github/workflows/host.yml");
const host = workflow.parse(YAML.parse(text));
const { steps } = host.jobs.host;
/** One step, by its id or name. */
const stepOf = (key: string) => {
  const found = steps.find((s) => s.id === key || s.name === key);
  if (!found) throw new Error(`no step ${key}`);
  return found;
};
/** One step's script. */
const runOf = (key: string) => {
  const found = stepOf(key).run;
  if (!found) throw new Error(`no script in ${key}`);
  return found;
};
/** The secret names a value refers to, sorted. */
const secretsIn = (value: unknown) =>
  [
    ...new Set([...JSON.stringify(value).matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1] ?? "")),
  ].sort();

/** The bot's variables (vars/bot.yml tb_secret_env and tb_setting_env), set in the Bot step only. */
const BOT_SETTINGS = [
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_REGION",
  "BACKUP_STORAGE_SECRET_KEY",
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_BACKUP_URL",
  "HEALTHCHECKS_PING_URL",
];
/**
 * The environment secret behind each of those variables. GitHub refuses a secret name that starts
 * with GITHUB_, so the three GITHUB_ variables read secrets of other names (vars/bot.yml
 * tb_secret_source and tb_setting_source); every other variable reads the secret of its own name.
 */
const SECRET_OF: Record<string, string> = {
  GITHUB_APP_CLIENT_ID: "SUGGEST_APP_CLIENT_ID",
  GITHUB_APP_PRIVATE_KEY: "SUGGEST_APP_PRIVATE_KEY",
  GITHUB_REPORTS_TOKEN: "REPORTS_GITHUB_TOKEN",
};
const secretOf = (name: string) => SECRET_OF[name] ?? name;
/** The steps in the job's order, by name, with their ids. */
const ORDER: [string, string | undefined][] = [
  ["Check the request", "request"],
  ["Check out main's host configuration", "config"],
  ["Install the pinned OpenTofu", "tofu-install"],
  ["Write the backend settings", "backend"],
  ["Initialize OpenTofu", "init"],
  ["Fetch the saved plan", "fetch"],
  ["Adopt the saved plan", "adopt"],
  ["Apply the saved plan", "apply"],
  ["Read the host connections", "output"],
  ["Pin the listed host keys", "pin"],
  ["Remove OpenTofu's files", undefined],
  ["Connect to the host", "connect"],
  ["Find the release's commit in its image", "release"],
  ["Check out the release", "release-checkout"],
  ["Install Ansible", "ansible"],
  ["Configure the host", "configure"],
  ["Deploy the bot", "bot"],
  ["Summary", "summary"],
  ["Remove the keys and OpenTofu's files", undefined],
];
/** ci.yml's pinned actions/checkout, which both checkouts must use. */
const CHECKOUT = /uses: (actions\/checkout@[0-9a-f]{40} # v[\d.]+)/u.exec(
  read(".github/workflows/ci.yml"),
)?.[1];
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";

describe("the workflow's shape", () => {
  test("is reusable only, with its eleven inputs and twelve outputs", () => {
    expect(Object.keys(host.on)).toEqual(["workflow_call"]);
    const inputs = host.on.workflow_call.inputs;
    expect(Object.keys(inputs)).toEqual([
      "environment",
      "action",
      "version",
      "commit",
      "digest",
      "config_commit",
      "tofu",
      "apply",
      "plan_digest",
      "plan_changes",
      "pins",
    ]);
    for (const name of ["environment", "action", "config_commit"])
      expect({ name, required: inputs[name]?.required, type: inputs[name]?.type }).toEqual({
        name,
        required: true,
        type: "string",
      });
    for (const name of ["version", "commit", "digest", "plan_digest", "plan_changes", "pins"])
      expect({ name, default: inputs[name]?.default, type: inputs[name]?.type }).toEqual({
        name,
        default: "",
        type: "string",
      });
    for (const name of ["tofu", "apply"])
      expect({ name, default: inputs[name]?.default, type: inputs[name]?.type }).toEqual({
        name,
        default: false,
        type: "boolean",
      });
    const names = [
      "outcome",
      "action",
      "version",
      "previous",
      "restore_point",
      "migrations",
      "schema_head",
      "step",
      "reason",
      "warnings",
      "pinned",
      "infrastructure",
    ];
    // Each workflow output is the job's, and each job output the summary step's.
    expect(
      Object.fromEntries(
        Object.entries(host.on.workflow_call.outputs).map(([k, v]) => [k, v.value]),
      ),
    ).toEqual(Object.fromEntries(names.map((n) => [n, `\${{ jobs.host.outputs.${n} }}`])));
    expect(host.jobs.host.outputs).toEqual(
      Object.fromEntries(names.map((n) => [n, `\${{ steps.summary.outputs.${n} }}`])),
    );
    // bot.yml's migrations are the target image's files the live image lacks, so a first start
    // lists every file even on a database already at the head: the output never claims they were
    // applied.
    const migrations = host.on.workflow_call.outputs.migrations?.description ?? "";
    expect(migrations).toContain("every one on a first start");
    expect(migrations).not.toMatch(/release applied/u);
    // Nothing untrusted can start it: no pull request trigger of any kind, and no trigger of its
    // own but the call.
    expect(text).not.toMatch(/pull_request/u);
  });

  test("one job in the caller's environment, first attempts from main only, one group per environment", () => {
    const job = host.jobs.host;
    expect(job.if).toBe("github.run_attempt == '1' && github.ref == 'refs/heads/main'");
    expect(job.environment).toBe(`\${{ inputs.environment }}`);
    // The Infrastructure and Prod calls share host-prod, so no two applies or pin writes overlap on
    // the unlocked state. A newer run waits, and queue: max keeps every waiting run: GitHub's
    // default keeps one and cancels it for the next, which could drop a rollback.
    expect(job.concurrency).toEqual({
      group: `host-\${{ inputs.environment }}`,
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(90);
    expect(job.env).toEqual({ TF_IN_AUTOMATION: "1", TF_INPUT: "0" });
  });

  test("holds least permissions: nothing at the top, contents: read for the job", () => {
    expect(host.permissions).toEqual({});
    expect(host.jobs.host.permissions).toEqual({ contents: "read" });
    expect(text).toMatch(/^ {6}contents: read # \S/mu);
    expect(text).not.toMatch(/docker\s+login|--password-stdin|packages:|actions: read/u);
  });

  test("no expression inside a script, no tracing, and no verbose or diffing ansible-playbook", () => {
    for (const s of steps) {
      const run = s.run ?? "";
      expect({ step: s.name, expression: run.includes("${{") }).toEqual({
        step: s.name,
        expression: false,
      });
      expect(run).not.toMatch(/set -[a-zA-Z]*x|\bset -o xtrace/u);
      // Each ansible-playbook call, continuation lines joined.
      for (const call of run.replace(/\\\n\s*/gu, " ").match(/ansible-playbook [^\n]*/gu) ?? [])
        expect({ call, loud: /\s(-v+|--verbose|--diff|-D|--check|-C)(\s|$)/u.test(call) }).toEqual({
          call,
          loud: false,
        });
    }
    // Nor through the environment.
    expect(text).not.toMatch(/ANSIBLE_(VERBOSITY|DIFF_ALWAYS|DEBUG|DISPLAY_ARGS_TO_STDOUT)/u);
  });

  test("runs the steps in order: OpenTofu only with tofu, the apply only with apply, connect before Configure", () => {
    expect(steps.map((s) => [s.name, s.id])).toEqual(ORDER);
    const connected = "steps.connect.outputs.skip == 'false'";
    expect(Object.fromEntries(steps.map((s) => [s.name, s.if ?? ""]))).toEqual({
      "Check the request": "",
      "Check out main's host configuration": "",
      "Install the pinned OpenTofu": "inputs.tofu",
      "Write the backend settings": "inputs.tofu",
      "Initialize OpenTofu": "inputs.tofu",
      "Fetch the saved plan": "inputs.tofu",
      "Adopt the saved plan": "inputs.tofu",
      "Apply the saved plan": "inputs.apply",
      "Read the host connections": "inputs.tofu",
      "Pin the listed host keys": "inputs.tofu",
      "Remove OpenTofu's files": "inputs.tofu",
      // Every call but Infrastructure's reaches a host.
      "Connect to the host": "inputs.action != 'infra'",
      "Find the release's commit in its image": `${connected} && inputs.action != 'configure'`,
      "Check out the release": `${connected} && inputs.action != 'configure'`,
      "Install Ansible": connected,
      "Configure the host": `${connected} && inputs.action != 'bot'`,
      "Deploy the bot": `${connected} && inputs.action != 'configure'`,
      Summary: "always()",
      "Remove the keys and OpenTofu's files": "always()",
    });
    // Each OpenTofu step runs one phase of tofu-ci.sh (or host.sh pin), from main's checkout.
    expect(
      steps
        .filter((s) => /^(tofu-install|backend|init|adopt|apply|output|pin)$/u.test(s.id ?? ""))
        .map((s) => s.run),
    ).toEqual([
      "bash config/ops/tofu/ci/tofu-ci.sh install",
      "bash config/ops/tofu/ci/tofu-ci.sh backend",
      "bash config/ops/tofu/ci/tofu-ci.sh init",
      "bash config/ops/tofu/ci/tofu-ci.sh adopt",
      "bash config/ops/tofu/ci/tofu-ci.sh apply",
      "bash config/ops/tofu/ci/tofu-ci.sh output",
      "bash config/ops/tofu/ci/host.sh pin",
    ]);
    expect(runOf("connect")).toContain(
      'bash config/ops/tofu/ci/host.sh connect "$ENVIRONMENT" || rc=$?',
    );
    // adopt compares with what the Infrastructure plan job showed, and pin writes only its list.
    expect(stepOf("adopt").env).toMatchObject({
      DIGEST: `\${{ inputs.plan_digest }}`,
      APPROVED: `\${{ inputs.plan_changes }}`,
      HAS_CHANGES: `\${{ inputs.apply }}`,
    });
    expect(stepOf("pin").env?.PINS).toBe(`\${{ inputs.pins }}`);
    // Nothing plans here: no values phase, no plan phase, and no TOFU_VARS (the comments may say so).
    const code = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/tofu-ci\.sh (values|plan|summarize|prepare|compare)\b|TOFU_VARS/u);
  });

  test("checks out main's head and the release at the commit its image names, and fetches the saved plan", () => {
    expect(CHECKOUT).toBeDefined();
    const pinned = CHECKOUT?.split(" #")[0];
    const config = stepOf("Check out main's host configuration");
    const release = stepOf("Check out the release");
    for (const s of [config, release]) expect(s.uses).toBe(pinned);
    // Each with its version comment, as ci.yml pins it.
    expect(text.split(`uses: ${CHECKOUT}\n`).length - 1).toBe(2);
    expect(config.with).toEqual({
      ref: `\${{ inputs.config_commit }}`,
      path: "config",
      "persist-credentials": false,
      "fetch-depth": 1,
    });
    // The release's ref is the revision label the image carries, never event data.
    expect(release.with).toEqual({
      ref: `\${{ steps.release.outputs.ref }}`,
      path: "release",
      "persist-credentials": false,
      "fetch-depth": 1,
    });
    // The Infrastructure plan job's artifact, by name, into OpenTofu's private directory.
    const fetch = stepOf("fetch");
    expect(fetch.uses).toBe(DOWNLOAD.split(" #")[0]);
    expect(text).toContain(`uses: ${DOWNLOAD}\n`);
    expect(fetch.with).toEqual({ name: "saved-plan", path: `\${{ runner.temp }}/tofu` });
    // Every action is pinned to a full SHA, and there are exactly these three.
    expect(steps.filter((s) => s.uses).map((s) => s.uses)).toEqual([
      pinned,
      DOWNLOAD.split(" #")[0],
      pinned,
    ]);
    // Ansible comes from main's hash-pinned requirements, into a private virtual environment.
    expect(runOf("Install Ansible")).toContain(
      "--no-deps --require-hashes -r config/ops/ansible/requirements.txt",
    );
  });

  test("names each secret in the one step that needs it", () => {
    const WRITE_KEY = ["TOFU_STATE_WRITE_ACCESS_KEY", "TOFU_STATE_WRITE_SECRET_KEY"];
    const BUCKET = ["TOFU_STATE_BUCKET", "TOFU_STATE_ENDPOINT"];
    const expected: Record<string, string[]> = {
      backend: BUCKET,
      init: [...WRITE_KEY, "TOFU_STATE_PASSPHRASE"],
      adopt: ["TOFU_STATE_PASSPHRASE"],
      apply: [
        ...WRITE_KEY,
        "TOFU_STATE_PASSPHRASE",
        "LINODE_WRITE_TOKEN",
        "CLOUDFLARE_WRITE_TOKEN",
      ],
      output: [...WRITE_KEY, "TOFU_STATE_PASSPHRASE"],
      pin: [...BUCKET, ...WRITE_KEY],
      connect: [
        ...BUCKET,
        ...WRITE_KEY,
        "TOFU_STATE_READ_ACCESS_KEY",
        "TOFU_STATE_READ_SECRET_KEY",
        "ANSIBLE_SSH_KEY",
      ],
      bot: BOT_SETTINGS.map(secretOf),
    };
    for (const s of steps)
      expect({ step: s.name, secrets: secretsIn(s) }).toEqual({
        step: s.name,
        secrets: [...(expected[s.id ?? ""] ?? [])].sort(),
      });
    // The infrastructure write tokens only where the apply runs, and nowhere else in the job.
    expect(stepOf("apply").if).toBe("inputs.apply");
    // The state write key only where OpenTofu runs, or where connect picks it for prod alone: a
    // repository secret of the write key's name could never reach staging.
    for (const s of steps.filter((x) =>
      secretsIn(x).some((n) => n.startsWith("TOFU_STATE_WRITE_")),
    ))
      expect({
        step: s.id,
        gated: ["inputs.tofu", "inputs.apply"].includes(s.if ?? "") || s.id === "connect",
      }).toEqual({
        step: s.id,
        gated: true,
      });
    expect(stepOf("connect").env).toMatchObject({
      AWS_ACCESS_KEY_ID: `\${{ inputs.environment == 'prod' && secrets.TOFU_STATE_WRITE_ACCESS_KEY || secrets.TOFU_STATE_READ_ACCESS_KEY }}`,
      AWS_SECRET_ACCESS_KEY: `\${{ inputs.environment == 'prod' && secrets.TOFU_STATE_WRITE_SECRET_KEY || secrets.TOFU_STATE_READ_SECRET_KEY }}`,
      ANSIBLE_SSH_KEY: `\${{ secrets.ANSIBLE_SSH_KEY }}`,
    });
    // Each bot variable straight from its environment secret: its own name, or SECRET_OF's for
    // the three GitHub won't take.
    const bot = stepOf("Deploy the bot").env ?? {};
    for (const name of BOT_SETTINGS)
      expect({ name, value: bot[name] }).toEqual({
        name,
        value: `\${{ secrets.${secretOf(name)} }}`,
      });
    expect(Object.keys(bot).sort()).toEqual(
      [
        ...BOT_SETTINGS,
        "ACTION",
        "ANSIBLE_CONFIG",
        "COMMIT",
        "DIGEST",
        "ENVIRONMENT",
        "LC_ALL",
        "VERSION",
      ].sort(),
    );
    // Configure's environment holds no secret at all, and main's ansible.cfg serves both steps.
    const configure = stepOf("Configure the host").env ?? {};
    expect(Object.keys(configure).sort()).toEqual([
      "ACTION",
      "ANSIBLE_CONFIG",
      "ENVIRONMENT",
      "LC_ALL",
    ]);
    for (const env of [configure, bot])
      expect(env.ANSIBLE_CONFIG).toBe(`\${{ github.workspace }}/config/ops/ansible/ansible.cfg`);
    expect(stepOf("Configure the host")["working-directory"]).toBe("config/ops/ansible");
    expect(stepOf("Deploy the bot")["working-directory"]).toBe("release/ops/ansible");
    // No host settings as secrets any more: the pin store replaced them.
    expect(text).not.toMatch(/TARGET_HOST|getent/u);
  });

  test("removes the keys and OpenTofu's files even when the job fails or is cancelled", () => {
    expect(steps.at(-1)).toEqual({
      name: "Remove the keys and OpenTofu's files",
      if: "always()",
      run: `rm -rf -- "\${RUNNER_TEMP:?}/ssh" "\${RUNNER_TEMP:?}/tofu" "\${RUNNER_TEMP:?}/pin"`,
    });
  });

  test("names no host beyond GHCR, and no address", () => {
    const hosts = [
      ...text.matchAll(
        /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9_]))/gimu,
      ),
    ].map((m) => (m[1] ?? "").toLowerCase());
    // jobs.host is the job's own name in its outputs, not a host.
    expect([...new Set(hosts)].filter((name) => name !== "jobs.host")).toEqual(["ghcr.io"]);
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
    expect(text).not.toMatch(/\b[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f:]*\b/iu);
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, run with simulated docker and ansible-playbook and host.sh's own stand-ins
// ---------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "host-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let boxes = 0;

/** A runner: stubs on PATH, RUNNER_TEMP, a workspace with main's host.sh, and the step files. */
function box() {
  const dir = join(scratch, `b${++boxes}`);
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  const workspace = join(dir, "work");
  for (const path of [
    bin,
    temp,
    join(dir, "images"),
    join(workspace, "config/ops/tofu/ci"),
    join(workspace, "config/ops/ansible"),
    join(workspace, "release/ops/ansible"),
  ])
    mkdirSync(path, { recursive: true });
  for (const [from, names] of [
    [STUBS, readdirSync(STUBS)],
    [PIN_STUBS, ["curl", "ssh-keyscan", "ssh", "ip"]],
  ] as const)
    for (const name of names) {
      cpSync(join(from, name), join(bin, name));
      chmodSync(join(bin, name), 0o755);
    }
  // No waiting: each pause is only recorded.
  writeFileSync(join(bin, "sleep"), '#!/bin/sh\necho "sleep $1" >> "$STUB/events"\n');
  chmodSync(join(bin, "sleep"), 0o755);
  cpSync(root("ops/tofu/ci/host.sh"), join(workspace, "config/ops/tofu/ci/host.sh"));
  for (const name of ["output", "summary", "path"]) writeFileSync(join(dir, name), "");
  return { dir, bin, temp, workspace };
}
type Box = ReturnType<typeof box>;

/** What a run knows: the inputs, the environment's secrets, the event and the job's status. */
interface Context {
  readonly inputs: Record<string, string | boolean>;
  readonly secrets: Record<string, string>;
  readonly event: string;
  readonly status?: string;
}
/** A step's result as later expressions read it: steps.<id>.outcome and .outputs. */
interface StepResult {
  readonly outcome: string;
  readonly outputs: Record<string, string>;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CONFIG = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const PLAN_DIGEST = "cd".repeat(32);
// Documentation addresses and invented IDs, bucket and credentials only.
const V4 = "192.0.2.10";
const V6 = "2001:db8:10::1";
const INSTANCE = "40000001";
const BUCKET = "example-state";
const ENDPOINT = "storage.example.org";
const RW = { id: "test-rw-access", secret: "test-rw-secret" };
const RO = { id: "test-ro-access", secret: "test-ro-secret" };

interface Key {
  pub: string;
  b64: string;
  fingerprint: string;
  private: string;
}
/** An ed25519 key pair made by the real ssh-keygen: its public line, fingerprint and private key. */
function keypair(name: string, passphrase = ""): Key {
  const dir = join(scratch, "keys");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const made = Bun.spawnSync(
    ["ssh-keygen", "-q", "-t", "ed25519", "-N", passphrase, "-C", "", "-f", path],
    { stdin: "ignore" },
  );
  if (made.exitCode !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
  const pub = readFileSync(`${path}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const fp = Bun.spawnSync(["ssh-keygen", "-E", "sha256", "-lf", `${path}.pub`], {
    stdin: "ignore",
  });
  const fingerprint =
    fp.stdout
      .toString()
      .split(" ")[1]
      ?.replace(/^SHA256:/u, "") ?? "";
  return {
    pub,
    b64: pub.split(" ")[1] ?? "",
    fingerprint,
    private: readFileSync(path, "utf8").trimEnd(),
  };
}
let HOST_KEY: Key;
let OTHER_KEY: Key;
let CONFIGURE_KEY: Key;
beforeAll(() => {
  if (!canConnect) return;
  HOST_KEY = keypair("host");
  OTHER_KEY = keypair("other");
  CONFIGURE_KEY = keypair("configure");
});

/** A stored pin, exactly as host.sh writes it. */
const pinOf = (key: Key, id = INSTANCE) =>
  JSON.stringify({ host_key: key.pub, instance_id: id, ipv4: V4, ipv6: V6 });
/** Puts a pin into the stand-in bucket. */
function store(where: Box, key: string, pin: string) {
  mkdirSync(join(where.dir, "store", "tarubot", "pins"), { recursive: true });
  writeFileSync(join(where.dir, "store", "tarubot", "pins", `${key}.json`), pin);
}

/**
 * Every bot secret, by its environment secret's name, set to a marker value named after the
 * variable it feeds, which the tests look for in the step's environment, arguments and logs.
 */
const botSecrets = (overrides: Record<string, string> = {}) => ({
  ...Object.fromEntries(
    BOT_SETTINGS.map((name) => [secretOf(name), `marker-${name.toLowerCase()}`]),
  ),
  ...overrides,
});
const context = (
  inputs: Partial<Record<string, string | boolean>> = {},
  secrets: Record<string, string> = {},
  event = "workflow_run",
): Context => ({
  inputs: {
    environment: "staging",
    action: "deploy",
    version: "2.37.1",
    commit: COMMIT,
    digest: DIGEST,
    config_commit: CONFIG,
    tofu: false,
    apply: false,
    plan_digest: "",
    plan_changes: "",
    pins: "",
    ...inputs,
  } as Record<string, string | boolean>,
  secrets: {
    TOFU_STATE_BUCKET: BUCKET,
    TOFU_STATE_ENDPOINT: `https://${ENDPOINT}`,
    TOFU_STATE_READ_ACCESS_KEY: RO.id,
    TOFU_STATE_READ_SECRET_KEY: RO.secret,
    TOFU_STATE_WRITE_ACCESS_KEY: RW.id,
    TOFU_STATE_WRITE_SECRET_KEY: RW.secret,
    TOFU_STATE_PASSPHRASE: "a-throwaway-passphrase-for-tests-only",
    ANSIBLE_SSH_KEY: canConnect ? CONFIGURE_KEY.private : "",
    ...botSecrets(),
    ...secrets,
  },
  event,
});

/**
 * A step's env with its expressions replaced as GitHub would: context paths (an unset secret is
 * empty, a boolean input is "true" or "false") and connect's one choice by environment.
 */
function resolveEnv(
  env: Record<string, string>,
  where: Box,
  c: Context,
  results: Record<string, StepResult>,
) {
  const lookup = (path: string): string => {
    const choice =
      /^inputs\.environment == 'prod' && secrets\.([A-Z_]+) \|\| secrets\.([A-Z_]+)$/u.exec(path);
    if (choice)
      return c.secrets[(c.inputs.environment === "prod" ? choice[1] : choice[2]) ?? ""] ?? "";
    const [scope, name, field, key] = path.split(".");
    if (scope === "inputs" && name && name in c.inputs) return String(c.inputs[name]);
    if (scope === "secrets" && name) return c.secrets[name] ?? "";
    if (scope === "steps" && name) {
      const r = results[name];
      if (field === "outcome") return r?.outcome ?? "";
      if (field === "outputs" && key) return r?.outputs[key] ?? "";
    }
    if (path === "github.event_name") return c.event;
    if (path === "github.workspace") return where.workspace;
    if (path === "job.status") return c.status ?? "success";
    throw new Error(`no context for ${path}`);
  };
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      v.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/gu, (_, path: string) => lookup(path.trim())),
    ]),
  );
}

/** The stand-ins' settings: the bucket, its users, the host's key and routes. */
const stubEnv = (where: Box, extra: Record<string, string> = {}) => ({
  STUB_HOST: `${BUCKET}.${ENDPOINT}`,
  STUB_RW_USER: `${RW.id}:${RW.secret}`,
  STUB_RO_USER: `${RO.id}:${RO.secret}`,
  FAKE_HOSTKEY: canConnect ? HOST_KEY.pub : "",
  FAKE_KEYSCAN_4: canConnect ? HOST_KEY.pub : "",
  FAKE_KEYSCAN_6: canConnect ? HOST_KEY.pub : "",
  STUB: where.dir,
  ...extra,
});

/** Run one step's script as GitHub's `shell: bash` does, in its working directory. */
function runStep(
  name: string,
  where: Box,
  c: Context,
  results: Record<string, StepResult> = {},
  fakes: Record<string, string> = {},
) {
  const s = stepOf(name);
  writeFileSync(join(where.dir, "output"), "");
  const env = resolveEnv(s.env ?? {}, where, c, results);
  const result = Bun.spawnSync(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", s.run ?? ""],
    {
      cwd: s["working-directory"] ? join(where.workspace, s["working-directory"]) : where.workspace,
      env: {
        PATH: `${where.bin}:/usr/bin:/bin`,
        HOME: where.dir,
        RUNNER_TEMP: where.temp,
        GITHUB_WORKSPACE: where.workspace,
        GITHUB_OUTPUT: join(where.dir, "output"),
        GITHUB_STEP_SUMMARY: join(where.dir, "summary"),
        GITHUB_PATH: join(where.dir, "path"),
        ...stubEnv(where, fakes),
        ...env,
      },
      stdin: "ignore",
    },
  );
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(join(where.dir, "output"), "utf8").split("\n"))
    if (line.includes("="))
      outputs[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
    env,
  };
}

/** The recorded ansible-playbook calls: argv, working directory and environment. */
function ansibleCalls(where: Box) {
  const dir = join(where.dir, "ansible");
  if (!existsSync(dir)) return [];
  const count = readdirSync(dir).filter((f) => f.endsWith(".argv")).length;
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const env = Object.fromEntries(
      readFileSync(join(dir, `${n}.env`), "utf8")
        .split("\0")
        .filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
    );
    return {
      argv: readFileSync(join(dir, `${n}.argv`), "utf8")
        .trimEnd()
        .split("\n"),
      cwd: readFileSync(join(dir, `${n}.cwd`), "utf8").trim(),
      tofu: readFileSync(join(dir, `${n}.tofu`), "utf8").trim(),
      env,
    };
  });
}

/** OpenTofu's steps, which run tofu-ci.sh: simulated here (infra.test.ts runs the phases). */
const SIMULATED = new Set([
  "config",
  "tofu-install",
  "backend",
  "init",
  "fetch",
  "adopt",
  "apply",
  "output",
  "release-checkout",
  "ansible",
]);

/**
 * Run the job's steps in order, as GitHub would for these `if:` conditions (the shape test pins
 * them). The checkouts, the install and OpenTofu's phases are simulated as succeeding (or failing
 * at `fail`); host.sh pin runs for real against the adopted plan.json and outputs.json `tofu`
 * writes. A failure skips every later step but the two `always()` ones.
 */
function job(
  where: Box,
  c: Context,
  options: {
    bot?: { result?: unknown; exit?: number };
    fail?: string | undefined;
    tofu?: { plan: unknown; outputs: unknown };
    fakes?: Record<string, string>;
  } = {},
) {
  const { bot } = options;
  if (bot?.result !== undefined)
    writeFileSync(
      join(where.dir, "bot-result"),
      typeof bot.result === "string" ? bot.result : JSON.stringify(bot.result),
    );
  if (bot?.exit !== undefined) writeFileSync(join(where.dir, "exit.bot.yml"), String(bot.exit));
  if (options.tofu) {
    mkdirSync(join(where.temp, "tofu"), { recursive: true });
    writeFileSync(join(where.temp, "tofu", "plan.json"), JSON.stringify(options.tofu.plan));
    writeFileSync(join(where.temp, "tofu", "outputs.json"), JSON.stringify(options.tofu.outputs));
  }
  const { action, tofu, apply } = c.inputs;
  const results: Record<string, StepResult> = {};
  const ran: string[] = [];
  let failed = false;
  const log: string[] = [];
  const outputs: Record<string, Record<string, string>> = {};
  const wanted = (id: string, condition: string | undefined): boolean => {
    const connected = results.connect?.outputs.skip === "false";
    switch (condition ?? "") {
      case "":
        return true;
      case "always()":
        return true;
      case "inputs.tofu":
        return tofu === true;
      case "inputs.apply":
        return apply === true;
      case "inputs.action != 'infra'":
        return action !== "infra";
      case "steps.connect.outputs.skip == 'false'":
        return connected;
      case "steps.connect.outputs.skip == 'false' && inputs.action != 'configure'":
        return connected && action !== "configure";
      case "steps.connect.outputs.skip == 'false' && inputs.action != 'bot'":
        return connected && action !== "bot";
      default:
        throw new Error(`no simulation for ${id}'s condition ${condition}`);
    }
  };
  for (const [name, id] of ORDER) {
    const s = stepOf(name);
    const always = s.if === "always()";
    const key = id ?? name;
    if ((failed && !always) || !wanted(key, s.if)) {
      results[key] = { outcome: "skipped", outputs: {} };
      continue;
    }
    if (SIMULATED.has(key)) {
      const outcome = options.fail === key ? "failure" : "success";
      results[key] = { outcome, outputs: {} };
      ran.push(name);
      if (outcome === "failure") failed = true;
      continue;
    }
    const r = runStep(
      name,
      where,
      { ...c, status: failed ? "failure" : "success" },
      results,
      options.fakes,
    );
    results[key] = { outcome: r.code === 0 ? "success" : "failure", outputs: r.outputs };
    outputs[key] = r.outputs;
    ran.push(name);
    log.push(r.stdout, r.stderr);
    if (r.code !== 0) failed = true;
  }
  return {
    ran,
    failed,
    results,
    outputs,
    log: log.join(""),
    calls: ansibleCalls(where),
    result: existsSync(join(where.temp, "result.json"))
      ? JSON.parse(readFileSync(join(where.temp, "result.json"), "utf8"))
      : undefined,
    summary: readFileSync(join(where.dir, "summary"), "utf8"),
  };
}

/** A box whose stand-in bucket holds `environment`'s pin and whose registry knows the release. */
function pinned(environment = "staging", key?: Key) {
  const where = box();
  if (canConnect) store(where, environment, pinOf(key ?? HOST_KEY));
  writeFileSync(join(where.dir, "images", DIGEST), COMMIT);
  return where;
}

/** Output without its mask commands: what the log shows. */
const unmasked = (output: string) =>
  output
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");

/** The result bot.yml's last play writes for a finished deploy. */
const deployed = {
  outcome: "deployed",
  action: "deploy",
  version: "2.37.1",
  previous: "2.37.0",
  restore_point: "2026-09-30T19:30:05.123456Z",
  migrations: ["011_example.sql"],
  schema_head: "011_example.sql",
  step: "-",
  reason: "-",
  warnings: [],
};

describe("the request check", () => {
  const check = (inputs: Partial<Record<string, string | boolean>>) =>
    runStep("Check the request", box(), context(inputs));
  const prodTofu = { environment: "prod", tofu: true, plan_digest: PLAN_DIGEST } as const;

  test("takes each environment's actions, and OpenTofu only in prod", () => {
    const bare = { version: "", commit: "", digest: "" };
    const accepted: Partial<Record<string, string | boolean>>[] = [
      ...["deploy", "bot", "preflight"].flatMap((action) => [
        { action },
        { environment: "prod", action },
        { ...prodTofu, action },
        { ...prodTofu, action, apply: true, pins: "prod" },
      ]),
      { action: "configure", ...bare },
      { environment: "prod", action: "configure", ...bare },
      // A prod request whose plan has nothing to apply or pin: its digest comes along, unused.
      { environment: "prod", plan_digest: PLAN_DIGEST, plan_changes: "" },
      { ...prodTofu, action: "configure", ...bare, apply: true },
      // The Infrastructure call: no release, OpenTofu, any keys the plan listed.
      { ...prodTofu, action: "infra", ...bare },
      { ...prodTofu, action: "infra", ...bare, apply: true, pins: "staging prod prod-2" },
    ];
    for (const inputs of accepted)
      expect({ inputs, code: check(inputs).code }).toEqual({ inputs, code: 0 });
  });

  test("refuses anything that doesn't fit its pattern, and OpenTofu anywhere but prod", () => {
    const refused: Partial<Record<string, string | boolean>>[] = [
      { environment: "production" },
      { environment: "" },
      { environment: "staging " },
      { environment: "Prod" },
      { action: "rollback" },
      { action: "deploy; id" },
      // OpenTofu, an apply and action=infra belong to prod alone.
      { tofu: true, plan_digest: PLAN_DIGEST },
      { apply: true },
      { action: "infra", tofu: true, plan_digest: PLAN_DIGEST },
      // An apply or action=infra needs the saved plan.
      { environment: "prod", apply: true },
      { environment: "prod", action: "infra", version: "", commit: "", digest: "" },
      // With the plan: its digest, and host keys only.
      { ...prodTofu, plan_digest: "" },
      { ...prodTofu, plan_digest: PLAN_DIGEST.toUpperCase() },
      { ...prodTofu, plan_digest: `${PLAN_DIGEST}0` },
      { ...prodTofu, pins: "production" },
      { ...prodTofu, pins: "prod;id" },
      { ...prodTofu, pins: "prod-100" },
      { ...prodTofu, pins: "../prod" },
      // Keys belong to a job with OpenTofu.
      { environment: "prod", pins: "prod" },
      { tofu: "yes" },
      { version: "2.37" },
      { version: "02.37.0" },
      { version: "2.37.0\n" },
      { commit: COMMIT.toUpperCase() },
      { commit: COMMIT.slice(1) },
      { digest: DIGEST.replace("sha256:", "") },
      { digest: `${DIGEST} x` },
      { config_commit: "main" },
      { config_commit: "" },
      { action: "bot", version: "" },
      { action: "configure", config_commit: CONFIG.slice(2) },
    ];
    for (const inputs of refused) {
      const r = check(inputs);
      expect({ inputs, code: r.code, error: r.stdout.startsWith("::error::") }).toEqual({
        inputs,
        code: 1,
        error: true,
      });
    }
    expect(check({ apply: true }).stdout).toContain(
      "::error::OpenTofu runs only in prod, which @deconfined approves: staging never applies or pins.",
    );
  });
});

describe.skipIf(!canConnect)("the connection", () => {
  const connect = (
    where: Box,
    inputs: Partial<Record<string, string | boolean>> = {},
    event = "workflow_run",
    secrets: Record<string, string> = {},
    fakes: Record<string, string> = {},
  ) => runStep("Connect to the host", where, context(inputs, secrets, event), {}, fakes);
  const secretsOf = (c: Context) => Object.values(c.secrets).filter((v) => v.length > 3);

  test("masks the pin's addresses, ID and key before anything else prints, and writes the inventory", () => {
    const where = pinned();
    const r = connect(where);
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ skip: "false" });
    const lines = (r.stdout + r.stderr).trimEnd().split("\n");
    const first = lines.findIndex((line) => !line.startsWith("::add-mask::"));
    // Every mask comes first, and every masked value is one of the pin's.
    expect(lines.slice(first).some((line) => line.startsWith("::add-mask::"))).toBe(false);
    expect(
      lines
        .slice(0, first)
        .map((line) => line.slice(12))
        .sort(),
    ).toEqual([INSTANCE, V4, V6, HOST_KEY.b64, HOST_KEY.fingerprint].sort());
    const shown = unmasked(r.stdout + r.stderr);
    for (const value of [INSTANCE, V4, V6, HOST_KEY.b64, HOST_KEY.fingerprint, BUCKET, ENDPOINT])
      expect({ value, shown: shown.includes(value) }).toEqual({ value, shown: false });
    expect(shown).not.toContain("PRIVATE KEY");
    const ssh = join(where.temp, "ssh");
    const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
    expect(mode(ssh)).toBe("700");
    for (const file of ["key", "known_hosts", "inventory.json"])
      expect({ file, mode: mode(join(ssh, file)) }).toEqual({ file, mode: "600" });
    expect(readFileSync(join(ssh, "known_hosts"), "utf8")).toBe(`target ${HOST_KEY.pub}\n`);
    const inventory = JSON.parse(readFileSync(join(ssh, "inventory.json"), "utf8"));
    expect(inventory.all.hosts.target).toMatchObject({
      ansible_host: V4,
      ansible_user: "root",
      ansible_ssh_private_key_file: join(ssh, "key"),
    });
    // No credential reached a stand-in's arguments or environment.
    const argv = readFileSync(join(where.dir, "argv"), "utf8");
    for (const value of secretsOf(context())) expect(argv.includes(value)).toBe(false);
    expect(existsSync(join(where.dir, "leaked-env"))).toBe(false);
  });

  test("reads staging's pin with the read-only key and prod's with the read/write key", () => {
    for (const [environment, user] of [
      ["staging", `${RO.id}:${RO.secret}`],
      ["prod", `${RW.id}:${RW.secret}`],
    ] as const) {
      const where = pinned(environment);
      // A staging environment that also saw a write key (a repository secret, say) never uses it.
      const r = connect(where, { environment }, "workflow_run");
      expect({ environment, code: r.code }).toEqual({ environment, code: 0 });
      expect(readFileSync(join(where.dir, "curl-config.1"), "utf8")).toContain(`user = "${user}"`);
    }
    const staging = runStep("Connect to the host", pinned(), context());
    expect(staging.env.AWS_ACCESS_KEY_ID).toBe(RO.id);
    const prod = runStep("Connect to the host", pinned("prod"), context({ environment: "prod" }));
    expect(prod.env.AWS_ACCESS_KEY_ID).toBe(RW.id);
  });

  test("without a pin, a merge on staging ends green with a notice; prod and every dispatch fail", () => {
    for (const noStore of [false, true]) {
      const secrets = noStore ? { TOFU_STATE_BUCKET: "" } : {};
      const merge = connect(box(), {}, "workflow_run", secrets);
      expect({ noStore, code: merge.code, outputs: merge.outputs }).toEqual({
        noStore,
        code: 0,
        outputs: { skip: "true" },
      });
      expect(merge.stdout).toContain(
        "::notice::no pinned host in the staging environment yet: the first approved run that builds it pins its key",
      );
      for (const [inputs, event] of [
        [{ environment: "prod" }, "workflow_run"],
        [{ environment: "prod" }, "workflow_dispatch"],
        [{}, "workflow_dispatch"],
      ] as const) {
        const r = connect(box(), inputs, event, secrets);
        expect({ noStore, inputs, event, code: r.code, outputs: r.outputs }).toEqual({
          noStore,
          inputs,
          event,
          code: 1,
          outputs: { reason: "no-host" },
        });
        expect(r.stdout).toContain("::error::no pinned host for");
      }
    }
    // The whole job: green with the no-host result, and nothing after the connection runs.
    const where = box();
    const run = job(where, context());
    expect(run.ran).toEqual([
      "Check the request",
      "Check out main's host configuration",
      "Connect to the host",
      "Summary",
      "Remove the keys and OpenTofu's files",
    ]);
    expect(run.failed).toBe(false);
    expect(run.calls).toEqual([]);
    expect(run.result).toMatchObject({ outcome: "no-host", action: "deploy" });
    expect(run.summary).toContain("## staging: no-host");
    expect(run.outputs.summary).toMatchObject({ outcome: "no-host", step: "-" });
  });

  test("a host key other than the pin stops at once, with its reason and no fingerprint", () => {
    const where = pinned("prod", OTHER_KEY);
    const r = connect(
      where,
      { environment: "prod" },
      "workflow_dispatch",
      {},
      { FAKE_ROUTE_6: "1" },
    );
    expect(r.code).toBe(1);
    expect(r.outputs).toEqual({ reason: "host-key" });
    // IPv6 was tried first, and the mismatch never fell back to IPv4.
    const ssh = readFileSync(join(where.dir, "events"), "utf8")
      .split("\n")
      .filter((e) => e.startsWith("ssh "));
    expect(ssh).toEqual(["ssh 6"]);
    const shown = unmasked(r.stdout + r.stderr);
    for (const value of [
      HOST_KEY.b64,
      HOST_KEY.fingerprint,
      OTHER_KEY.b64,
      OTHER_KEY.fingerprint,
      V6,
    ])
      expect({ value, shown: shown.includes(value) }).toEqual({ value, shown: false });
    expect(existsSync(join(where.temp, "ssh", "key"))).toBe(false);
    // The job fails at the connection, and the summary names it.
    const run = job(pinned("prod", OTHER_KEY), context({ environment: "prod" }), {
      fakes: { FAKE_ROUTE_6: "1" },
    });
    expect(run.failed).toBe(true);
    expect(run.calls).toEqual([]);
    expect(run.outputs.summary).toMatchObject({
      outcome: "failed",
      step: "connect",
      reason: "host-key",
    });
  });
});

describe.skipIf(!canConnect)("OpenTofu's part: Infrastructure and Prod", () => {
  /** plan.json for one host the plan creates, and OpenTofu's outputs once it exists. */
  const created = (key: string) => ({
    plan: {
      format_version: "1.2",
      prior_state: { values: { root_module: { resources: [] } } },
      resource_changes: [
        {
          address: `linode_instance.host["${key}"]`,
          mode: "managed",
          type: "linode_instance",
          name: "host",
          index: key,
          change: { actions: ["create"], before: null },
        },
      ],
    },
    outputs: {
      host_connection: {
        sensitive: true,
        value: { [key]: { instance_id: INSTANCE, ipv4: V4, ipv6: V6 } },
      },
    },
  });
  const prod = (inputs: Partial<Record<string, string | boolean>> = {}) =>
    context(
      { environment: "prod", tofu: true, plan_digest: PLAN_DIGEST, ...inputs },
      {},
      "workflow_dispatch",
    );

  test("a prod job pins its new host's key, then connects to it with that key alone", () => {
    const where = box();
    writeFileSync(join(where.dir, "images", DIGEST), COMMIT);
    const run = job(where, prod({ apply: true, pins: "prod" }), {
      bot: { result: deployed },
      tofu: created("prod"),
    });
    expect(run.failed).toBe(false);
    expect(run.ran).toEqual(ORDER.map(([name]) => name));
    // The pin is stored once, before the first login.
    const events = readFileSync(join(where.dir, "events"), "utf8").trim().split("\n");
    const put = events.indexOf("curl PUT tarubot/pins/prod.json");
    expect(put).toBeGreaterThan(-1);
    expect(events.filter((e) => e.startsWith("curl PUT"))).toHaveLength(1);
    expect(put).toBeLessThan(events.findIndex((e) => e.startsWith("ssh ")));
    expect(readFileSync(join(where.dir, "store/tarubot/pins/prod.json"), "utf8")).toBe(
      pinOf(HOST_KEY),
    );
    // Then Configure and the bot, for prod, with OpenTofu's files (the saved plan's JSON, which
    // holds the passphrase and every TOFU_VARS value) already gone.
    expect(run.calls.map((c) => c.argv.slice(2, 5))).toEqual([
      ["site.yml", "-e", "tarubot_role=prod"],
      ["bot.yml", "-e", "tarubot_target=prod"],
    ]);
    expect(run.calls.map((c) => c.tofu)).toEqual(["absent", "absent"]);
    expect(run.outputs.summary).toMatchObject({
      outcome: "deployed",
      pinned: "prod",
      infrastructure: "applied",
    });
    expect(run.summary).toContain("## Infrastructure: applied");
    expect(run.summary).toContain("## prod: deployed");
    // No address, ID or key in the log but in a mask.
    const shown = unmasked(run.log);
    for (const value of [INSTANCE, V4, V6, HOST_KEY.b64, HOST_KEY.fingerprint])
      expect({ value, shown: shown.includes(value) }).toEqual({ value, shown: false });
  });

  test("the Infrastructure call applies and pins, reaches no host, and reports its own outcome", () => {
    const bare = { action: "infra", version: "", commit: "", digest: "" };
    const cases: [
      Partial<Record<string, string | boolean>>,
      string | undefined,
      Record<string, string>,
    ][] = [
      [
        { ...bare, apply: true, pins: "staging" },
        undefined,
        { outcome: "applied", pinned: "staging", step: "-" },
      ],
      [
        { ...bare, pins: "staging" },
        undefined,
        { outcome: "pinned", pinned: "staging", step: "-" },
      ],
      [{ ...bare, apply: true }, undefined, { outcome: "applied", pinned: "", step: "-" }],
      [
        { ...bare, apply: true, pins: "staging" },
        "adopt",
        { outcome: "failed", pinned: "", step: "adopt" },
      ],
      [
        { ...bare, apply: true, pins: "staging" },
        "apply",
        { outcome: "failed", pinned: "", step: "apply" },
      ],
    ];
    for (const [inputs, fail, expected] of cases) {
      const where = box();
      const run = job(where, prod(inputs), { tofu: created("staging"), fail });
      expect({ inputs, fail, failed: run.failed, outputs: run.outputs.summary }).toEqual({
        inputs,
        fail,
        failed: fail !== undefined,
        outputs: {
          action: "infra",
          version: "-",
          previous: "-",
          restore_point: "-",
          migrations: "",
          schema_head: "-",
          reason: "-",
          warnings: "",
          infrastructure: expected.outcome ?? "",
          ...expected,
        },
      });
      // Never a connection, Configure or the bot.
      expect(run.ran).not.toContain("Connect to the host");
      expect(run.calls).toEqual([]);
      expect(run.summary).toContain(`## Infrastructure: ${expected.outcome}`);
    }
  });
});

describe.skipIf(!canConnect)("the release's commit", () => {
  test("comes from the digest's revision label, which must equal the plan's commit", () => {
    const where = pinned();
    const ok = runStep("Find the release's commit in its image", where, context());
    expect(ok.code).toBe(0);
    expect(ok.outputs).toEqual({ ref: COMMIT });
    expect(readFileSync(join(where.dir, "docker-calls"), "utf8")).toBe(
      `buildx imagetools inspect ghcr.io/deconfined/tarubot@${DIGEST} --format {{json .Image}}\n`,
    );
    const other = pinned();
    writeFileSync(join(other.dir, "images", DIGEST), "f".repeat(40));
    const moved = runStep("Find the release's commit in its image", other, context());
    expect({ code: moved.code, outputs: moved.outputs }).toEqual({ code: 1, outputs: {} });
    expect(moved.stdout).toBe(
      "::error::The image's revision label names another commit than the plan's.\n",
    );
    for (const label of ["", "not-a-commit", COMMIT.toUpperCase()]) {
      const odd = pinned();
      writeFileSync(join(odd.dir, "images", DIGEST), label);
      const r = runStep("Find the release's commit in its image", odd, context());
      expect({ label, code: r.code, outputs: r.outputs }).toEqual({ label, code: 1, outputs: {} });
    }
    const missing = runStep("Find the release's commit in its image", box(), context());
    expect({ code: missing.code, outputs: missing.outputs }).toEqual({ code: 1, outputs: {} });
  });
});

describe.skipIf(!canConnect)("Configure and the bot", () => {
  const inventory = (where: Box) => join(where.temp, "ssh", "inventory.json");

  test("configure runs site.yml alone, with no secret, and ends configured", () => {
    for (const environment of ["staging", "prod"]) {
      const where = pinned(environment);
      const run = job(
        where,
        context({ environment, action: "configure", version: "", commit: "", digest: "" }),
      );
      expect(run.failed).toBe(false);
      expect(run.ran).toEqual([
        "Check the request",
        "Check out main's host configuration",
        "Connect to the host",
        "Install Ansible",
        "Configure the host",
        "Summary",
        "Remove the keys and OpenTofu's files",
      ]);
      expect(run.calls.map((c) => c.argv)).toEqual([
        ["-i", inventory(where), "site.yml", "-e", `tarubot_role=${environment}`],
      ]);
      expect(run.calls[0]?.cwd).toBe(join(where.workspace, "config/ops/ansible"));
      expect(run.calls[0]?.env.ANSIBLE_CONFIG).toBe(
        join(where.workspace, "config/ops/ansible/ansible.cfg"),
      );
      // No secret's value reaches Configure's environment (the stand-ins' own settings aside).
      const values = Object.values(context().secrets).filter((v) => v.length > 3);
      for (const [name, value] of Object.entries(run.calls[0]?.env ?? {}))
        if (!/^(STUB|FAKE_)/u.test(name))
          expect({ name, secret: values.some((secret) => value.includes(secret)) }).toEqual({
            name,
            secret: false,
          });
      expect(run.result).toMatchObject({ outcome: "configured", action: "configure" });
      expect(run.summary).toContain(`## ${environment}: configured`);
      expect(run.outputs.summary).toMatchObject({ outcome: "configured", infrastructure: "-" });
    }
  });

  test("deploy runs Configure, then the release's bot.yml with six public arguments and the 12 settings", () => {
    for (const environment of ["staging", "prod"])
      for (const token of ["marker-discord_token", ""]) {
        const where = pinned(environment);
        const c = context({ environment }, { DISCORD_TOKEN: token });
        const run = job(where, c, { bot: { result: deployed } });
        expect(run.failed).toBe(false);
        expect(run.calls.map((call) => call.argv[2])).toEqual(["site.yml", "bot.yml"]);
        // bot.yml always runs; it, not host.yml, decides what a missing DISCORD_TOKEN means.
        const bot = run.calls[1];
        expect(bot?.argv).toEqual([
          "-i",
          inventory(where),
          "bot.yml",
          "-e",
          `tarubot_target=${environment}`,
          "-e",
          "tarubot_action=deploy",
          "-e",
          "tarubot_version=2.37.1",
          "-e",
          `tarubot_commit=${COMMIT}`,
          "-e",
          `tarubot_digest=${DIGEST}`,
          "-e",
          `tarubot_result=${join(where.temp, "result.json")}`,
        ]);
        expect(bot?.cwd).toBe(join(where.workspace, "release/ops/ansible"));
        // Main's ansible.cfg, the release's playbook.
        expect(bot?.env.ANSIBLE_CONFIG).toBe(
          join(where.workspace, "config/ops/ansible/ansible.cfg"),
        );
        for (const name of BOT_SETTINGS)
          expect({ name, present: name in (bot?.env ?? {}) }).toEqual({ name, present: true });
        expect(bot?.env.DISCORD_TOKEN).toBe(token);
        // The renamed secrets reach bot.yml under the bot's own names.
        expect(bot?.env.GITHUB_REPORTS_TOKEN).toBe("marker-github_reports_token");
        expect(bot?.env.GITHUB_APP_CLIENT_ID).toBe("marker-github_app_client_id");
        expect(bot?.env.GITHUB_APP_PRIVATE_KEY).toBe("marker-github_app_private_key");
        // No secret value is ever an argument, or in the log.
        for (const value of Object.values(c.secrets).filter((v) => v.length > 3))
          for (const call of run.calls)
            expect(call.argv.some((arg) => arg.includes(value))).toBe(false);
        expect(run.log).not.toContain("marker-");
        expect(run.log).not.toContain(RW.secret);
        expect(run.summary).toContain(`## ${environment}: deployed`);
        expect(run.outputs.summary).toEqual({
          outcome: "deployed",
          action: "deploy",
          version: "2.37.1",
          previous: "2.37.0",
          restore_point: "2026-09-30T19:30:05.123456Z",
          migrations: "011_example.sql",
          schema_head: "011_example.sql",
          step: "-",
          reason: "-",
          warnings: "",
          pinned: "",
          infrastructure: "-",
        });
      }
  });

  test("bot skips Configure, and preflight runs both", () => {
    const bot = job(pinned("prod"), context({ environment: "prod", action: "bot" }), {
      bot: { result: { ...deployed, action: "bot" } },
    });
    expect(bot.calls.map((c) => c.argv[2])).toEqual(["bot.yml"]);
    expect(bot.calls[0]?.argv).toContain("tarubot_action=bot");
    expect(bot.failed).toBe(false);
    const preflight = job(pinned(), context({ action: "preflight" }), {
      bot: { result: { ...deployed, outcome: "preflight-ok", action: "preflight", previous: "-" } },
    });
    expect(preflight.calls.map((c) => c.argv[2])).toEqual(["site.yml", "bot.yml"]);
    expect(preflight.failed).toBe(false);
    expect(preflight.summary).toContain("## staging: preflight-ok");
  });

  test("a failed Configure skips the bot, and the summary names where the run stopped", () => {
    const where = pinned();
    writeFileSync(join(where.dir, "exit.site.yml"), "2");
    const run = job(where, context());
    expect(run.ran).toEqual([
      "Check the request",
      "Check out main's host configuration",
      "Connect to the host",
      "Find the release's commit in its image",
      "Check out the release",
      "Install Ansible",
      "Configure the host",
      "Summary",
      "Remove the keys and OpenTofu's files",
    ]);
    expect(run.calls.map((c) => c.argv[2])).toEqual(["site.yml"]);
    // The job is red from Configure's step; the summary only reports.
    expect(run.failed).toBe(true);
    expect(run.results.summary?.outcome).toBe("success");
    expect(run.log).toContain(
      "Result on staging: outcome=failed step=configure reason=-; no result file: the run stopped before bot.yml's last play.",
    );
    expect(run.summary).toContain("## staging: failed");
    expect(run.outputs.summary).toMatchObject({
      outcome: "failed",
      step: "configure",
      reason: "-",
    });
  });

  test("a refused bot.yml fails the job, and a release whose label moved never reaches the host", () => {
    const refused = job(pinned(), context(), {
      bot: {
        result: { ...deployed, outcome: "refused", step: "checks", reason: "missing-secret" },
        exit: 2,
      },
    });
    expect(refused.failed).toBe(true);
    expect(refused.log).toContain("Result on staging: outcome=refused action=deploy");
    expect(refused.summary).toContain("## staging: refused");
    expect(refused.outputs.summary).toMatchObject({
      outcome: "refused",
      step: "checks",
      reason: "missing-secret",
    });
    const where = pinned();
    writeFileSync(join(where.dir, "images", DIGEST), "f".repeat(40));
    const moved = job(where, context(), { bot: { result: deployed } });
    expect(moved.calls).toEqual([]);
    expect(moved.failed).toBe(true);
    expect(moved.outputs.summary).toMatchObject({ outcome: "failed", step: "release" });
  });
});

describe.skipIf(!hasJq)("the summary", () => {
  /** Run the summary over a result file (a string is written as it is; undefined: none). */
  const summarize = (
    result: unknown,
    status = "success",
    inputs: Partial<Record<string, string | boolean>> = {},
    results: Record<string, StepResult> = {},
  ) => {
    const where = box();
    if (result !== undefined)
      writeFileSync(
        join(where.temp, "result.json"),
        typeof result === "string" ? result : JSON.stringify(result),
      );
    const r = runStep("Summary", where, { ...context(inputs), status }, results);
    return { ...r, summary: readFileSync(join(where.dir, "summary"), "utf8") };
  };

  test("renders the file to the log, the run's summary and the outputs, and decides nothing", () => {
    const r = summarize(deployed);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "Result on staging: outcome=deployed action=deploy version=2.37.1 previous=2.37.0 restore_point=2026-09-30T19:30:05.123456Z migrations=011_example.sql schema_head=011_example.sql step=- reason=- warnings=none\n",
    );
    expect(r.summary).toContain("## staging: deployed");
    expect(r.summary).toContain("| migrations | `011_example.sql` |");
    const window = summarize({ ...deployed, warnings: ["db-maintenance-window"] });
    expect(window.stdout).toContain("warnings=db-maintenance-window");
    expect(window.outputs.warnings).toBe("db-maintenance-window");
    // The job's colour comes from the steps above: a red outcome renders and exits 0.
    for (const outcome of ["refused", "unhealthy", "failed"])
      expect({ outcome, code: summarize({ ...deployed, outcome }).code }).toEqual({
        outcome,
        code: 0,
      });
  });

  test("prints and outputs only plain characters, and ? for anything that isn't a string or a list of them", () => {
    const r = summarize({
      ...deployed,
      version: "2.37.1; echo $HOME",
      previous: "2.37.0\n::error::injected",
      schema_head: ["011_example.sql"],
      warnings: [{ odd: true }],
      step: "",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "version=2.37.1??echo??HOME previous=2.37.0?::error::injected restore_point=",
    );
    // A list of strings is still a list; anything else is ?.
    expect(r.stdout).toContain("schema_head=011_example.sql step=? reason=- warnings=?");
    // Every line of the log is the one result line: nothing starts a workflow command.
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    // An output leaves only when it fits its pattern.
    expect(r.outputs).toMatchObject({
      version: "?",
      previous: "?",
      schema_head: "011_example.sql",
      step: "?",
      warnings: "?",
    });
    for (const value of Object.values(r.outputs)) expect(value).not.toMatch(/[\n$;]/u);
    for (const odd of ["not json", "[]", '"deployed"', "{"]) {
      const s = summarize(odd, "failure");
      expect({
        odd,
        code: s.code,
        start: s.stdout.startsWith(
          "Result on staging: outcome=failed step=- reason=-; no result file",
        ),
      }).toEqual({ odd, code: 0, start: true });
    }
  });

  test("names the rollback dispatch when the release isn't healthy or didn't start, on either host", () => {
    // On prod, a request waiting for its approval holds host-prod, so the rollback waits behind it
    // until @deconfined rejects it.
    const waiting = {
      staging: "",
      prod: ", after rejecting any prod request still waiting for approval",
    };
    for (const environment of ["staging", "prod"] as const) {
      const r = summarize(
        { ...deployed, outcome: "unhealthy", step: "health", reason: "not-healthy" },
        "failure",
        { environment },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        `::error::2.37.1 isn't healthy on ${environment}. To roll back, run Deploy with target=${environment}, version=2.37.0 and action=bot${waiting[environment]}.`,
      );
      expect(r.summary).toContain("version=2.37.0 and action=bot");
      expect(r.outputs).toMatchObject({
        outcome: "unhealthy",
        step: "health",
        reason: "not-healthy",
      });
      // A failed start (its migration failed, say) leaves the bot down: the same dispatch.
      const down = summarize(
        { ...deployed, outcome: "failed", step: "restart", reason: "restart-failed" },
        "failure",
        { environment },
      );
      expect(down.stdout).toContain(
        `::error::2.37.1 didn't start on ${environment}. To roll back, run Deploy with target=${environment}, version=2.37.0 and action=bot${waiting[environment]}.`,
      );
      expect(down.summary).toContain("version=2.37.0 and action=bot");
    }
    // With no release before it, there is nothing to name; nor for another failure.
    const first = summarize({ ...deployed, outcome: "unhealthy", previous: "-" });
    expect(first.stdout).not.toContain("To roll back");
    const firstDown = summarize({
      ...deployed,
      outcome: "failed",
      reason: "restart-failed",
      previous: "-",
    });
    expect(firstDown.stdout).not.toContain("To roll back");
    const other = summarize({
      ...deployed,
      outcome: "failed",
      step: "commands",
      reason: "register-failed",
    });
    expect(other.stdout).not.toContain("To roll back");
  });

  test("without a result, names the step where the run stopped and the connection's reason", () => {
    const failed = summarize(
      undefined,
      "failure",
      {},
      {
        request: { outcome: "success", outputs: {} },
        connect: { outcome: "failure", outputs: { reason: "key-rejected" } },
      },
    );
    expect(failed.code).toBe(0);
    expect(failed.stdout).toBe(
      "Result on staging: outcome=failed step=connect reason=key-rejected; no result file: the run stopped before bot.yml's last play. A step above failed, or the host became unreachable while bot.yml ran.\n",
    );
    expect(failed.summary).toContain("## staging: failed");
    expect(failed.outputs).toMatchObject({
      outcome: "failed",
      step: "connect",
      reason: "key-rejected",
    });
    const green = summarize(undefined, "success", { action: "configure" });
    expect(green.stdout).toContain("outcome=?");
  });

  test("reports OpenTofu's part: applied, pinned, unchanged, or failed at its step", () => {
    const tofu = { environment: "prod", tofu: true };
    const ok = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { outcome: "success", outputs: {} }]));
    const cases: [Partial<Record<string, string | boolean>>, Record<string, StepResult>, string][] =
      [
        [{ ...tofu, apply: true }, ok(["adopt", "apply", "pin"]), "applied"],
        [
          tofu,
          { ...ok(["adopt"]), pin: { outcome: "success", outputs: { pinned: "prod" } } },
          "pinned",
        ],
        [tofu, ok(["adopt", "pin"]), "unchanged"],
        [
          { ...tofu, apply: true },
          { ...ok(["adopt"]), apply: { outcome: "failure", outputs: {} } },
          "failed",
        ],
        [tofu, { ...ok(["adopt"]), pin: { outcome: "failure", outputs: {} } }, "failed"],
      ];
    for (const [inputs, results, infrastructure] of cases) {
      const r = summarize(deployed, "success", inputs, results);
      expect({ inputs, infrastructure: r.outputs.infrastructure }).toEqual({
        inputs,
        infrastructure,
      });
      expect(r.summary).toContain(`## Infrastructure: ${infrastructure}`);
      expect(r.stdout).toContain(`Infrastructure on prod: ${infrastructure}`);
    }
    // For the Infrastructure call it is the whole outcome.
    const infra = summarize(
      undefined,
      "failure",
      { ...tofu, action: "infra", apply: true },
      {
        ...ok(["adopt"]),
        apply: { outcome: "failure", outputs: {} },
      },
    );
    expect(infra.outputs).toEqual({
      outcome: "failed",
      action: "infra",
      version: "-",
      previous: "-",
      restore_point: "-",
      migrations: "",
      schema_head: "-",
      step: "apply",
      reason: "-",
      warnings: "",
      pinned: "",
      infrastructure: "failed",
    });
    // A pinned list that isn't host keys never leaves.
    const odd = summarize(deployed, "success", tofu, {
      pin: { outcome: "success", outputs: { pinned: "prod 192.0.2.1" } },
    });
    expect(odd.outputs.pinned).toBe("?");
  });
});

describe("removing the keys and OpenTofu's files", () => {
  test("removes OpenTofu's files right after the pin step, before anything reaches the host", () => {
    // In the job's order: the pin step (their last reader), this step, then connect, the release
    // checkout, pip and both playbooks, none of which reads them.
    const names = steps.map((s) => s.name);
    expect(names.indexOf("Remove OpenTofu's files")).toBe(
      names.indexOf("Pin the listed host keys") + 1,
    );
    expect(names.indexOf("Connect to the host")).toBe(names.indexOf("Remove OpenTofu's files") + 1);
    const s = stepOf("Remove OpenTofu's files");
    expect(s).toEqual({
      name: "Remove OpenTofu's files",
      if: "inputs.tofu",
      run: `rm -rf -- "\${RUNNER_TEMP:?}/tofu"`,
    });
    // It leaves the keys and the pin step's private files to the last step.
    const where = box();
    for (const name of ["ssh", "tofu", "pin"]) {
      mkdirSync(join(where.temp, name));
      writeFileSync(join(where.temp, name, "file"), "x");
    }
    expect(
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", s.run ?? ""], {
        env: { PATH: "/usr/bin:/bin", RUNNER_TEMP: where.temp },
      }).exitCode,
    ).toBe(0);
    expect(["ssh", "tofu", "pin"].map((name) => existsSync(join(where.temp, name)))).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("deletes the three directories, and refuses to run without RUNNER_TEMP", () => {
    const where = box();
    for (const name of ["ssh", "tofu", "pin"]) {
      mkdirSync(join(where.temp, name));
      writeFileSync(join(where.temp, name, "file"), "x");
    }
    const s = stepOf("Remove the keys and OpenTofu's files");
    expect(
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", s.run ?? ""], {
        env: { PATH: "/usr/bin:/bin", RUNNER_TEMP: where.temp },
      }).exitCode,
    ).toBe(0);
    for (const name of ["ssh", "tofu", "pin"])
      expect(existsSync(join(where.temp, name))).toBe(false);
    expect(
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", s.run ?? ""], {
        env: { PATH: "/usr/bin:/bin" },
      }).exitCode,
    ).not.toBe(0);
  });
});
