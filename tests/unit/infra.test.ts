/**
 * The OpenTofu module (ops/tofu) and the "Infrastructure" workflow that plans and applies it
 * (.github/workflows/infra.yml), since 2.36.0 (issue #62). Each of the workflow's steps runs one
 * phase of ops/tofu/ci/tofu-ci.sh, whose rules live in the jq programs beside it.
 *
 * Nothing here runs tofu or the network. The jq programs and the script's phases run against sample
 * plans and a stand-in for tofu (tests/fixtures/infra/tofu) where jq is installed, and are
 * skipped where it isn't (the image build); OpenTofu's own tests (ops/tofu/tests/main.tftest.hcl,
 * in CI's "Infrastructure checks") cover what the module renders and plans.
 *
 * - infra.yml: dispatch from main only, Plan in the reviewer-free `infra-plan` environment with the
 *   read-only secrets only and Apply in the approval-gated `infra` with the write ones only
 *   (REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)", confirmed item 4), first attempts
 *   only, least permissions, one concurrency group that queues every waiting run, pinned actions,
 *   every ${{ }} through env:, each secret in the steps that need it, and the phases each job runs.
 *   Execution gates stay owner settings. Private records use the same role-scoped S3 credentials
 *   and state passphrase; no separate owner variable, token or historical job proof is needed.
 * - The hand-off: Plan plans without a state lock and keeps its encrypted saved plan as a one-day
 *   artifact only for an apply that passed the guards; Apply never plans, refuses a file whose
 *   SHA-256 or change list differs from the Plan job's, or that was planned with other values than
 *   infra's TOFU_VARS, and applies that saved plan with nothing that could change it, so OpenTofu
 *   refuses it if the state moved since.
 * - Public logs (the repository and its Actions logs are public): every tofu command writes to a
 *   private file, and so does every jq error on plan or apply output, the prepare phase masks
 *   every identifying value in TOFU_VARS before anything else prints and reads the replace input
 *   from the event payload (a step's env: prints unmasked), diagnostics print through a filter
 *   that no digit, '/', '@' or '=' survives, first host keys stay in encrypted records, and the guards
 *   refuse deletes, replaces and access-list removals nobody asked for. The state passphrase, the
 *   only key to that public artifact, must be at least 32 characters, in the script and the module.
 * - The pinned OpenTofu: one install phase, used by ci.yml and infra.yml, whose version and
 *   checksum files agree and satisfy the module's required_version.
 * - ops/tofu: every variable sensitive, the addresses output sensitive, the validations present
 *   and in step with infra.yml's own checks, no host key or private key anywhere, verify-required
 *   seeded, the access lists protected and adopted by import, encrypted state and plans, no bucket
 *   or endpoint in the repository, the lock file pinning both providers, and examples that use
 *   only documentation names and addresses.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";
import { handoffBinding } from "../../scripts/infra-policy.js";
import { hostRecordCodec } from "../../scripts/infra-control-cli.js";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);
const hasJq = Bun.which("jq") !== null;

/** Every file under a directory, relative to the repository, skipping tofu's .terraform/. */
const walk = (dir: string): string[] =>
  readdirSync(root(dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(root("").length))
    .filter((p) => !p.split("/").includes(".terraform"))
    .sort();

// ---- infra.yml ----------------------------------------------------------------------------------

const step = z
  .object({
    name: z.string(),
    id: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
    env: z.record(z.string(), z.string()).optional(),
    run: z.string().optional(),
  })
  .strict();
const job = z
  .object({
    name: z.string(),
    needs: z.string().optional(),
    if: z.string(),
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    environment: z.string(),
    permissions: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(step),
  })
  .strict();
const input = z
  .object({
    description: z.string(),
    type: z.enum(["choice", "string", "boolean"]),
    options: z.array(z.string()).optional(),
    default: z.union([z.string(), z.boolean()]),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Infrastructure"),
    "run-name": z.string(),
    on: z
      .object({ workflow_dispatch: z.object({ inputs: z.record(z.string(), input) }).strict() })
      .strict(),
    permissions: z.object({}).strict(),
    concurrency: z
      .object({ group: z.string(), "cancel-in-progress": z.boolean(), queue: z.literal("max") })
      .strict(),
    defaults: z.object({ run: z.object({ shell: z.literal("bash") }).strict() }).strict(),
    env: z.record(z.string(), z.string()),
    jobs: z.object({ plan: job, apply: job }).strict(),
  })
  .strict();

const INFRA = ".github/workflows/infra.yml";
const infraText = read(INFRA);
const infra = workflow.parse(YAML.parse(infraText));
const { plan, apply } = infra.jobs;
type Job = z.infer<typeof job>;

/** One job's step, by name. */
const stepOf = (j: Job, name: string) => {
  const found = j.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};
/** A GitHub Actions expression, `${{ inner }}`, built so this source holds no placeholder. */
const expr = (inner: string) => `\${{ ${inner} }}`;

/** The steps Plan and Apply start with, in order, with the script phase each runs (none for an action). */
const SHARED: [string, string | null][] = [
  ["Check out source", null],
  ["Install the project Bun version", null],
  ["Install the pinned OpenTofu", "install"],
  ["Prepare the values and the masks", "prepare"],
  ["Initialize OpenTofu", "init"],
];
/** The saved plan's artifact, which only the Plan job uploads and only the Apply job downloads. */
const ARTIFACT = "saved-plan";
/** Both jobs share private backend/input configuration; provider/storage keys stay READ/WRITE. */
const SHARED_SECRETS = [
  "TOFU_STATE_BUCKET",
  "TOFU_STATE_ENDPOINT",
  "TOFU_STATE_PASSPHRASE",
  "TOFU_VARS",
];
/** Every secrets.NAME a job's steps read, sorted and unique. */
const secretsOfJob = (j: Job) =>
  [
    ...new Set(
      j.steps.flatMap((s) =>
        Object.values(s.env ?? {}).flatMap((v) =>
          [...v.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1] ?? ""),
        ),
      ),
    ),
  ].sort();
