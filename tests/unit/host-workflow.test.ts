/**
 * The reusable "Host" workflow (.github/workflows/host.yml, 2.36.0, issue #62): Configure
 * (ops/ansible/site.yml at main's head, as root), then the release's own ops/ansible/bot.yml, over
 * SSH from a GitHub runner. deploy.yml's staging job calls it; production joins in 2.37.0.
 *
 * - Shape: the six inputs and nothing else that triggers it, one job in the target's environment,
 *   first attempts only, one concurrency group per target that never cancels, least permissions,
 *   every ${{ }} through env:, no tracing and no verbose or diffing ansible-playbook, the two
 *   pinned checkouts (the release's ref from the image's own label), the 14 secret names each in
 *   the one step that needs them, and the key removed on every path.
 * - Behavior: the step scripts run here with simulated getent, ssh-keyscan, docker and
 *   ansible-playbook (tests/fixtures/host-workflow) and the real ssh-keygen: the request check,
 *   the no-host rule, the host settings and their masks, the key each address offers checked
 *   against the pinned one, files and inventory, the release commit taken from the image,
 *   Configure and the Bot step for each action, the summary's pattern filter and its green
 *   outcomes, and the key's removal. The public-log rules come first: masks before any other
 *   output, no host key or fingerprint outside a mask, no secret in any argument, and nothing
 *   unmatched from the host's result file reaches the log.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
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
const hasJq = Bun.which("jq") !== null;
/** The settings step computes fingerprints with OpenSSH's ssh-keygen, as a runner has it. */
const canSettle = hasJq && Bun.which("ssh-keygen") !== null;

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
    type: z.literal("string"),
    required: z.boolean().optional(),
    default: z.string().optional(),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Host"),
    on: z
      .object({ workflow_call: z.object({ inputs: z.record(z.string(), input) }).strict() })
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
              .object({ group: z.string(), "cancel-in-progress": z.boolean() })
              .strict(),
            permissions: z.record(z.string(), z.string()),
            defaults: z.object({ run: z.object({ shell: z.literal("bash") }).strict() }).strict(),
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

/** The host's three settings, read in "Load the host settings" only. */
const HOST_SECRETS = ["ANSIBLE_SSH_KEY", "TARGET_HOST", "TARGET_HOST_KEY"];
/** The bot's 11 (vars/bot.yml tb_secret_env), read in "Deploy the bot" only. */
const BOT_SECRETS = [
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_REGION",
  "BACKUP_STORAGE_SECRET_KEY",
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_BACKUP_URL",
  "HEALTHCHECKS_PING_URL",
];
/** The step order interfaces §3 gives, by name. */
const ORDER = [
  "Check the request",
  "Load the host settings",
  "Find the release's commit in its image",
  "Check out main's host configuration",
  "Check out the release",
  "Install Ansible",
  "Configure the host",
  "Deploy the bot",
  "Summary",
  "Remove the key",
];
/** ci.yml's pinned actions/checkout, which both checkouts must use. */
const CHECKOUT = /uses: (actions\/checkout@[0-9a-f]{40} # v[\d.]+)/u.exec(
  read(".github/workflows/ci.yml"),
)?.[1];

