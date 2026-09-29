/**
 * The OpenTofu module (ops/tofu) and the "Infrastructure" workflow that plans and applies it
 * (.github/workflows/infra.yml), since 2.36.0 (issue #62).
 *
 * Static only: nothing here runs tofu, jq, a shell or the network, because the unit suite also
 * runs inside the image build. OpenTofu's own tests (ops/tofu/tests/main.tftest.hcl, in CI's
 * "Infrastructure checks") cover what the module renders and plans.
 *
 * - infra.yml: dispatch from main only, the `infra` environment on both jobs, first attempts only,
 *   least permissions, pinned actions, every ${{ }} through env:, each secret in the steps that
 *   need it, and the Plan job's shared steps repeated unchanged in Apply.
 * - Public logs (the repository and its Actions logs are public): every tofu command writes to a
 *   private file, the Prepare step masks every identifying value in TOFU_VARS before anything
 *   else prints, diagnostics print through a filter that no digit, '/', '@' or '=' survives, no
 *   host key is ever fetched or printed, and the guards refuse deletes, replaces and access-list
 *   removals nobody asked for. Apply refuses a missing or different change list.
 * - The pinned OpenTofu: one install step, byte-identical in ci.yml and infra.yml, whose version
 *   and checksum files agree and satisfy the module's required_version.
 * - ops/tofu: every variable sensitive, the addresses output sensitive, the validations present
 *   and in step with infra.yml's own checks, no host key or private key anywhere, verify-required
 *   seeded, the access lists protected and adopted by import, encrypted state and plans, no bucket
 *   or endpoint in the repository, the lock file pinning both providers, and examples that use
 *   only documentation names and addresses.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

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
    with: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
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
    concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }).strict(),
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
const runOf = (j: Job, name: string) => stepOf(j, name).run ?? "";
/** A GitHub Actions expression, `${{ inner }}`, built so this source holds no placeholder. */
const expr = (inner: string) => `\${{ ${inner} }}`;

/** The steps both jobs share, in order, and the ones only Apply adds before its cleanup. */
const SHARED = [
  "Check out source",
  "Install the pinned OpenTofu",
  "Prepare the values and the masks",
  "Initialize OpenTofu",
  "Plan",
  "Summarize the plan",
];
const PREPARE = runOf(plan, "Prepare the values and the masks");
const SUMMARIZE = runOf(plan, "Summarize the plan");

/** A jq program the Prepare step writes to "$d/<name>" with a quoted heredoc. */
const jqProgram = (name: string) => {
  const match = new RegExp(`cat > "\\$d/${name}" <<'JQ'\\n([\\s\\S]*?)\\nJQ\\n`, "u").exec(PREPARE);
  if (!match?.[1]) throw new Error(`no ${name} in the Prepare step`);
  return match[1];
};