/** The script every step runs, and one of its phases (a shell function) as text. */
const SCRIPT = "ops/tofu/ci/tofu-ci.sh";
const scriptText = read(SCRIPT);
const phaseOf = (name: string) => {
  const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}$`, "mu").exec(scriptText);
  if (!match?.[1]) throw new Error(`no phase ${name} in ${SCRIPT}`);
  return match[1];
};
const PREPARE = phaseOf("prepare");
const SUMMARIZE = phaseOf("summarize");

/** One of the jq programs beside the script, without its leading comment lines. */
const jqProgram = (name: string) =>
  read(`ops/tofu/ci/${name}`)
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");

/** Every command line of a script (heredoc bodies and comments left out). */
const commandLines = (script: string) => {
  const lines: string[] = [];
  let heredoc: string | null = null;
  for (const line of script.split("\n")) {
    if (heredoc !== null) {
      if (line === heredoc) heredoc = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    lines.push(trimmed);
    const opens = /<<'([A-Z]+)'$/u.exec(trimmed);
    if (opens?.[1]) heredoc = opens[1];
  }
  return lines;
};

describe("infra.yml's shape", () => {
  test("runs only when dispatched: no pull request, push, schedule or other workflow starts it", () => {
    expect(Object.keys((YAML.parse(infraText) as { on: object }).on)).toEqual([
      "workflow_dispatch",
    ]);
    expect(infraText).not.toMatch(/pull_request|workflow_run|workflow_call|schedule:|push:/u);
    const inputs = infra.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual([
      "operation",
      "replace",
      "allow_destroy",
      "allow_access_removal",
    ]);
    expect(inputs.operation).toMatchObject({
      type: "choice",
      options: ["plan", "apply", "baseline", "adopt"],
      default: "plan",
    });
    expect(inputs.replace).toMatchObject({ type: "string", default: "" });
    expect(inputs.allow_destroy).toMatchObject({ type: "boolean", default: false });
    expect(inputs.allow_access_removal).toMatchObject({ type: "boolean", default: false });
    // The title names the operation only: never the replace target or anything from a secret.
    expect(infra["run-name"]).toBe(`Infrastructure ${expr("inputs.operation")}`);
  });

  test("one concurrency group serializes runs, and nothing holds a permission by default", () => {
    // queue: max keeps every waiting run; GitHub's default keeps one and cancels it for the next.
    expect(infra.concurrency).toEqual({
      group: "infra",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(infra.permissions).toEqual({});
    expect(infra.env).toEqual({ TF_IN_AUTOMATION: "1", TF_INPUT: "0" });
  });

  test("Plan runs in infra-plan with no approval and Apply in infra, from main, on the first attempt only", () => {
    // Confirmed item 4: infra-plan has no reviewer, so a plan never waits; only Apply, in the
    // approval-gated infra, asks @deconfined. Both environments accept only main.
    const guard = "github.run_attempt == '1' && github.ref == 'refs/heads/main'";
    expect(plan.if).toBe(guard);
    expect(apply.if).toBe(
      `${guard} && (inputs.operation == 'baseline' || (contains(fromJSON('["apply","adopt"]'), inputs.operation) && needs.plan.outputs.has_changes == 'true'))`,
    );
    // Plan is the first job; nothing reads the environments' own rules through the API, which
    // the owner sets and reads back once (REQUIREMENTS.md, "Approved pipeline amendments").
    expect(Object.keys(infra.jobs)).toEqual(["plan", "apply"]);
    expect(plan.needs).toBeUndefined();
    expect(apply.needs).toBe("plan");
    expect(plan.environment).toBe("infra-plan");
    expect(apply.environment).toBe("infra");
    expect([...infraText.matchAll(/^ {4}environment: (.*)$/gmu)].map((m) => m[1])).toEqual([
      "infra-plan",
      "infra",
    ]);
    for (const j of [plan, apply]) {
      expect(j.permissions).toEqual({ contents: "read" });
      expect(j["runs-on"]).toBe("ubuntu-24.04");
    }
    expect(plan.outputs).toEqual({
      changes: expr("steps.summary.outputs.changes"),
      has_changes: expr("steps.summary.outputs.has_changes"),
      digest: expr("steps.summary.outputs.digest"),
      binding: expr("steps.summary.outputs.binding"),
      policy_decision: expr("steps.summary.outputs.policy_decision"),
    });
    expect(apply.outputs).toBeUndefined();
  });

  test("Plan reads only read credentials; Apply uses writes and a distinct read-only verification step", () => {
    const planSecrets = secretsOfJob(plan);
    const applySecrets = secretsOfJob(apply);
    expect(planSecrets).toEqual(
      [
        "CLOUDFLARE_READ_TOKEN",
        "LINODE_READ_TOKEN",
        ...SHARED_SECRETS,
        "TOFU_STATE_READ_ACCESS_KEY",
        "TOFU_STATE_READ_SECRET_KEY",
      ].sort(),
    );
    expect(applySecrets).toEqual(
      [
        "CLOUDFLARE_WRITE_TOKEN",
        "LINODE_WRITE_TOKEN",
        "LINODE_READ_TOKEN",
        "CLOUDFLARE_READ_TOKEN",
        ...SHARED_SECRETS,
        "TOFU_STATE_WRITE_ACCESS_KEY",
        "TOFU_STATE_WRITE_SECRET_KEY",
      ].sort(),
    );
    // Provider/storage names identify the read-only and write roles.
    for (const name of [...planSecrets, ...applySecrets].filter((n) => !SHARED_SECRETS.includes(n)))
      expect({ name, kind: /_(READ|WRITE)_/u.test(name) }).toEqual({ name, kind: true });
    expect(planSecrets.filter((n) => n.includes("_WRITE_"))).toEqual([]);
    expect(applySecrets.filter((n) => n.includes("_READ_"))).toEqual([
      "CLOUDFLARE_READ_TOKEN",
      "LINODE_READ_TOKEN",
    ]);
    // Each job maps them onto the variables OpenTofu reads, the same names in both.
    const tools = (kind: string) => ({
      AWS_ACCESS_KEY_ID: expr(`secrets.TOFU_STATE_${kind}_ACCESS_KEY`),
      AWS_SECRET_ACCESS_KEY: expr(`secrets.TOFU_STATE_${kind}_SECRET_KEY`),
      TF_VAR_state_passphrase: expr("secrets.TOFU_STATE_PASSPHRASE"),
      LINODE_TOKEN: expr(`secrets.LINODE_${kind}_TOKEN`),
      CLOUDFLARE_API_TOKEN: expr(`secrets.CLOUDFLARE_${kind}_TOKEN`),
    });
    expect(stepOf(plan, "Plan").env).toEqual(tools("READ"));
    expect(stepOf(apply, "Apply").env).toEqual(tools("WRITE"));
    expect(stepOf(apply, "Verify adoption with read-only provider credentials").env).toEqual({
      ...tools("WRITE"),
      LINODE_TOKEN: expr("secrets.LINODE_READ_TOKEN"),
      CLOUDFLARE_API_TOKEN: expr("secrets.CLOUDFLARE_READ_TOKEN"),
    });
    // The script names each environment's own secrets when one is missing.
    expect(phaseOf("plan")).toContain(
      'provider_tokens "LINODE_READ_TOKEN and CLOUDFLARE_READ_TOKEN must be set in the infra-plan environment."',
    );
    expect(phaseOf("apply")).toContain(
      'provider_tokens "LINODE_WRITE_TOKEN and CLOUDFLARE_WRITE_TOKEN must be set in the infra environment."',
    );
  });

  test("the actions are checkout at ci.yml's pin, and the artifact pair that carries the saved plan", () => {
    const ciPin = /uses: (actions\/checkout@[0-9a-f]{40}) # v[\d.]+/u.exec(
      read(".github/workflows/ci.yml"),
    );
    expect(ciPin?.[1]).toBeDefined();
    const pinned = (action: string) => new RegExp(`^actions/${action}@[0-9a-f]{40}$`, "u");
    for (const [j, artifact] of [
      [plan, "upload-artifact"],
      [apply, "download-artifact"],
    ] as const) {
      const uses = j.steps.filter((s) => s.uses);
      expect(uses[0]?.uses).toBe(ciPin?.[1]);
      expect(uses[0]?.with).toEqual({ "persist-credentials": false });
      expect(uses).toHaveLength(3);
      expect(uses[1]?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
      expect(uses[1]?.with).toEqual({ "bun-version-file": "package.json" });
      expect(uses[2]?.uses).toMatch(pinned(artifact));
    }
  });

  test("each job runs the script's phases in order: Plan plans, and Apply applies the saved plan", () => {
    const phases = (j: Job) =>
      j.steps.map((s) => [
        s.name,
        /^bash ops\/tofu\/ci\/tofu-ci\.sh ([a-z_]+)$/u.exec(s.run ?? "")?.[1] ?? null,
      ]);
    const cleanup = ["Clean up", null];
    expect(phases(plan)).toEqual([
      ...SHARED,
      ["Read durable control records", "control_read"],
      ["Plan", "plan"],
      ["Summarize the plan", "summarize"],
      ["Keep the saved plan for Apply", null],
      cleanup,
    ]);
    // Apply never plans: it fetches the Plan job's saved plan, checks it, then applies it.
    expect(phases(apply)).toEqual([
      ...SHARED,
      ["Read durable control records", "control_read"],
      ["Fetch the saved plan", null],
      ["Compare with the reviewed plan", "compare"],
      ["Install first-host enrollment tools", null],
      ["Apply", "apply"],
      ["Verify adoption with read-only provider credentials", "verify_adoption"],
      ["Establish initial baseline without provider changes", "baseline"],
      cleanup,
    ]);
    // The script holds exactly those phases, and runs nothing else.
    expect(scriptText).toContain(
      "  install | prepare | init | control_read | plan | summarize | compare | apply | verify_adoption | baseline)\n",
    );
    for (const j of [plan, apply]) {
      const clean = stepOf(j, "Clean up");
      expect(clean.if).toBe("always()");
      expect(clean.run).toBe(`rm -rf -- "\${RUNNER_TEMP:?}/tofu"`);
    }
  });

  test("every expression reaches a script through env:, and each secret only the step that needs it", () => {
    const secretsOf = (s: z.infer<typeof step>) =>
      Object.values(s.env ?? {})
        .flatMap((v) => [...v.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]))
        .sort();
    const prepare = ["TOFU_STATE_BUCKET", "TOFU_STATE_ENDPOINT", "TOFU_VARS"];
    const init = (kind: string) => [
      "TOFU_STATE_PASSPHRASE",
      `TOFU_STATE_${kind}_ACCESS_KEY`,
      `TOFU_STATE_${kind}_SECRET_KEY`,
    ];
    const tokens = (kind: string) =>
      [`CLOUDFLARE_${kind}_TOKEN`, `LINODE_${kind}_TOKEN`, ...init(kind)].sort();
    const expected: [Job, Record<string, string[]>][] = [
      [
        plan,
        {
          "Prepare the values and the masks": prepare,
          "Initialize OpenTofu": init("READ"),
          "Read durable control records": init("READ").sort(),
          Plan: tokens("READ"),
          "Summarize the plan": ["TOFU_STATE_PASSPHRASE"],
        },
      ],
      [
        apply,
        {
          "Prepare the values and the masks": prepare,
          "Initialize OpenTofu": init("WRITE"),
          "Read durable control records": init("WRITE").sort(),
          "Compare with the reviewed plan": ["TOFU_STATE_PASSPHRASE"],
          Apply: tokens("WRITE"),
          "Verify adoption with read-only provider credentials": [
            "CLOUDFLARE_READ_TOKEN",
            "LINODE_READ_TOKEN",
            ...init("WRITE"),
          ].sort(),
          "Establish initial baseline without provider changes": [...init("WRITE")].sort(),
        },
      ],
    ];
    for (const [j, secrets] of expected)
      for (const s of j.steps) {
        expect({ step: s.name, run: s.run?.includes("${{") ?? false }).toEqual({
          step: s.name,
          run: false,
        });
        // Each env value is one whole expression or a plain literal, never a template.
        for (const value of Object.values(s.env ?? {}))
          expect({
            step: s.name,
            value,
            ok: /^\$\{\{ [a-z_.A-Z]+ \}\}$|^[^$]*$/u.test(value),
          }).toMatchObject({
            ok: true,
          });
        expect({ job: j.name, step: s.name, secrets: secretsOf(s) }).toEqual({
          job: j.name,
          step: s.name,
          secrets: secrets[s.name] ?? [],
        });
      }
    // Everything else anywhere in the file is an input, the Plan job's outputs or the runner's
    // temporary directory (the artifact's path); no step gets the job token.
    const expressions = [...infraText.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/gu)].map((m) => m[1]);
    for (const e of expressions)
      expect({
        e,
        ok: /^(secrets\.[A-Z_]+|vars\.TOFU_CONTROL_RECORDS_ENABLED|inputs\.[a-z_]+|steps\.summary\.outputs\.[a-z_]+|needs\.plan\.outputs\.(changes|digest|binding)|runner\.temp)$/u.test(
          e ?? "",
        ),
      }).toMatchObject({
        ok: true,
      });
    // GitHub prints a step's env: values in the clear before it runs, so the replace input, which
    // a mistyped host name could fill, never goes there: prepare reads it from the event payload.
    expect(infraText).not.toContain(expr("inputs.replace"));
  });

  test("the manual workflow needs no extra GitHub record-authority secret", () => {
    // The protected dispatch and approval-gated Apply job remain the authorization boundary.
    // Removing these additional credentials does not enable the fenced automatic adapter.
    expect(infraText).not.toMatch(/CONTROL_(?:OWNER|REPOSITORY)/u);
    expect(infra.on).toEqual({ workflow_dispatch: { inputs: infra.on.workflow_dispatch.inputs } });
    expect(plan.environment).toBe("infra-plan");
    expect(apply.environment).toBe("infra");
  });

  test("only the encrypted saved plan leaves the Plan job, for an apply that passed the guards, for one day", () => {
    const keep = stepOf(plan, "Keep the saved plan for Apply");
    // After the summary step, whose guards exit non-zero, so a refused plan never leaves the job.
    expect(keep.if).toBe(
      `inputs.operation == 'baseline' || (contains(fromJSON('["apply","adopt"]'), inputs.operation) && steps.summary.outputs.has_changes == 'true')`,
    );
    expect(keep.with).toEqual({
      name: ARTIFACT,
      path: `${expr("runner.temp")}/tofu/plan.bin`,
      "if-no-files-found": "error",
      "retention-days": 1,
      "compression-level": 0,
    });
    const fetch = stepOf(apply, "Fetch the saved plan");
    expect(fetch.if).toBeUndefined();
    expect(fetch.with).toEqual({ name: ARTIFACT, path: `${expr("runner.temp")}/tofu` });
    // plan.bin is only ever written encrypted: ops/tofu/versions.tf enforces plan encryption
    // (pinned in "state and plans are encrypted" below), and the plan phase writes it with -out.
    expect(phaseOf("plan")).toContain('-out="$d/plan.bin"');
  });

  test("Plan takes no state lock, and Apply applies the Plan job's saved plan and nothing else", () => {
    // Plan's state key is read-only, so it must never try to write a lock.
    expect(phaseOf("plan")).toContain(
      'args=(-chdir="$module" plan -input=false -lock=false -json -var-file="$d/values.tfvars.json" -out="$d/plan.bin")',
    );
    // Apply checks the file's SHA-256 and change list against the Plan job's outputs first.
    const compare = stepOf(apply, "Compare with the reviewed plan");
    expect(compare.env).toEqual({
      DIGEST: expr("needs.plan.outputs.digest"),
      APPROVED: expr("needs.plan.outputs.changes"),
      BINDING: expr("needs.plan.outputs.binding"),
      TF_VAR_state_passphrase: expr("secrets.TOFU_STATE_PASSPHRASE"),
    });
    const COMPARE = phaseOf("compare");
    expect(COMPARE).toContain(`[[ \${DIGEST-} =~ ^[0-9a-f]{64}$ ]] || fail`);
    expect(COMPARE).toContain(`[[ -n \${APPROVED-} || $operation == baseline ]] || fail`);
    expect(COMPARE).toContain(`digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)`);
    expect(COMPARE).toContain(`[[ $digest == "\${DIGEST-}" ]] || fail`);
    expect(COMPARE).toContain(`[[ $current == "\${APPROVED-}" ]] || fail`);
    expect(COMPARE.indexOf("sha256sum")).toBeLessThan(COMPARE.indexOf("\n  changes\n"));
    expect(SUMMARIZE).toContain(`digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)`);
    expect(SUMMARIZE).toContain('echo "digest=$digest"');
    // The apply names only the saved plan, with no -var, -replace or -refresh that would ask for a
    // new plan, so OpenTofu applies exactly that file and refuses it as stale if the state changed
    // since the Plan job read it.
    const applyCalls = commandLines(phaseOf("apply")).filter((l) => /^tofu\s/u.test(l));
    expect(applyCalls).toEqual([
      'tofu -chdir="$module" apply -input=false -json "$d/plan.bin" >"$d/apply.jsonl" 2>"$d/apply.stderr" || rc=$?',
      'tofu -chdir="$module" show -json >"$d/applied-state.json" 2>"$d/applied-state.stderr" ||',
    ]);
    // And the Apply job runs no plan phase of its own.
    expect(apply.steps.some((s) => /tofu-ci\.sh (?:plan|summarize)$/u.test(s.run ?? ""))).toBe(
      false,
    );
  });
});

describe("public-log hygiene", () => {
  test("every tofu command writes its output and errors to a private file", () => {
    // Decrypted state/show evidence also stays private and is never uploaded.
    const calls = commandLines(scriptText).filter((l) => /^tofu\s/u.test(l));
    expect(calls.length).toBe(9);
    expect(scriptText.match(/\btofu -chdir=/gu)).toHaveLength(8);
    for (const line of calls) {
      // stdout to a file under $d, and stderr to a file or along with stdout.
      const ok =
        />"\$d\/[a-z.-]+"/u.test(line) && (/ 2>"\$d\/[a-z.-]+"/u.test(line) || / 2>&1/u.test(line));
      expect({ line, ok }).toEqual({ line, ok: true });
    }
    // jq's own errors quote the value they failed on, so every jq call that reads the plan or the
    // apply's output sends them to a private file or nowhere: summary.jq, diag.jq (plan and
    // apply), applied.jq and compare's check of the planned values.
    const jqOnOutput = commandLines(scriptText).filter(
      (l) => /\bjq\b/u.test(l) && /"\$d\/(?:plan\.jsonl?|apply\.jsonl)"/u.test(l),
    );
    expect(jqOnOutput.length).toBe(4);
    for (const line of jqOnOutput)
      expect({
        line,
        private: / 2>"\$d\/[a-z.]+"| 2>\/dev\/null |>\/dev\/null 2>&1 /u.test(line),
      }).toEqual({ line, private: true });
    // State is read only by the private evidence helper; no output/console or tracing is allowed.
    for (const text of [infraText, scriptText]) {
      expect(text).not.toMatch(/\btofu(?: -chdir=\S+)? (?:output|console)\b/u);
      expect(text).not.toMatch(
        / -no-color| -detailed-exitcode|set -[a-zA-Z]*x|\bcat (?:-- )?"\$d\/(?!changes\.txt)/u,
      );
    }
  });

  test("the prepare phase masks every identifying value before anything else prints", () => {
    const masks = jqProgram("masks.jq");
    for (const part of [
      "(.hosts[] | .fqdn)",
      ".cloudflare_zone_id",
      '(.db_allow_extra[] | ., split("/")[0])',
      '(.root_password_hash | select(. != ""))',
      '((.root_keys[], .configure_keys[]) | split(" ")[] | select(startswith("AAAA")))',
    ])
      expect({ part, present: masks.includes(part) }).toEqual({ part, present: true });
    // Labels are Linode display names, never masked: masking a plain word would censor the log.
    expect(masks).not.toContain(".label");
    const lines = commandLines(PREPARE);
    const loop = lines.findIndex((l) => l.includes("::add-mask::"));
    expect(loop).toBeGreaterThan(0);
    // Before the masks: only fixed messages print (fail takes one literal). TOFU_VARS reaches jq
    // through printf (a builtin) and a pipe, and jq's output and errors go to a file or nowhere.
    for (const line of lines.slice(0, loop)) {
      if (/^(?:echo|printf)\b/u.test(line) && !line.startsWith(`printf '%s' "\${TOFU_VARS-}" |`))
        expect({ line, printed: true }).toEqual({ line, printed: false });
      if (/^fail /u.test(line))
        expect({ line, fixed: /^fail "[^$`]*"$/u.test(line) }).toEqual({ line, fixed: true });
      if (line.includes(`\${TOFU_VARS-}`))
        expect({
          line,
          private: />(?:"\$d\/[a-z.]+"|\/dev\/null 2>&1); then$|>"\$d\/[a-z.]+"$/u.test(line),
        }).toEqual({ line, private: true });
    }
    // The shape check says nothing of the value, and the replace target, read from the event
    // payload rather than env:, is never echoed back.
    expect(PREPARE).toContain(`jq -e -f "$here/shape.jq" >/dev/null 2>&1`);
    expect(PREPARE).toContain(
      `replace=$(jq -r '.inputs.replace // ""' "\${GITHUB_EVENT_PATH:?}" 2>/dev/null) || fail`,
    );
    expect(
      commandLines(PREPARE).filter((l) => /^(?:echo|printf)\b/u.test(l) && l.includes("$replace")),
    ).toEqual([`printf '%s' "$replace" >"$d/replace"`]);
    expect(PREPARE).not.toContain("REPLACE");
    expect(scriptText).toMatch(/^fail\(\) \{\n {2}echo "::error::\$1"\n {2}exit 1\n\}$/mu);
  });

  test("the shape check agrees with ops/tofu/variables.tf on keys and names", () => {
    const shape = jqProgram("shape.jq");
    const variables = read("ops/tofu/variables.tf");
    for (const pattern of [
      "^(staging|production)(-[0-9]{1,2})?$",
      "^[a-z]{1,16}$",
      "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$",
    ])
      expect({
        pattern,
        shape: shape.includes(pattern),
        tofu: variables.includes(pattern),
      }).toEqual({
        pattern,
        shape: true,
        tofu: true,
      });
    // Exactly the seven keys of examples/example.tfvars.json.
    const keys = Object.keys(JSON.parse(read("ops/tofu/examples/example.tfvars.json")))
      .filter((k) => k !== "existing_databases")
      .sort();
    expect(shape).toContain(
      `(keys - ["existing_databases"]) == ${JSON.stringify(keys).replaceAll(",", ", ")}`,
    );
    // A label is only a string here (it isn't masked); variables.tf keeps Linode's own rules.
    expect(shape).toContain('(.value.label | type == "string")');
    expect(variables).toContain('can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label))');
    expect(variables).not.toContain("strcontains(k, h.label)");
  });

  test("the diagnostics filter lets no digit, '/', '@' or '=' through, nor a dotted name", () => {
    const diag = jqProgram("diag.jq");
    const classes = [...diag.matchAll(/gsub\("(\[\^[^\]]+\])"; ""\)/gu)].map((m) => m[1]);
    expect(classes).toEqual(["[^A-Za-z .,:'()-]"]);
    const keep = new RegExp(classes[0] ?? "", "gu");
    const dotted = /[A-Za-z-]+(?:[.][A-Za-z-]+)+/gu;
    expect(diag).toContain('gsub("[A-Za-z-]+([.][A-Za-z-]+)+"; "(name)")');
    const nasty =
      "Error 403 for db 123456 at https://api.example.org/v4/x?id=9 from 192.0.2.10 and 2001:db8::1, key=AAAAC3Nz@host";
    const out = nasty.replace(keep, "").replace(dotted, "(name)");
    expect(out).not.toMatch(/[0-9/@=]/u);
    expect(out).not.toContain("example");
    // Masked values are replaced before the filter, the summary is cut to 120 characters, and
    // the detail never prints.
    expect(diag).toContain('split($m) | join(" (masked) ")');
    expect(diag).toContain(".[0:120]");
    expect(diag).not.toContain(".detail");
    // Addresses print only in the change list's own form.
    const address = '^[a-z_]+[.][a-z_]+(\\\\[\\"[a-z0-9-]+\\"\\\\])?$';
    expect(diag).toContain(address);
    expect(jqProgram("summary.jq")).toContain(address);
  });

  test("first-host enrollment stays private and its tools install only in the approved Apply job", () => {
    expect(infraText).not.toMatch(
      /ssh-keyscan|known_hosts|ssh-ed25519|TARGET_HOST|host_key|ssh-keygen/u,
    );
    expect(scriptText).not.toMatch(
      /ssh-keyscan|known_hosts|ssh-ed25519|TARGET_HOST|host_key|ssh-keygen/u,
    );
    expect(phaseOf("apply")).toContain(
      `line="built \${BASH_REMATCH[1]} (\${BASH_REMATCH[2]}): durable first-host enrollment completed"`,
    );
    const tools = stepOf(apply, "Install first-host enrollment tools");
    expect(tools.if).toBe("inputs.operation == 'apply'");
    expect(tools.run).toContain("unbound dnsutils dns-root-data openssh-client");
    expect(plan.steps.some((s) => s.name === tools.name)).toBe(false);
    // Only the apply's counts print from its output, and only numbers.
    expect(jqProgram("applied.jq")).toContain("\\(.add | numbers) added");
  });

  test("deletes, replaces and access-list removals need their own switch; unnamed changes never apply", () => {
    const env = stepOf(plan, "Summarize the plan").env;
    expect(env?.ALLOW_DESTROY).toBe(expr("inputs.allow_destroy"));
    expect(env?.ALLOW_ACCESS_REMOVAL).toBe(expr("inputs.allow_access_removal"));
    const guards = [
      ...SUMMARIZE.matchAll(
        /if grep -qE '([^']+)' "\$d\/changes\.txt"( && \[\[ \$\{([A-Z_]+)-\} != true \]\])?/gu,
      ),
    ].map((m) => ({ pattern: new RegExp(m[1] ?? "", "mu"), flag: m[3] ?? null }));
    expect(guards.map((g) => g.flag)).toEqual([null, "ALLOW_DESTROY", "ALLOW_ACCESS_REMOVAL"]);
    const [unnamed, destroy, removal] = guards;
    const matches = (g: typeof unnamed, line: string) => g?.pattern.test(line) ?? false;
    expect(matches(unnamed, "? ?")).toBe(true);
    expect(matches(unnamed, "create ?")).toBe(true);
    expect(matches(unnamed, "update ? +1 -0")).toBe(true);
    expect(matches(unnamed, 'create linode_instance.host["staging"]')).toBe(false);
    expect(matches(destroy, 'delete linode_firewall.host["staging"]')).toBe(true);
    expect(matches(destroy, 'replace linode_instance.host["staging"]')).toBe(true);
    expect(matches(destroy, 'update linode_instance.host["staging"]')).toBe(false);
    expect(matches(removal, 'update linode_database_access_controls.db["primary"] +2 -1')).toBe(
      true,
    );
    expect(matches(removal, 'import linode_database_access_controls.db["primary"] +0 -10')).toBe(
      true,
    );
    expect(matches(removal, 'update linode_database_access_controls.db["primary"] +2 -0')).toBe(
      false,
    );
    expect(SUMMARIZE).toContain('exit "$refuse"');
    // A replace names exactly one configured host's instance.
    expect(PREPARE).toContain(
      `if ! [[ $replace =~ ^linode_instance\\.host\\[\\"((staging|production)(-[0-9]{1,2})?)\\"\\]$ ]] ||`,
    );
    expect(PREPARE).toContain(`jq -e --arg k "\${BASH_REMATCH[1]}" '.hosts | has($k)'`);
  });

  test("the change list names its actions and access-list counts, and goes out under a random delimiter", () => {
    const summary = jqProgram("summary.jq");
    for (const action of ["create", "update", "delete", "read", "replace", "no-op"])
      expect(summary).toContain(`then "${action}"`);
    expect(summary).toContain('"import \\($a)\\($n)"');
    expect(summary).toContain('" +\\(.plus) -\\(.minus)"');
    expect(summary).toContain('else "?" end');
    expect(SUMMARIZE).toContain(
      "delimiter=\"changes_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')\"",
    );
    expect(SUMMARIZE).toContain('echo "changes<<$delimiter"');
  });
});