describe("the workflow's shape", () => {
  test("is reusable only, with the plan's six inputs", () => {
    expect(Object.keys(host.on)).toEqual(["workflow_call"]);
    const inputs = host.on.workflow_call.inputs;
    expect(Object.keys(inputs)).toEqual([
      "target",
      "action",
      "version",
      "commit",
      "digest",
      "config_commit",
    ]);
    for (const name of ["target", "action", "config_commit"])
      expect({ name, required: inputs[name]?.required }).toEqual({ name, required: true });
    for (const name of ["version", "commit", "digest"])
      expect({ name, default: inputs[name]?.default }).toEqual({ name, default: "" });
    // Nothing untrusted can start it: no pull request trigger of any kind.
    expect(text).not.toMatch(/pull_request/u);
  });

  test("one job in the target's environment, first attempts only, one group per target", () => {
    const job = host.jobs.host;
    expect(job.if).toBe("github.run_attempt == '1'");
    expect(job.environment).toBe(`\${{ inputs.target }}`);
    // Two runs never overlap on a host; a newer one waits and nothing is cancelled.
    expect(job.concurrency).toEqual({
      group: `host-\${{ inputs.target }}`,
      "cancel-in-progress": false,
    });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(40);
  });

  test("holds least permissions: nothing at the top, contents: read for the job", () => {
    expect(host.permissions).toEqual({});
    expect(host.jobs.host.permissions).toEqual({ contents: "read" });
    expect(text).toMatch(/^ {6}contents: read # \S/mu);
    expect(text).not.toMatch(/docker\s+login|--password-stdin|packages:/u);
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

  test("runs the steps in the plan's order, each when the action needs it", () => {
    expect(steps.map((s) => s.name)).toEqual(ORDER);
    const unlessSkipped = "steps.host.outputs.skip != 'true'";
    expect(steps.map((s) => [s.name, s.if ?? ""])).toEqual([
      ["Check the request", ""],
      ["Load the host settings", ""],
      [
        "Find the release's commit in its image",
        `${unlessSkipped} && inputs.action != 'configure'`,
      ],
      ["Check out main's host configuration", unlessSkipped],
      ["Check out the release", `${unlessSkipped} && inputs.action != 'configure'`],
      ["Install Ansible", unlessSkipped],
      ["Configure the host", `${unlessSkipped} && inputs.action != 'bot'`],
      ["Deploy the bot", `${unlessSkipped} && inputs.action != 'configure'`],
      ["Summary", "always()"],
      ["Remove the key", "always()"],
    ]);
  });

  test("checks out main's head and the release at the commit its image names, without credentials", () => {
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
    // Every action is pinned to a full SHA, and there are exactly these two.
    expect(steps.filter((s) => s.uses).map((s) => s.uses)).toEqual([pinned, pinned]);
    // Ansible comes from main's hash-pinned requirements, into a private virtual environment.
    expect(runOf("Install Ansible")).toContain(
      "--no-deps --require-hashes -r config/ops/ansible/requirements.txt",
    );
  });

  test("names 14 secrets: the host's three in its settings step, the bot's 11 in the bot's step", () => {
    expect(secretsIn(host)).toEqual([...HOST_SECRETS, ...BOT_SECRETS].sort());
    for (const s of steps) {
      const expected =
        s.id === "host" ? HOST_SECRETS : s.name === "Deploy the bot" ? BOT_SECRETS : [];
      expect({ step: s.name, secrets: secretsIn(s) }).toEqual({ step: s.name, secrets: expected });
    }
    // Each under its own name, straight from the environment's secret.
    const bot = stepOf("Deploy the bot").env ?? {};
    for (const name of BOT_SECRETS) expect(bot[name]).toBe(`\${{ secrets.${name} }}`);
    expect(Object.keys(bot).sort()).toEqual(
      [
        ...BOT_SECRETS,
        "ACTION",
        "ANSIBLE_CONFIG",
        "COMMIT",
        "DIGEST",
        "LC_ALL",
        "TARGET",
        "VERSION",
      ].sort(),
    );
    // Configure's environment holds no secret at all, and main's ansible.cfg serves both steps.
    const configure = stepOf("Configure the host").env ?? {};
    expect(Object.keys(configure).sort()).toEqual(["ACTION", "ANSIBLE_CONFIG", "LC_ALL", "TARGET"]);
    for (const env of [configure, bot])
      expect(env.ANSIBLE_CONFIG).toBe(`\${{ github.workspace }}/config/ops/ansible/ansible.cfg`);
    expect(stepOf("Configure the host")["working-directory"]).toBe("config/ops/ansible");
    expect(stepOf("Deploy the bot")["working-directory"]).toBe("release/ops/ansible");
  });

  test("removes the key even when the job fails or is cancelled", () => {
    expect(steps.at(-1)).toEqual({
      name: "Remove the key",
      if: "always()",
      run: `rm -rf -- "\${RUNNER_TEMP:?}/ssh"`,
    });
  });

  test("names no host beyond GHCR, and no address", () => {
    const hosts = [
      ...text.matchAll(
        /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9]))/gimu,
      ),
    ].map((m) => (m[1] ?? "").toLowerCase());
    // steps.host is the settings step's id in the conditions, not a name.
    expect([...new Set(hosts)].filter((name) => name !== "steps.host")).toEqual(["ghcr.io"]);
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
    expect(text).not.toMatch(/\b[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f:]*\b/iu);
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, run with simulated getent, docker and ansible-playbook
// ---------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "host-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let boxes = 0;

/** A runner's directories: stubs on PATH, RUNNER_TEMP, a workspace and the step files. */
function box() {
  const dir = join(scratch, `b${++boxes}`);
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  const workspace = join(dir, "work");
  for (const path of [
    bin,
    temp,
    join(dir, "hosts"),
    join(dir, "images"),
    join(workspace, "config/ops/ansible"),
    join(workspace, "release/ops/ansible"),
  ])
    mkdirSync(path, { recursive: true });
  for (const name of readdirSync(STUBS)) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  for (const name of ["output", "summary", "path"]) writeFileSync(join(dir, name), "");
  return { dir, bin, temp, workspace };
}
type Box = ReturnType<typeof box>;

/** What a run knows: the inputs, the environment's secrets, the event and the job's status. */
interface Context {
  readonly inputs: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly event: string;
  readonly status?: string;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CONFIG = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const HOST = "staging.example.org";
/** An ed25519 key line as ssh-keyscan prints it, without the name: a 68-character blob. */
const HOST_KEY = `ssh-ed25519 ${"AAAAC3NzaC1lZDI1NTE5AAAAIExample".padEnd(68, "E")}`;
/** Another host's key: what a rebuilt host offers before the owner pins it. */
const OTHER_KEY = `ssh-ed25519 ${"AAAAC3NzaC1lZDI1NTE5AAAAIOther".padEnd(68, "O")}`;
/** A key line's base64 part. */
const blobOf = (line: string) => line.split(" ")[1] ?? "";
/** The SHA256 fingerprint ssh-keygen prints for a key, without its SHA256: prefix. */
const fingerprintOf = (line: string) =>
  createHash("sha256")
    .update(Buffer.from(blobOf(line), "base64"))
    .digest("base64")
    .replace(/=+$/u, "");
/** The two masks the settings step prints for a key: its base64 and its fingerprint. */
const keyMasks = (line: string) => [
  `::add-mask::${blobOf(line)}`,
  `::add-mask::${fingerprintOf(line)}`,
];
/** Output without its mask commands: what the log shows. */
const unmasked = (output: string) =>
  output
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAexample\n-----END OPENSSH PRIVATE KEY-----";
/** Documentation addresses the simulated name resolves to. */
const ADDRESSES = ["2001:db8::10", "192.0.2.10"];

/** Every bot secret, set to a marker value the tests look for in arguments and logs. */
const botSecrets = (overrides: Record<string, string> = {}) => ({
  ...Object.fromEntries(BOT_SECRETS.map((name) => [name, `marker-${name.toLowerCase()}`])),
  GITHUB_APP_PRIVATE_KEY: "",
  ...overrides,
});
const context = (
  inputs: Partial<Record<string, string>> = {},
  secrets: Record<string, string> = {},
  event = "workflow_run",
): Context => ({
  inputs: {
    target: "staging",
    action: "deploy",
    version: "2.36.0",
    commit: COMMIT,
    digest: DIGEST,
    config_commit: CONFIG,
    ...inputs,
  } as Record<string, string>,
  secrets: {
    TARGET_HOST: HOST,
    TARGET_HOST_KEY: HOST_KEY,
    ANSIBLE_SSH_KEY: PRIVATE_KEY,
    ...botSecrets(),
    ...secrets,
  },
  event,
});

/** A step's env with its expressions replaced as GitHub would (an unset secret is empty). */
function resolveEnv(env: Record<string, string>, where: Box, c: Context) {
  const lookup = (path: string): string => {
    const [scope, name] = path.split(".");
    if (scope === "inputs" && name && name in c.inputs) return c.inputs[name] ?? "";
    if (scope === "secrets" && name) return c.secrets[name] ?? "";
    if (path === "github.event_name") return c.event;
    if (path === "github.workspace") return where.workspace;
    if (path === "job.status") return c.status ?? "success";
    throw new Error(`no context for ${path}`);
  };
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      v.replace(/\$\{\{\s*([a-z_]+\.[A-Za-z_]+)\s*\}\}/gu, (_, path: string) => lookup(path)),
    ]),
  );
}

/** Run one step's script as GitHub's `shell: bash` does, in its working directory. */
function runStep(name: string, where: Box, c: Context) {
  const s = stepOf(name);
  writeFileSync(join(where.dir, "output"), "");
  const env = resolveEnv(s.env ?? {}, where, c);
  const result = Bun.spawnSync(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", s.run ?? ""],
    {
      cwd: s["working-directory"] ? join(where.workspace, s["working-directory"]) : where.workspace,
      env: {
        PATH: `${where.bin}:/usr/bin:/bin`,
        HOME: where.dir,
        STUB: where.dir,
        RUNNER_TEMP: where.temp,
        GITHUB_WORKSPACE: where.workspace,
        GITHUB_OUTPUT: join(where.dir, "output"),
        GITHUB_STEP_SUMMARY: join(where.dir, "summary"),
        GITHUB_PATH: join(where.dir, "path"),
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
      env,
    };
  });
}

/**
 * Run the job's scripts in order, as GitHub would for these `if:` conditions (the shape test pins
 * them): the checkouts and the install are left out, a failure skips every later step but the
 * two `always()` ones, and skip=true or the action leaves out what the conditions leave out.
 */
function job(where: Box, c: Context, bot?: { result?: unknown; exit?: number }) {
  if (bot?.result !== undefined)
    writeFileSync(
      join(where.dir, "bot-result"),
      typeof bot.result === "string" ? bot.result : JSON.stringify(bot.result),
    );
  if (bot?.exit !== undefined) writeFileSync(join(where.dir, "exit.bot.yml"), String(bot.exit));
  const action = c.inputs.action;
  const ran: string[] = [];
  let failed = false;
  let skip = false;
  const log: string[] = [];
  const results: Record<string, ReturnType<typeof runStep>> = {};
  for (const name of ORDER) {
    if (name.startsWith("Check out") || name === "Install Ansible") continue;
    const always = name === "Summary" || name === "Remove the key";
    if (failed && !always) continue;
    if (!always && name !== "Check the request" && name !== "Load the host settings") {
      if (skip) continue;
      if (name === "Configure the host" && action === "bot") continue;
      if (name !== "Configure the host" && action === "configure") continue;
    }
    const r = runStep(name, where, { ...c, status: failed ? "failure" : "success" });
    results[name] = r;
    ran.push(name);
    log.push(r.stdout, r.stderr);
    if (name === "Load the host settings" && r.outputs.skip === "true") skip = true;
    if (r.code !== 0) failed = true;
  }
  return {
    ran,
    failed,
    results,
    log: log.join(""),
    calls: ansibleCalls(where),
    result: existsSync(join(where.temp, "result.json"))
      ? JSON.parse(readFileSync(join(where.temp, "result.json"), "utf8"))
      : undefined,
    summary: readFileSync(join(where.dir, "summary"), "utf8"),
  };
}

/** A box whose simulated DNS, host and registry know the staging host and the release. */
function staged() {
  const where = box();
  writeFileSync(join(where.dir, "hosts", HOST), `${ADDRESSES.join("\n")}\n`);
  writeFileSync(join(where.dir, "hosts", "2001:db8::20"), "2001:db8::20\n");
  writeFileSync(join(where.dir, "hosts", "198.51.100.20"), "198.51.100.20\n");
  // Every address offers the pinned key.
  mkdirSync(join(where.dir, "keys"));
  for (const address of [...ADDRESSES, "2001:db8::20", "198.51.100.20"])
    writeFileSync(join(where.dir, "keys", address), `${HOST_KEY}\n`);
  writeFileSync(join(where.dir, "images", DIGEST), COMMIT);
  return where;
}

/** The result bot.yml's last play writes for a finished deploy. */
const deployed = {
  outcome: "deployed",
  action: "deploy",
  version: "2.36.0",
  previous: "2.35.0",
  restore_point: "2026-09-29T19:30:05.123456Z",
  migrations: ["011_example.sql"],
  schema_head: "011_example.sql",
  step: "-",
  reason: "-",
  warnings: [],
};

describe("the request check", () => {
  test("takes staging's four actions with a release, and configure without one", () => {
    const where = box();
    for (const action of ["deploy", "bot", "preflight", "configure"])
      expect({
        action,
        code: runStep("Check the request", where, context({ action })).code,
      }).toEqual({ action, code: 0 });
    const bare = context({ action: "configure", version: "", commit: "", digest: "" });
    expect(runStep("Check the request", where, bare).code).toBe(0);
  });

  test("refuses anything that doesn't fit its pattern", () => {
    const where = box();
    for (const inputs of [
      { target: "production" },
      { target: "" },
      { target: "staging " },
      { action: "rollback" },
      { action: "deploy; id" },
      { version: "2.36" },
      { version: "02.36.0" },
      { version: "2.36.0\n" },
      { commit: COMMIT.toUpperCase() },
      { commit: COMMIT.slice(1) },
      { digest: DIGEST.replace("sha256:", "") },
      { digest: `${DIGEST} x` },
      { config_commit: "main" },
      { config_commit: "" },
      { action: "bot", version: "" },
      { action: "configure", config_commit: CONFIG.slice(2) },
    ]) {
      const r = runStep("Check the request", where, context(inputs));
      expect({ inputs, code: r.code, error: r.stdout.startsWith("::error::") }).toEqual({
        inputs,
        code: 1,
        error: true,
      });
    }
  });
});

describe.skipIf(!canSettle)("the host settings", () => {
  const settings = (secrets: Record<string, string> = {}, event = "workflow_run", inputs = {}) => {
    const where = staged();
    const r = runStep("Load the host settings", where, context(inputs, secrets, event));
    const ssh = join(where.temp, "ssh");
    return { ...r, where, ssh };
  };

  test("without a host, a merge ends green with a notice, and a dispatch fails", () => {
    const merge = settings({ TARGET_HOST: "" });
    expect(merge.code).toBe(0);
    expect(merge.stdout).toBe("::notice::no host in the staging environment\n");
    expect(merge.outputs).toEqual({ skip: "true" });
    expect(JSON.parse(readFileSync(join(merge.where.temp, "result.json"), "utf8"))).toEqual({
      outcome: "no-host",
      action: "deploy",
      version: "-",
      previous: "-",
      restore_point: "-",
      migrations: [],
      schema_head: "-",
      step: "-",
      reason: "-",
      warnings: [],
    });
    expect(existsSync(merge.ssh)).toBe(false);
    const dispatch = settings({ TARGET_HOST: "" }, "workflow_dispatch");
    expect(dispatch.code).toBe(1);
    expect(dispatch.stdout).toBe(
      "::error::no host in the staging environment: set its TARGET_HOST secret.\n",
    );
    expect(existsSync(join(dispatch.where.temp, "result.json"))).toBe(false);
    // The whole job: green with the no-host result, and nothing after the settings runs.
    const where = staged();
    const run = job(where, context({}, { TARGET_HOST: "" }));
    expect(run.ran).toEqual([
      "Check the request",
      "Load the host settings",
      "Summary",
      "Remove the key",
    ]);
    expect(run.failed).toBe(false);
    expect(run.calls).toEqual([]);
    expect(run.summary).toContain("## staging: no-host");
  });

  test("masks every address before any other output, and prints nothing else", () => {
    const ok = settings();
    expect(ok.code).toBe(0);
    // The addresses first, then the pinned key's base64 and fingerprint.
    expect(ok.stdout).toBe(
      [...ADDRESSES.map((a) => `::add-mask::${a}`).sort(), ...keyMasks(HOST_KEY)]
        .join("\n")
        .concat("\n"),
    );
    expect(ok.stderr).toBe("");
    expect(ok.outputs).toEqual({ skip: "false" });
    // A failure after the name resolved still comes after the masks.
    const bad = settings({ TARGET_HOST_KEY: "ssh-rsa AAAAB3NzaC1yc2E" });
    expect(bad.code).toBe(1);
    const lines = bad.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 2).sort()).toEqual(ADDRESSES.map((a) => `::add-mask::${a}`).sort());
    expect(lines.slice(2)).toEqual([
      "::error::TARGET_HOST_KEY must be one line: ssh-ed25519 and the host's key, with no name or comment.",
    ]);
    // Neither the name nor the key reach the output, whatever happens, but in a mask.
    for (const r of [ok, bad]) {
      expect(r.stdout + r.stderr).not.toContain(HOST);
      expect(unmasked(r.stdout + r.stderr)).not.toContain(blobOf(HOST_KEY));
      expect(unmasked(r.stdout + r.stderr)).not.toContain(fingerprintOf(HOST_KEY));
      expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    }
  });

  test("writes the key, the pinned host key and the inventory, private, under the alias target", () => {
    const ok = settings();
    expect(ok.code).toBe(0);
    const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
    expect(mode(ok.ssh)).toBe("700");
    for (const file of ["key", "known_hosts", "inventory.json"])
      expect({ file, mode: mode(join(ok.ssh, file)) }).toEqual({ file, mode: "600" });
    expect(readFileSync(join(ok.ssh, "key"), "utf8")).toBe(`${PRIVATE_KEY}\n`);
    expect(readFileSync(join(ok.ssh, "known_hosts"), "utf8")).toBe(`target ${HOST_KEY}\n`);
    const inventory = JSON.parse(readFileSync(join(ok.ssh, "inventory.json"), "utf8"));
    expect(Object.keys(inventory.all.hosts)).toEqual(["target"]);
    const target = inventory.all.hosts.target;
    expect(target).toMatchObject({
      ansible_host: HOST,
      ansible_user: "root",
      ansible_ssh_private_key_file: join(ok.ssh, "key"),
    });
    expect(target.ansible_ssh_common_args.split(" ")).toEqual(
      [
        "-F /dev/null",
        "-o IdentitiesOnly=yes",
        "-o IdentityAgent=none",
        "-o BatchMode=yes",
        "-o StrictHostKeyChecking=yes",
        `-o UserKnownHostsFile=${join(ok.ssh, "known_hosts")}`,
        "-o GlobalKnownHostsFile=/dev/null",
        "-o HostKeyAlias=target",
        "-o HostKeyAlgorithms=ssh-ed25519",
        "-o CheckHostIP=no",
        "-o UpdateHostKeys=no",
        "-o AddressFamily=any",
        "-o ConnectTimeout=20",
        "-o ServerAliveInterval=15",
        "-o ServerAliveCountMax=4",
        "-o LogLevel=ERROR",
      ]
        .join(" ")
        .split(" "),
    );
    // Nothing in the files names the host but the inventory's ansible_host.
    expect(readFileSync(join(ok.ssh, "known_hosts"), "utf8")).not.toContain(HOST);
    expect(target.ansible_ssh_common_args).not.toContain(HOST);
    // A key pasted with carriage returns is written without them.
    const pasted = settings({ ANSIBLE_SSH_KEY: PRIVATE_KEY.replaceAll("\n", "\r\n") });
    expect(readFileSync(join(pasted.ssh, "key"), "utf8")).toBe(`${PRIVATE_KEY}\n`);
    // A trailing newline in the pinned key, as a pasted secret may carry, is tolerated.
    expect(settings({ TARGET_HOST_KEY: `${HOST_KEY}\n` }).code).toBe(0);
    expect(settings({ TARGET_HOST_KEY: `${HOST_KEY}\r\n` }).code).toBe(0);
  });

  test("takes an address literal too (the lab), and masks it", () => {
    for (const literal of ["2001:db8::20", "198.51.100.20"]) {
      const r = settings({ TARGET_HOST: literal });
      expect({ literal, code: r.code, stdout: r.stdout }).toEqual({
        literal,
        code: 0,
        stdout: [`::add-mask::${literal}`, ...keyMasks(HOST_KEY)].join("\n").concat("\n"),
      });
    }
  });

  test("refuses a host that isn't one DNS name or address, or a key that isn't one pinned ed25519 key", () => {
    for (const [secrets, message] of [
      [{ TARGET_HOST: "Staging.Example.Org" }, "TARGET_HOST must be"],
      [{ TARGET_HOST: `${HOST} -oProxyCommand=x` }, "TARGET_HOST must be"],
      [{ TARGET_HOST: "-oProxyCommand=x" }, "TARGET_HOST must be"],
      [{ TARGET_HOST: "staging" }, "TARGET_HOST must be"],
      [{ TARGET_HOST: `root@${HOST}` }, "TARGET_HOST must be"],
      [{ TARGET_HOST: `${HOST}\nother.example.org` }, "TARGET_HOST must be"],
      [{ TARGET_HOST: "unknown.example.org" }, "TARGET_HOST doesn't resolve."],
      [{ TARGET_HOST_KEY: "" }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: `${HOST} ${HOST_KEY}` }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: `target ${HOST_KEY}` }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: `${HOST_KEY} root@${HOST}` }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: `${HOST_KEY}\n${HOST_KEY}` }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: `${HOST_KEY}=` }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: HOST_KEY.slice(0, -1) }, "TARGET_HOST_KEY must be"],
      [{ TARGET_HOST_KEY: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ" }, "TARGET_HOST_KEY must be"],
      // The right shape, but ssh-keygen reads no ed25519 key in it.
      [
        { TARGET_HOST_KEY: `ssh-ed25519 ${"AAAAB3NzaC1yc2EAAAADAQABAAAAQQ".padEnd(68, "A")}` },
        "TARGET_HOST_KEY must be",
      ],
      [{ ANSIBLE_SSH_KEY: "" }, "ANSIBLE_SSH_KEY isn't set in the staging environment."],
    ] as const) {
      const r = settings(secrets);
      expect({ secrets, code: r.code, error: r.stdout.includes(`::error::${message}`) }).toEqual({
        secrets,
        code: 1,
        error: true,
      });
      expect(r.outputs.skip).toBeUndefined();
      expect(existsSync(join(r.ssh, "inventory.json"))).toBe(false);
    }
  });
  test("reads the key each address offers first, masks every key seen, and stops on any other", () => {
    // Each address scanned once, quietly, for its ed25519 key.
    const ok = settings();
    expect(ok.code).toBe(0);
    expect(readFileSync(join(ok.where.dir, "keyscan-calls"), "utf8")).toBe(
      [...ADDRESSES]
        .sort()
        .map((a) => `-q -T 20 -t ed25519 -- ${a}\n`)
        .join(""),
    );
    const scan = (where: Box) => runStep("Load the host settings", where, context());
    // A rebuilt host not yet pinned: both keys are masked before the fixed error, nothing else
    // names either, and no file is written, so ssh never runs and never prints a fingerprint.
    const rebuilt = staged();
    for (const a of ADDRESSES) writeFileSync(join(rebuilt.dir, "keys", a), `${OTHER_KEY}\n`);
    const moved = scan(rebuilt);
    expect(moved.code).toBe(1);
    const lines = moved.stdout.trimEnd().split("\n");
    expect(lines.slice(0, -1).sort()).toEqual(
      [
        ...ADDRESSES.map((a) => `::add-mask::${a}`),
        ...keyMasks(HOST_KEY),
        ...keyMasks(OTHER_KEY),
      ].sort(),
    );
    expect(lines.slice(0, 2).sort()).toEqual(ADDRESSES.map((a) => `::add-mask::${a}`).sort());
    expect(lines.at(-1)).toBe(
      `::error::The host's key isn't the one pinned in TARGET_HOST_KEY. After a rebuild, pin the new key from your own machine (ops/tofu/README.md, "Pinning a new host key").`,
    );
    for (const secret of [blobOf(OTHER_KEY), fingerprintOf(OTHER_KEY), blobOf(HOST_KEY)])
      expect(unmasked(moved.stdout + moved.stderr)).not.toContain(secret);
    expect(moved.stderr).toBe("");
    expect(existsSync(join(rebuilt.temp, "ssh"))).toBe(false);
    expect(moved.outputs.skip).toBeUndefined();
    // One address offering another key (a stale record, say) stops the run too.
    const split = staged();
    writeFileSync(join(split.dir, "keys", ADDRESSES[1] ?? ""), `${OTHER_KEY}\n`);
    expect(scan(split).code).toBe(1);
    // An address this runner can't reach offers nothing, and its complaint goes nowhere; the
    // others decide.
    const v4only = staged();
    rmSync(join(v4only.dir, "keys", ADDRESSES[0] ?? ""));
    const reached = scan(v4only);
    expect({ code: reached.code, stderr: reached.stderr }).toEqual({ code: 0, stderr: "" });
    // No address answering stops with its own message.
    const down = staged();
    for (const a of ADDRESSES) rmSync(join(down.dir, "keys", a));
    const silent = scan(down);
    expect(silent.code).toBe(1);
    expect(silent.stdout.trimEnd().split("\n").at(-1)).toBe(
      "::error::The host offered no Ed25519 host key at any of its addresses: is it up, with port 22 open?",
    );
    expect(existsSync(join(down.temp, "ssh"))).toBe(false);
    // The whole job: nothing reaches ansible-playbook, and the run reads failed.
    const again = staged();
    for (const a of ADDRESSES) writeFileSync(join(again.dir, "keys", a), `${OTHER_KEY}\n`);
    const run = job(again, context());
    expect(run.calls).toEqual([]);
    expect(run.failed).toBe(true);
    expect(run.summary).toContain("## staging: failed");
    expect(unmasked(run.log)).not.toContain(fingerprintOf(OTHER_KEY));
  });
});