/** Every command line of every run script (heredoc bodies and comments left out). */
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
      options: ["plan", "apply"],
      default: "plan",
    });
    expect(inputs.replace).toMatchObject({ type: "string", default: "" });
    expect(inputs.allow_destroy).toMatchObject({ type: "boolean", default: false });
    expect(inputs.allow_access_removal).toMatchObject({ type: "boolean", default: false });
    // The title names the operation only: never the replace target or anything from a secret.
    expect(infra["run-name"]).toBe(`Infrastructure ${expr("inputs.operation")}`);
  });

  test("one concurrency group serializes runs, and nothing holds a permission by default", () => {
    expect(infra.concurrency).toEqual({ group: "infra", "cancel-in-progress": false });
    expect(infra.permissions).toEqual({});
    expect(infra.env).toEqual({ TF_IN_AUTOMATION: "1", TF_INPUT: "0" });
  });

  test("both jobs wait in the infra environment, from main, on the first attempt only", () => {
    const guard = "github.run_attempt == '1' && github.ref == 'refs/heads/main'";
    expect(plan.if).toBe(guard);
    expect(apply.if).toBe(
      `${guard} && inputs.operation == 'apply' && needs.plan.outputs.has_changes == 'true'`,
    );
    expect(apply.needs).toBe("plan");
    for (const j of [plan, apply]) {
      expect(j.environment).toBe("infra");
      expect(j.permissions).toEqual({ contents: "read" });
      expect(j["runs-on"]).toBe("ubuntu-24.04");
    }
    expect(plan.outputs).toEqual({
      changes: expr("steps.summary.outputs.changes"),
      has_changes: expr("steps.summary.outputs.has_changes"),
    });
  });

  test("the only action is checkout, at ci.yml's pin, without persisted credentials", () => {
    const ciPin = /uses: (actions\/checkout@[0-9a-f]{40}) # v[\d.]+/u.exec(
      read(".github/workflows/ci.yml"),
    );
    expect(ciPin?.[1]).toBeDefined();
    for (const j of [plan, apply]) {
      const uses = j.steps.filter((s) => s.uses);
      expect(uses.map((s) => s.uses)).toEqual([ciPin?.[1]]);
      expect(uses[0]?.with).toEqual({ "persist-credentials": false });
    }
  });

  test("the steps run in order, and Apply repeats the Plan job's steps unchanged", () => {
    expect(plan.steps.map((s) => s.name)).toEqual([...SHARED, "Clean up"]);
    expect(apply.steps.map((s) => s.name)).toEqual([
      ...SHARED,
      "Compare with the approved plan",
      "Apply",
      "Clean up",
    ]);
    for (const name of [...SHARED, "Clean up"])
      expect({ name, same: stepOf(apply, name) }).toEqual({ name, same: stepOf(plan, name) });
    for (const j of [plan, apply]) {
      const cleanup = stepOf(j, "Clean up");
      expect(cleanup.if).toBe("always()");
      expect(cleanup.run).toBe(`rm -rf -- "\${RUNNER_TEMP:?}/tofu"`);
    }
  });

  test("every expression reaches a script through env:, and each secret only the step that needs it", () => {
    const secretsOf = (s: z.infer<typeof step>) =>
      Object.values(s.env ?? {})
        .flatMap((v) => [...v.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]))
        .sort();
    const expected: Record<string, string[]> = {
      "Prepare the values and the masks": ["TOFU_STATE_BUCKET", "TOFU_STATE_ENDPOINT", "TOFU_VARS"],
      "Initialize OpenTofu": [
        "TOFU_STATE_ACCESS_KEY",
        "TOFU_STATE_PASSPHRASE",
        "TOFU_STATE_SECRET_KEY",
      ],
      Plan: [
        "CLOUDFLARE_API_TOKEN",
        "LINODE_TOKEN",
        "TOFU_STATE_ACCESS_KEY",
        "TOFU_STATE_PASSPHRASE",
        "TOFU_STATE_SECRET_KEY",
      ],
      "Summarize the plan": ["TOFU_STATE_PASSPHRASE"],
      Apply: [
        "CLOUDFLARE_API_TOKEN",
        "LINODE_TOKEN",
        "TOFU_STATE_ACCESS_KEY",
        "TOFU_STATE_PASSPHRASE",
        "TOFU_STATE_SECRET_KEY",
      ],
    };
    for (const j of [plan, apply])
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
        expect({ step: s.name, secrets: secretsOf(s) }).toEqual({
          step: s.name,
          secrets: expected[s.name] ?? [],
        });
      }
    // Everything else anywhere in the file is an input or the Plan job's outputs.
    const expressions = [...infraText.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/gu)].map((m) => m[1]);
    for (const e of expressions)
      expect({
        e,
        ok: /^(secrets\.[A-Z_]+|inputs\.[a-z_]+|steps\.summary\.outputs\.[a-z_]+|needs\.plan\.outputs\.changes)$/u.test(
          e ?? "",
        ),
      }).toMatchObject({
        ok: true,
      });
  });
});