// ---- The pinned OpenTofu ------------------------------------------------------------------------

describe("the pinned OpenTofu", () => {
  test("one install phase, which ci.yml and infra.yml's Plan and Apply jobs run", () => {
    const installs = (text: string) =>
      [
        ...text.matchAll(
          /^ {6}- name: Install the pinned OpenTofu\n(?: {8}#.*\n)* {8}run: (.*)$/gmu,
        ),
      ].map((m) => m[1]);
    const call = "bash ops/tofu/ci/tofu-ci.sh install";
    expect(installs(infraText)).toEqual([call, call]);
    expect(installs(read(".github/workflows/ci.yml"))).toEqual([call]);
    // The release's zip, checked against the committed SUMS line before anything runs it.
    const install = phaseOf("install");
    expect(install).toContain('v=$(<"$module/.opentofu-version")');
    expect(install).toContain(
      `"https://github.com/opentofu/opentofu/releases/download/v\${v}/tofu_\${v}_linux_amd64.zip"`,
    );
    expect(install).toContain('sha256sum --check --strict --quiet "$module/opentofu.sha256"');
    expect(install.indexOf("sha256sum")).toBeLessThan(install.indexOf("unzip"));
  });

  test("the checksum names the pinned release, which satisfies required_version", () => {
    const version = read("ops/tofu/.opentofu-version");
    expect(version).toMatch(/^\d+\.\d+\.\d+\n$/u);
    const v = version.trim();
    expect(read("ops/tofu/opentofu.sha256")).toMatch(
      new RegExp(`^[0-9a-f]{64}  tofu_${v.replaceAll(".", "\\.")}_linux_amd64\\.zip\\n$`, "u"),
    );
    const required = /required_version = ">= (\d+)\.(\d+)\.0"/u.exec(read("ops/tofu/versions.tf"));
    expect(required).not.toBeNull();
    const [major = 0, minor = 0] = v.split(".").map(Number);
    const [needMajor, needMinor] = [Number(required?.[1]), Number(required?.[2])];
    expect(major > needMajor || (major === needMajor && minor >= needMinor)).toBe(true);
  });

  test("CI's cloud-init check installs jsonschema, without which cloud-init skips the schema", () => {
    // cloud-init 24.4 on AlmaLinux 10 prints "Skipping cloud-config schema validation. Jsonschema
    // dependency missing." and exits 0 when python3-jsonschema is absent, so the check must
    // install it and fail on any file not reported valid, not only on the last one.
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/dnf -qy install cloud-init python3-jsonschema/u);
    expect(ci).toMatch(
      /"Valid schema \$f"\) ;; \*\) exit 1|schema --config-file "\$f" \|\| exit 1/u,
    );
  });
});