describe.skipIf(!hasJq)("the release's commit", () => {
  test("comes from the digest's revision label, which must equal the plan's commit", () => {
    const where = staged();
    const ok = runStep("Find the release's commit in its image", where, context());
    expect(ok.code).toBe(0);
    expect(ok.outputs).toEqual({ ref: COMMIT });
    expect(readFileSync(join(where.dir, "docker-calls"), "utf8")).toBe(
      `buildx imagetools inspect ghcr.io/deconfined/tarubot@${DIGEST} --format {{json .Image}}\n`,
    );
    const other = staged();
    writeFileSync(join(other.dir, "images", DIGEST), "f".repeat(40));
    const moved = runStep("Find the release's commit in its image", other, context());
    expect({ code: moved.code, outputs: moved.outputs }).toEqual({ code: 1, outputs: {} });
    expect(moved.stdout).toBe(
      "::error::The image's revision label names another commit than the plan's.\n",
    );
    for (const label of ["", "not-a-commit", COMMIT.toUpperCase()]) {
      const odd = staged();
      writeFileSync(join(odd.dir, "images", DIGEST), label);
      const r = runStep("Find the release's commit in its image", odd, context());
      expect({ label, code: r.code, outputs: r.outputs }).toEqual({ label, code: 1, outputs: {} });
    }
    const missing = runStep("Find the release's commit in its image", box(), context());
    expect({ code: missing.code, outputs: missing.outputs }).toEqual({ code: 1, outputs: {} });
  });
});