describe("public-log hygiene", () => {
  test("every tofu command writes its output and errors to a private file", () => {
    for (const j of [plan, apply])
      for (const s of j.steps) {
        if (s.name === "Install the pinned OpenTofu" || !s.run) continue;
        for (const line of commandLines(s.run).filter((l) => /(?:^|[\s;&|(])tofu\s/u.test(l))) {
          // stdout to a file under $d, and stderr to a file or along with stdout.
          const ok =
            /> "\$d\/[a-z.]+"/u.test(line) &&
            (/ 2> "\$d\/[a-z.]+"/u.test(line) || / 2>&1/u.test(line));
          expect({ step: s.name, line, ok }).toEqual({ step: s.name, line, ok: true });
        }
      }
    // No step reads outputs or state, which hold addresses and the hash.
    expect(infraText).not.toMatch(/\btofu(?: -chdir=\S+)? (?:output|state|console)\b/u);
    expect(infraText).not.toMatch(
      / -no-color| -detailed-exitcode|set -x|\bcat "\$d\/(?!changes\.txt)/u,
    );
  });

  test("the Prepare step masks every identifying value before anything else prints", () => {
    const masks = jqProgram("masks.jq");
    for (const part of [
      "(.hosts[] | .fqdn, .label)",
      ".cloudflare_zone_id",
      '(.db_allow_extra[] | ., split("/")[0])',
      '(.root_password_hash | select(. != ""))',
      '((.root_keys[], .configure_keys[]) | split(" ")[] | select(startswith("AAAA")))',
    ])
      expect({ part, present: masks.includes(part) }).toEqual({ part, present: true });
    const lines = commandLines(PREPARE);
    const loop = lines.findIndex((l) => l.includes("::add-mask::"));
    expect(loop).toBeGreaterThan(0);
    // Before the masks: only fixed ::error:: messages print. TOFU_VARS reaches jq through
    // printf (a builtin) and a pipe, and jq's output and errors go to a file or nowhere.
    for (const line of lines.slice(0, loop)) {
      if (/^(?:echo|printf)\b/u.test(line) && !line.startsWith("printf '%s' \"$TOFU_VARS\" |"))
        expect({ line, fixed: /^echo "::error::[^$`]*"$/u.test(line) }).toEqual({
          line,
          fixed: true,
        });
      if (line.includes("$TOFU_VARS"))
        expect({
          line,
          private: /> (?:"\$d\/[a-z.]+"|\/dev\/null 2>&1); then$|> "\$d\/[a-z.]+"$/u.test(line),
        }).toEqual({
          line,
          private: true,
        });
    }
    // The shape check says nothing of the value, and the replace target is never echoed back.
    expect(PREPARE).toContain(`jq -e -f "$d/shape.jq" > /dev/null 2>&1`);
    expect(PREPARE).not.toMatch(/echo[^\n]*\$REPLACE/u);
  });

  test("the masks and the shape check agree with ops/tofu/variables.tf on labels and keys", () => {
    const shape = jqProgram("shape.jq");
    const variables = read("ops/tofu/variables.tf");
    for (const pattern of [
      "^(staging|production)(-[0-9]{1,2})?$",
      "^[a-z][a-z0-9-]{6,61}[a-z0-9]$",
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
    const keys = Object.keys(JSON.parse(read("ops/tofu/examples/example.tfvars.json"))).sort();
    expect(shape).toContain(`keys == ${JSON.stringify(keys).replaceAll(",", ", ")}`);
    // A label must hold a '-', and never occur inside a host key, in both checks.
    expect(shape).toContain('contains("-") and (contains("--") | not)');
    expect(shape).toContain("$k | contains($l) | not");
    expect(variables).toContain('strcontains(h.label, "-")');
    expect(variables).toContain("!anytrue([for k in keys(var.hosts) : strcontains(k, h.label)])");
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

  test("no host key is fetched or printed; Apply names each built host and the README step", () => {
    expect(infraText).not.toMatch(
      /ssh-keyscan|known_hosts|ssh-ed25519|TARGET_HOST|host_key|ssh-keygen/u,
    );
    const run = runOf(apply, "Apply");
    expect(run).toContain(
      `line="built \${BASH_REMATCH[1]} (\${BASH_REMATCH[2]}): pin its host key from your own machine (ops/tofu/README.md, Pinning a new host key)"`,
    );
    expect(read("ops/tofu/README.md")).toContain("## Pinning a new host key");
    // Only the apply's counts print from its output, and only numbers.
    expect(jqProgram("applied.jq")).toContain("\\(.add | numbers) added");
  });

  test("deletes, replaces and access-list removals need their own switch; unnamed changes never apply", () => {
    const env = stepOf(plan, "Summarize the plan").env;
    expect(env?.ALLOW_DESTROY).toBe(expr("inputs.allow_destroy"));
    expect(env?.ALLOW_ACCESS_REMOVAL).toBe(expr("inputs.allow_access_removal"));
    const guards = [
      ...SUMMARIZE.matchAll(
        /if grep -qE '([^']+)' "\$d\/changes\.txt"( && \[\[ \$([A-Z_]+) != true \]\])?/gu,
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
      'if ! [[ $REPLACE =~ ^linode_instance\\.host\\[\\"((staging|production)(-[0-9]{1,2})?)\\"\\]$ ]] \\',
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

  test("Apply refuses a missing or different change list, and applies its own saved plan", () => {
    const compare = stepOf(apply, "Compare with the approved plan");
    expect(compare.env).toEqual({ APPROVED: expr("needs.plan.outputs.changes") });
    expect(compare.run).toContain("if [[ -z $APPROVED ]]; then");
    expect(compare.run).toContain('current=$(< "$d/changes.txt")');
    expect(compare.run).toContain('if [[ $current != "$APPROVED" ]]; then');
    const run = runOf(apply, "Apply");
    expect(run).toContain(
      'tofu -chdir=ops/tofu apply -input=false -json "$d/plan.bin" > "$d/apply.jsonl" 2> "$d/apply.stderr" || rc=$?',
    );
    expect(runOf(plan, "Plan")).toContain('-out="$d/plan.bin"');
  });
});

// ---- The pinned OpenTofu ------------------------------------------------------------------------

/** The install step's text, byte for byte, as interfaces §4 gives it. */
const INSTALL_STEP = `      - name: Install the pinned OpenTofu
        run: |
          # The release in ops/tofu/.opentofu-version, checked against ops/tofu/opentofu.sha256 (copied
          # from that release's signature-verified SHA256SUMS) before anything runs it.
          set -Eeuo pipefail
          v=$(< ops/tofu/.opentofu-version)
          [[ $v =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::ops/tofu/.opentofu-version must hold X.Y.Z."; exit 1; }
          d=$RUNNER_TEMP/tofu-bin
          mkdir -p "$d"
          curl -fsSL --proto '=https' --tlsv1.2 -o "$d/tofu_\${v}_linux_amd64.zip" "https://github.com/opentofu/opentofu/releases/download/v\${v}/tofu_\${v}_linux_amd64.zip"
          (cd "$d" && sha256sum --check --strict --quiet "$GITHUB_WORKSPACE/ops/tofu/opentofu.sha256")
          unzip -q -o "$d/tofu_\${v}_linux_amd64.zip" tofu -d "$d"
          echo "$d" >> "$GITHUB_PATH"
`;

/** Each "Install the pinned OpenTofu" step's text in a workflow file, up to the next step. */
const installSteps = (text: string) =>
  [...text.matchAll(/^ {6}- name: Install the pinned OpenTofu\n(?: {8}.*\n|\n)*/gmu)].map(
    (m) => m[0],
  );

describe("the pinned OpenTofu", () => {
  test("one install step, byte-identical in ci.yml and in both of infra.yml's jobs", () => {
    expect(installSteps(infraText)).toEqual([INSTALL_STEP, INSTALL_STEP]);
    expect(installSteps(read(".github/workflows/ci.yml"))).toEqual([INSTALL_STEP]);
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
      "ops/tofu/cloud-init.yaml.tftpl",
      "ops/tofu/examples/example.tfvars.json",
      "ops/tofu/examples/user-data-with-hash.yaml",
      "ops/tofu/examples/user-data-without-hash.yaml",
      "ops/tofu/main.tf",
      "ops/tofu/opentofu.sha256",
      "ops/tofu/outputs.tf",
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
    expect(hosts).toContain('can(regex("^[a-z][a-z0-9-]{6,61}[a-z0-9]$", h.label))');
    expect(block(VARIABLES, "variable.database_ids")).toContain('can(regex("^[a-z]{1,16}$", k))');
    expect(block(VARIABLES, "variable.db_allow_extra")).toContain(
      'can(cidrhost(x, 0)) && strcontains(x, "/")',
    );
    expect(block(VARIABLES, "variable.state_passphrase")).toContain(
      "length(var.state_passphrase) >= 16",
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

  test("no host key, private key, fingerprint record or key generator anywhere in the module", () => {
    for (const file of TOFU) {
      // The test file asserts these words are absent from every rendering.
      if (file === "ops/tofu/tests/main.tftest.hcl") continue;
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
    // The import block tofu test can't exercise: one per cluster, with the provider's ID form.
    const imports = [...main.matchAll(/^import \{\n([\s\S]*?)^\}$/gmu)].map((m) => m[1] ?? "");
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("for_each = local.database_keys");
    expect(imports[0]).toContain("to = linode_database_access_controls.db[each.key]");
    expect(imports[0]).toContain(`id = nonsensitive("\${var.database_ids[each.key]}:postgresql")`);
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
      "hosts",
      "root_keys",
      "root_password_hash",
    ]);
    expect(Object.keys(vars.hosts)).toEqual(["staging"]);
    expect(vars.cloudflare_zone_id).toBe("0".repeat(32));
    expect(vars.database_ids).toEqual({ primary: "0" });
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
      "staging.tarubot.dev",
      "db.example.com.",
      "https://host.linodeobjects.com/x",
    ])
      expect({ sample, caught: hostNames(sample).length > 0 }).toEqual({ sample, caught: true });
    expect(hostNames("linode_instance.host main.tf README.md sk-ssh-ed25519@openssh.com")).toEqual(
      [],
    );
  });

  test("only github.com, the registry in the lock file, example.org and the endpoint's shape", () => {
    for (const file of FILES) {
      const text = read(file);
      const allowed = (host: string) =>
        host === "github.com" ||
        host === "example.org" ||
        host.endsWith(".example.org") ||
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