// ---- ops/tofu ------------------------------------------------------------------------------------

const TOFU = walk("ops/tofu");
const tf = (name: string) => read(`ops/tofu/${name}`);

/**
 * The top-level blocks of an HCL file, by label ("variable.hosts", "resource.linode_instance.host").
 * `tofu fmt -check` keeps every top-level block's closing brace alone at the start of a line.
 */
const blocks = (text: string) => {
  const found = new Map<string, string>();
  for (const m of text.matchAll(/^([a-z_]+)((?: "[^"]+")*) \{\n([\s\S]*?)^\}$/gmu)) {
    const labels = [...(m[2] ?? "").matchAll(/"([^"]+)"/gu)].map((l) => l[1]);
    found.set([m[1], ...labels].join("."), m[3] ?? "");
  }
  return found;
};
const VARIABLES = blocks(tf("variables.tf"));
const MAIN = blocks(tf("main.tf"));
const OUTPUTS = blocks(tf("outputs.tf"));
const block = (map: Map<string, string>, key: string) => {
  const found = map.get(key);
  if (found === undefined) throw new Error(`no block ${key}`);
  return found;
};

describe("ops/tofu", () => {
  test("the module's files are the ones reviewed, and nothing under .terraform/ is read", () => {
    expect(TOFU).toEqual([
      "ops/tofu/.opentofu-version",
      "ops/tofu/.terraform.lock.hcl",
      "ops/tofu/README.md",
      "ops/tofu/ci/applied.jq",
      "ops/tofu/ci/diag.jq",
      "ops/tofu/ci/masks.jq",
      "ops/tofu/ci/shape.jq",
      "ops/tofu/ci/summary.jq",
      "ops/tofu/ci/tofu-ci.sh",
      "ops/tofu/cloud-init.yaml.tftpl",
      "ops/tofu/examples/example.tfvars.json",
      "ops/tofu/examples/user-data-with-hash.yaml",
      "ops/tofu/examples/user-data-without-hash.yaml",
      "ops/tofu/main.tf",
      "ops/tofu/opentofu.sha256",
      "ops/tofu/outputs.tf",
      "ops/tofu/tests/database-adoption.tftest.hcl",
      "ops/tofu/tests/fixtures/database-adoption-validation/outputs.tf",
      "ops/tofu/tests/main.tftest.hcl",
      "ops/tofu/variables.tf",
      "ops/tofu/versions.tf",
    ]);
  });

  test("every variable is sensitive, validated with fixed text, and the addresses output is sensitive", () => {
    const names = [...VARIABLES.keys()].map((k) => k.replace(/^variable\./u, ""));
    expect(names).toEqual([
      "hosts",
      "root_keys",
      "configure_keys",
      "root_password_hash",
      "cloudflare_zone_id",
      "database_ids",
      "existing_databases",
      "db_allow_extra",
      "state_passphrase",
    ]);
    for (const [name, body] of VARIABLES) {
      expect({ name, sensitive: /^ {2}sensitive\s+= true$/mu.test(body) }).toEqual({
        name,
        sensitive: true,
      });
      expect({ name, validated: body.includes("validation {") }).toEqual({ name, validated: true });
      // A message is one literal: no interpolation or directive that could echo a value.
      for (const m of body.matchAll(/error_message\s*=\s*(.*)$/gmu))
        expect({
          name,
          message: m[1],
          fixed: /^"[^"]*"$/u.test(m[1] ?? "") && !/[$%]\{/u.test(m[1] ?? ""),
        }).toMatchObject({
          fixed: true,
        });
    }
    expect(block(OUTPUTS, "output.addresses")).toMatch(/^ {2}sensitive\s+= true$/mu);
    // hosts carries only public roles; its value must unwrap them explicitly.
    expect(block(OUTPUTS, "output.hosts")).toContain("nonsensitive(var.hosts[k].role)");
  });

  test("the host-key, label, database-key, CIDR and hash validations are present", () => {
    const hosts = block(VARIABLES, "variable.hosts");
    expect(hosts).toContain(
      'can(regex("^(staging|production)(-[0-9]{1,2})?$", k)) && split("-", k)[0] == h.role',
    );
    expect(hosts).toContain('can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label))');
    expect(block(VARIABLES, "variable.database_ids")).toContain('can(regex("^[a-z]{1,16}$", k))');
    expect(block(VARIABLES, "variable.db_allow_extra")).toContain(
      'can(cidrhost(x, 0)) && strcontains(x, "/")',
    );
    expect(block(VARIABLES, "variable.state_passphrase")).toContain(
      "length(var.state_passphrase) >= 32",
    );
    // The root hash pattern, run here as a JavaScript regex: yescrypt or SHA-512 crypt only.
    const hashPattern = /can\(regex\("(\^\(\[\$\]y[^"]+)", var\.root_password_hash\)\)/u.exec(
      block(VARIABLES, "variable.root_password_hash"),
    )?.[1];
    expect(hashPattern).toBeDefined();
    const hash = new RegExp(hashPattern ?? "^$", "u");
    const fake = /root_password_hash = "([^"]+)"/u.exec(tf("tests/main.tftest.hcl"))?.[1] ?? "";
    expect(fake).toContain("EXAMPLE");
    expect(hash.test(fake)).toBe(true);
    expect(hash.test(`$6$rounds=5000$saltsalt$${"a".repeat(86)}`)).toBe(true);
    for (const bad of ["$1$salt$hash", `$y$j9T$salt$${"a".repeat(42)}`, `${fake}\n`, "!", "*"])
      expect({ bad, ok: hash.test(bad) }).toEqual({ bad, ok: false });
  });

  test("OpenTofu renders no host key, private key, fingerprint record or key generator", () => {
    for (const file of TOFU) {
      // Enrollment runs after Apply; these checks concern the infrastructure/cloud-init renderings.
      if (!file.endsWith(".tf") && !file.endsWith(".tftpl")) continue;
      const text = read(file);
      for (const word of [
        "tls_private_key",
        "hashicorp/tls",
        "SSHFP",
        "ssh_keys",
        "PRIVATE KEY",
        "hashicorp/random",
      ])
        expect({ file, word, found: text.includes(word) }).toEqual({ file, word, found: false });
    }
    const test_ = tf("tests/main.tftest.hcl");
    expect(test_).toContain('!strcontains(base64decode(i.metadata[0].user_data), "ssh_keys")');
    expect(test_).toContain('!strcontains(base64decode(i.metadata[0].user_data), "PRIVATE KEY")');
  });

  test("the instance takes its credentials from cloud-init alone, and user data never rebuilds a host", () => {
    const instance = block(MAIN, "resource.linode_instance.host");
    expect(instance).toContain('image           = "linode/almalinux10"');
    expect(instance).toContain('disk_encryption = "enabled"');
    expect(instance).toContain("booted          = true");
    expect(instance).toContain('interface_generation = "legacy_config"');
    expect(instance).toContain('purpose = "public"');
    expect(instance).toContain("user_data = base64encode(local.user_data[each.key])");
    expect(instance).toContain("ignore_changes = [metadata, root_pass]");
    // A throwaway password the provider requires, never a chosen one, and no keys or users.
    expect(instance).toContain(`root_pass = base64sha512("\${uuid()}\${uuid()}")`);
    expect(instance).not.toMatch(/^\s*(authorized_keys|authorized_users)\s*=/mu);
    expect(instance).toContain("contains(keys(var.configure_keys), var.hosts[each.key].role)");
    expect(tf("main.tf")).toContain(
      'root_keys          = concat(var.root_keys, [lookup(var.configure_keys, var.hosts[k].role, "")])',
    );
    // Providers take no inline credentials.
    expect(tf("versions.tf")).toMatch(/^provider "linode" \{\}$/mu);
    expect(tf("versions.tf")).toMatch(/^provider "cloudflare" \{\}$/mu);
    expect(TOFU.map(read).join("\n")).not.toMatch(
      /^\s*(api_token|token|access_key|secret_key)\s*=/mu,
    );
  });

  test("the firewall admits only SSH and ICMP, and the records are unproxied", () => {
    const firewall = block(MAIN, "resource.linode_firewall.host");
    expect(firewall).toContain('inbound_policy  = "DROP"');
    expect(firewall).toContain('outbound_policy = "ACCEPT"');
    const rules = [...firewall.matchAll(/inbound \{\n([\s\S]*?)\n {2}\}/gu)].map((m) => m[1] ?? "");
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatch(/protocol = "TCP"[\s\S]*ports {4}= "22"/u);
    for (const rule of rules) expect(rule).toContain('action   = "ACCEPT"');
    for (const name of [
      "resource.cloudflare_dns_record.a",
      "resource.cloudflare_dns_record.aaaa",
    ]) {
      const record = block(MAIN, name);
      expect(record).toContain("proxied = false");
      expect(record).toContain("ttl     = 300");
    }
    expect(tf("main.tf")).not.toMatch(/type\s*=\s*"(?!A"|AAAA")[A-Z]+"/u);
  });

  test("each access list is the hosts' CIDR entries plus the extras, protected and adopted by import", () => {
    const list = block(MAIN, "resource.linode_database_access_controls.db");
    expect(list).toContain("for_each = local.database_keys");
    expect(list).toContain('database_type = "postgresql"');
    expect(list).toContain("allow_list    = concat(local.host_access, var.db_allow_extra)");
    expect(list).toContain("prevent_destroy = true");
    const main = tf("main.tf");
    // IPv6 first, then IPv4, in the form the API stores.
    expect(main).toMatch(
      /host_access = concat\(\n\s+\[for k in sort\(tolist\(local\.host_keys\)\) : "\$\{local\.host_ipv6\[k\]\}\/128"\],\n\s+\[for k in sort\(tolist\(local\.host_keys\)\) : "\$\{local\.host_ipv4\[k\]\}\/32"\],\n/u,
    );
    // The unchanged access-list import keeps its state address and provider ID form. The separate
    // existing-cluster import is covered by database-adoption-module.test.ts and import-only guards.
    const imports = [...main.matchAll(/^import \{\n([\s\S]*?)^\}$/gmu)].map((m) => m[1] ?? "");
    expect(imports).toHaveLength(2);
    const accessImport = imports.find((value) =>
      value.includes("to = linode_database_access_controls.db[each.key]"),
    );
    expect(accessImport).toContain("for_each = local.database_keys");
    expect(accessImport).toContain("to = linode_database_access_controls.db[each.key]");
    expect(accessImport).toContain(
      `id = nonsensitive("\${var.database_ids[each.key]}:postgresql")`,
    );
    // Both for_each keys come unwrapped from their sensitive maps, as public-safe words.
    expect(main).toContain("host_keys     = nonsensitive(toset(keys(var.hosts)))");
    expect(main).toContain("database_keys = nonsensitive(toset(keys(var.database_ids)))");
  });

  test("state and plans are encrypted, and the backend names no bucket or endpoint", () => {
    const versions = tf("versions.tf");
    const backend = /backend "s3" \{\n([\s\S]*?)\n {2}\}/u.exec(versions)?.[1] ?? "";
    expect(backend).toContain('key = "tarubot/infra.tfstate"');
    expect(backend).toContain('region = "us-east-1"');
    for (const skip of [
      "skip_credentials_validation",
      "skip_region_validation",
      "skip_requesting_account_id",
      "skip_metadata_api_check",
      "skip_s3_checksum",
    ])
      expect(backend).toMatch(new RegExp(`^\\s+${skip}\\s+= true$`, "mu"));
    expect(backend).not.toMatch(
      /^\s*(bucket|endpoints?|use_path_style|use_lockfile|access_key|secret_key|profile)\s*=/mu,
    );
    expect(versions).toContain("passphrase = var.state_passphrase");
    expect(versions).toMatch(/method "aes_gcm" "state" \{\n\s+keys = key_provider\.pbkdf2\.state/u);
    for (const kind of ["state", "plan"])
      expect(versions).toMatch(
        new RegExp(
          `\\n {4}${kind} \\{\\n {6}method {3}= method\\.aes_gcm\\.state\\n {6}enforced = true\\n {4}\\}`,
          "u",
        ),
      );
    // Two providers, each held to its release line; the lock file pins them with hashes.
    expect([...versions.matchAll(/source\s+= "([^"]+)"/gu)].map((m) => m[1])).toEqual([
      "linode/linode",
      "cloudflare/cloudflare",
    ]);
    const constraints = Object.fromEntries(
      [...versions.matchAll(/source\s+= "([^"]+)"\n\s+version = "(~> [\d.]+)"/gu)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const lock = tf(".terraform.lock.hcl");
    for (const [source, constraint] of Object.entries(constraints)) {
      const entry = new RegExp(
        `provider "registry\\.opentofu\\.org/${source}" \\{\\n\\s+version\\s+= "([\\d.]+)"\\n\\s+constraints = "${constraint}"\\n\\s+hashes = \\[\\n((?:\\s+"(?:h1|zh):[^"]+",\\n)+)`,
        "u",
      ).exec(lock);
      expect({ source, locked: entry !== null }).toEqual({ source, locked: true });
      expect(entry?.[2]).toMatch(/"h1:/u);
      expect(entry?.[2]).toMatch(/"zh:/u);
    }
    expect([...lock.matchAll(/^provider "([^"]+)"/gmu)].map((m) => m[1])).toEqual([
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/linode/linode",
    ]);
  });

  test("the user data seeds verify-required and carries only keys, the hash and the hostname", () => {
    const vars = JSON.parse(tf("examples/example.tfvars.json"));
    const keys = [...vars.root_keys, vars.configure_keys.staging];
    for (const [file, withHash] of [
      ["examples/user-data-without-hash.yaml", false],
      ["examples/user-data-with-hash.yaml", true],
    ] as const) {
      const text = tf(file);
      expect(text.startsWith("#cloud-config\n")).toBe(true);
      const data = YAML.parse(text) as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(
        [
          "disable_root",
          "fqdn",
          "hostname",
          "packages",
          "ssh_authorized_keys",
          "ssh_deletekeys",
          "ssh_genkeytypes",
          "ssh_pwauth",
          "users",
          "write_files",
          withHash ? "chpasswd" : "runcmd",
        ].sort(),
      );
      expect(data).toMatchObject({
        hostname: "staging",
        fqdn: "staging.example.org",
        users: [],
        disable_root: false,
        ssh_pwauth: false,
        ssh_deletekeys: true,
        ssh_genkeytypes: ["ed25519"],
        ssh_authorized_keys: keys,
        packages: ["python3", "python3-libselinux"],
      });
      expect(data.write_files).toEqual([
        {
          path: "/etc/ssh/sshd_config.d/00-tarubot.conf",
          owner: "root:root",
          permissions: "0600",
          content: expect.stringMatching(/^(?:# .*\n){2}PubkeyAuthOptions verify-required\n$/u),
        },
      ]);
      if (withHash)
        expect(data.chpasswd).toEqual({
          expire: false,
          users: [
            { name: "root", type: "hash", password: expect.stringMatching(/^\$y\$.*EXAMPLE/u) },
          ],
        });
      else expect(data.runcmd).toEqual([["usermod", "--lock", "root"]]);
    }
    // The template seeds the same line, in write_files.
    expect(tf("cloud-init.yaml.tftpl")).toMatch(
      /^write_files:\n {2}- path: \/etc\/ssh\/sshd_config\.d\/00-tarubot\.conf\n[\s\S]*\n {6}PubkeyAuthOptions verify-required\n/mu,
    );
  });

  test("the example values are placeholders: staging only, fake keys and IDs, no passphrase", () => {
    const vars = JSON.parse(tf("examples/example.tfvars.json"));
    expect(Object.keys(vars).sort()).toEqual([
      "cloudflare_zone_id",
      "configure_keys",
      "database_ids",
      "db_allow_extra",
      "existing_databases",
      "hosts",
      "root_keys",
      "root_password_hash",
    ]);
    expect(Object.keys(vars.hosts)).toEqual(["staging"]);
    expect(vars.cloudflare_zone_id).toBe("0".repeat(32));
    expect(vars.database_ids).toEqual({ primary: "0" });
    expect(vars.existing_databases).toEqual({});
    expect(vars.root_password_hash).toBe("");
    for (const key of [...vars.root_keys, ...Object.values(vars.configure_keys)])
      expect(key).toMatch(/EXAMPLE/u);
  });
});

describe("no host and no real address", () => {
  /** Host names ending in a common top-level domain (not .host, .sh or .md, which name files and resources here). */
  const hostNames = (text: string) =>
    [
      ...text
        // A key type, not a host.
        .replaceAll("sk-ssh-ed25519@openssh.com", "")
        .matchAll(
          /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca))(?:$|(?=[^a-z0-9]))/gimu,
        ),
    ].map((m) => (m[1] ?? "").toLowerCase());
  const FILES = [...TOFU, INFRA];

  test("the host check catches what it must", () => {
    for (const sample of [
      "staging.example.net",
      "db.example.com.",
      "https://host.linodeobjects.com/x",
    ])
      expect({ sample, caught: hostNames(sample).length > 0 }).toEqual({ sample, caught: true });
    expect(hostNames("linode_instance.host main.tf README.md sk-ssh-ed25519@openssh.com")).toEqual(
      [],
    );
  });

  test("hostnames are limited to public documentation, placeholders and the endpoint's shape", () => {
    for (const file of FILES) {
      const text = read(file);
      const allowed = (host: string) =>
        host === "github.com" ||
        host === "example.org" ||
        host.endsWith(".example.org") ||
        // Public provider documentation is not a private infrastructure identifier.
        (host === "techdocs.akamai.com" && file === "ops/tofu/README.md") ||
        (host === "registry.opentofu.org" && file === "ops/tofu/.terraform.lock.hcl");
      const hosts = [...new Set(hostNames(text))].filter((h) => !allowed(h));
      // The README shows the endpoint only as a shape.
      const shaped = hosts.filter(
        (h) => h === "linodeobjects.com" && file === "ops/tofu/README.md",
      );
      expect({ file, hosts: hosts.filter((h) => !shaped.includes(h)) }).toEqual({
        file,
        hosts: [],
      });
      if (shaped.length > 0)
        expect(
          text
            .match(/[a-z0-9<>.-]*linodeobjects\.com/gu)
            ?.every((h) => h === "<region>.linodeobjects.com"),
        ).toBe(true);
    }
  });

  test("addresses come only from the documentation ranges, apart from the firewall's any-address", () => {
    for (const file of FILES) {
      const text = read(file).replace(/"h1:[^"]+"|"zh:[^"]+"/gu, "");
      for (const [address] of text.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/gu))
        expect({
          file,
          address,
          documentation: /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$|^0\.0\.0\.0$/u.test(
            address,
          ),
        }).toMatchObject({
          documentation: true,
        });
      for (const [address] of text.matchAll(
        /(?<![\w:])[0-9a-f]{1,4}:[0-9a-f]{0,4}:[0-9a-f:]*(?![\w:])/giu,
      ))
        expect({ file, address, documentation: /^2001:db8:/iu.test(address) }).toMatchObject({
          documentation: true,
        });
    }
  });
});