describe.skipIf(!canSettle)("Configure and the bot", () => {
  const inventory = (where: Box) => join(where.temp, "ssh", "inventory.json");

  test("configure runs site.yml alone, with no secret, and ends configured", () => {
    const where = staged();
    const run = job(where, context({ action: "configure", version: "", commit: "", digest: "" }));
    expect(run.failed).toBe(false);
    expect(run.ran).toEqual([
      "Check the request",
      "Load the host settings",
      "Configure the host",
      "Summary",
      "Remove the key",
    ]);
    expect(run.calls.map((c) => c.argv)).toEqual([
      ["-i", inventory(where), "site.yml", "-e", "tarubot_role=staging"],
    ]);
    expect(run.calls[0]?.cwd).toBe(join(where.workspace, "config/ops/ansible"));
    expect(run.calls[0]?.env.ANSIBLE_CONFIG).toBe(
      join(where.workspace, "config/ops/ansible/ansible.cfg"),
    );
    // No secret's value reaches Configure's environment.
    const values = Object.values(context().secrets).filter(Boolean);
    for (const value of Object.values(run.calls[0]?.env ?? {}))
      expect(values.some((secret) => value.includes(secret))).toBe(false);
    expect(run.result).toMatchObject({ outcome: "configured", action: "configure" });
    expect(run.summary).toContain("## staging: configured");
  });

  test("deploy runs Configure, then the release's bot.yml with six public arguments and the 11 settings", () => {
    for (const token of ["marker-discord_token", ""]) {
      const where = staged();
      const run = job(where, context({}, { DISCORD_TOKEN: token }), { result: deployed });
      expect(run.failed).toBe(false);
      expect(run.calls.map((c) => c.argv[2])).toEqual(["site.yml", "bot.yml"]);
      // bot.yml always runs; it, not host.yml, decides what a missing DISCORD_TOKEN means.
      const bot = run.calls[1];
      expect(bot?.argv).toEqual([
        "-i",
        inventory(where),
        "bot.yml",
        "-e",
        "tarubot_target=staging",
        "-e",
        "tarubot_action=deploy",
        "-e",
        "tarubot_version=2.36.0",
        "-e",
        `tarubot_commit=${COMMIT}`,
        "-e",
        `tarubot_digest=${DIGEST}`,
        "-e",
        `tarubot_result=${join(where.temp, "result.json")}`,
      ]);
      expect(bot?.cwd).toBe(join(where.workspace, "release/ops/ansible"));
      // Main's ansible.cfg, the release's playbook.
      expect(bot?.env.ANSIBLE_CONFIG).toBe(join(where.workspace, "config/ops/ansible/ansible.cfg"));
      for (const name of BOT_SECRETS)
        expect({ name, present: name in (bot?.env ?? {}) }).toEqual({ name, present: true });
      expect(bot?.env.DISCORD_TOKEN).toBe(token);
      // No secret value is ever an argument.
      for (const value of Object.values(context({}, { DISCORD_TOKEN: token }).secrets).filter(
        Boolean,
      ))
        for (const call of run.calls)
          expect(call.argv.some((arg) => arg.includes(value))).toBe(false);
      expect(run.log).not.toContain("marker-");
      expect(run.summary).toContain("## staging: deployed");
    }
  });

  test("bot skips Configure, and preflight runs both", () => {
    const bot = job(staged(), context({ action: "bot" }), {
      result: { ...deployed, action: "bot" },
    });
    expect(bot.calls.map((c) => c.argv[2])).toEqual(["bot.yml"]);
    expect(bot.calls[0]?.argv).toContain("tarubot_action=bot");
    expect(bot.failed).toBe(false);
    const preflight = job(staged(), context({ action: "preflight" }), {
      result: { ...deployed, outcome: "preflight-ok", action: "preflight", previous: "-" },
    });
    expect(preflight.calls.map((c) => c.argv[2])).toEqual(["site.yml", "bot.yml"]);
    expect(preflight.failed).toBe(false);
    expect(preflight.summary).toContain("## staging: preflight-ok");
  });

  test("a failed Configure skips the bot, and the summary calls the run failed", () => {
    const where = staged();
    writeFileSync(join(where.dir, "exit.site.yml"), "2");
    const run = job(where, context());
    expect(run.ran).toEqual([
      "Check the request",
      "Load the host settings",
      "Find the release's commit in its image",
      "Configure the host",
      "Summary",
      "Remove the key",
    ]);
    expect(run.calls.map((c) => c.argv[2])).toEqual(["site.yml"]);
    expect(run.results.Summary?.code).toBe(1);
    expect(run.results.Summary?.stdout).toContain(
      "Result on staging: outcome=failed action=deploy",
    );
    expect(run.summary).toContain("## staging: failed");
  });

  test("a refused bot.yml fails the job, and a release whose label moved never reaches the host", () => {
    const refused = job(staged(), context(), {
      result: { ...deployed, outcome: "refused", step: "checks", reason: "missing-secret" },
      exit: 2,
    });
    expect(refused.failed).toBe(true);
    expect(refused.results.Summary?.stdout).toContain(
      "::error::The staging run ended refused (step checks, reason missing-secret).",
    );
    const where = staged();
    writeFileSync(join(where.dir, "images", DIGEST), "f".repeat(40));
    const moved = job(where, context(), { result: deployed });
    expect(moved.calls).toEqual([]);
    expect(moved.failed).toBe(true);
  });
});

