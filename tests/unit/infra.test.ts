/**
 * The OpenTofu module (ops/tofu) and the script whose phases plan and apply it
 * (ops/tofu/ci/tofu-ci.sh), since 2.36.0 (issue #62). Since 2.37.0 the Deploy workflow runs them:
 * its Infrastructure plan job (.github/workflows/deploy.yml, the reviewer-free `infra-plan`
 * environment with the read-only secrets and the one copy of TOFU_VARS) plans, and the approving
 * `prod` job (.github/workflows/host.yml) adopts, applies and reads the outputs. The workflows' own
 * tests (deploy-workflow, host-workflow) pin their jobs; this file checks only which phases each
 * workflow runs. The phases' rules live in the jq programs beside the script.
 *
 * Nothing here runs tofu or the network. The jq programs and the script's phases run against sample
 * plans and a stand-in for tofu (tests/fixtures/infra/tofu) where jq is installed, and are
 * skipped where it isn't (the image build); OpenTofu's own tests (ops/tofu/tests/main.tftest.hcl,
 * in CI's "Infrastructure checks") cover what the module renders and plans.
 *
 * - The phases: backend and values apart, the rebuild target from REBUILD_TARGET (empty, staging or
 *   prod, naming a host in TOFU_VARS) and never from the event payload.
 * - The hand-off: summarize publishes the change list, has_changes and the saved plan's SHA-256;
 *   adopt, which needs no TOFU_VARS, refuses a file whose SHA-256 or change list differs from
 *   them, takes the values from the saved plan itself and masks them before anything else prints,
 *   and accepts an empty change list only with has_changes=false (the pins-only case); apply takes
 *   only an adopted plan with changes, with nothing that could change it, so OpenTofu refuses it if
 *   the state moved since; output keeps the state's outputs, host_connection among them, in a
 *   private file and masks every address and instance ID first.
 * - The guards: a change the list can't name never applies; deletes, replaces and access-list
 *   removals need their own switch; a rebuild alone allows exactly its target's replace and the
 *   removal of that instance's own two old entries, so db_allow_extra drift still needs
 *   allow_access_removal (the review's B1); and there is no per-target guard, so a module-wide
 *   change passes from either target (B6).
 * - Public logs (the repository and its Actions logs are public): every tofu command writes to a
 *   private file, and so does every jq error on plan, apply or output data; values and adopt mask
 *   every identifying value before anything else prints; diagnostics print through a filter that
 *   no digit, '/', '@' or '=' survives; no host key is ever fetched or printed here (host.sh pins
 *   them); and the state passphrase, the only key to the public saved plan, must be at least 32
 *   characters, in the script and the module.
 * - The pinned OpenTofu: one install phase, used by ci.yml, deploy.yml and host.yml, whose version
 *   and checksum files agree and satisfy the module's required_version.
 * - ops/tofu: the hosts are staging and prod (production is the Compose path's word only), every
 *   variable sensitive, host_connection sensitive, the validations present and in step with the
 *   script's own checks, no host key or private key anywhere in the module, verify-required
 *   seeded, the access lists protected and adopted by import, encrypted state and plans, no bucket
 *   or endpoint in the repository, the lock file pinning both providers, and examples that use only
 *   documentation names and addresses.
 * - .dockerignore: OpenTofu's local state, saved plans, values and backend settings, and database
 *   dumps under any name, never reach the image; the placeholder values the build's tests read do.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";

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

// ---- tofu-ci.sh, as text -------------------------------------------------------------------------

/** The script every step runs, and one of its phases or helpers (a shell function) as text. */
const SCRIPT = "ops/tofu/ci/tofu-ci.sh";
const scriptText = read(SCRIPT);
const phaseOf = (name: string) => {
  const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}$`, "mu").exec(scriptText);
  if (!match?.[1]) throw new Error(`no phase ${name} in ${SCRIPT}`);
  return match[1];
};
/** The phases, in the order the usage line names them. */
const PHASES = [
  "install",
  "backend",
  "values",
  "init",
  "plan",
  "summarize",
  "adopt",
  "apply",
  "output",
];
const VALUES = phaseOf("values");
const SUMMARIZE = phaseOf("summarize");
const ADOPT = phaseOf("adopt");
const OUTPUT = phaseOf("output");

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

/** Every `fail "…"` message on a line, which must be one literal that can't echo a value. */
const failMessages = (line: string) =>
  [...line.matchAll(/\bfail ("[^"]*"|\S+)/gu)].map((m) => m[1]);
const fixed = (message: string | undefined) => /^"[^$`]*"$/u.test(message ?? "");