// ---- The jq programs and the script's phases, run --------------------------------------------

/** Run jq over a value with one of the programs beside the script. */
function jq(program: string, input: string, args: string[] = []) {
  const run = Bun.spawnSync(["jq", ...args, "-f", root(`ops/tofu/ci/${program}`)], {
    stdin: new TextEncoder().encode(input),
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}
const EXAMPLE = read("ops/tofu/examples/example.tfvars.json");
const example = () => JSON.parse(EXAMPLE) as Record<string, unknown> & { hosts: object };

/** A plan's resource change, in the shape of `tofu show -json`. */
const change = (
  address: string,
  actions: string[],
  fields: {
    before?: object | null;
    after?: object | null;
    after_unknown?: object;
    importing?: object;
  } = {},
) => {
  const [, type, name, index] =
    /^([a-z_]+)\.([a-z_]+)(?:\["([a-z0-9-]+)"\])?$/u.exec(address) ?? [];
  return {
    address,
    type,
    name,
    ...(index === undefined ? {} : { index }),
    change: { actions, before: {}, after: {}, after_unknown: {}, ...fields },
  };
};
const SUMMARY_VARS = ["--slurpfile", "vars", root("ops/tofu/examples/example.tfvars.json"), "-r"];

describe.skipIf(!hasJq)("the jq programs", () => {
  test("shape.jq takes the example and refuses what the masks can't rely on", () => {
    expect(jq("shape.jq", EXAMPLE, ["-e"]).code).toBe(0);
    // A label is any string now; only variables.tf holds Linode's rules.
    const plainLabel = example();
    Object.assign((plainLabel.hosts as Record<string, object>).staging ?? {}, { label: "tarubot" });
    expect(jq("shape.jq", JSON.stringify(plainLabel), ["-e"]).code).toBe(0);
    for (const [what, edit] of [
      ["an extra key", (v: Record<string, unknown>) => Object.assign(v, { more: 1 })],
      ["a host key", (v: Record<string, unknown>) => Object.assign(v, { hosts: { stage: {} } })],
      [
        "an upper-case fqdn",
        (v: Record<string, unknown>) => {
          Object.assign((v.hosts as Record<string, object>).staging ?? {}, {
            fqdn: "Staging.Example.Org",
          });
        },
      ],
      ["a zone ID", (v: Record<string, unknown>) => Object.assign(v, { cloudflare_zone_id: "x" })],
      [
        "an extra entry",
        (v: Record<string, unknown>) => Object.assign(v, { db_allow_extra: ["x"] }),
      ],
    ] as const) {
      const value = example();
      edit(value);
      expect({ what, code: jq("shape.jq", JSON.stringify(value), ["-e"]).code }).toEqual({
        what,
        code: 1,
      });
    }
    expect(jq("shape.jq", "not json", ["-e"]).code).not.toBe(0);
  });

  test("masks.jq lists the names, the zone, the extras, the hash and each key's base64, never a label", () => {
    const value = example();
    Object.assign(value, { root_password_hash: "$y$j9T$EXAMPLEsalt$EXAMPLEhashEXAMPLEhash" });
    const masks = JSON.parse(jq("masks.jq", JSON.stringify(value), ["-c"]).out) as string[];
    expect(masks).toContain("staging.example.org");
    expect(masks).toContain("0".repeat(32));
    expect(masks).toContain("$y$j9T$EXAMPLEsalt$EXAMPLEhashEXAMPLEhash");
    for (const extra of value.db_allow_extra as string[]) {
      expect(masks).toContain(extra);
      expect(masks).toContain(extra.split("/")[0] ?? "");
    }
    for (const key of [
      ...(value.root_keys as string[]),
      ...Object.values(value.configure_keys as object),
    ])
      expect(masks).toContain(
        String(key)
          .split(" ")
          .find((part) => part.startsWith("AAAA")) ?? "",
      );
    for (const word of ["tarubot-staging", "staging", "primary", "us-east", "g6-standard-1"])
      expect({ word, masked: masks.includes(word) }).toEqual({ word, masked: false });
  });

  test("summary.jq names each change, counts access-list entries, and turns the unknown into ?", () => {
    const summarize = (changes: object[]) =>
      jq("summary.jq", JSON.stringify({ resource_changes: changes }), SUMMARY_VARS).out;
    const extra = JSON.parse(EXAMPLE).db_allow_extra as string[];
    // A new host: its addresses are unknown, so the list's counts are rebuilt (two per host).
    expect(
      summarize([
        change('linode_instance.host["staging"]', ["create"], {
          after_unknown: { ipv4: true, ipv6: true },
        }),
        change('linode_firewall.host["staging"]', ["create"]),
        change('cloudflare_dns_record.a["staging"]', ["create"]),
        change('linode_database_access_controls.db["primary"]', ["update"], {
          before: { allow_list: extra },
          after: {},
          after_unknown: { allow_list: true },
        }),
      ]),
    ).toBe(
      [
        'create cloudflare_dns_record.a["staging"]',
        'create linode_firewall.host["staging"]',
        'create linode_instance.host["staging"]',
        'update linode_database_access_controls.db["primary"] +2 -0',
        "",
      ].join("\n"),
    );
    // A rebuild: a replace, and the old addresses leave the list.
    expect(
      summarize([
        change('linode_instance.host["staging"]', ["delete", "create"], {
          before: { ipv4: ["192.0.2.10"], ipv6: "2001:db8:1::10/128" },
          after_unknown: { ipv4: true, ipv6: true },
        }),
        change('linode_database_access_controls.db["primary"]', ["update"], {
          before: { allow_list: ["2001:db8:1::10/128", "192.0.2.10/32", ...extra] },
          after: {},
          after_unknown: { allow_list: true },
        }),
      ]),
    ).toBe(
      'replace linode_instance.host["staging"]\nupdate linode_database_access_controls.db["primary"] +2 -2\n',
    );
    // An import with a known list, no-ops left out, and what it can't name as ?.
    expect(
      summarize([
        change('linode_database_access_controls.db["primary"]', ["no-op"], {
          before: { allow_list: extra },
          after: { allow_list: extra },
          importing: { id: "0:postgresql" },
        }),
        change('linode_firewall.host["staging"]', ["no-op"]),
        change('linode_firewall.host["staging"]', ["forget"]),
        change("module.other.thing", ["create"]),
      ]),
    ).toBe(
      [
        '? linode_firewall.host["staging"]',
        "create ?",
        'import linode_database_access_controls.db["primary"] +0 -0',
        "",
      ].join("\n"),
    );
  });

  test("diag.jq prints severity, address, place and a summary with no digit, '/', '@', '=' or dotted name", () => {
    const masks = join(tmpdir(), `infra-masks-${process.pid}.json`);
    writeFileSync(masks, JSON.stringify(["tarubot-lab-label", "staging.example.org"]));
    try {
      const lines = [
        {
          type: "diagnostic",
          diagnostic: {
            severity: "error",
            summary:
              "Error 403 for db 123456 at https://api.example.org/v4/x?id=9 from 192.0.2.10 and 2001:db8::1, key=AAAAC3Nz@host",
            detail: "the detail never prints",
            address: 'provider["registry.opentofu.org/linode/linode"]',
          },
        },
        {
          type: "diagnostic",
          diagnostic: {
            severity: "error",
            summary: "Record staging.example.org exists; label tarubot-lab-label in use",
            address: 'cloudflare_dns_record.a["staging"]',
            range: { filename: "main.tf", start: { line: 46 } },
          },
        },
        { type: "change_summary", changes: { add: 1 } },
      ]
        .map((line) => JSON.stringify(line))
        .concat(["not json at all"])
        .join("\n");
      const out = jq("diag.jq", lines, ["-rR", "--slurpfile", "masks", masks]).out;
      expect(out).toBe(
        [
          "error ? Error for db at https:(name) from ... and :db::, keyAAAACNzhost",
          'error cloudflare_dns_record.a["staging"] main.tf:46 Record (masked) exists label (masked) in use',
          "",
        ].join("\n"),
      );
      // The one number left is the module's own line.
      expect(out.replace("main.tf:46", "")).not.toMatch(/[0-9/@=]|example|detail/u);
    } finally {
      rmSync(masks, { force: true });
    }
  });

  test("applied.jq prints only the apply's counts", () => {
    const out = jq(
      "applied.jq",
      [
        JSON.stringify({ type: "apply_complete", hook: { resource: { addr: "x" } } }),
        JSON.stringify({
          type: "change_summary",
          changes: { add: 4, change: 1, import: 0, remove: 0, operation: "apply" },
        }),
      ].join("\n"),
      ["-rR"],
    ).out;
    expect(out).toBe("applied: 4 added, 1 changed, 0 imported, 0 destroyed\n");
  });
});

describe.skipIf(!hasJq)("tofu-ci.sh's phases, with a stand-in for tofu", () => {
  const scratch = mkdtempSync(join(tmpdir(), "infra-phases-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let boxes = 0;

  /**
   * A runner: the stand-in tofu first on PATH, RUNNER_TEMP, the step files, and a
   * dispatch's event payload with an empty replace input.
   */
  function runner() {
    const dir = join(scratch, `r${++boxes}`);
    for (const path of ["bin", "temp", "stub"]) mkdirSync(join(dir, path), { recursive: true });
    cpSync(root("tests/fixtures/infra/tofu"), join(dir, "bin", "tofu"));
    chmodSync(join(dir, "bin", "tofu"), 0o755);
    // Every controller call uses the real record engines with invented filesystem/native helpers.
    // Even disabled-record preflight must never make a native S3, provider, SSH or DNS request.
    const wrapper = join(dir, "bin", "bun");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [[ $1 == */scripts/infra-control-cli.ts ]]; then\n  exec "\${TEST_REAL_BUN:?}" "\${CONTROL_FIXTURE:?}" "\${@:2}"\nfi\nexec "\${TEST_REAL_BUN:?}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    for (const name of ["env", "output", "summary", "path"]) writeFileSync(join(dir, name), "");
    const event = (replace: string) =>
      writeFileSync(
        join(dir, "event.json"),
        JSON.stringify({ inputs: { operation: "apply", replace, allow_destroy: "false" } }),
      );
    event("");
    const phase = (name: string, env: Record<string, string> = {}) => {
      const r = Bun.spawnSync(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", root(SCRIPT), name],
        {
          env: {
            PATH: `${join(dir, "bin")}:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
            HOME: dir,
            STUB: join(dir, "stub"),
            RUNNER_TEMP: join(dir, "temp"),
            GITHUB_ENV: join(dir, "env"),
            GITHUB_OUTPUT: join(dir, "output"),
            GITHUB_STEP_SUMMARY: join(dir, "summary"),
            GITHUB_PATH: join(dir, "path"),
            GITHUB_EVENT_PATH: join(dir, "event.json"),
            GITHUB_SHA: "1".repeat(40),
            GITHUB_RUN_ID: "1234",
            GITHUB_RUN_ATTEMPT: "1",
            // Prepare also invokes the real Bun validator before the injected controller phase.
            TEST_REAL_BUN: process.execPath,
            CONTROL_FIXTURE: root("tests/fixtures/infra/control.ts"),
            ...env,
          },
          stdin: "ignore",
        },
      );
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const file = (path: string) => readFileSync(join(dir, path), "utf8");
    return { dir, phase, file, event };
  }
  const PREPARED = {
    TOFU_VARS: EXAMPLE,
    STATE_BUCKET: "state-bucket-example",
    STATE_ENDPOINT: "https://us-east-1.example.org",
  };
  const STATE = {
    AWS_ACCESS_KEY_ID: "access-example",
    AWS_SECRET_ACCESS_KEY: "secret-example",
    TF_VAR_state_passphrase: "a throwaway passphrase of 32 or more characters",
  };
  /** A saved plan's `variables`, as `tofu show -json` gives them: every value, the passphrase too. */
  const planned = (values: Record<string, unknown>) => ({
    ...Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
    state_passphrase: { value: STATE.TF_VAR_state_passphrase },
  });

  /** Run the actual controller in child phases with an injected encrypted filesystem transport. */
  test("owner-enabled baseline establishment journals unchanged state and invokes no provider Apply", () => {
    const r = runner();
    const values = { ...example(), hosts: {}, configure_keys: {}, database_ids: {} };
    const state = {
      version: 4,
      terraform_version: "1.12.6",
      lineage: "11111111-1111-4111-8111-111111111111",
      serial: 10,
      resources: [],
      outputs: {},
    };
    const full = {
      format_version: "1.2",
      terraform_version: "1.12.6",
      errored: false,
      variables: planned(values),
      resource_changes: [],
      planned_values: {
        root_module: { resources: [] },
        outputs: { addresses: { value: {} }, hosts: { value: {} } },
      },
      output_changes: Object.fromEntries(
        ["addresses", "hosts"].map((key) => [
          key,
          { actions: ["no-op"], before: {}, after: {}, after_unknown: false },
        ]),
      ),
    };
    writeFileSync(
      join(r.dir, "event.json"),
      JSON.stringify({ inputs: { operation: "baseline", replace: "" } }),
    );
    writeFileSync(join(r.dir, "stub", "plan.json"), JSON.stringify(full));
    writeFileSync(join(r.dir, "stub", "state.json"), JSON.stringify(state));
    const credentials = {
      ...STATE,
      CONTROL_RECORDS_ENABLED: "true",
      TEST_REAL_BUN: process.execPath,
      CONTROL_FIXTURE: root("tests/fixtures/infra/control.ts"),
      LINODE_TOKEN: "invented-token",
      CLOUDFLARE_API_TOKEN: "invented-token",
    };
    expect(r.phase("prepare", { ...PREPARED, TOFU_VARS: JSON.stringify(values) }).code).toBe(0);
    expect(r.phase("control_read", credentials).code).toBe(0);
    expect(r.phase("plan", credentials).code).toBe(0);
    expect(r.phase("summarize", credentials).code).toBe(0);
    const output = r.file("output");
    const reviewed = {
      ...credentials,
      DIGEST: /^digest=(.+)$/mu.exec(output)?.[1] ?? "",
      BINDING: /^binding=(.+)$/mu.exec(output)?.[1] ?? "",
      APPROVED: "",
    };
    expect(r.phase("compare", reviewed).code).toBe(0);
    expect(r.phase("baseline", reviewed)).toEqual({
      code: 0,
      out: "Initial applied-input baseline established; no provider or state mutation.\n",
      err: "",
    });
    expect(r.phase("control_read", credentials).code).toBe(0);
    expect(JSON.parse(r.file("temp/tofu/baseline-inputs.json"))).toEqual(values);
    for (const call of new Bun.Glob("*").scanSync({ cwd: join(r.dir, "stub", "calls") }))
      expect(r.file(`stub/calls/${call}`)).not.toMatch(/^apply$/mu);
    // A second establishment or stale approved snapshot cannot replace the baseline.
    expect(r.phase("baseline", reviewed).code).toBe(1);

    // A later reviewed host plan uses the persisted baseline; Apply never replans.
    const current = example();
    const managed = {
      address: 'linode_instance.host["staging"]',
      mode: "managed",
      type: "linode_instance",
      name: "host",
      index: "staging",
      provider_name: "registry.opentofu.org/linode/linode",
      values: {
        id: "200",
        label: "example-staging",
        ipv4: ["198.51.100.10"],
        ipv6: "2001:db8::10/128",
      },
    };
    const dns = (["a", "aaaa"] as const).map((name) => ({
      address: `cloudflare_dns_record.${name}["staging"]`,
      mode: "managed",
      type: "cloudflare_dns_record",
      name,
      index: "staging",
      provider_name: "registry.opentofu.org/cloudflare/cloudflare",
      values: {
        zone_id: current.cloudflare_zone_id,
        name: (current.hosts as Record<string, { fqdn: string }>).staging?.fqdn,
        type: name === "a" ? "A" : "AAAA",
        content: name === "a" ? "198.51.100.10" : "2001:db8::10",
        proxied: false,
      },
    }));
    const resources = [managed, ...dns];
    const candidate = {
      ...full,
      variables: planned(current),
      resource_changes: resources.map((resource) => ({
        ...resource,
        change: { actions: ["create"], before: null, after: resource.values, after_unknown: {} },
      })),
      planned_values: { ...full.planned_values, root_module: { resources } },
    };
    writeFileSync(
      join(r.dir, "event.json"),
      JSON.stringify({ inputs: { operation: "apply", replace: "" } }),
    );
    writeFileSync(join(r.dir, "stub", "plan.json"), JSON.stringify(candidate));
    writeFileSync(
      join(r.dir, "stub", "state.after.json"),
      JSON.stringify({ ...state, serial: 11, resources: [{ invented: "applied" }] }),
    );
    writeFileSync(
      join(r.dir, "stub", "applied-state.json"),
      JSON.stringify({
        format_version: "1.0",
        terraform_version: "1.12.6",
        values: candidate.planned_values,
      }),
    );
    expect(r.phase("prepare", PREPARED).code).toBe(0);
    expect(r.phase("control_read", credentials).code).toBe(0);
    expect(r.phase("plan", credentials).code).toBe(0);
    expect(r.phase("summarize", credentials).code).toBe(0);
    const lastOutput = (key: string) =>
      [...r.file("output").matchAll(new RegExp(`^${key}=(.+)$`, "gmu"))].at(-1)?.[1] ?? "";
    const reviewedApply = {
      ...credentials,
      DIGEST: lastOutput("digest"),
      BINDING: lastOutput("binding"),
      APPROVED: resources
        .map((resource) => `create ${resource.address}`)
        .sort()
        .join("\n"),
    };
    expect(r.phase("compare", reviewedApply).code).toBe(0);
    // A lost DNS acknowledgement leaves both durable pending records. Removing that host from
    // later inputs does not hide the fixed pending index, and a retry offers no provider Apply.
    const uncertain = runner();
    for (const path of ["stub", "temp"])
      cpSync(join(r.dir, path), join(uncertain.dir, path), { recursive: true });
    cpSync(join(r.dir, "event.json"), join(uncertain.dir, "event.json"));
    writeFileSync(join(uncertain.dir, "stub", "fail-enrollment-dns"), "1");
    expect(uncertain.phase("apply", reviewedApply).code).toBe(1);
    const appliedCalls = () =>
      readdirSync(join(uncertain.dir, "stub", "calls")).filter((name) =>
        uncertain.file(`stub/calls/${name}`).includes("\napply\n"),
      ).length;
    expect(appliedCalls()).toBe(1);
    writeFileSync(
      join(uncertain.dir, "temp", "tofu", "values.tfvars.json"),
      JSON.stringify(values),
    );
    writeFileSync(join(uncertain.dir, "temp", "tofu", "plan.json"), JSON.stringify(full));
    writeFileSync(
      join(uncertain.dir, "temp", "tofu", "verified.binding"),
      handoffBinding(join(uncertain.dir, "temp", "tofu"), {
        ...STATE,
        GITHUB_SHA: "1".repeat(40),
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_EVENT_PATH: join(uncertain.dir, "event.json"),
      }),
    );
    expect(uncertain.phase("apply", reviewedApply).code).toBe(1);
    expect(appliedCalls()).toBe(1);
    expect(uncertain.phase("control_read", credentials).code).toBe(1);
    const privateCodec = hostRecordCodec(
      PREPARED.STATE_BUCKET,
      PREPARED.STATE_ENDPOINT,
      STATE.TF_VAR_state_passphrase,
    );
    const pending = privateCodec.open(
      "hosts/pending",
      readFileSync(join(uncertain.dir, "stub", "control-objects", "hosts/pending")),
    );
    expect(pending).toEqual({ schema: 1, targets: ["staging"] });
    expect(uncertain.file("stub/enrollment-stages")).toBe(
      "verify-instance\nscan-key\npublish-sshfp\n",
    );
    const result = r.phase("apply", reviewedApply);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Applied state verified and durable baseline completed.");
    expect(result.out).toContain("durable first-host enrollment completed");
    expect(r.file("stub/enrollment-stages")).toBe(
      "verify-instance\nscan-key\npublish-sshfp\nvalidate-dnssec\n",
    );
    const trust = privateCodec.open(
      "hosts/staging",
      readFileSync(join(r.dir, "stub", "control-objects", "hosts/staging")),
    ) as {
      status: string;
      host: { generation: string; instanceId: number };
      observed: { key: string };
    };
    expect(trust.status).toBe("complete");
    expect(trust.host.instanceId).toBe(200);
    expect(trust.host.generation).toBe(
      JSON.parse(r.file("temp/tofu/control-ticket.json")).generation,
    );
    for (const marker of [
      trust.observed.key,
      "198.51.100.10",
      "2001:db8::10",
      "staging.example.org",
    ])
      expect(result.out + result.err).not.toContain(marker);
    expect(r.phase("control_read", credentials).code).toBe(0);
    expect(JSON.parse(r.file("temp/tofu/baseline-inputs.json"))).toEqual(current);

    // Attempting another new host for the already enrolled target stops BEFORE a provider call.
    const beforeConflict = readdirSync(join(r.dir, "stub", "calls")).length;
    expect(r.phase("apply", reviewedApply).code).toBe(1);
    expect(readdirSync(join(r.dir, "stub", "calls"))).toHaveLength(beforeConflict);
    // A non-creation provider error still leaves Infra pending; no fresh run silently clears it.
    const update = {
      ...candidate,
      resource_changes: resources.map((resource) => ({
        ...resource,
        change: {
          actions: ["no-op"],
          before: resource.values,
          after: resource.values,
          after_unknown: {},
        },
      })),
    };
    const hostUpdate = update.resource_changes[0];
    if (!hostUpdate) throw new Error("missing-invented-host");
    hostUpdate.change.actions = ["update"];
    writeFileSync(join(r.dir, "stub", "plan.json"), JSON.stringify(update));
    expect(r.phase("plan", credentials).code).toBe(0);
    expect(r.phase("summarize", credentials).code).toBe(0);
    const retry = {
      ...reviewedApply,
      APPROVED: 'update linode_instance.host["staging"]',
      DIGEST: lastOutput("digest"),
      BINDING: lastOutput("binding"),
    };
    expect(r.phase("compare", retry).code).toBe(0);
    writeFileSync(join(r.dir, "stub", "exit.apply"), "1");
    expect(r.phase("apply", retry).code).toBe(1);
    expect(r.phase("control_read", credentials).code).toBe(1);
    expect(r.phase("apply", retry).code).toBe(1);
  });

  test("disabled control records read no state, while invalid flags fail closed", () => {
    const r = runner();
    r.phase("prepare", PREPARED);
    expect(r.phase("control_read").code).toBe(0);
    expect(JSON.parse(r.file("temp/tofu/control-context.json"))).toEqual({ enabled: false });
    expect(existsSync(join(r.dir, "stub", "calls"))).toBe(false);
    const bad = r.phase("control_read", { CONTROL_RECORDS_ENABLED: "invalid-private-marker" });
    expect(bad.code).toBe(1);
    expect(bad.out + bad.err).not.toContain("invalid-private-marker");
    expect(r.phase("baseline", STATE).code).toBe(1);
  });

  test("prepare escapes private multiline mask commands before any value can split into public lines", () => {
    const values = example();
    values.existing_databases = {
      primary: {
        label: "invented-first%\r\ninvented-second",
        engine_id: "postgresql/17",
        region: "us-east",
        type: "g6-standard-1",
        cluster_size: 1,
        suspended: false,
        expected_encrypted: true,
        expected_ssl_connection: true,
        updates: { day_of_week: 2, duration: 4, frequency: "weekly", hour_of_day: 22 },
        private_network: null,
        engine_config: { engine_config_pg_timezone: "xy" },
      },
    };
    const result = runner().phase("prepare", { ...PREPARED, TOFU_VARS: JSON.stringify(values) });
    expect(result.code).toBe(0);
    expect(result.out).toContain("::add-mask::invented-first%25%0D%0Ainvented-second\n");
    expect(result.out).toContain("::add-mask::xy\n");
    expect(result.out.split("\n")).not.toContain("invented-second");
    expect(result.err).toBe("");
  });

  test("prepare masks every identifying value first, and writes only private files", () => {
    const r = runner();
    const done = r.phase("prepare", PREPARED);
    expect({ code: done.code, err: done.err }).toEqual({ code: 0, err: "" });
    const lines = done.out.trimEnd().split("\n");
    const masks = JSON.parse(jq("masks.jq", EXAMPLE, ["-c"]).out) as string[];
    expect(lines.slice(0, masks.length)).toEqual(masks.map((m) => `::add-mask::${m}`));
    expect(lines.slice(masks.length)).toEqual([
      "Prepared the values for 1 host(s) and 1 access list(s).",
    ]);
    expect(r.file("env")).toBe(`TF_DATA_DIR=${join(r.dir, "temp", "tofu")}/data\n`);
    expect(r.file("temp/tofu/backend.hcl")).toContain('bucket         = "state-bucket-example"');
    expect(JSON.parse(r.file("temp/tofu/values.tfvars.json"))).toEqual(JSON.parse(EXAMPLE));
    // A value the shape refuses: one fixed error, no mask, nothing of the value.
    const bad = runner().phase("prepare", {
      ...PREPARED,
      TOFU_VARS: '{"hosts": "staging.example.org"}',
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toStartWith("::error::TOFU_VARS must match the required keys");
    expect(bad.out + bad.err).not.toContain("example.org");
    // A replace, read from the event payload, names one configured host's instance, and is never
    // echoed back, not even a host name typed in its place.
    for (const replace of [
      'linode_instance.host["production"]',
      "linode_instance.host",
      "x; id",
      "other.example.net",
      "192.0.2.99",
    ]) {
      const box = runner();
      box.event(replace);
      const refused = box.phase("prepare", PREPARED);
      expect({ replace, code: refused.code }).toEqual({ replace, code: 1 });
      expect(refused.out.trimEnd().split("\n").at(-1)).toBe(
        '::error::replace must be exactly linode_instance.host["<key>"], naming a host in TOFU_VARS.',
      );
      // A host name or address typed in its place never reaches the log.
      if (!replace.startsWith("linode_instance"))
        expect({ replace, echoed: (refused.out + refused.err).includes(replace) }).toEqual({
          replace,
          echoed: false,
        });
    }
    const staging = runner();
    staging.event('linode_instance.host["staging"]');
    expect(staging.phase("prepare", PREPARED).code).toBe(0);
    expect(staging.file("temp/tofu/replace")).toBe('linode_instance.host["staging"]');
    expect(r.file("temp/tofu/replace")).toBe("");
    // A replace in env: is ignored: the step never sets one.
    const ignored = runner();
    expect(
      ignored.phase("prepare", { ...PREPARED, REPLACE: 'linode_instance.host["production"]' }).code,
    ).toBe(0);
    expect(ignored.file("temp/tofu/replace")).toBe("");
    // Without a readable payload, prepare stops with a fixed message.
    expect(
      runner().phase("prepare", { ...PREPARED, GITHUB_EVENT_PATH: join(scratch, "none.json") }).out,
    ).toEndWith("::error::The dispatch's inputs couldn't be read from the event payload.\n");
  });

  test("init, plan and summarize keep tofu's output private, list the changes and apply the guards", () => {
    const r = runner();
    expect(r.phase("prepare", PREPARED).code).toBe(0);
    expect(r.phase("init", STATE)).toEqual({ code: 0, out: "init ok\n", err: "" });
    const tokens = { ...STATE, LINODE_TOKEN: "t", CLOUDFLARE_API_TOKEN: "t" };
    expect(r.phase("plan", tokens)).toEqual({ code: 0, out: "plan ok\n", err: "" });
    // A plan with a replace and an access-list removal.
    writeFileSync(
      join(r.dir, "stub", "plan.json"),
      JSON.stringify({
        resource_changes: [
          change('linode_instance.host["staging"]', ["delete", "create"], {
            after_unknown: { ipv4: true, ipv6: true },
          }),
          change('linode_database_access_controls.db["primary"]', ["update"], {
            before: { allow_list: ["2001:db8:1::10/128", "192.0.2.10/32"] },
            after: {},
            after_unknown: { allow_list: true },
          }),
        ],
      }),
    );
    const guarded = r.phase("summarize", {
      TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
      ALLOW_DESTROY: "false",
      ALLOW_ACCESS_REMOVAL: "false",
    });
    expect(guarded.code).toBe(1);
    expect(guarded.out).toBe(
      [
        "The plan's changes:",
        'replace linode_instance.host["staging"]',
        'update linode_database_access_controls.db["primary"] +4 -2',
        "::error::The plan deletes or replaces a resource; dispatch again with allow_destroy if you meant it.",
        "::error::The plan removes an entry from a database access list; dispatch again with allow_access_removal if you meant it.",
        "",
      ].join("\n"),
    );
    expect(r.file("summary")).toContain('| replace | `linode_instance.host["staging"]` |  |');
    const output = r.file("output");
    expect(output).toMatch(/^changes<<changes_[0-9a-f]{32}\nreplace /u);
    expect(output).toContain("has_changes=true\n");
    // The saved plan's SHA-256, which the Apply job checks the fetched file against.
    const saved = readFileSync(join(r.dir, "temp", "tofu", "plan.bin"));
    expect(output).toContain(
      `\ndigest=${new Bun.CryptoHasher("sha256").update(saved).digest("hex")}\n`,
    );
    const allowed = runner();
    allowed.phase("prepare", PREPARED);
    writeFileSync(
      join(allowed.dir, "stub", "plan.json"),
      readFileSync(join(r.dir, "stub", "plan.json")),
    );
    writeFileSync(join(allowed.dir, "temp", "tofu", "plan.bin"), "a saved plan");
    expect(
      allowed.phase("summarize", {
        TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
        ALLOW_DESTROY: "true",
        ALLOW_ACCESS_REMOVAL: "true",
      }).code,
    ).toBe(0);
    // Every tofu call ran in the module, and the plan took no state lock.
    const calls = readdirSync(join(r.dir, "stub", "calls"))
      .sort((a, b) => Number(a) - Number(b))
      .map((n) => readFileSync(join(r.dir, "stub", "calls", n), "utf8").split("\n"));
    expect(calls.every((args) => args[0] === `-chdir=${root("ops/tofu")}`)).toBe(true);
    expect(calls.map((args) => args[1])).toEqual(["init", "plan", "show"]);
    expect(calls[1]).toContain("-lock=false");
    expect(calls[1]).toContain(`-out=${join(r.dir, "temp", "tofu", "plan.bin")}`);
    // A failed plan prints only the filtered diagnostics.
    const failed = runner();
    failed.phase("prepare", PREPARED);
    writeFileSync(join(failed.dir, "stub", "exit.plan"), "1");
    writeFileSync(
      join(failed.dir, "stub", "plan.jsonl"),
      `${JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary: "No access to 192.0.2.10 at staging.example.org", detail: "secret" } })}\n`,
    );
    const r2 = failed.phase("plan", tokens);
    expect(r2.code).toBe(1);
    expect(r2.out).toBe(
      "::error::plan failed (exit 1). Its diagnostics, with names, numbers and addresses left out:\nerror - No access to ... at (masked) \n",
    );
    // A plan summary.jq can't read (a provider that changed a schema): jq's own error, which
    // quotes the start of the value, stays in a private file, and only fixed text prints.
    const odd = runner();
    odd.phase("prepare", PREPARED);
    writeFileSync(join(odd.dir, "temp", "tofu", "plan.bin"), "a saved plan");
    writeFileSync(
      join(odd.dir, "stub", "plan.json"),
      JSON.stringify({
        resource_changes: [
          change('linode_database_access_controls.db["primary"]', ["update"], {
            before: { allow_list: "203.0.113.10/32" },
            after_unknown: { allow_list: true },
          }),
        ],
      }),
    );
    const unread = odd.phase("summarize", {
      TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
    });
    expect(unread).toEqual({
      code: 1,
      out: "::error::The change list couldn't be built from the saved plan; nothing was applied.\n",
      err: "",
    });
    expect(odd.file("temp/tofu/summary.stderr")).toContain("203.0.113.");
  });

  test("compare binds the saved plan; disabled records refuse new hosts before an ordinary Apply", () => {
    // The Apply job: prepare, then the saved plan as the artifact left it, then compare and apply.
    const r = runner();
    r.phase("prepare", PREPARED);
    expect(r.phase("control_read").code).toBe(0);
    const saved = "an encrypted saved plan";
    writeFileSync(join(r.dir, "temp", "tofu", "plan.bin"), saved);
    const digest = new Bun.CryptoHasher("sha256").update(saved).digest("hex");
    const extra = JSON.parse(EXAMPLE).db_allow_extra as string[];
    /** The fetched plan as `tofu show -json` reads it, planned with the given values. */
    let creating = true;
    const savedPlan = (values: Record<string, unknown>) =>
      writeFileSync(
        join(r.dir, "stub", "plan.json"),
        JSON.stringify({
          variables: planned(values),
          resource_changes: [
            {
              ...change('linode_instance.host["staging"]', [creating ? "create" : "update"], {
                ...(creating ? { before: null } : {}),
                after_unknown: { ipv4: true, ipv6: true },
              }),
              mode: "managed",
            },
            change('linode_database_access_controls.db["primary"]', ["update"], {
              before: { allow_list: extra },
              after: {},
              after_unknown: { allow_list: true },
            }),
          ],
        }),
      );
    savedPlan(example());
    // Plan's binding includes its full private show, reconstructed independently by Compare.
    cpSync(join(r.dir, "stub", "plan.json"), join(r.dir, "temp", "tofu", "plan.json"));
    let list =
      'create linode_instance.host["staging"]\nupdate linode_database_access_controls.db["primary"] +2 -0';
    const reviewed = {
      DIGEST: digest,
      APPROVED: list,
      TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
      BINDING: handoffBinding(join(r.dir, "temp", "tofu"), {
        TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
        GITHUB_SHA: "1".repeat(40),
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_EVENT_PATH: join(r.dir, "event.json"),
      }),
    };
    expect(r.phase("compare", reviewed)).toEqual({
      code: 0,
      out: "The saved plan is the reviewed one.\n",
      err: "",
    });
    // The list is re-derived from the fetched file itself, through tofu show.
    expect(r.file("temp/tofu/changes.txt")).toBe(`${list}\n`);
    for (const [what, env, message] of [
      ["no digest", { DIGEST: "" }, "::error::The Plan job's digest didn't arrive"],
      ["no list", { APPROVED: "" }, "::error::The Plan job's change list didn't arrive"],
      ["no binding", { BINDING: "" }, "::error::The Plan job's handoff binding didn't arrive"],
      [
        "wrong binding",
        { BINDING: "0".repeat(64) },
        "::error::The plan's backend, inputs, run or code differs",
      ],
      [
        "another file",
        { DIGEST: "0".repeat(64) },
        "::error::The saved plan isn't the file the Plan job made",
      ],
      [
        "other changes",
        { APPROVED: list.replace("+2", "+3") },
        "::error::The saved plan's changes differ from the ones the Plan job showed",
      ],
    ] as const) {
      const refused = r.phase("compare", { ...reviewed, ...env });
      expect({ what, code: refused.code, starts: refused.out.startsWith(message) }).toEqual({
        what,
        code: 1,
        starts: true,
      });
    }
    // The saved plan applies the values it was planned with (infra-plan's TOFU_VARS), so they must
    // be infra's: a key, Configure key or hash set in one copy alone changes no line of the list.
    const VARS_DIFFER =
      "::error::TOFU_VARS in infra differs from the value the Plan job planned with (infra-plan's); nothing was applied. Set the same value in both and dispatch a new run.\n";
    for (const [what, values] of [
      ["another root key", { ...example(), root_keys: ["ssh-ed25519 AAAAC3Nz other"] }],
      ["another Configure key", { ...example(), configure_keys: { staging: "ssh-ed25519 x" } }],
      ["another hash", { ...example(), root_password_hash: "$6$x" }],
      ["a missing value", { ...example(), cloudflare_zone_id: undefined }],
    ] as const) {
      savedPlan(values);
      expect({ what, ...r.phase("compare", reviewed) }).toEqual({
        what,
        code: 1,
        out: VARS_DIFFER,
        err: "",
      });
    }
    // A plan whose values can't be read at all is refused the same way.
    writeFileSync(
      join(r.dir, "stub", "plan.json"),
      JSON.stringify({ ...JSON.parse(r.file("stub/plan.json")), variables: undefined }),
    );
    expect(r.phase("compare", reviewed).out).toBe(VARS_DIFFER);
    savedPlan(example());
    expect(r.phase("compare", reviewed).code).toBe(0);
    // Backend identity is privately bound too: refuse a mismatch before provider writes.
    const backend = r.file("temp/tofu/backend.hcl");
    writeFileSync(
      join(r.dir, "temp", "tofu", "backend.hcl"),
      backend.replace("us-east-1", "us-west-1"),
    );
    expect(r.phase("compare", reviewed)).toEqual({
      code: 1,
      out: "::error::The plan's backend, inputs, run or code differs from Plan; nothing was applied.\n",
      err: "",
    });
    const writeTokens = { ...STATE, LINODE_TOKEN: "t", CLOUDFLARE_API_TOKEN: "t" };
    // Failed Compare removes a previous success marker; direct Apply must then fail.
    expect(r.phase("apply", writeTokens).out).toBe(
      "::error::Apply has no successful plan comparison; nothing was applied.\n",
    );
    writeFileSync(join(r.dir, "temp", "tofu", "backend.hcl"), backend);
    expect(r.phase("compare", reviewed).code).toBe(0);
    writeFileSync(join(r.dir, "temp", "tofu", "plan.bin"), `${saved}-changed-after-compare`);
    expect(r.phase("apply", writeTokens)).toEqual({
      code: 1,
      out: "::error::The plan handoff changed after comparison; nothing was applied.\n",
      err: "",
    });
    writeFileSync(join(r.dir, "temp", "tofu", "plan.bin"), saved);
    expect(r.phase("compare", reviewed).code).toBe(0);
    writeFileSync(
      join(r.dir, "stub", "apply.jsonl"),
      `${JSON.stringify({ type: "change_summary", changes: { add: 4, change: 1, import: 0, remove: 0 } })}\n`,
    );
    const refusal = r.phase("apply", writeTokens);
    expect(refusal.code).toBe(1);
    expect(refusal.out).toContain("Infrastructure control evidence or persistence failed");
    expect(
      readdirSync(join(r.dir, "stub", "calls")).every(
        (name) => !r.file(`stub/calls/${name}`).includes("\napply\n"),
      ),
    ).toBe(true);
    creating = false;
    savedPlan(example());
    cpSync(join(r.dir, "stub", "plan.json"), join(r.dir, "temp", "tofu", "plan.json"));
    list = list
      .replace("create linode_instance", "update linode_instance")
      .split("\n")
      .sort()
      .join("\n");
    reviewed.APPROVED = list;
    reviewed.BINDING = handoffBinding(join(r.dir, "temp", "tofu"), {
      TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase,
      GITHUB_SHA: "1".repeat(40),
      GITHUB_RUN_ID: "1234",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: join(r.dir, "event.json"),
    });
    expect(r.phase("compare", reviewed)).toEqual({
      code: 0,
      out: "The saved plan is the reviewed one.\n",
      err: "",
    });
    const applied = r.phase("apply", writeTokens);
    expect(applied).toEqual({
      code: 0,
      out: ["applied: 4 added, 1 changed, 0 imported, 0 destroyed", ""].join("\n"),
      err: "",
    });
    // The apply named the fetched file and nothing that could make it a new plan.
    const calls = readdirSync(join(r.dir, "stub", "calls")).sort((a, b) => Number(a) - Number(b));
    const last = readFileSync(join(r.dir, "stub", "calls", calls.at(-1) ?? ""), "utf8");
    expect(last).toBe(
      [
        `-chdir=${root("ops/tofu")}`,
        "apply",
        "-input=false",
        "-json",
        join(r.dir, "temp", "tofu", "plan.bin"),
        "",
      ].join("\n"),
    );
    // A stale plan: OpenTofu refuses it, and only the filtered diagnostic prints.
    writeFileSync(join(r.dir, "stub", "exit.apply"), "1");
    writeFileSync(
      join(r.dir, "stub", "apply.jsonl"),
      `${JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary: "Saved plan is stale", detail: "secret" } })}\n`,
    );
    expect(r.phase("apply", writeTokens)).toEqual({
      code: 1,
      out: "::error::apply failed (exit 1); reconcile any pending control operation before a new run. Its diagnostics, with names, numbers and addresses left out:\nerror - Saved plan is stale\n",
      err: "",
    });
    // Without the tokens, nothing runs; each message names that job's own secrets.
    expect(r.phase("apply", STATE).out).toBe(
      "::error::LINODE_WRITE_TOKEN and CLOUDFLARE_WRITE_TOKEN must be set in the infra environment.\n",
    );
    expect(r.phase("plan", STATE).out).toBe(
      "::error::LINODE_READ_TOKEN and CLOUDFLARE_READ_TOKEN must be set in the infra-plan environment.\n",
    );
    expect(r.phase("init", { TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase }).out).toBe(
      "::error::The state key must be set: TOFU_STATE_READ_ACCESS_KEY and TOFU_STATE_READ_SECRET_KEY in infra-plan, TOFU_STATE_WRITE_ACCESS_KEY and TOFU_STATE_WRITE_SECRET_KEY in infra.\n",
    );
    // The passphrase is the only key to the saved plan, which anyone signed in to GitHub can
    // download for a day, so init, plan and apply all refuse one shorter than 32 characters.
    const TOO_SHORT = "::error::TOFU_STATE_PASSPHRASE must be at least 32 characters.\n";
    const passphrase = (length: number) => ({
      ...writeTokens,
      TF_VAR_state_passphrase: "p".repeat(length),
    });
    for (const name of ["init", "plan", "apply"])
      expect({ name, ...r.phase(name, passphrase(31)) }).toEqual({
        name,
        code: 1,
        out: TOO_SHORT,
        err: "",
      });
    expect(r.phase("init", passphrase(32))).toEqual({ code: 0, out: "init ok\n", err: "" });
    expect(r.phase("nothing").code).toBe(1);
  });
});