describe.skipIf(!hasJq)("the summary", () => {
  /** Run the summary over a result file (a string is written as it is; undefined: none). */
  const summarize = (result: unknown, status = "success", action = "deploy") => {
    const where = box();
    if (result !== undefined)
      writeFileSync(
        join(where.temp, "result.json"),
        typeof result === "string" ? result : JSON.stringify(result),
      );
    const r = runStep("Summary", where, { ...context({ action }), status });
    return { ...r, summary: readFileSync(join(where.dir, "summary"), "utf8") };
  };

  test("prints every field that fits its pattern", () => {
    const r = summarize(deployed);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "Result on staging: outcome=deployed action=deploy version=2.36.0 previous=2.35.0 restore_point=2026-09-29T19:30:05.123456Z migrations=011_example.sql schema_head=011_example.sql step=- reason=- warnings=none\n",
    );
    expect(r.summary).toContain("## staging: deployed");
    expect(r.summary).toContain("| migrations | `011_example.sql` |");
    const window = summarize({ ...deployed, warnings: ["db-maintenance-window"] });
    expect(window.stdout).toContain("warnings=db-maintenance-window");
  });

  test("prints anything else as ?, so nothing from the host reaches the log unmatched", () => {
    const r = summarize({
      outcome: "deployed",
      action: "deploy",
      version: "2.36.0; echo leaked",
      previous: "2.35.0\n::error::leaked",
      restore_point: "yesterday leaked",
      migrations: ["011_example.sql", "leaked.sql"],
      schema_head: ["011_example.sql"],
      step: "health leaked",
      reason: "Leaked-Reason",
      warnings: [{ leaked: true }],
    });
    expect(r.code).toBe(0);
    expect(r.stdout + r.summary).not.toContain("leaked");
    expect(r.stdout).toBe(
      "Result on staging: outcome=deployed action=deploy version=? previous=? restore_point=? migrations=? schema_head=? step=? reason=? warnings=?\n",
    );
    for (const odd of ["not json", "[]", '"deployed"', "{"]) {
      const s = summarize(odd);
      expect({ odd, code: s.code, outcome: s.stdout.split(" ")[3] }).toEqual({
        odd,
        code: 1,
        outcome: "outcome=?",
      });
    }
  });

  test("is green only for no-host, configured, deployed, superseded and preflight-ok", () => {
    for (const outcome of ["no-host", "configured", "deployed", "superseded", "preflight-ok"])
      expect({ outcome, code: summarize({ ...deployed, outcome }).code }).toEqual({
        outcome,
        code: 0,
      });
    for (const outcome of ["refused", "unhealthy", "failed", "deployed-ish", ""])
      expect({ outcome, code: summarize({ ...deployed, outcome }).code }).toEqual({
        outcome,
        code: 1,
      });
  });

  test("names the rollback dispatch when the release isn't healthy", () => {
    const r = summarize({
      ...deployed,
      outcome: "unhealthy",
      step: "health",
      reason: "not-healthy",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "::error::2.36.0 isn't healthy on staging. To roll back, run Deploy with target=staging, version=2.35.0 and action=bot.",
    );
    expect(r.summary).toContain("version=2.35.0 and action=bot");
    // With no release before it, there is nothing to name.
    const first = summarize({ ...deployed, outcome: "unhealthy", previous: "-" });
    expect(first.stdout).not.toContain("To roll back");
  });

  test("without a result, a failed job reads as failed and a green one can't pass", () => {
    const failed = summarize(undefined, "failure");
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(
      "Result on staging: outcome=failed action=deploy version=- previous=- restore_point=- migrations=none schema_head=- step=- reason=-",
    );
    const unknown = summarize(undefined, "success", "configure");
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("outcome=? action=configure");
  });
});

describe("removing the key", () => {
  test("deletes the whole directory, and refuses to run without RUNNER_TEMP", () => {
    const where = box();
    mkdirSync(join(where.temp, "ssh"));
    writeFileSync(join(where.temp, "ssh", "key"), "x");
    const s = stepOf("Remove the key");
    expect(
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", s.run ?? ""], {
        env: { PATH: "/usr/bin:/bin", RUNNER_TEMP: where.temp },
      }).exitCode,
    ).toBe(0);
    expect(existsSync(join(where.temp, "ssh"))).toBe(false);
    expect(
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", s.run ?? ""], {
        env: { PATH: "/usr/bin:/bin" },
      }).exitCode,
    ).not.toBe(0);
  });
});