describe("tofu-ci.sh's phases", () => {
  test("the script runs exactly its nine phases, reads no event payload and traces nothing", () => {
    expect(scriptText).toContain(`\n  ${PHASES.join(" | ")})\n`);
    for (const name of PHASES) expect(phaseOf(name).length).toBeGreaterThan(0);
    // 2.36.0's prepare read the replace input from the event payload, and compare needed a second
    // copy of TOFU_VARS; backend, values and adopt replace them.
    for (const gone of ["prepare", "compare"])
      expect(() => phaseOf(gone)).toThrow(`no phase ${gone}`);
    expect(scriptText).not.toMatch(/GITHUB_EVENT_PATH|\binputs\.|\.inputs\b/u);
    expect(scriptText).not.toMatch(/set -[a-zA-Z]*x|set -o xtrace/u);
    expect(scriptText).toMatch(/^set -Eeuo pipefail\numask 077$/mu);
    expect(scriptText).toMatch(/^fail\(\) \{\n {2}echo "::error::\$1"\n {2}exit 1\n\}$/mu);
    // No per-target or cross-environment guard: @deconfined approves the whole plan, and nothing
    // here reads a deploy target, a pin scope or an environment name.
    expect(scriptText).not.toMatch(/\b(?:TARGET|PIN_SCOPE|ENVIRONMENT|TARGET_HOST)\b/u);
    // The rename: the Compose path's word appears nowhere in the new path's script.
    expect(scriptText).not.toContain("production");
  });

  test("every tofu command writes its output and errors to a private file", () => {
    // init, plan, show, apply and output: every tofu call starts its line.
    const calls = commandLines(scriptText).filter((l) => /^tofu\s/u.test(l));
    expect(calls.map((l) => /^tofu (?:-chdir="\$module" )?(\S+)/u.exec(l)?.[1])).toEqual([
      "init",
      `"\${args[@]}"`,
      "show",
      "apply",
      "output",
    ]);
    const code = commandLines(scriptText).join("\n");
    expect(code.match(/\btofu -chdir=/gu)).toHaveLength(4);
    for (const line of calls) {
      // stdout to a file under $d, and stderr to a file or along with stdout.
      const ok =
        />"\$d\/[a-z.]+"/u.test(line) && (/ 2>"\$d\/[a-z.]+"/u.test(line) || / 2>&1/u.test(line));
      expect({ line, ok }).toEqual({ line, ok: true });
    }
    // jq's own errors quote the value they failed on, so every jq call that reads the plan, the
    // apply's messages or the state's outputs sends them to a private file or nowhere.
    const jqOnOutput = commandLines(scriptText).filter(
      (l) =>
        /\bjq\b/u.test(l) &&
        /"\$d\/(?:plan\.jsonl?|apply\.jsonl|outputs(?:\.raw)?\.json)"/u.test(l),
    );
    expect(jqOnOutput.length).toBe(9);
    for (const line of jqOnOutput)
      expect({
        line,
        private: / 2>"\$d\/[a-z.]+"| 2>\/dev\/null(?:[ )]|$)|>\/dev\/null 2>&1(?:[ ;)]|$)/u.test(
          line,
        ),
      }).toEqual({ line, private: true });
    // Only the output phase reads the state's outputs; nothing reads the state or a console.
    expect(scriptText).not.toMatch(/\btofu(?: -chdir=\S+)? (?:state|console)\b/u);
    expect(code.match(/\btofu(?: -chdir=\S+)? output\b/gu)).toHaveLength(1);
    expect(OUTPUT).toContain('output -json >"$d/outputs.raw.json" 2>"$d/output.stderr"');
    expect(scriptText).not.toMatch(
      / -no-color| -detailed-exitcode|\bcat (?:-- )?"\$d\/(?!changes\.txt)/u,
    );
  });

  test("values and adopt mask every identifying value before anything else prints", () => {
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
    // mask_values prints the masks and nothing else.
    expect(
      commandLines(phaseOf("mask_values")).filter((l) => /^(?:echo|printf)\b/u.test(l)),
    ).toEqual(['echo "::add-mask::$m"']);
    for (const [name, text] of [
      ["values", VALUES],
      ["adopt", ADOPT],
    ] as const) {
      const lines = commandLines(text);
      const at = lines.indexOf('mask_values "$d/values.tfvars.json"');
      expect({ name, at: at > 0 }).toEqual({ name, at: true });
      // Before the masks: only fixed messages print. TOFU_VARS reaches jq through printf (a
      // builtin) and a pipe, and jq's output and errors go to a file or nowhere; so do the values
      // adopt reads from the saved plan.
      for (const line of lines.slice(0, at)) {
        if (/^(?:echo|printf)\b/u.test(line) && !line.startsWith(`printf '%s' "\${TOFU_VARS-}" |`))
          expect({ name, line, printed: true }).toEqual({ name, line, printed: false });
        for (const message of failMessages(line))
          expect({ name, line, fixed: fixed(message) }).toEqual({ name, line, fixed: true });
        if (line.includes(`\${TOFU_VARS-}`) || (/\bjq\b/u.test(line) && line.includes("$d/plan")))
          expect({
            name,
            line,
            private:
              />(?:"\$d\/[a-z.]+"|\/dev\/null 2>&1); then$|>"\$d\/[a-z.]+"(?: 2>\/dev\/null)?(?: \|\|)?$|>\/dev\/null 2>&1 \|\|$/u.test(
                line,
              ),
          }).toEqual({ name, line, private: true });
      }
    }
    // The shape checks say nothing of the value.
    expect(VALUES).toContain(`jq -e -f "$here/shape.jq" >/dev/null 2>&1`);
    expect(ADOPT).toContain(`jq -e -f "$here/shape.jq" "$d/values.tfvars.json" >/dev/null 2>&1`);
    // adopt holds no TOFU_VARS: the saved plan's own values, without the passphrase, are its values.
    expect(commandLines(ADOPT).join("\n")).not.toContain("${TOFU_VARS");
    expect(ADOPT).toContain(
      `jq -c '.variables | map_values(.value) | del(.state_passphrase)' "$d/plan.json" >"$d/values.tfvars.json" 2>/dev/null ||`,
    );
    // output masks every address and instance ID before its one line.
    expect(commandLines(OUTPUT).filter((l) => /^(?:echo|printf)\b/u.test(l))).toEqual([
      'echo "::add-mask::$m"',
      `echo "Read the connections of $(jq -r '.host_connection.value | length' "$d/outputs.json" 2>/dev/null) host(s)."`,
    ]);
    // The rebuild target is never echoed back.
    expect(
      commandLines(VALUES).filter((l) => /^(?:echo|printf)\b/u.test(l) && l.includes("$target")),
    ).toEqual([]);
  });

  test("the shape check agrees with ops/tofu/variables.tf on keys and names", () => {
    const shape = jqProgram("shape.jq");
    const variables = read("ops/tofu/variables.tf");
    for (const pattern of [
      "^(staging|prod)(-[0-9]{1,2})?$",
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
    expect(shape).toContain('(.value.role | str("^(staging|prod)$"))');
    // The rebuild target and the built-host line use the same two roles.
    expect(VALUES).toContain("[[ $target =~ ^(staging|prod)$ ]]");
    expect(SUMMARIZE).toContain("[[ $target =~ ^(staging|prod)$ ]]");
    // Exactly the seven keys of examples/example.tfvars.json.
    const keys = Object.keys(JSON.parse(read("ops/tofu/examples/example.tfvars.json"))).sort();
    expect(shape).toContain(`keys == ${JSON.stringify(keys).replaceAll(",", ", ")}`);
    // A label is only a string here (it isn't masked); variables.tf keeps Linode's own rules.
    expect(shape).toContain('(.value.label | type == "string")');
    expect(variables).toContain('can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label))');
    expect(variables).not.toContain("strcontains(k, h.label)");
    for (const text of [shape, variables]) expect(text).not.toContain("production");
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

  test("no host key is fetched or printed here; apply names each built host, which the job pins next", () => {
    // ops/tofu/ci/host.sh pins host keys (tests/unit/host-pin.test.ts); this script never does.
    expect(scriptText).not.toMatch(
      /ssh-keyscan|known_hosts|ssh-ed25519|TARGET_HOST|host_key|ssh-keygen/u,
    );
    const APPLY = phaseOf("apply");
    expect(APPLY).toContain(
      `$address =~ ^linode_instance\\.host\\[\\"((staging|prod)(-[0-9]{1,2})?)\\"\\]$`,
    );
    expect(APPLY).toContain(
      `line="built \${BASH_REMATCH[1]} (\${BASH_REMATCH[2]}): this job pins its host key next"`,
    );
    // Only the apply's counts print from its output, and only numbers.
    expect(jqProgram("applied.jq")).toContain("\\(.add | numbers) added");
  });

  test("the approving job takes only the file shown, and apply adds nothing that could change it", () => {
    // Plan's state key is read-only, so it must never try to write a lock.
    expect(phaseOf("plan")).toContain(
      'args=(-chdir="$module" plan -input=false -lock=false -json -var-file="$d/values.tfvars.json" -out="$d/plan.bin")',
    );
    expect(phaseOf("plan")).toContain('if [[ -n $replace ]]; then args+=("-replace=$replace"); fi');
    // adopt checks the file's SHA-256 before OpenTofu reads it, and masks before listing changes.
    expect(ADOPT).toContain(`[[ \${DIGEST-} =~ ^[0-9a-f]{64}$ ]] || fail`);
    expect(ADOPT).toContain(`[[ $digest == "\${DIGEST-}" ]] || fail`);
    expect(ADOPT).toContain(`[[ $current == "\${APPROVED-}" ]] || fail`);
    expect(ADOPT.indexOf("sha256sum")).toBeLessThan(ADOPT.indexOf("\n  show_plan\n"));
    expect(ADOPT.indexOf("\n  mask_values ")).toBeLessThan(ADOPT.indexOf("\n  change_list\n"));
    expect(ADOPT.indexOf('rm -f -- "$d/adopted"')).toBeLessThan(ADOPT.indexOf("DIGEST"));
    expect(SUMMARIZE).toContain(`digest=$(sha256sum -- "$d/plan.bin" | cut -d' ' -f1)`);
    expect(SUMMARIZE).toContain('echo "digest=$digest"');
    // The apply names only the saved plan, with no -var, -replace or -refresh that would ask for a
    // new plan, so OpenTofu applies exactly that file and refuses it as stale if the state changed
    // since the Infrastructure plan job read it.
    const applyCalls = commandLines(phaseOf("apply")).filter((l) => /^tofu\s/u.test(l));
    expect(applyCalls).toEqual([
      'tofu -chdir="$module" apply -input=false -json "$d/plan.bin" >"$d/apply.jsonl" 2>"$d/apply.stderr" || rc=$?',
    ]);
  });

  test("the guards name their switches, and the change list goes out under a random delimiter", () => {
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
    expect(SUMMARIZE).toContain(`\${ALLOW_DESTROY-} != true ]]`);
    expect(SUMMARIZE).toContain(`[[ \${ALLOW_ACCESS_REMOVAL-} != true ]]`);
    expect(SUMMARIZE).toContain('exit "$refuse"');
    // The rebuild's own replace is the one exact line the destroy guard lets through.
    expect(SUMMARIZE).toContain(`grep -vxF "replace $expected"`);
    // The allowance reads plan.json privately and prints nothing of it.
    expect(SUMMARIZE).toContain(
      `jq -e --arg t "$target" --slurpfile vars "$d/values.tfvars.json" "$REBUILD_REMOVALS" "$d/plan.json" >/dev/null 2>&1`,
    );
  });
});

// ---- The pinned OpenTofu ------------------------------------------------------------------------

describe("the pinned OpenTofu", () => {
  test("one install phase; ci.yml, deploy.yml and host.yml run the phases each needs", () => {
    /** The tofu-ci.sh phases a workflow runs: each call ends its line with the phase's name. */
    const phasesIn = (file: string) =>
      [
        ...new Set(
          [...read(`.github/workflows/${file}`).matchAll(/tofu-ci\.sh"? ([a-z]+)\s*$/gmu)].map(
            (m) => m[1] ?? "",
          ),
        ),
      ].sort();
    expect(phasesIn("ci.yml")).toEqual(["install"]);
    // Deploy's Infrastructure plan job plans, with infra-plan's read-only secrets and TOFU_VARS.
    expect(phasesIn("deploy.yml")).toEqual(
      ["install", "backend", "values", "init", "plan", "summarize"].sort(),
    );
    // The approving prod job adopts, applies and reads the outputs, with no TOFU_VARS.
    expect(phasesIn("host.yml")).toEqual(
      ["install", "backend", "init", "adopt", "apply", "output"].sort(),
    );
    // Every phase has a caller.
    expect(
      [
        ...new Set([...phasesIn("ci.yml"), ...phasesIn("deploy.yml"), ...phasesIn("host.yml")]),
      ].sort(),
    ).toEqual([...PHASES].sort());
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
/** host.sh (2.37.0) handles host keys by design; tests/unit/host-pin.test.ts covers it. */
const HOST_SH = "ops/tofu/ci/host.sh";

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
      HOST_SH,
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
      "ops/tofu/tests/main.tftest.hcl",
      "ops/tofu/variables.tf",
      "ops/tofu/versions.tf",
    ]);
  });

  test("every variable is sensitive and validated with fixed text; host_connection is sensitive", () => {
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
    // Two outputs: the public roles, and the connection details host.sh pin reads. 2.36.0's
    // addresses output is gone: host_connection carries the addresses with the instance ID.
    expect([...OUTPUTS.keys()]).toEqual(["output.hosts", "output.host_connection"]);
    const connection = block(OUTPUTS, "output.host_connection");
    expect(connection).toMatch(/^ {2}sensitive\s+= true$/mu);
    expect(connection).toContain("for k in local.host_keys : k => {");
    expect(connection).toContain("instance_id = tostring(linode_instance.host[k].id)");
    expect(connection).toContain("ipv6        = local.host_ipv6[k]");
    expect(connection).toContain("ipv4        = local.host_ipv4[k]");
    // host_ipv6 is the bare address, without the API's /128.
    expect(tf("main.tf")).toContain(
      'host_ipv6 = { for k in local.host_keys : k => split("/", linode_instance.host[k].ipv6)[0] }',
    );
    // hosts carries only public roles; its value must unwrap them explicitly.
    expect(block(OUTPUTS, "output.hosts")).toContain("nonsensitive(var.hosts[k].role)");
    // The module's own tests pin the value (main.tftest.hcl).
    expect(tf("tests/main.tftest.hcl")).toContain("issensitive(output.host_connection)");
  });

  test("the host-key, label, database-key, CIDR and hash validations are present", () => {
    const hosts = block(VARIABLES, "variable.hosts");
    expect(hosts).toContain(
      'can(regex("^(staging|prod)(-[0-9]{1,2})?$", k)) && split("-", k)[0] == h.role',
    );
    expect(block(VARIABLES, "variable.configure_keys")).toContain(
      'contains(["staging", "prod"], role)',
    );
    expect(hosts).toContain('can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", h.label))');
    expect(block(VARIABLES, "variable.database_ids")).toContain('can(regex("^[a-z]{1,16}$", k))');
    expect(block(VARIABLES, "variable.db_allow_extra")).toContain(
      'can(cidrhost(x, 0)) && strcontains(x, "/")',
    );
    expect(block(VARIABLES, "variable.state_passphrase")).toContain(
      "length(var.state_passphrase) >= 32",
    );
    // production is the Compose path's word only; the module's tests refuse it as key and role.
    for (const run of [
      "refuses_a_production_host",
      "refuses_a_numbered_production_host",
      "refuses_a_production_configure_key",
    ])
      expect(tf("tests/main.tftest.hcl")).toContain(`run "${run}" {`);
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
      // The test file asserts these words are absent from every rendering, and host.sh, which
      // pins host keys and writes the Configure key, has its own test.
      if (file === "ops/tofu/tests/main.tftest.hcl" || file === HOST_SH) continue;
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
    expect(Object.keys(vars.configure_keys)).toEqual(["staging"]);
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
  const FILES = [...TOFU, "tests/fixtures/infra/tofu", ".dockerignore"];

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

  test("only github.com, the registry in the lock file, example.org and the endpoint's shape", () => {
    for (const file of FILES) {
      const text = read(file);
      const allowed = (host: string) =>
        host === "github.com" ||
        host === "example.org" ||
        host.endsWith(".example.org") ||
        (host === "registry.opentofu.org" && file === "ops/tofu/.terraform.lock.hcl");
      const hosts = [...new Set(hostNames(text))].filter((h) => !allowed(h));
      // An Object Storage endpoint appears only as a shape.
      const shaped = hosts.filter((h) => h === "linodeobjects.com");
      expect({ file, hosts: hosts.filter((h) => h !== "linodeobjects.com") }).toEqual({
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

// ---- .dockerignore -------------------------------------------------------------------------------

describe(".dockerignore", () => {
  /** The file's patterns, in order; Docker lets the last one that matches a path or a parent decide. */
  const patterns = read(".dockerignore")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
  const excluded = (path: string) => {
    const parts = path.split("/");
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    let out = false;
    for (const line of patterns) {
      const negated = line.startsWith("!");
      const glob = new Bun.Glob(negated ? line.slice(1) : line);
      if (prefixes.some((p) => glob.match(p))) out = !negated;
    }
    return out;
  };

  test("OpenTofu's local state, plans, values and backend settings, and every dump, stay out of the image", () => {
    // Codex's ce3ded7 lines (2.37.0), with the committed placeholder values re-included after them.
    for (const line of [
      "**/*.tfstate",
      "**/*.tfstate.*",
      "**/*.tfplan",
      "**/plan.bin",
      "**/*.tfvars",
      "**/*.tfvars.json",
      "**/backend.hcl",
      "!ops/tofu/examples/*.tfvars.json",
      "**/*.dump",
      "**/*.backup",
    ])
      expect({ line, present: patterns.includes(line) }).toEqual({ line, present: true });
    expect(patterns.indexOf("!ops/tofu/examples/*.tfvars.json")).toBeGreaterThan(
      patterns.indexOf("**/*.tfvars.json"),
    );
    for (const path of [
      "terraform.tfstate",
      "ops/tofu/terraform.tfstate",
      "ops/tofu/terraform.tfstate.backup",
      "ops/tofu/rehearsal.tfplan",
      "plan.bin",
      "scratch/tofu/plan.bin",
      "prod.tfvars",
      "ops/tofu/prod.tfvars.json",
      "values.tfvars.json",
      "backend.hcl",
      "ops/tofu/backend.hcl",
      "ops/tofu/.terraform/providers/registry.opentofu.org/linode/linode/x",
      "tarubot_dev-before-2.37.0.dump",
      "backups/tarubot.backup",
      ".cache/backups/tarubot_dev.dump",
      "tarubot_backup.sql",
      ".env",
    ])
      expect({ path, excluded: excluded(path) }).toEqual({ path, excluded: true });
    // The build stage runs the unit tests, which read these.
    for (const path of [
      "ops/tofu/examples/example.tfvars.json",
      "ops/tofu/main.tf",
      "ops/tofu/ci/tofu-ci.sh",
      "tests/fixtures/infra/tofu",
      ".env.example",
    ])
      expect({ path, excluded: excluded(path) }).toEqual({ path, excluded: false });
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
type Values = Record<string, unknown> & {
  hosts: Record<string, object>;
  configure_keys: Record<string, string>;
  db_allow_extra: string[];
};
const example = () => JSON.parse(EXAMPLE) as Values;
/** The example with a prod host beside staging: both of Deploy's targets. */
const twoHosts = () => {
  const values = example();
  values.hosts.prod = {
    label: "tarubot-prod",
    fqdn: "prod.example.org",
    region: "us-east",
    type: "g6-standard-1",
    role: "prod",
  };
  values.configure_keys.prod =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0003 configure-prod";
  return values;
};
const TWO = JSON.stringify(twoHosts());

/** A plan's resource change, in the shape of `tofu show -json`. */
const change = (
  address: string,
  actions: string[],
  fields: {
    before?: object;
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
    // Both targets' hosts, and a numbered prod host.
    expect(jq("shape.jq", TWO, ["-e"]).code).toBe(0);
    const numbered = twoHosts();
    numbered.hosts["prod-2"] = { ...(numbered.hosts.prod ?? {}), label: "tarubot-prod-2" };
    expect(jq("shape.jq", JSON.stringify(numbered), ["-e"]).code).toBe(0);
    // A label is any string now; only variables.tf holds Linode's rules.
    const plainLabel = example();
    Object.assign(plainLabel.hosts.staging ?? {}, { label: "tarubot" });
    expect(jq("shape.jq", JSON.stringify(plainLabel), ["-e"]).code).toBe(0);
    for (const [what, edit] of [
      ["an extra key", (v: Values) => Object.assign(v, { more: 1 })],
      ["a host key", (v: Values) => Object.assign(v, { hosts: { stage: {} } })],
      [
        "the Compose path's word as a host key",
        (v: Values) =>
          Object.assign(v, {
            hosts: {
              production: {
                label: "tarubot-production",
                fqdn: "production.example.org",
                region: "us-east",
                type: "g6-standard-1",
                role: "production",
              },
            },
          }),
      ],
      [
        "the Compose path's word as a role",
        (v: Values) => {
          Object.assign(v.hosts.staging ?? {}, { role: "production" });
        },
      ],
      [
        "an upper-case fqdn",
        (v: Values) => {
          Object.assign(v.hosts.staging ?? {}, { fqdn: "Staging.Example.Org" });
        },
      ],
      ["a zone ID", (v: Values) => Object.assign(v, { cloudflare_zone_id: "x" })],
      ["an extra entry", (v: Values) => Object.assign(v, { db_allow_extra: ["x"] })],
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
    const value = twoHosts();
    Object.assign(value, { root_password_hash: "$y$j9T$EXAMPLEsalt$EXAMPLEhashEXAMPLEhash" });
    const masks = JSON.parse(jq("masks.jq", JSON.stringify(value), ["-c"]).out) as string[];
    expect(masks).toContain("staging.example.org");
    expect(masks).toContain("prod.example.org");
    expect(masks).toContain("0".repeat(32));
    expect(masks).toContain("$y$j9T$EXAMPLEsalt$EXAMPLEhashEXAMPLEhash");
    for (const extra of value.db_allow_extra) {
      expect(masks).toContain(extra);
      expect(masks).toContain(extra.split("/")[0] ?? "");
    }
    for (const key of [...(value.root_keys as string[]), ...Object.values(value.configure_keys)])
      expect(masks).toContain(
        String(key)
          .split(" ")
          .find((part) => part.startsWith("AAAA")) ?? "",
      );
    for (const word of [
      "tarubot-staging",
      "tarubot-prod",
      "staging",
      "prod",
      "primary",
      "us-east",
      "g6-standard-1",
    ])
      expect({ word, masked: masks.includes(word) }).toEqual({ word, masked: false });
  });

  test("summary.jq names each change, counts access-list entries, and turns the unknown into ?", () => {
    const summarize = (changes: object[]) =>
      jq("summary.jq", JSON.stringify({ resource_changes: changes }), SUMMARY_VARS).out;
    const extra = example().db_allow_extra;
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
   * A runner: the stand-in tofu first on PATH, RUNNER_TEMP, the step files, and an event payload
   * holding a replace input and a rebuild, which no phase may read.
   */
  function runner() {
    const dir = join(scratch, `r${++boxes}`);
    for (const path of ["bin", "temp", "stub"]) mkdirSync(join(dir, path), { recursive: true });
    cpSync(root("tests/fixtures/infra/tofu"), join(dir, "bin", "tofu"));
    chmodSync(join(dir, "bin", "tofu"), 0o755);
    for (const name of ["env", "output", "summary", "path"]) writeFileSync(join(dir, name), "");
    writeFileSync(
      join(dir, "event.json"),
      JSON.stringify({
        inputs: { replace: 'linode_instance.host["staging"]', rebuild: true, target: "prod" },
      }),
    );
    const phase = (name: string, env: Record<string, string> = {}) => {
      const r = Bun.spawnSync(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", root(SCRIPT), name],
        {
          env: {
            PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
            HOME: dir,
            STUB: join(dir, "stub"),
            RUNNER_TEMP: join(dir, "temp"),
            GITHUB_ENV: join(dir, "env"),
            GITHUB_OUTPUT: join(dir, "output"),
            GITHUB_STEP_SUMMARY: join(dir, "summary"),
            GITHUB_PATH: join(dir, "path"),
            GITHUB_EVENT_PATH: join(dir, "event.json"),
            ...env,
          },
          stdin: "ignore",
        },
      );
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const file = (path: string) => readFileSync(join(dir, path), "utf8");
    /** Writes a file, making its directory first, as download-artifact does for the saved plan. */
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    /** The stand-in's recorded calls, each as its argument list. */
    const calls = () =>
      existsSync(join(dir, "stub", "calls"))
        ? readdirSync(join(dir, "stub", "calls"))
            .sort((a, b) => Number(a) - Number(b))
            .map((n) => readFileSync(join(dir, "stub", "calls", n), "utf8").split("\n"))
        : [];
    return { dir, phase, file, write, calls };
  }
  const BACKEND = {
    STATE_BUCKET: "state-bucket-example",
    STATE_ENDPOINT: "https://us-east-1.example.org",
  };
  const STATE = {
    AWS_ACCESS_KEY_ID: "access-example",
    AWS_SECRET_ACCESS_KEY: "secret-example",
    TF_VAR_state_passphrase: "a throwaway passphrase of 32 or more characters",
  };
  const TOKENS = { ...STATE, LINODE_TOKEN: "t", CLOUDFLARE_API_TOKEN: "t" };
  const PASSPHRASE = { TF_VAR_state_passphrase: STATE.TF_VAR_state_passphrase };
  const NO_SWITCHES = { ...PASSPHRASE, ALLOW_DESTROY: "false", ALLOW_ACCESS_REMOVAL: "false" };
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const masksOf = (values: string) => JSON.parse(jq("masks.jq", values, ["-c"]).out) as string[];
  /** A saved plan's `variables`, as `tofu show -json` gives them: every value, the passphrase too. */
  const planned = (values: Record<string, unknown>) => ({
    ...Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
    state_passphrase: { value: STATE.TF_VAR_state_passphrase },
  });

  /** Each host's addresses before a change, from the documentation ranges. */
  const OLD = {
    staging: { ipv4: "192.0.2.10", ipv6: "2001:db8:1::10" },
    prod: { ipv4: "192.0.2.20", ipv6: "2001:db8:2::20" },
  } as const;
  type Key = keyof typeof OLD;
  const other = (key: Key): Key => (key === "staging" ? "prod" : "staging");
  /** An instance's attributes as the provider reports them: IPv6 with its /128. */
  const attributes = (key: Key) => ({ ipv4: [OLD[key].ipv4], ipv6: `${OLD[key].ipv6}/128` });
  /** A host's two access-list entries, as the API stores them. */
  const entries = (key: Key) => [`${OLD[key].ipv6}/128`, `${OLD[key].ipv4}/32`];
  const kept = (key: Key) =>
    change(`linode_instance.host["${key}"]`, ["no-op"], {
      before: attributes(key),
      after: attributes(key),
    });
  const replaced = (key: Key) =>
    change(`linode_instance.host["${key}"]`, ["delete", "create"], {
      before: attributes(key),
      after: {},
      after_unknown: { ipv4: true, ipv6: true },
    });
  /** The primary cluster's list, with a new host's addresses unknown, as a plan shows it. */
  const accessList = (before: string[]) =>
    change('linode_database_access_controls.db["primary"]', ["update"], {
      before: { allow_list: before },
      after: {},
      after_unknown: { allow_list: true },
    });
  const EXTRA = example().db_allow_extra;
  /** Both hosts built and in the list; a rebuild of `target` replaces its instance. */
  const rebuildPlan = (target: Key, drift: string[] = []) => ({
    resource_changes: [
      replaced(target),
      kept(other(target)),
      change(`cloudflare_dns_record.a["${target}"]`, ["update"]),
      change(`cloudflare_dns_record.aaaa["${target}"]`, ["update"]),
      accessList([...entries("staging"), ...entries("prod"), ...EXTRA, ...drift]),
    ],
  });
  const rebuildList = (target: Key, minus = 2) =>
    [
      `replace linode_instance.host["${target}"]`,
      `update cloudflare_dns_record.a["${target}"]`,
      `update cloudflare_dns_record.aaaa["${target}"]`,
      `update linode_database_access_controls.db["primary"] +2 -${minus}`,
    ].join("\n");
  const ALLOWED_REMOVAL = "The access-list removals are the rebuilt host's own two old entries.";
  const OTHER_REMOVAL =
    "::error::The plan removes a database access-list entry other than the rebuilt host's own two old ones; dispatch again with allow_access_removal if you meant it.";
  const DESTROY =
    "::error::The plan deletes or replaces a resource; dispatch again with allow_destroy if you meant it.";

  /** A runner with the values read (TOFU_VARS and REBUILD_TARGET) and a saved plan in place. */
  function withPlan(values: string, target: string, plan: object) {
    const r = runner();
    const valuesRun = r.phase("values", { TOFU_VARS: values, REBUILD_TARGET: target });
    expect({ code: valuesRun.code, err: valuesRun.err }).toEqual({ code: 0, err: "" });
    r.write("temp/tofu/plan.bin", "a saved plan");
    r.write("stub/plan.json", JSON.stringify(plan));
    return r;
  }

  test("backend writes the backend settings and TF_DATA_DIR, and nothing of either prints", () => {
    const r = runner();
    expect(r.phase("backend", BACKEND)).toEqual({
      code: 0,
      out: "Wrote the backend settings.\n",
      err: "",
    });
    expect(r.file("temp/tofu/backend.hcl")).toBe(
      [
        'bucket         = "state-bucket-example"',
        'endpoints      = { s3 = "https://us-east-1.example.org" }',
        "use_path_style = false",
        "",
      ].join("\n"),
    );
    expect(r.file("env")).toBe(`TF_DATA_DIR=${join(r.dir, "temp", "tofu")}/data\n`);
    expect(statSync(join(r.dir, "temp", "tofu", "backend.hcl")).mode & 0o077).toBe(0);
    expect(statSync(join(r.dir, "temp", "tofu")).mode & 0o077).toBe(0);
    // It needs nothing else, and never reads TOFU_VARS.
    expect(existsSync(join(r.dir, "temp", "tofu", "values.tfvars.json"))).toBe(false);
    // A bucket with a dot or a bad endpoint: one fixed message each, and nothing of the value.
    for (const [env, message] of [
      [
        { STATE_BUCKET: "state.bucket.example.org" },
        "::error::TOFU_STATE_BUCKET must be an Object Storage bucket name of a-z, 0-9 and '-', with no dot.\n",
      ],
      [
        { STATE_BUCKET: "" },
        "::error::TOFU_STATE_BUCKET must be an Object Storage bucket name of a-z, 0-9 and '-', with no dot.\n",
      ],
      [
        { STATE_ENDPOINT: "https://us-east-1.example.org/path" },
        "::error::TOFU_STATE_ENDPOINT must be the bucket's https:// endpoint, with no path (ops/tofu/README.md).\n",
      ],
      [
        { STATE_ENDPOINT: "http://us-east-1.example.org" },
        "::error::TOFU_STATE_ENDPOINT must be the bucket's https:// endpoint, with no path (ops/tofu/README.md).\n",
      ],
    ] as const) {
      const refused = runner().phase("backend", { ...BACKEND, ...env });
      expect(refused).toEqual({ code: 1, out: message, err: "" });
    }
  });

  test("values masks every identifying value first, writes private files, and takes the rebuild target from REBUILD_TARGET only", () => {
    const r = runner();
    const done = r.phase("values", { TOFU_VARS: EXAMPLE });
    expect({ code: done.code, err: done.err }).toEqual({ code: 0, err: "" });
    const masks = masksOf(EXAMPLE);
    expect(done.out).toBe(
      [
        ...masks.map((m) => `::add-mask::${m}`),
        "Read the values for 1 host(s) and 1 access list(s).",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(r.file("temp/tofu/values.tfvars.json"))).toEqual(JSON.parse(EXAMPLE));
    expect(JSON.parse(r.file("temp/tofu/masks.json"))).toEqual(masks);
    for (const name of ["values.tfvars.json", "masks.json", "replace"])
      expect({ name, mode: statSync(join(r.dir, "temp", "tofu", name)).mode & 0o077 }).toEqual({
        name,
        mode: 0,
      });
    // The event payload names a replace and a rebuild; neither is read.
    expect(r.file("temp/tofu/replace")).toBe("");
    // It writes no backend settings: that is the backend phase's.
    expect(existsSync(join(r.dir, "temp", "tofu", "backend.hcl"))).toBe(false);
    expect(r.file("env")).toBe("");
    // A value the shape refuses: one fixed error, no mask, nothing of the value.
    const bad = runner().phase("values", { TOFU_VARS: '{"hosts": "staging.example.org"}' });
    expect(bad.code).toBe(1);
    expect(bad.out).toStartWith("::error::TOFU_VARS must be one JSON object");
    expect(bad.out).not.toContain("::add-mask::");
    expect(bad.out + bad.err).not.toContain("example.org");
    // The rebuild target names one of the two plain hosts in TOFU_VARS, for either target.
    for (const [values, target] of [
      [EXAMPLE, "staging"],
      [TWO, "staging"],
      [TWO, "prod"],
    ] as const) {
      const box = runner();
      expect({
        target,
        code: box.phase("values", { TOFU_VARS: values, REBUILD_TARGET: target }).code,
      }).toEqual({
        target,
        code: 0,
      });
      expect(box.file("temp/tofu/replace")).toBe(`linode_instance.host["${target}"]`);
    }
    // Anything else is refused with one fixed message after the masks, and never echoed back.
    const NOT_A_TARGET =
      "::error::REBUILD_TARGET must be empty, staging or prod, naming a host in TOFU_VARS.";
    for (const [values, target] of [
      [EXAMPLE, "prod"],
      [TWO, "production"],
      [TWO, 'linode_instance.host["staging"]'],
      [TWO, "staging-2"],
      [TWO, "x; id"],
      [TWO, "other.example.net"],
      [TWO, "192.0.2.99"],
    ] as const) {
      const refused = runner().phase("values", { TOFU_VARS: values, REBUILD_TARGET: target });
      expect({ target, code: refused.code }).toEqual({ target, code: 1 });
      expect(refused.out.trimEnd().split("\n").at(-1)).toBe(NOT_A_TARGET);
      expect({
        target,
        echoed: refused.out
          .split("\n")
          .some((l) => !l.startsWith("::add-mask::") && l !== NOT_A_TARGET && l.includes(target)),
      }).toEqual({ target, echoed: false });
    }
  });

  test("init, plan and summarize keep tofu's output private, list the changes and apply the guards", () => {
    const r = runner();
    expect(r.phase("backend", BACKEND).code).toBe(0);
    expect(r.phase("values", { TOFU_VARS: EXAMPLE }).code).toBe(0);
    // init's output names the bucket, so it stays in a private file.
    r.write("stub/init.stderr", "bucket state-bucket-example at us-east-1.example.org\n");
    expect(r.phase("init", STATE)).toEqual({ code: 0, out: "init ok\n", err: "" });
    expect(r.phase("plan", TOKENS)).toEqual({ code: 0, out: "plan ok\n", err: "" });
    // A plan with a replace and an access-list removal, and no rebuild asked for.
    r.write(
      "stub/plan.json",
      JSON.stringify({
        resource_changes: [
          change('linode_instance.host["staging"]', ["delete", "create"], {
            after_unknown: { ipv4: true, ipv6: true },
          }),
          accessList(["2001:db8:1::10/128", "192.0.2.10/32"]),
        ],
      }),
    );
    const guarded = r.phase("summarize", NO_SWITCHES);
    expect(guarded).toEqual({
      code: 1,
      out: [
        "The plan's changes:",
        'replace linode_instance.host["staging"]',
        'update linode_database_access_controls.db["primary"] +4 -2',
        DESTROY,
        "::error::The plan removes an entry from a database access list; dispatch again with allow_access_removal if you meant it.",
        "",
      ].join("\n"),
      err: "",
    });
    expect(r.file("summary")).toContain('| replace | `linode_instance.host["staging"]` |  |');
    expect(r.file("summary")).not.toContain("Rebuild");
    const output = r.file("output");
    expect(output).toMatch(/^changes<<changes_[0-9a-f]{32}\nreplace /u);
    expect(output).toContain("has_changes=true\n");
    // The saved plan's SHA-256, which the approving job checks the fetched file against.
    const saved = r.file("temp/tofu/plan.bin");
    expect(output).toContain(`\ndigest=${sha256(saved)}\n`);
    // Both switches let it through.
    expect(
      r.phase("summarize", { ...PASSPHRASE, ALLOW_DESTROY: "true", ALLOW_ACCESS_REMOVAL: "true" })
        .code,
    ).toBe(0);
    // Every tofu call ran in the module, the plan took no state lock and replaced nothing.
    const calls = r.calls();
    expect(calls.every((args) => args[0] === `-chdir=${root("ops/tofu")}`)).toBe(true);
    expect(calls.map((args) => args[1])).toEqual(["init", "plan", "show", "show"]);
    expect(calls[1]).toContain("-lock=false");
    expect(calls[1]).toContain(`-out=${join(r.dir, "temp", "tofu", "plan.bin")}`);
    expect(calls[1]?.some((a) => a.startsWith("-replace"))).toBe(false);
    // A rebuild's plan replaces exactly its target's instance.
    const rebuild = runner();
    rebuild.phase("values", { TOFU_VARS: TWO, REBUILD_TARGET: "prod" });
    expect(rebuild.phase("plan", TOKENS).code).toBe(0);
    expect(rebuild.calls()[0]?.filter((a) => a.startsWith("-replace"))).toEqual([
      '-replace=linode_instance.host["prod"]',
    ]);
    // No changes: has_changes=false, and the digest still goes out (a pins-only run needs it).
    const none = withPlan(EXAMPLE, "", { resource_changes: [kept("staging")] });
    expect(none.phase("summarize", NO_SWITCHES)).toEqual({
      code: 0,
      out: "No changes.\n",
      err: "",
    });
    expect(none.file("output")).toContain("has_changes=false\n");
    expect(none.file("output")).toContain(`\ndigest=${sha256("a saved plan")}\n`);
    expect(none.file("summary")).toContain("No changes.");
    // A failed plan prints only the filtered diagnostics.
    const failed = runner();
    failed.phase("values", { TOFU_VARS: EXAMPLE });
    failed.write("stub/exit.plan", "1");
    failed.write(
      "stub/plan.jsonl",
      `${JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary: "No access to 192.0.2.10 at staging.example.org", detail: "secret" } })}\n`,
    );
    expect(failed.phase("plan", TOKENS)).toEqual({
      code: 1,
      out: "::error::plan failed (exit 1). Its diagnostics, with names, numbers and addresses left out:\nerror - No access to ... at (masked) \n",
      err: "",
    });
    // Without the values phase, plan and summarize stop with a fixed message.
    const early = runner();
    expect(early.phase("plan", TOKENS).out).toBe(
      "::error::The values are missing: run the values phase first.\n",
    );
    expect(early.phase("summarize", NO_SWITCHES).out).toBe(
      "::error::The values are missing: run the values phase first.\n",
    );
    expect(early.phase("init", STATE).out).toBe(
      "::error::The backend settings are missing: run the backend phase first.\n",
    );
    // A plan summary.jq can't read (a provider that changed a schema): jq's own error, which
    // quotes the start of the value, stays in a private file, and only fixed text prints.
    const odd = withPlan(EXAMPLE, "", {
      resource_changes: [
        change('linode_database_access_controls.db["primary"]', ["update"], {
          before: { allow_list: "203.0.113.10/32" },
          after_unknown: { allow_list: true },
        }),
      ],
    });
    expect(odd.phase("summarize", PASSPHRASE)).toEqual({
      code: 1,
      out: "::error::The change list couldn't be built from the saved plan; nothing was applied.\n",
      err: "",
    });
    expect(odd.file("temp/tofu/summary.stderr")).toContain("203.0.113.");
    // show's own errors stay private too.
    const unshown = withPlan(EXAMPLE, "", { resource_changes: [] });
    unshown.write("stub/exit.show", "1");
    unshown.write("stub/show.stderr", "decryption failed for 192.0.2.10\n");
    expect(unshown.phase("summarize", PASSPHRASE)).toEqual({
      code: 1,
      out: "::error::show failed (exit 1): a TOFU_STATE_PASSPHRASE other than the one that made the plan fails here too.\n",
      err: "",
    });
  });

  test("a rebuild allows exactly its own instance's replace and its two old access-list entries, for either target (B1)", () => {
    for (const target of ["staging", "prod"] as const) {
      // The rebuilt host's two old entries leave the list: no switch needed.
      const ok = withPlan(TWO, target, rebuildPlan(target));
      const passed = ok.phase("summarize", { ...NO_SWITCHES, REBUILD_TARGET: target });
      expect({ target, ...passed }).toEqual({
        target,
        code: 0,
        out: ["The plan's changes:", rebuildList(target), ALLOWED_REMOVAL, ""].join("\n"),
        err: "",
      });
      expect(ok.file("summary")).toContain(
        `Rebuild: approving replaces the \`${target}\` host's instance.`,
      );
      expect(ok.file("summary")).toContain(`- ${ALLOWED_REMOVAL}`);
      // Nothing of the allowance's inputs prints: no address, old or kept.
      for (const address of [...entries("staging"), ...entries("prod")])
        expect({
          target,
          address,
          printed: (passed.out + ok.file("summary")).includes(address),
        }).toEqual({
          target,
          address,
          printed: false,
        });

      // db_allow_extra drifted: an entry no longer in TOFU_VARS would leave the list with the
      // rebuild. That is a removal nobody asked for, so it still needs allow_access_removal.
      const drift = withPlan(TWO, target, rebuildPlan(target, ["203.0.113.50/32"]));
      const refused = drift.phase("summarize", { ...NO_SWITCHES, REBUILD_TARGET: target });
      expect({ target, ...refused }).toEqual({
        target,
        code: 1,
        out: ["The plan's changes:", rebuildList(target, 3), OTHER_REMOVAL, ""].join("\n"),
        err: "",
      });
      expect(
        drift.phase("summarize", {
          ...NO_SWITCHES,
          ALLOW_ACCESS_REMOVAL: "true",
          REBUILD_TARGET: target,
        }).code,
      ).toBe(0);

      // The other host's entry leaving (its address changed) isn't the rebuild's either.
      const moved = rebuildPlan(target);
      moved.resource_changes[1] = change(`linode_instance.host["${other(target)}"]`, ["update"], {
        before: attributes(other(target)),
        after: { ...attributes(other(target)), ipv4: ["198.51.100.99"] },
      });
      const otherEntry = withPlan(TWO, target, moved).phase("summarize", {
        ...NO_SWITCHES,
        REBUILD_TARGET: target,
      });
      expect({
        target,
        code: otherEntry.code,
        last: otherEntry.out.trimEnd().split("\n").at(-1),
      }).toEqual({
        target,
        code: 1,
        last: OTHER_REMOVAL,
      });

      // Without the rebuild, the same plan needs both switches.
      const plain = withPlan(TWO, "", rebuildPlan(target));
      const unasked = plain.phase("summarize", NO_SWITCHES);
      expect({ target, code: unasked.code }).toEqual({ target, code: 1 });
      expect(unasked.out).toContain(DESTROY);
      expect(unasked.out).toContain(
        "::error::The plan removes an entry from a database access list; dispatch again with allow_access_removal if you meant it.",
      );

      // A rebuild of one host never covers the other's replace, or a delete of its own.
      const wrong = withPlan(TWO, other(target), rebuildPlan(target));
      const across = wrong.phase("summarize", { ...NO_SWITCHES, REBUILD_TARGET: other(target) });
      expect({ target, code: across.code }).toEqual({ target, code: 1 });
      expect(across.out).toContain(DESTROY);
      expect(across.out).toContain(OTHER_REMOVAL);
      const deleted = rebuildPlan(target);
      deleted.resource_changes[0] = change(`linode_instance.host["${target}"]`, ["delete"], {
        before: attributes(target),
        after: null,
      });
      const gone = withPlan(TWO, target, deleted).phase("summarize", {
        ...NO_SWITCHES,
        REBUILD_TARGET: target,
      });
      expect({ target, code: gone.code }).toEqual({ target, code: 1 });
      expect(gone.out).toContain(DESTROY);
    }
    // A numbered host's replace is never the plain target's.
    const numbered = twoHosts();
    numbered.hosts["staging-2"] = { ...(numbered.hosts.staging ?? {}), label: "tarubot-staging-2" };
    const plan = rebuildPlan("staging");
    plan.resource_changes.push(
      change('linode_instance.host["staging-2"]', ["delete", "create"], {
        before: { ipv4: ["192.0.2.30"], ipv6: "2001:db8:3::30/128" },
        after: {},
        after_unknown: { ipv4: true, ipv6: true },
      }),
    );
    const two = withPlan(JSON.stringify(numbered), "staging", plan).phase("summarize", {
      ...NO_SWITCHES,
      REBUILD_TARGET: "staging",
    });
    expect(two.code).toBe(1);
    expect(two.out).toContain(DESTROY);
    // REBUILD_TARGET must be the one the values phase planned with.
    const mismatch = withPlan(TWO, "staging", rebuildPlan("staging"));
    for (const target of ["", "prod", "production"])
      expect({
        target,
        ...mismatch.phase("summarize", { ...NO_SWITCHES, REBUILD_TARGET: target }),
      }).toMatchObject({
        target,
        code: 1,
        out: expect.stringMatching(/^::error::REBUILD_TARGET (?:differs|must be)/u),
      });
  });

  test("a module-wide change passes summarize whichever target the run is for (B6)", () => {
    // A firewall rule, a TTL or a provider update touches both hosts' resources at once. There is
    // no per-target guard: @deconfined approves the whole plan, from either target's run.
    const moduleWide = [
      kept("staging"),
      kept("prod"),
      change('linode_firewall.host["staging"]', ["update"]),
      change('linode_firewall.host["prod"]', ["update"]),
      change('cloudflare_dns_record.a["staging"]', ["update"]),
      change('cloudflare_dns_record.a["prod"]', ["update"]),
    ];
    const list = [
      'update cloudflare_dns_record.a["prod"]',
      'update cloudflare_dns_record.a["staging"]',
      'update linode_firewall.host["prod"]',
      'update linode_firewall.host["staging"]',
    ];
    expect(
      withPlan(TWO, "", { resource_changes: moduleWide }).phase("summarize", NO_SWITCHES),
    ).toEqual({
      code: 0,
      out: ["The plan's changes:", ...list, ""].join("\n"),
      err: "",
    });
    // And beside either target's rebuild.
    for (const target of ["staging", "prod"] as const) {
      const plan = rebuildPlan(target);
      plan.resource_changes.push(
        change('linode_firewall.host["staging"]', ["update"]),
        change('linode_firewall.host["prod"]', ["update"]),
      );
      const passed = withPlan(TWO, target, plan).phase("summarize", {
        ...NO_SWITCHES,
        REBUILD_TARGET: target,
      });
      expect({ target, code: passed.code, err: passed.err }).toEqual({ target, code: 0, err: "" });
      expect(passed.out).toContain('update linode_firewall.host["prod"]\n');
      expect(passed.out).toContain('update linode_firewall.host["staging"]\n');
    }
  });

  /**
   * The approving job's runner: a fetched saved plan planned with `values`, whose change list and
   * digest the Infrastructure plan job published.
   */
  function fetched(values: Record<string, unknown>, changes: object[]) {
    const r = runner();
    const saved = "an encrypted saved plan";
    r.write("temp/tofu/plan.bin", saved);
    r.write(
      "stub/plan.json",
      JSON.stringify({ variables: planned(values), resource_changes: changes }),
    );
    return { r, digest: sha256(saved) };
  }
  const BUILD = [
    change('linode_instance.host["prod"]', ["create"], {
      after_unknown: { ipv4: true, ipv6: true },
    }),
    kept("staging"),
    accessList([...entries("staging"), ...EXTRA]),
  ];
  const BUILD_LIST = [
    'create linode_instance.host["prod"]',
    'update linode_database_access_controls.db["primary"] +2 -0',
  ].join("\n");

  test("adopt takes the values from the saved plan, masks them first, and refuses any other file or list", () => {
    const { r, digest } = fetched(twoHosts(), BUILD);
    const shown = { DIGEST: digest, APPROVED: BUILD_LIST, HAS_CHANGES: "true", ...PASSPHRASE };
    // No TOFU_VARS in the approving job; a stray one would be ignored.
    const adopted = r.phase("adopt", { ...shown, TOFU_VARS: EXAMPLE });
    const masks = masksOf(TWO);
    expect(adopted).toEqual({
      code: 0,
      out: [
        ...masks.map((m) => `::add-mask::${m}`),
        "The saved plan is the one shown before the approval.",
        "",
      ].join("\n"),
      err: "",
    });
    // Its values are the plan's own, without the passphrase, in private files.
    expect(JSON.parse(r.file("temp/tofu/values.tfvars.json"))).toEqual(twoHosts());
    expect(r.file("temp/tofu/values.tfvars.json")).not.toContain(STATE.TF_VAR_state_passphrase);
    expect(JSON.parse(r.file("temp/tofu/masks.json"))).toEqual(masks);
    expect(r.file("temp/tofu/changes.txt")).toBe(`${BUILD_LIST}\n`);
    expect(r.file("temp/tofu/adopted")).toBe(`${digest}\n`);
    for (const name of ["values.tfvars.json", "plan.json", "adopted"])
      expect({ name, mode: statSync(join(r.dir, "temp", "tofu", name)).mode & 0o077 }).toEqual({
        name,
        mode: 0,
      });
    // It read the fetched file itself, through tofu show.
    expect(r.calls()).toEqual([
      [`-chdir=${root("ops/tofu")}`, "show", "-json", join(r.dir, "temp", "tofu", "plan.bin"), ""],
    ]);

    for (const [what, env, message] of [
      ["no digest", { DIGEST: "" }, "::error::The Infrastructure plan job's digest didn't arrive"],
      [
        "a short digest",
        { DIGEST: "0".repeat(63) },
        "::error::The Infrastructure plan job's digest didn't arrive",
      ],
      [
        "another file",
        { DIGEST: "0".repeat(64) },
        "::error::The saved plan isn't the file the Infrastructure plan job made",
      ],
      [
        "no has_changes",
        { HAS_CHANGES: "" },
        "::error::The Infrastructure plan job's has_changes didn't arrive",
      ],
      [
        "a mangled has_changes",
        { HAS_CHANGES: "yes" },
        "::error::The Infrastructure plan job's has_changes didn't arrive",
      ],
      [
        "no list",
        { APPROVED: "" },
        "::error::The Infrastructure plan job's change list didn't arrive",
      ],
      [
        "a list beside has_changes=false",
        { HAS_CHANGES: "false" },
        "::error::The Infrastructure plan job listed changes but reported none",
      ],
      [
        "other changes",
        { APPROVED: BUILD_LIST.replace("+2", "+3") },
        "::error::The saved plan's changes differ from the ones the Infrastructure plan job showed",
      ],
      [
        "changes behind has_changes=false",
        { HAS_CHANGES: "false", APPROVED: "" },
        "::error::The saved plan's changes differ from the ones the Infrastructure plan job showed",
      ],
    ] as const) {
      const refused = r.phase("adopt", { ...shown, ...env });
      expect({
        what,
        code: refused.code,
        last: refused.out.trimEnd().split("\n").at(-1)?.startsWith(message),
      }).toEqual({
        what,
        code: 1,
        last: true,
      });
      // A refusal leaves nothing adopted for apply.
      expect({ what, adopted: existsSync(join(r.dir, "temp", "tofu", "adopted")) }).toEqual({
        what,
        adopted: false,
      });
    }
    // A saved plan whose values aren't in TOFU_VARS's shape (planned before the prod rename, say):
    // one fixed message, no mask, nothing of the values.
    const renamed = twoHosts();
    renamed.hosts = { production: { ...(renamed.hosts.prod ?? {}), role: "production" } };
    const old = fetched(renamed, BUILD);
    const refused = old.r.phase("adopt", { ...shown, DIGEST: old.digest });
    expect(refused).toEqual({
      code: 1,
      out: "::error::The saved plan's values aren't in TOFU_VARS's shape; nothing was applied. Dispatch a new run.\n",
      err: "",
    });
    // A plan with no values at all: one fixed message, and jq's own error stays unprinted.
    const empty = runner();
    empty.write("temp/tofu/plan.bin", "a saved plan");
    empty.write("stub/plan.json", JSON.stringify({ resource_changes: BUILD }));
    expect(empty.phase("adopt", { ...shown, DIGEST: sha256("a saved plan") })).toEqual({
      code: 1,
      out: "::error::The saved plan's values couldn't be read; nothing was applied. Dispatch a new run.\n",
      err: "",
    });
    // The artifact missing (kept one day), or another file: refused before OpenTofu reads it.
    const late = runner();
    expect(late.phase("adopt", shown).out).toBe(
      "::error::The saved plan didn't arrive (the artifact is kept one day); dispatch a new run.\n",
    );
    const swapped = fetched(twoHosts(), BUILD);
    expect(swapped.r.phase("adopt", { ...shown, DIGEST: "0".repeat(64) }).code).toBe(1);
    expect([...late.calls(), ...swapped.r.calls()]).toEqual([]);

    // The pins-only case: no changes, an empty list, has_changes=false.
    const pins = fetched(twoHosts(), [kept("staging"), kept("prod")]);
    expect(
      pins.r.phase("adopt", {
        DIGEST: pins.digest,
        APPROVED: "",
        HAS_CHANGES: "false",
        ...PASSPHRASE,
      }),
    ).toEqual({
      code: 0,
      out: [
        ...masks.map((m) => `::add-mask::${m}`),
        "The saved plan is the one shown before the approval; it has no changes to apply.",
        "",
      ].join("\n"),
      err: "",
    });
    expect(pins.r.file("temp/tofu/changes.txt")).toBe("");
    // An empty list is never taken as "no changes" beside has_changes=true.
    expect(
      pins.r.phase("adopt", {
        DIGEST: pins.digest,
        APPROVED: "",
        HAS_CHANGES: "true",
        ...PASSPHRASE,
      }).code,
    ).toBe(1);
  });

  test("apply applies only an adopted plan with changes, printing counts and built hosts only", () => {
    const { r, digest } = fetched(twoHosts(), BUILD);
    const shown = { DIGEST: digest, APPROVED: BUILD_LIST, HAS_CHANGES: "true", ...PASSPHRASE };
    // Not adopted yet: nothing runs.
    expect(r.phase("apply", TOKENS)).toEqual({
      code: 1,
      out: "::error::The saved plan hasn't been adopted (run the adopt phase first); nothing was applied.\n",
      err: "",
    });
    expect(r.phase("adopt", shown).code).toBe(0);
    r.write(
      "stub/apply.jsonl",
      `${JSON.stringify({ type: "change_summary", changes: { add: 4, change: 1, import: 0, remove: 0 } })}\n`,
    );
    const applied = r.phase("apply", TOKENS);
    expect(applied).toEqual({
      code: 0,
      out: [
        "applied: 4 added, 1 changed, 0 imported, 0 destroyed",
        "built prod (prod): this job pins its host key next",
        "",
      ].join("\n"),
      err: "",
    });
    expect(r.file("summary")).toBe("- built prod (prod): this job pins its host key next\n");
    // The apply named the fetched file and nothing that could make it a new plan.
    expect(r.calls().at(-1)).toEqual([
      `-chdir=${root("ops/tofu")}`,
      "apply",
      "-input=false",
      "-json",
      join(r.dir, "temp", "tofu", "plan.bin"),
      "",
    ]);
    // A stale plan: OpenTofu refuses it, and only the filtered diagnostic prints.
    r.write("stub/exit.apply", "1");
    r.write(
      "stub/apply.jsonl",
      `${JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary: "Saved plan is stale", detail: "secret" } })}\n`,
    );
    expect(r.phase("apply", TOKENS)).toEqual({
      code: 1,
      out: "::error::apply failed (exit 1); a stale plan fails here too, so dispatch a new run. Its diagnostics, with names, numbers and addresses left out:\nerror - Saved plan is stale\n",
      err: "",
    });
    // A file swapped after adopt isn't the adopted one.
    r.write("temp/tofu/plan.bin", "another saved plan");
    expect(r.phase("apply", TOKENS).out).toBe(
      "::error::The saved plan hasn't been adopted (run the adopt phase first); nothing was applied.\n",
    );
    // A rebuild names the rebuilt host the same way.
    const rebuilt = fetched(twoHosts(), rebuildPlan("staging").resource_changes);
    expect(
      rebuilt.r.phase("adopt", {
        DIGEST: rebuilt.digest,
        APPROVED: rebuildList("staging"),
        HAS_CHANGES: "true",
        ...PASSPHRASE,
      }).code,
    ).toBe(0);
    expect(rebuilt.r.phase("apply", TOKENS).out).toBe(
      "built staging (staging): this job pins its host key next\n",
    );
    // A pins-only plan has nothing to apply.
    const pins = fetched(twoHosts(), [kept("staging")]);
    pins.r.phase("adopt", {
      DIGEST: pins.digest,
      APPROVED: "",
      HAS_CHANGES: "false",
      ...PASSPHRASE,
    });
    expect(pins.r.phase("apply", TOKENS)).toEqual({
      code: 1,
      out: "::error::The adopted plan has no changes, so there is nothing to apply.\n",
      err: "",
    });
    expect(pins.r.calls().map((args) => args[1])).toEqual(["show"]);
    // Without the tokens, nothing runs; the message names prod's own secrets.
    expect(r.phase("apply", STATE).out).toBe(
      "::error::LINODE_WRITE_TOKEN and CLOUDFLARE_WRITE_TOKEN must be set in the prod environment.\n",
    );
  });

  test("output keeps the state's outputs private and masks every address and instance ID first", () => {
    const r = runner();
    const connection = {
      staging: { instance_id: "12345678", ipv6: "2001:db8:1::10", ipv4: "192.0.2.10" },
      prod: { instance_id: "87654321", ipv6: "2001:db8:2::20", ipv4: "192.0.2.20" },
    };
    const outputs = {
      hosts: {
        sensitive: false,
        type: ["object", {}],
        value: { staging: "staging", prod: "prod" },
      },
      host_connection: { sensitive: true, type: ["object", {}], value: connection },
    };
    r.write("stub/outputs.json", JSON.stringify(outputs));
    const done = r.phase("output", STATE);
    // Host by host: the instance ID, then IPv4, then IPv6, each before the one line that prints.
    const secrets = Object.values(connection).flatMap((c) => [c.instance_id, c.ipv4, c.ipv6]);
    expect(done).toEqual({
      code: 0,
      out: [
        ...secrets.map((m) => `::add-mask::${m}`),
        "Read the connections of 2 host(s).",
        "",
      ].join("\n"),
      err: "",
    });
    expect(JSON.parse(r.file("temp/tofu/outputs.json"))).toEqual(outputs);
    expect(statSync(join(r.dir, "temp", "tofu", "outputs.json")).mode & 0o077).toBe(0);
    expect(existsSync(join(r.dir, "temp", "tofu", "outputs.raw.json"))).toBe(false);
    expect(r.calls()).toEqual([[`-chdir=${root("ops/tofu")}`, "output", "-json", ""]]);
    // A state with no outputs yet reads as no hosts.
    const bare = runner();
    expect(bare.phase("output", STATE)).toEqual({
      code: 0,
      out: "Read the connections of 0 host(s).\n",
      err: "",
    });
    expect(JSON.parse(bare.file("temp/tofu/outputs.json"))).toEqual({
      host_connection: { sensitive: true, value: {} },
    });
    // A host_connection that isn't an object is refused, and nothing of it prints.
    const odd = runner();
    odd.write(
      "stub/outputs.json",
      JSON.stringify({ host_connection: { sensitive: true, value: "192.0.2.10" } }),
    );
    expect(odd.phase("output", STATE)).toEqual({
      code: 1,
      out: "::error::The state's host_connection output couldn't be read; no host was pinned.\n",
      err: "",
    });
    // OpenTofu's own errors stay in a private file.
    const failed = runner();
    failed.write("stub/exit.output", "1");
    failed.write("stub/output.stderr", "state at state-bucket-example for 192.0.2.10\n");
    expect(failed.phase("output", STATE)).toEqual({
      code: 1,
      out: "::error::output failed (exit 1): check the environment's TOFU_STATE_* secrets.\n",
      err: "",
    });
    expect(failed.file("temp/tofu/output.stderr")).toContain("192.0.2.10");
    // It needs the state's key and passphrase, and nothing else.
    expect(runner().phase("output", PASSPHRASE).code).toBe(1);
  });

  test("each phase names its environment's secrets, and init, plan, apply and output need a 32-character passphrase", () => {
    const r = runner();
    r.phase("backend", BACKEND);
    r.phase("values", { TOFU_VARS: EXAMPLE });
    expect(r.phase("plan", STATE).out).toBe(
      "::error::LINODE_READ_TOKEN and CLOUDFLARE_READ_TOKEN must be set in the infra-plan environment.\n",
    );
    expect(r.phase("init", PASSPHRASE).out).toBe(
      "::error::The state key must be set: TOFU_STATE_READ_ACCESS_KEY and TOFU_STATE_READ_SECRET_KEY in infra-plan, TOFU_STATE_WRITE_ACCESS_KEY and TOFU_STATE_WRITE_SECRET_KEY in prod.\n",
    );
    // The passphrase is the only key to the saved plan, which anyone signed in to GitHub can
    // download for a day, so every phase that opens state or a plan refuses one shorter than 32.
    const TOO_SHORT = "::error::TOFU_STATE_PASSPHRASE must be at least 32 characters.\n";
    const passphrase = (length: number) => ({
      ...TOKENS,
      TF_VAR_state_passphrase: "p".repeat(length),
    });
    for (const name of ["init", "plan", "apply", "output"])
      expect({ name, ...r.phase(name, passphrase(31)) }).toEqual({
        name,
        code: 1,
        out: TOO_SHORT,
        err: "",
      });
    expect(r.phase("init", passphrase(32))).toEqual({ code: 0, out: "init ok\n", err: "" });
    // The retired phases and anything else: the usage line.
    for (const name of ["nothing", "prepare", "compare"])
      expect({ name, ...r.phase(name) }).toEqual({
        name,
        code: 1,
        out: "::error::usage: tofu-ci.sh install|backend|values|init|plan|summarize|adopt|apply|output\n",
        err: "",
      });
  });
});
