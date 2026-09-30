/**
 * The "Deploy" workflow (.github/workflows/deploy.yml: production since 2.30.0, issue #41; the
 * provenance check since 2.33.0, issue #50; staging through the reusable host.yml since 2.36.0,
 * issue #62) and what the other workflows must not do around it.
 *
 * - Shape: the triggers and the `target` and `action` inputs, the first-attempt rule on every job,
 *   least permissions (no packages, no registry login), no action and no checkout in this file,
 *   every ${{ }} through env:, no concurrency group, and which job may see which environment,
 *   secret and variable. The jobs' `if` expressions and the run's title are evaluated here with a
 *   small reader of GitHub's expression syntax, so each target's jobs run exactly when they should.
 * - Production's live path is byte-identical to 2.35.0's until 2.37.0: the Deploy and Notify jobs'
 *   text, ops/deploy.sh, ops/backup.sh, the Compose file, its settings template and the .env
 *   backup tool are pinned by SHA-256. The command contract and the result line are the same
 *   patterns as ops/deploy.sh's.
 * - The staging job calls host.yml with the plan's outputs, and host.yml hands bot.yml exactly
 *   the inputs and secret names the release's vars/bot.yml declares, each from the environment
 *   secret its tb_secret_source names. No workflow reads a secret or variable GitHub would refuse
 *   to create (a GITHUB_ name other than the built-in GITHUB_TOKEN).
 * - The repository names no host: the workflows and ops/deploy.sh carry no host name beyond
 *   GitHub's, the registry's and Pushover's.
 * - Behavior: the plan, SSH and notify scripts run here with simulated gh, docker, ssh, curl and
 *   date (tests/fixtures/deploy-workflow) to check the targets, production's switch, the gates,
 *   the dispatch's action, staging's floor, the image's provenance, the runtime-change rule, the
 *   compare API's 300-file cap, dispatches and rollbacks, the host-side summary, the clock
 *   warnings, the SSH retry rules and the messages.
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
const STUBS = root("tests/fixtures/deploy-workflow");
const hasJq = Bun.which("jq") !== null;
const hasGit = Bun.which("git") !== null;

// The linux/arm64 image build runs the unit suite under QEMU, many times slower at starting
// processes: "the SSH step > tells a refused format, a lost host and a host never reached apart"
// took 5.3 s there and "the notify step > reports each outcome with its priority" 5.0 s, past
// Bun's 5 s default (PR #44's "Container build (tarubot)"). Natively each takes well under a
// second. The scripts' clocks are simulated (the SSH tests' `clock` prelude and the `sleep` and
// `date` stubs), so no assertion depends on real time; this limit only stops a hung script.
setDefaultTimeout(120_000);

const step = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const job = z
  .object({
    name: z.string(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string(),
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    environment: z.string().optional(),
    permissions: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(step),
  })
  .strict();
/** A job that calls a reusable workflow: it has no runner, environment or steps of its own. */
const call = z
  .object({
    name: z.string(),
    needs: z.string(),
    if: z.string(),
    permissions: z.record(z.string(), z.string()),
    uses: z.string(),
    with: z.record(z.string(), z.string()),
    secrets: z.literal("inherit"),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Deploy"),
    "run-name": z.string(),
    on: z.object({
      workflow_run: z.object({
        workflows: z.array(z.string()),
        types: z.array(z.string()),
        branches: z.array(z.string()),
      }),
      workflow_dispatch: z.object({
        inputs: z.record(
          z.string(),
          z
            .object({
              description: z.string(),
              required: z.boolean().optional(),
              type: z.string(),
              options: z.array(z.string()).optional(),
              default: z.union([z.string(), z.boolean()]).optional(),
            })
            .strict(),
        ),
      }),
    }),
    permissions: z.record(z.string(), z.string()),
    defaults: z.object({ run: z.object({ shell: z.literal("bash") }) }),
    jobs: z.object({ plan: job, deploy: job, "deploy-staging": call, notify: job }).strict(),
  })
  .strict();

const text = read(".github/workflows/deploy.yml");
const deploy = workflow.parse(YAML.parse(text));
const script = read("ops/deploy.sh");
/** host.yml, which the staging job calls. */
const hostText = read(".github/workflows/host.yml");
type JobName = keyof typeof deploy.jobs;
/** The jobs with steps of their own. */
type StepJob = "plan" | "deploy" | "notify";
/** One step, by its id or name. */
const stepOf = (jobName: StepJob, key: string) => {
  const found = deploy.jobs[jobName].steps.find((s) => s.id === key || s.name === key);
  if (!found) throw new Error(`no step ${key} in ${jobName}`);
  return found;
};
/** One step's script, by its id or name. */
const runOf = (jobName: StepJob, key: string) => {
  const found = stepOf(jobName, key).run;
  if (!found) throw new Error(`no script in ${jobName}'s ${key}`);
  return found;
};
/** A single-quoted pattern assignment, NAME='…', from a script. */
const pattern = (source: string, name: string) => {
  const found = new RegExp(`${name}='([^']+)'`, "u").exec(source)?.[1];
  if (!found) throw new Error(`no ${name}`);
  return found;
};
/** SHA-256 of a text, in hex. */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** The Deploy job's text: from its `  deploy:` line through its key removal's run line. */
const productionJobText = (source: string) => {
  const start = source.indexOf("\n  deploy:\n") + 1;
  const last = '        run: rm -rf "$RUNNER_TEMP/ssh"\n';
  const end = source.indexOf(last, start);
  if (start === 0 || end < 0) throw new Error("no Deploy job");
  return source.slice(start, end + last.length);
};
/** The Notify job's text: from its `  notify:` line to the end of the file. */
const notifyJobText = (source: string) => {
  const start = source.indexOf("\n  notify:\n") + 1;
  if (start === 0) throw new Error("no Notify job");
  return source.slice(start);
};

// ---------------------------------------------------------------------------------------------
// GitHub's expression syntax, as far as deploy.yml uses it
// ---------------------------------------------------------------------------------------------

/**
 * Evaluate one GitHub Actions expression against a context. It covers what deploy.yml uses:
 * dotted context paths (missing ones are null), string and number literals, true, false, null,
 * `!`, `==`, `!=`, `&&`, `||`, parentheses, format() and always(). As in GitHub, `&&` and `||`
 * return an operand rather than a boolean, strings compare without regard to case, and null,
 * false, 0, NaN and '' are falsy. Anything else throws, so an expression this reader doesn't
 * understand fails the test rather than passing it.
 */
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1");
  const tokens: string[] = [];
  const lexer =
    /\s*('(?:[^']|'')*'|\d+|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*|&&|\|\||==|!=|[!(),])/uy;
  while (lexer.lastIndex < source.length) {
    const start = lexer.lastIndex;
    const match = lexer.exec(source);
    if (!match?.[1]) {
      if (source.slice(start).trim() === "") break;
      throw new Error(`can't read ${source.slice(start)}`);
    }
    tokens.push(match[1]);
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new Error(`expected ${expected ?? "a token"} at ${at} in ${source}`);
    return token;
  };
  const truthy = (v: unknown) =>
    !(v === null || v === false || v === 0 || v === "" || Number.isNaN(v));
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const number = (v: unknown) => (v === null ? 0 : typeof v === "boolean" ? Number(v) : Number(v));
  const equal = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase()
      : typeof a === typeof b
        ? a === b
        : number(a) === number(b);
  const lookup = (path: string) => {
    let value: unknown = context;
    for (const part of path.split(".")) {
      if (value === null || typeof value !== "object" || !(part in value)) return null;
      value = (value as Record<string, unknown>)[part];
    }
    return value ?? null;
  };
  const call = (name: string, args: unknown[]) => {
    if (name === "always" && args.length === 0) return true;
    if (name === "format")
      return str(args[0]).replace(/\{(\d+)\}/gu, (_, i: string) => str(args[Number(i) + 1]));
    throw new Error(`no function ${name}`);
  };
  const primary = (): unknown => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^\d+$/u.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (/^[A-Za-z_]/u.test(token)) {
      if (peek() !== "(") return lookup(token);
      take("(");
      const args: unknown[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      return call(token, args);
    }
    throw new Error(`unexpected ${token} in ${source}`);
  };
  const unary = (): unknown => {
    if (peek() !== "!") return primary();
    take("!");
    return !truthy(unary());
  };
  const comparison = (): unknown => {
    let left = unary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const right = unary();
      left = op === "==" ? equal(left, right) : !equal(left, right);
    }
    return left;
  };
  const and = (): unknown => {
    let left = comparison();
    while (peek() === "&&") {
      take("&&");
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): unknown => {
    let left = and();
    while (peek() === "||") {
      take("||");
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unread tokens in ${source}`);
  return value;
}

/** What a scenario sets: the event, a dispatch's inputs, the switch and the plan's result. */
interface Scenario {
  readonly event?: "workflow_run" | "workflow_dispatch";
  readonly target?: string;
  readonly action?: string;
  readonly rollback?: boolean;
  readonly version?: string;
  readonly from?: string;
  readonly attempt?: string;
  /** Production's switch, DEPLOY_ENABLED ("true" by default). */
  readonly switches?: { readonly production?: string };
  readonly plan?: {
    readonly result?: string;
    readonly production?: string;
    readonly staging?: string;
    /** The plan's notify output; null leaves it unset, as a plan that never ran its step. */
    readonly notify?: string | null;
  };
}

/**
 * The plan's notify output for `scenario`, as its first line decides it: true for a run that asks
 * for production while DEPLOY_ENABLED reads as true without regard to case.
 */
function notifyOf(scenario: Scenario): string {
  const production =
    (scenario.event ?? "workflow_run") === "workflow_run" ||
    (scenario.target ?? "production") === "production";
  const on = (scenario.switches?.production ?? "true").toLowerCase() === "true";
  return String(production && on);
}

/** The expression context GitHub gives a run of deploy.yml in `scenario`. */
function contextOf(scenario: Scenario): Record<string, unknown> {
  const event = scenario.event ?? "workflow_run";
  return {
    github: {
      run_attempt: scenario.attempt ?? "1",
      event_name: event,
      ref: "refs/heads/main",
      repository: "deconfined/tarubot",
      event: {
        workflow_run:
          event === "workflow_run"
            ? {
                conclusion: "success",
                event: "push",
                head_branch: "main",
                path: ".github/workflows/publish.yml",
                head_sha: "0123456789abcdef0123456789abcdef01234567",
                head_repository: { full_name: "deconfined/tarubot" },
              }
            : null,
      },
    },
    inputs:
      event === "workflow_dispatch"
        ? {
            version: scenario.version ?? "2.36.0",
            rollback: scenario.rollback ?? false,
            from: scenario.from ?? "",
            target: scenario.target ?? "production",
            action: scenario.action ?? "deploy",
          }
        : {},
    vars: { DEPLOY_ENABLED: scenario.switches?.production ?? "true" },
    needs: {
      plan: {
        result: scenario.plan?.result ?? "success",
        outputs: {
          production: scenario.plan?.production ?? "true",
          staging: scenario.plan?.staging ?? "true",
          // What the plan's first line writes: true when the run asks for production while its
          // switch reads as true (by default, as the plan left it for these scenarios).
          ...(scenario.plan?.notify === null
            ? {}
            : { notify: scenario.plan?.notify ?? notifyOf(scenario) }),
        },
      },
      deploy: { result: "success" },
    },
  };
}
/** Whether `jobName` runs in `scenario`. */
const runs = (jobName: JobName, scenario: Scenario) =>
  evaluate(deploy.jobs[jobName].if, contextOf(scenario)) === true;

describe("the expression reader", () => {
  test("follows GitHub's rules for the operators deploy.yml uses", () => {
    const context = { a: { b: "X" }, t: true, f: false, s: "", n: null };
    expect(evaluate("a.b == 'x'", context)).toBe(true);
    expect(evaluate("a.missing", context)).toBeNull();
    expect(evaluate("t && 'yes' || 'no'", context)).toBe("yes");
    expect(evaluate("f && 'yes' || 'no'", context)).toBe("no");
    expect(evaluate("s || n || 'last'", context)).toBe("last");
    expect(evaluate("!(t && f) && a.b != 'y'", context)).toBe(true);
    expect(evaluate("format('{0}-{1}{2}', 'a', n, 'c')", context)).toBe("a-c");
    expect(evaluate("'1' == 1 && always()", context)).toBe(true);
    expect(() => evaluate("contains(a.b, 'x')", context)).toThrow();
    expect(() => evaluate("a.b ==", context)).toThrow();
  });
});

describe("the workflow's shape", () => {
  test("runs after a successful publish of main, or by hand from main, for either target", () => {
    const publish = z
      .object({ name: z.string() })
      .passthrough()
      .parse(YAML.parse(read(".github/workflows/publish.yml")));
    expect(deploy.on.workflow_run).toEqual({
      workflows: [publish.name],
      types: ["completed"],
      branches: ["main"],
    });
    expect(deploy.on.workflow_dispatch.inputs).toEqual({
      version: expect.objectContaining({ required: true, type: "string" }),
      rollback: expect.objectContaining({ type: "boolean", default: false }),
      from: expect.objectContaining({ type: "string", default: "" }),
      target: expect.objectContaining({
        type: "choice",
        options: ["production", "staging"],
        default: "production",
      }),
      action: expect.objectContaining({
        type: "choice",
        options: ["deploy", "bot", "configure", "preflight"],
        default: "deploy",
      }),
    });
    const plan = deploy.jobs.plan.if;
    for (const term of [
      "github.run_attempt == '1' && (",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.path == '.github/workflows/publish.yml'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    ])
      expect({ term, present: plan.includes(term) }).toEqual({ term, present: true });
    // No switch holds the plan back: production's is read inside it, and staging has none.
    expect(plan).not.toContain("vars.");
    for (const production of ["true", "", "false"])
      for (const event of ["workflow_run", "workflow_dispatch"] as const)
        expect({
          production,
          event,
          runs: runs("plan", { event, switches: { production } }),
        }).toEqual({ production, event, runs: true });
  });

  test("refuses re-runs: every job requires the first attempt", () => {
    for (const [name, j] of Object.entries(deploy.jobs))
      expect({ name, first: j.if.trim().startsWith("github.run_attempt == '1' &&") }).toEqual({
        name,
        first: true,
      });
    for (const name of Object.keys(deploy.jobs) as JobName[])
      expect({ name, second: runs(name, { attempt: "2" }) }).toEqual({ name, second: false });
    // host.yml's job refuses them too.
    expect(hostText).toContain("\n    if: github.run_attempt == '1'\n");
  });

  test("each deploy job runs only for its own target, when the plan says so", () => {
    expect(deploy.jobs.deploy.if).toBe(
      "github.run_attempt == '1' && needs.plan.outputs.production == 'true' && (github.event_name == 'workflow_run' || inputs.target == 'production')",
    );
    expect(deploy.jobs["deploy-staging"].if).toBe(
      "github.run_attempt == '1' && needs.plan.outputs.staging == 'true' && (github.event_name == 'workflow_run' || inputs.target == 'staging')",
    );
    const table: [Scenario, boolean, boolean][] = [
      [{}, true, true],
      [{ plan: { staging: "false" } }, true, false],
      [{ plan: { production: "false" } }, false, true],
      [{ plan: { production: "", staging: "" } }, false, false],
      [{ event: "workflow_dispatch", plan: { staging: "false" } }, true, false],
      [
        { event: "workflow_dispatch", target: "staging", plan: { production: "false" } },
        false,
        true,
      ],
      // Even a plan that said yes to both deploys only the target a dispatch names.
      [{ event: "workflow_dispatch", target: "production" }, true, false],
      [{ event: "workflow_dispatch", target: "staging" }, false, true],
      [{ event: "workflow_dispatch", target: "staging", action: "configure" }, false, true],
    ];
    for (const [scenario, production, staging] of table)
      expect({
        scenario,
        production: runs("deploy", scenario),
        staging: runs("deploy-staging", scenario),
      }).toEqual({ scenario, production, staging });
    // Both need the plan alone: production never waits for staging, nor staging for approval.
    expect(deploy.jobs.deploy.needs).toBe("plan");
    expect(deploy.jobs["deploy-staging"].needs).toBe("plan");
  });

  test("notifies about production only, as the plan decided when the run planned", () => {
    expect(deploy.jobs.notify.if.replace(/\s+/gu, " ")).toBe(
      "github.run_attempt == '1' && always() && needs.plan.result != 'skipped' && ( needs.plan.outputs.notify == 'true' || (needs.plan.outputs.notify == '' && vars.DEPLOY_ENABLED == 'true' && (github.event_name == 'workflow_run' || inputs.target != 'staging')))",
    );
    expect(deploy.jobs.notify.needs).toEqual(["plan", "deploy"]);
    const table: [Scenario, boolean][] = [
      [{}, true],
      [{ plan: { result: "failure" } }, true],
      [{ plan: { result: "skipped" } }, false],
      [{ event: "workflow_dispatch" }, true],
      [{ event: "workflow_dispatch", target: "staging" }, false],
      [{ switches: { production: "" } }, false],
      [{ event: "workflow_dispatch", switches: { production: "false" } }, false],
      // GitHub's comparison ignores case, and so does the plan's decision: `True` is reported
      // (the plan itself leaves production paused, and the message says why).
      [{ switches: { production: "True" } }, true],
      // Production was on when the run planned and is off now (paused while a request waited, or
      // while the deploy ran): the outcome is still reported.
      [{ switches: { production: "" }, plan: { notify: "true" } }, true],
      [
        {
          event: "workflow_dispatch",
          switches: { production: "false" },
          plan: { notify: "true", result: "success" },
        },
        true,
      ],
      // Production off when the run planned and on now: nothing to report.
      [{ plan: { notify: "false" } }, false],
      // A plan whose step never ran wrote no output: the switch as it reads now decides.
      [{ plan: { result: "failure", notify: null } }, true],
      [{ switches: { production: "" }, plan: { result: "failure", notify: null } }, false],
      [
        {
          event: "workflow_dispatch",
          target: "staging",
          plan: { result: "failure", notify: null },
        },
        false,
      ],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, notify: runs("notify", scenario) }).toEqual({
        scenario,
        notify: expected,
      });
  });

  test("titles each run with its target, and a staging dispatch with its action", () => {
    const title = deploy["run-name"];
    expect(title).toContain("format('Deploy {0}{1}{2}{3}', inputs.version,");
    expect(title).toContain("inputs.rollback && format(' rollback from {0}', inputs.from) || ''");
    expect(title).toContain(
      "inputs.target == 'staging' && inputs.action != 'deploy' && format(' {0}', inputs.action) || ''",
    );
    expect(title).toContain("inputs.target == 'staging' && ' to staging' || ''");
    expect(title).toContain("format('Deploy {0}', github.event.workflow_run.head_sha)");
    const titleOf = (scenario: Scenario) => evaluate(title, contextOf(scenario));
    expect(titleOf({})).toBe("Deploy 0123456789abcdef0123456789abcdef01234567");
    const dispatch = { event: "workflow_dispatch", version: "2.36.0" } as const;
    // Production's titles are 2.35.0's, whatever the action says (the plan refuses any but deploy).
    expect(titleOf(dispatch)).toBe("Deploy 2.36.0");
    expect(titleOf({ ...dispatch, rollback: true, from: "2.36.1" })).toBe(
      "Deploy 2.36.0 rollback from 2.36.1",
    );
    expect(titleOf({ ...dispatch, action: "bot" })).toBe("Deploy 2.36.0");
    // Staging's end in " to staging", which the production host refuses; any action but deploy
    // is named.
    const staging = { ...dispatch, target: "staging" } as const;
    expect(titleOf(staging)).toBe("Deploy 2.36.0 to staging");
    for (const action of ["bot", "configure", "preflight"])
      expect({ action, title: titleOf({ ...staging, action }) }).toEqual({
        action,
        title: `Deploy 2.36.0 ${action} to staging`,
      });
    // The production host builds the same titles and checks them.
    expect(script).toContain('title="Deploy $V rollback from $F"');
    expect(script).toContain('title="Deploy $V"');
    expect(script).toContain('.display_title == ("Deploy " + $commit)');
  });

  test("the plan and every documented check name the signer by its exact identity", () => {
    // gh turns --signer-workflow into a pattern anchored only at its start, so a workflow named
    // publish.yml-canary.yml would pass it; the certificate's full identity can't be matched so.
    const identity =
      "--cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main";
    const flat = (source: string) => source.replace(/\\\n[\s#]*/gu, " ");
    expect(flat(runOf("plan", "plan"))).toContain(identity);
    // Every workflow, operating guide and script that runs `gh attestation verify`, or shows it
    // with its flags, names the exact identity, and none uses the prefix form. The maintainer
    // records (VERIFICATION.md and the like) keep their history as it happened.
    const files = [
      "docs/HOSTING.md",
      "docs/CI_CD.md",
      ...["site/src/content/docs", ".github/workflows", "ops"].flatMap((dir) =>
        [...new Bun.Glob("**/*.{md,mdx,yml,sh}").scanSync({ cwd: root(dir), dot: true })]
          .filter((path) => !path.split("/").includes(".terraform"))
          .map((path) => `${dir}/${path}`),
      ),
    ];
    let verifying = 0;
    for (const path of files) {
      const source = flat(read(path));
      if (/attestation verify [^\n`]*--[a-z]/u.test(source)) {
        verifying++;
        expect({ path, exact: source.includes(identity) }).toEqual({ path, exact: true });
      }
      expect({ path, prefix: /--signer-workflow [^\s/]+\//u.test(source) }).toEqual({
        path,
        prefix: false,
      });
    }
    // deploy.yml's plan at least; today also the hosting and CI records and the install page.
    expect(verifying).toBeGreaterThan(0);
  });

  test("holds least permissions: nothing at the top, read-only for the plan and staging, no packages", () => {
    expect(deploy.permissions).toEqual({});
    expect(deploy.jobs.plan.permissions).toEqual({
      contents: "read",
      actions: "read",
      attestations: "read",
    });
    // Each grant says what it is for.
    for (const grant of ["contents", "actions", "attestations"])
      expect({
        grant,
        commented: new RegExp(`^ {6}${grant}: read # \\S`, "mu").test(text),
      }).toEqual({ grant, commented: true });
    for (const name of ["deploy", "notify"] as const)
      expect({ name, permissions: deploy.jobs[name].permissions }).toEqual({
        name,
        permissions: {},
      });
    // host.yml's two checkouts read this public repository; its job can hold no more than this.
    expect(deploy.jobs["deploy-staging"].permissions).toEqual({ contents: "read" });
    // The package is public: the provenance check logs in nowhere and reads no package.
    expect(text).not.toMatch(/^\s*packages:/mu);
    expect(text).not.toMatch(/docker\s+login|--password-stdin|ghcr\.io\/token/u);
  });

  test("uses no action, no checkout, no expression inside a script, no tracing, no concurrency", () => {
    for (const name of ["plan", "deploy", "notify"] as const)
      for (const s of deploy.jobs[name].steps) {
        expect(s.uses).toBeUndefined();
        expect(s.run ?? "").not.toContain("${{");
        expect(s.run ?? "").not.toMatch(/set -[a-zA-Z]*x/u);
      }
    // The staging job's one `uses` is the reusable workflow in this repository, which holds the
    // checkouts and the concurrency group.
    expect(deploy.jobs["deploy-staging"].uses).toBe("./.github/workflows/host.yml");
    expect(text).not.toMatch(/^\s*concurrency:/mu);
    expect(text).not.toContain("actions/checkout");
    // Each script is written out, not shared through a YAML anchor.
    expect(text).not.toMatch(/:\s+[&*][A-Za-z]|<<:/u);
  });

  test("keeps secrets and variables in the jobs and environments that need them", () => {
    const refs = (value: unknown, kind: "secrets" | "vars") =>
      [
        ...new Set(
          [...JSON.stringify(value).matchAll(new RegExp(`${kind}\\.([A-Z_]+)`, "gu"))].map(
            (m) => m[1],
          ),
        ),
      ].sort();
    const { plan, notify } = deploy.jobs;
    expect(plan.environment).toBeUndefined();
    expect(refs(plan, "secrets")).toEqual([]);
    expect(refs(plan, "vars")).toEqual(["DEPLOY_ENABLED", "RELEASE_PIPELINE_ENABLED"]);
    const production = deploy.jobs.deploy;
    expect(production.environment).toBe("production");
    expect(refs(production, "secrets")).toEqual(["DEPLOY_SSH_KEY"]);
    expect(refs(production, "vars")).toEqual([
      "DEPLOY_ENABLED",
      "DEPLOY_HOST",
      "DEPLOY_KNOWN_HOSTS",
    ]);
    // Staging's secrets load in host.yml's job, which names the `staging` environment; this job
    // names none of them, and no variable.
    const staging = deploy.jobs["deploy-staging"];
    expect(staging.secrets).toBe("inherit");
    expect(refs(staging, "secrets")).toEqual([]);
    expect(refs(staging, "vars")).toEqual([]);
    expect(notify.environment).toBe("notify");
    expect(refs(notify, "secrets")).toEqual(["PUSHOVER_TOKEN", "PUSHOVER_USER"]);
    expect(refs(notify, "vars")).toEqual(["DEPLOY_ENABLED"]);
    // Production's key file is removed even when the deploy fails or is cancelled.
    expect(production.steps.at(-1)).toEqual({
      name: "Remove the key",
      if: "always()",
      run: 'rm -rf "$RUNNER_TEMP/ssh"',
    });
  });

  test("production's deploy job checks its switch again before its key loads", () => {
    const first = deploy.jobs.deploy.steps[0];
    expect({ id: first?.id, env: first?.env }).toEqual({
      id: "start",
      env: { DEPLOY_ENABLED: `\${{ vars.DEPLOY_ENABLED }}` },
    });
    expect(first?.run).toContain('if [ "$DEPLOY_ENABLED" != true ]; then');
    expect(first?.run).toContain("reason=paused");
  });

  test("pins production's host key and uses only the deploy key", () => {
    const ssh = runOf("deploy", "ssh");
    for (const option of [
      "-F /dev/null",
      "-o IdentitiesOnly=yes",
      "-o IdentityAgent=none",
      "-o BatchMode=yes",
      "-o StrictHostKeyChecking=yes",
      '-o UserKnownHostsFile="$dir/kh"',
      "-o GlobalKnownHostsFile=/dev/null",
      "-o UpdateHostKeys=no",
      "-o HostKeyAlgorithms=ssh-ed25519",
    ])
      expect({ option, present: ssh.includes(option) }).toEqual({ option, present: true });
    expect(ssh).not.toMatch(/accept-new|StrictHostKeyChecking=no|VerifyHostKeyDNS/u);
    expect(ssh).toContain("unset DEPLOY_SSH_KEY");
    expect(ssh).toContain("KNOWN_HOST='^([^ ]+) ssh-ed25519 [A-Za-z0-9+/]+={0,2}$'");
    expect(ssh).toContain('"tarubot@$DEPLOY_HOST" "$CMD"');
  });

  test("gives production's host run time to report before its job times out", () => {
    const j = deploy.jobs.deploy;
    const seconds = Number(stepOf("deploy", "ssh").env?.RECONNECT_SECONDS);
    // ops/deploy.sh's waits and timeouts add up to about 68 minutes in the worst case.
    expect({
      name: j.name,
      environment: j.environment,
      minutes: j["timeout-minutes"],
      seconds,
      target: stepOf("deploy", "ssh").env?.DEPLOY_ENVIRONMENT,
    }).toEqual({
      name: "Deploy",
      environment: "production",
      minutes: 90,
      seconds: 4800,
      target: "production",
    });
    expect(j["timeout-minutes"] * 60).toBeGreaterThan(seconds + 300);
  });

  test("says that production's result is its own job and approval, never the run's conclusion", () => {
    // The workflow's comments, as one line of prose.
    const comments = text
      .split("\n")
      .filter((line) => line.trim().startsWith("#"))
      .map((line) => line.trim().replace(/^#\s?/u, ""))
      .join(" ");
    expect(comments).toContain(
      "whether production deployed a run is the Deploy job's conclusion together with the production approval, never the run's conclusion",
    );
    expect(comments).toContain("Notify reads it that way.");
    // Nothing still points at the pull unit or the old staging SSH step.
    expect(comments).not.toMatch(/pull unit|host lock|STAGING_DEPLOY_ENABLED/u);
  });
});

describe("production's live path until 2.37.0", () => {
  test("is byte-identical to 2.35.0's: the Deploy and Notify jobs and the files they use", () => {
    // SHA-256 at 92339f5 (2.35.0, live in production). The Deploy job runs from its `  deploy:`
    // line through its key removal's run line, and Notify from `  notify:` to the end of the file;
    // the comment blocks above them may change. Production moves to host.yml in 2.37.0, and the
    // files go in 2.38.0.
    expect({
      deploy: sha256(productionJobText(text)),
      notify: sha256(notifyJobText(text)),
      "ops/deploy.sh": sha256(script),
      "ops/backup.sh": sha256(read("ops/backup.sh")),
      "docker-compose.production.yml": sha256(read("docker-compose.production.yml")),
      "production.env.example": sha256(read("production.env.example")),
      "scripts/host-env-backup.ts": sha256(read("scripts/host-env-backup.ts")),
    }).toEqual({
      deploy: "8b0b19f663223444d788ac552c8980daacab61b368d39fc73ddb466ba529a21d",
      notify: "13de52a260d4c593a1259c9048e1641b35bdc5c79eb5d4b23fd0827909e4e70a",
      "ops/deploy.sh": "5b71d171d98d0f881956a6aead5603ca049af86ba919f1bd1881d54ad9e539e4",
      "ops/backup.sh": "d70378ec85edd42e493e2b870e5ea81ff501799040ed8c795e48fed15256cab8",
      "docker-compose.production.yml":
        "77370642a46a789bd9485b18e6847b87c8517a7642641df141d3e90c68204e07",
      "production.env.example": "f8edc1831b513a25210f5e0fdf615f1716405d2ea1e55c98fa453a1a95ce9d37",
      "scripts/host-env-backup.ts":
        "46f6106ac6637236b1b522d50ce90c308dd65177cb52585b4f8cd25cba573ea4",
    });
  });

  test("the job texts the pins cover are whole jobs, with nothing of another job inside", () => {
    const production = productionJobText(text);
    expect(production.split("\n")[0]).toBe("  deploy:");
    // No other job header (two-space indent) falls inside either text.
    const headers = (job: string) =>
      job
        .split("\n")
        .slice(1)
        .filter((line) => /^ {2}[a-z]/u.test(line));
    expect(headers(production)).toEqual([]);
    const notify = notifyJobText(text);
    expect(notify.split("\n")[0]).toBe("  notify:");
    expect(headers(notify)).toEqual([]);
    expect(notify.trimEnd().split("\n").at(-1)).toContain('echo "::warning::The Pushover message');
  });
});

describe("the staging job and host.yml", () => {
  const host = YAML.parse(hostText) as {
    on: { workflow_call: { inputs: Record<string, unknown> } };
    jobs: {
      host: { steps: { name: string; run?: string; env?: Record<string, string> }[] };
    };
  };
  const botStep = host.jobs.host.steps.find((s) => s.name === "Deploy the bot");

  test("calls host.yml for staging with the plan's outputs, and inherits the secrets it may read", () => {
    const staging = deploy.jobs["deploy-staging"];
    expect(staging.name).toBe("Deploy staging");
    expect(staging.with).toEqual({
      target: "staging",
      action: `\${{ needs.plan.outputs.staging_action }}`,
      version: `\${{ needs.plan.outputs.version }}`,
      commit: `\${{ needs.plan.outputs.commit }}`,
      digest: `\${{ needs.plan.outputs.digest }}`,
      config_commit: `\${{ needs.plan.outputs.config_commit }}`,
    });
    // Every output it reads is the plan step's own.
    for (const value of Object.values(staging.with)) {
      const output = /^\$\{\{ needs\.plan\.outputs\.([a-z_]+) \}\}$/u.exec(value)?.[1];
      if (output)
        expect({ output, from: deploy.jobs.plan.outputs?.[output] }).toEqual({
          output,
          from: `\${{ steps.plan.outputs.${output} }}`,
        });
    }
    // Legacy staging omits the replacement's optional acceptance inputs.
    expect(Object.keys(staging.with).sort()).toEqual(
      Object.keys(host.on.workflow_call.inputs)
        .filter((key) => !["accept_release", "schema_head", "publication_run"].includes(key))
        .sort(),
    );
    // The plan writes the three new outputs.
    const plan = runOf("plan", "plan");
    for (const name of ["staging_action", "config_commit", "schema_head"])
      expect({ name, written: plan.includes(`out ${name} `) }).toEqual({ name, written: true });
  });

  test("hands bot.yml exactly the inputs and secret names the release's vars/bot.yml declares", () => {
    const vars = YAML.parse(read("ops/ansible/vars/bot.yml")) as {
      tb_inputs: string[];
      tb_secret_env: string[];
      tb_secret_source: Record<string, string>;
    };
    expect(botStep).toBeDefined();
    const run = (botStep?.run ?? "").replace(/\\\n\s*/gu, " ");
    const names = [...run.matchAll(/-e "(tarubot_[a-z_]+)=/gu)].map((m) => m[1]);
    expect(names.sort()).toEqual([...vars.tb_inputs].sort());
    // Each variable from the environment secret tb_secret_source names for it, else from the
    // secret of its own name. GitHub refuses a secret name that starts with GITHUB_, so the
    // GITHUB_ variables need an entry, and exactly they have one.
    const source = (name: string) => vars.tb_secret_source[name] ?? name;
    expect(Object.keys(vars.tb_secret_source).sort()).toEqual(
      vars.tb_secret_env.filter((name) => name.startsWith("GITHUB_")).sort(),
    );
    const env = botStep?.env ?? {};
    const secrets = Object.entries(env)
      .filter(([, value]) => value.startsWith("${{ secrets."))
      .map(([name, value]) => {
        expect({ name, value }).toEqual({ name, value: `\${{ secrets.${source(name)} }}` });
        return name;
      });
    expect(secrets.sort()).toEqual([...vars.tb_secret_env].sort());
  });
});

describe("the contract with ops/deploy.sh", () => {
  test("the command forms and the result line are the same patterns on both sides", () => {
    const ssh = runOf("deploy", "ssh");
    for (const form of ["DEPLOY_FORM", "ROLLBACK_FORM", "RESULT_FORM", "STEP_LINE", "WARNING_LINE"])
      expect({ form, same: pattern(ssh, form) }).toEqual({ form, same: pattern(script, form) });
  });

  test("the forms accept what the workflow builds and nothing looser", () => {
    const deployForm = new RegExp(pattern(script, "DEPLOY_FORM"), "u");
    const rollbackForm = new RegExp(pattern(script, "ROLLBACK_FORM"), "u");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const digest = `sha256:${"ab".repeat(32)}`;
    expect(deployForm.exec(`deploy 2.30.1 ${commit} ${digest} 36300000042`)?.slice(1)).toEqual([
      "2.30.1",
      "2",
      "30",
      "1",
      commit,
      digest,
      "36300000042",
    ]);
    expect(rollbackForm.exec(`rollback 2.30.0 ${commit} ${digest} 1 2.30.1`)?.[8]).toBe("2.30.1");
    for (const bad of [
      `deploy 2.30.1 ${commit} ${digest} 36300000042 2.30.0`,
      `deploy 2.30.01 ${commit} ${digest} 1`,
      `deploy 2.30.1 ${commit.toUpperCase()} ${digest} 1`,
      `rollback 2.30.0 ${commit} ${digest} 1`,
    ])
      expect({ bad, ok: deployForm.test(bad) || rollbackForm.test(bad) }).toEqual({
        bad,
        ok: false,
      });
  });

  test("the host looks for the Deploy job by the name the workflow gives it", () => {
    // ops/deploy.sh requires a job with this name to be in progress; a rename would refuse every run.
    expect(deploy.jobs.deploy.name).toBe("Deploy");
    expect(script).toContain('.name == "Deploy" and .status == "in_progress"');
  });

  test("the plan and the host agree on the version pattern and the reviewer", () => {
    const plan = runOf("plan", "plan");
    expect(pattern(plan, "VER")).toBe(pattern(script, "readonly VERSION"));
    // The one account that approves production, by login; the plan no longer needs its id, which
    // only the staging dispatcher check read.
    const login = /^readonly REVIEWER=([a-z0-9-]+)$/mu.exec(script)?.[1];
    expect(plan).toContain(`\nREVIEWER=${login}\n`);
    expect(plan).toContain(`[{type: "User", login: "${login}"}]`);
    expect(plan).not.toContain("REVIEWER_ID");
    // Nor any trace of the capability words or the staging switch.
    expect(text).not.toMatch(/CAPABILIT|STAGING_DEPLOY_ENABLED|TRIGGERING_ACTOR/u);
  });
});

describe("no host in the repository", () => {
  /**
   * Every host name ending in a common top-level domain, whatever surrounds it (not .sh, which
   * would take the scripts' own file names). As in docs-site.test.ts, the pattern ends in an
   * alternative with `$`, which keeps CodeQL's missing-anchor query from reading it as a URL
   * check; the lookahead lets a period or hyphen follow the name.
   */
  const hostNames = (source: string) =>
    [
      ...source.matchAll(
        /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9]))/gimu,
      ),
    ].map((m) => (m[1] ?? "").toLowerCase());
  // slsa.dev only names the provenance predicate type the plan requires; nothing connects to it.
  // steps.host is host.yml's settings step, as its conditions name it.
  const allowed = new Set([
    "github.com",
    "api.github.com",
    "ghcr.io",
    "api.pushover.net",
    "slsa.dev",
    "steps.host",
    "jobs.host",
  ]);

  test("the workflows and ops/deploy.sh name no host beyond GitHub, GHCR and Pushover", () => {
    for (const [file, source] of [
      [".github/workflows/deploy.yml", text],
      [".github/workflows/host.yml", hostText],
      ["ops/deploy.sh", script],
    ] as const) {
      const hosts = [...new Set(hostNames(source))].filter((host) => !allowed.has(host));
      expect({ file, hosts }).toEqual({ file, hosts: [] });
      // No address literal either.
      expect({ file, ip: /\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(source) }).toEqual({
        file,
        ip: false,
      });
    }
    // Each host comes from its environment: production's variable, staging's secret.
    expect(runOf("deploy", "ssh")).toContain("[[ $DEPLOY_HOST =~ $HOST_NAME ]]");
    expect(hostText).toContain(`TARGET_HOST: \${{ secrets.TARGET_HOST }}`);
    expect(text.match(/https:\/\/slsa\.dev\/[^\s"']*/gu)).toEqual([
      "https://slsa.dev/provenance/v1",
    ]);
  });

  test("the host check catches what it must", () => {
    const samples = [
      "ssh to deploy.example.com.",
      "deploy.example.net ssh-ed25519 AAAA",
      "deploy.example.net-old",
      "deploy.example.net. IN SSHFP 4 2 0",
      "`tarubot@bot.example.org`",
      "https://host.example.io/health",
      "HOST.EXAMPLE.COM",
    ];
    for (const sample of samples)
      expect({ sample, caught: hostNames(sample).some((h) => !allowed.has(h)) }).toEqual({
        sample,
        caught: true,
      });
    expect(hostNames("https://api.github.com/repos and ghcr.io/deconfined/tarubot")).toEqual([
      "api.github.com",
      "ghcr.io",
    ]);
  });
});

describe("the other workflows", () => {
  const files = readdirSync(root(".github/workflows")).filter((f) => /\.ya?ml$/u.test(f));
  /** host.yml's secrets: the host's three and the bot's 11. */
  const HOST_SECRETS = [
    "ANSIBLE_SSH_KEY",
    "TARGET_HOST",
    "TARGET_HOST_KEY",
    "BACKUP_STORAGE_ACCESS_KEY",
    "BACKUP_STORAGE_ENDPOINT",
    "BACKUP_STORAGE_REGION",
    "BACKUP_STORAGE_SECRET_KEY",
    "DATABASE_CA_CERT",
    "DATABASE_URL",
    "DISCORD_TOKEN",
    "SUGGEST_APP_PRIVATE_KEY",
    "REPORTS_GITHUB_TOKEN",
    "HEALTHCHECKS_BACKUP_URL",
    "HEALTHCHECKS_PING_URL",
  ];
  /** Which workflow alone may name each group of environments, switches and secrets. */
  const owners: [string, RegExp][] = [
    [
      "deploy.yml",
      /environment:\s*(?:production|staging|notify)\b|DEPLOY_ENABLED|DEPLOY_SSH_KEY|DEPLOY_KNOWN_HOSTS|DEPLOY_HOST|PUSHOVER_/u,
    ],
    [
      "host.yml",
      new RegExp(
        `secrets\\.(?:${HOST_SECRETS.join("|")})\\b|environment:\\s*\\$\\{\\{\\s*inputs\\.target`,
        "u",
      ),
    ],
    [
      "infra.yml",
      // infra-plan's and infra's: the *_READ_* and *_WRITE_* tokens, and the TOFU_* settings.
      /environment:\s*infra(?:-plan)?\b|secrets\.(?:LINODE_[A-Z_]*TOKEN|CLOUDFLARE_[A-Z_]*TOKEN|TOFU_[A-Z_]+)\b/u,
    ],
  ];

  test("only deploy.yml names production's settings, host.yml staging's and infra.yml Tofu's", () => {
    for (const file of files) {
      const source = read(`.github/workflows/${file}`);
      for (const [owner, names] of owners)
        expect({ file, owner, named: names.test(source) }).toEqual({
          file,
          owner,
          named: file === owner || (owner === "infra.yml" && file === "release-infra.yml"),
        });
      // No workflow runs untrusted pull-request code with the repository's secrets.
      expect({ file, target: source.includes("pull_request_target") }).toEqual({
        file,
        target: false,
      });
    }
  });

  test("every secret and variable a workflow reads is one GitHub lets the owner create", () => {
    // GitHub refuses a secret or variable name that starts with GITHUB_ (in any case) and allows
    // only letters, digits and underscores, not starting with a digit. GITHUB_TOKEN is the one
    // GITHUB_ secret, the job's own token, which nobody creates.
    const refused: string[] = [];
    for (const file of files) {
      const source = read(`.github/workflows/${file}`);
      for (const match of source.matchAll(/\b(secrets|vars)\.([A-Za-z0-9_]+)/gu)) {
        const [, kind, name = ""] = match;
        if (kind === "secrets" && name === "GITHUB_TOKEN") continue;
        if (/^GITHUB_/iu.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
          refused.push(`${file}: ${kind}.${name}`);
      }
    }
    expect(refused).toEqual([]);
  });

  test("publish.yml builds from main only: no tag trigger", () => {
    const publish = z
      .object({
        on: z.object({ push: z.object({ branches: z.array(z.string()) }).strict() }).passthrough(),
        jobs: z.object({ publish: z.object({ if: z.string() }).passthrough() }).passthrough(),
      })
      .passthrough()
      .parse(YAML.parse(read(".github/workflows/publish.yml")));
    expect(publish.on.push).toEqual({ branches: ["main"] });
    expect(publish.jobs.publish.if).toBe("github.ref == 'refs/heads/main'");
  });

  test("CI checks the host scripts with ShellCheck", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("shellcheck -S warning ops/*.sh\n");
    expect(ci).not.toContain("ops/*/*.sh");
  });

  test("CODEOWNERS makes @deconfined the reviewer of every pull request", () => {
    const owners = read(".github/CODEOWNERS")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(owners).toEqual(["* @deconfined"]);
  });
});

describe("CI's guards", () => {
  const ci = YAML.parse(read(".github/workflows/ci.yml")) as {
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string[];
        environment?: unknown;
        env?: Record<string, string>;
        steps: { name?: string; if?: string; env?: Record<string, string>; run?: string }[];
      }
    >;
  };
  const stepIn = (jobName: string, name: string) => {
    const found = ci.jobs[jobName]?.steps.find((s) => s.name === name);
    if (!found) throw new Error(`no step ${name} in ${jobName}`);
    return found;
  };

  test("the infrastructure checks run on pull requests and dispatches, with no secret", () => {
    const infra = ci.jobs.infrastructure;
    expect(infra?.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
    );
    expect(infra?.environment).toBeUndefined();
    expect(JSON.stringify(infra)).not.toMatch(/\$\{\{\s*(?:secrets|vars)\./u);
    expect(infra?.env).toEqual({ TF_VAR_state_passphrase: "ci-only-throwaway-state-passphrase" });
    // The cloud-init image is pinned by its index digest.
    expect(JSON.stringify(infra)).toMatch(/almalinux:10@sha256:[0-9a-f]{64}/u);
    expect(ci.jobs.result?.needs).toEqual(["checks", "images", "playbook", "infrastructure"]);
  });

  test("CI result requires the infrastructure checks on pull requests, and allows them skipped otherwise", () => {
    const run = stepIn("result", "Require all applicable validation jobs").run ?? "";
    const result = (env: Record<string, string>) =>
      Bun.spawnSync(["bash", "-e", "-c", run], {
        env: {
          PATH: "/usr/bin:/bin",
          CHECKS: "success",
          IMAGES: "success",
          PLAYBOOK: "success",
          ...env,
        },
      }).exitCode;
    expect(result({ EVENT: "pull_request", INFRA: "success" })).toBe(0);
    expect(result({ EVENT: "pull_request", INFRA: "skipped" })).not.toBe(0);
    expect(result({ EVENT: "pull_request", INFRA: "failure" })).not.toBe(0);
    for (const event of ["workflow_call", "push", "workflow_dispatch"]) {
      expect({ event, code: result({ EVENT: event, INFRA: "skipped" }) }).toEqual({
        event,
        code: 0,
      });
      expect({ event, code: result({ EVENT: event, INFRA: "failure" }) }).toEqual({
        event,
        code: 1,
      });
    }
  });

  test.skipIf(!hasGit)("pull requests may add migrations, never edit, rename or remove one", () => {
    const guard = stepIn("checks", "Refuse edits to applied migrations");
    expect(guard.if).toBe("github.event_name == 'pull_request'");
    expect(guard.env).toEqual({ BASE_SHA: `\${{ github.event.pull_request.base.sha }}` });
    const dir = mkdtempSync(join(tmpdir(), "migration-guard-"));
    try {
      const git = (...args: string[]) => {
        const r = Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: dir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
        return r.stdout.toString().trim();
      };
      git("init", "--quiet", "-b", "main");
      mkdirSync(join(dir, "migrations"));
      writeFileSync(join(dir, "migrations/001_init.sql"), "CREATE TABLE t (id int);\n");
      writeFileSync(join(dir, "README.md"), "x\n");
      git("add", "-A");
      git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      /** The guard over a branch made by `change` from the base commit. */
      const check = (change: () => void) => {
        git("checkout", "--quiet", "--detach", base);
        change();
        git("add", "-A");
        git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "change");
        return Bun.spawnSync(["bash", "-eo", "pipefail", "-c", guard.run ?? ""], {
          cwd: dir,
          env: { PATH: "/usr/bin:/bin", BASE_SHA: base, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
        });
      };
      const sql = (name: string, body: string) => () =>
        writeFileSync(join(dir, "migrations", name), body);
      for (const [what, change] of [
        ["an added migration", sql("002_more.sql", "ALTER TABLE t ADD n int;\n")],
        ["another file", () => writeFileSync(join(dir, "README.md"), "y\n")],
      ] as const)
        expect({ what, code: check(change).exitCode }).toEqual({ what, code: 0 });
      for (const [what, change] of [
        ["an edited migration", sql("001_init.sql", "CREATE TABLE t (id bigint);\n")],
        ["a renamed migration", () => git("mv", "migrations/001_init.sql", "migrations/001_x.sql")],
        ["a removed migration", () => git("rm", "--quiet", "migrations/001_init.sql")],
      ] as const) {
        const r = check(change);
        expect({ what, code: r.exitCode }).toEqual({ what, code: 1 });
        expect(r.stdout.toString()).toContain(
          "::error::This pull request edits, renames or removes",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, run with simulated tools
// ---------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let boxes = 0;

/** A directory with the stubs on a PATH, a GITHUB_OUTPUT and a summary file. */
function box() {
  const dir = join(scratch, `b${++boxes}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of readdirSync(STUBS)) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return { dir, bin };
}

/**
 * Run one workflow script with the given environment; returns status, stdout and outputs. A
 * prelude runs first in the same shell (the SSH tests use it to move the clock on).
 */
function runScript(
  source: string,
  where: { dir: string; bin: string },
  env: Record<string, string>,
  prelude = "",
) {
  const result = Bun.spawnSync(["bash", "-c", `${prelude}${source}`], {
    env: {
      PATH: `${where.bin}:/usr/bin:/bin`,
      HOME: where.dir,
      STUB: where.dir,
      GITHUB_OUTPUT: join(where.dir, "output"),
      GITHUB_STEP_SUMMARY: join(where.dir, "summary"),
      GITHUB_REPOSITORY: "deconfined/tarubot",
      GITHUB_RUN_ID: "36300000042",
      GITHUB_SERVER_URL: "https://github.com",
      RUNNER_TEMP: where.dir,
      ...env,
    },
    stdin: "ignore",
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(join(where.dir, "output"), "utf8").split("\n"))
    if (line.includes("="))
      outputs[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
    summary: readFileSync(join(where.dir, "summary"), "utf8"),
  };
}
describe("production's SSH step", () => {
  const host = "deploy.example.invalid";
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const digest = `sha256:${"ab".repeat(32)}`;
  const base = {
    DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    DEPLOY_HOST: host,
    DEPLOY_KNOWN_HOSTS: `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBx9`,
    ACTION: "deploy",
    VERSION: "2.30.1",
    COMMIT: commit,
    DIGEST: digest,
    FROM: "-",
  };

  /**
   * Each retry pause (the sleep stub records it) moves bash's clock on by 1,000 seconds, so the
   * reconnect deadline passes after a few attempts.
   */
  const clock = 'sleep() { command sleep "$@"; SECONDS=$((SECONDS + 1000)); }\n';

  /**
   * Run the Deploy job's SSH step, with its own DEPLOY_ENVIRONMENT and RECONNECT_SECONDS from the
   * workflow, and ssh behaviors, one per connection attempt.
   */
  function ssh(behaviors: string[], env: Record<string, string> = {}) {
    const where = box();
    writeFileSync(join(where.dir, "plan"), `${behaviors.join("\n")}\n`);
    const own = stepOf("deploy", "ssh").env ?? {};
    const settings = {
      DEPLOY_ENVIRONMENT: own.DEPLOY_ENVIRONMENT ?? "",
      RECONNECT_SECONDS: own.RECONNECT_SECONDS ?? "",
    };
    const result = runScript(
      runOf("deploy", "ssh"),
      where,
      { ...base, ...settings, ...env },
      clock,
    );
    const calls = existsSync(join(where.dir, "ssh-calls"))
      ? readFileSync(join(where.dir, "ssh-calls"), "utf8")
      : "";
    const sleeps = existsSync(join(where.dir, "sleeps"))
      ? readFileSync(join(where.dir, "sleeps"), "utf8").trim().split("\n")
      : [];
    return {
      ...result,
      dir: where.dir,
      calls,
      attempts: (calls.match(/^call /gmu) ?? []).length,
      sleeps,
    };
  }

  test("sends the contract command once, echoes only fixed lines, and reports the result", () => {
    const s = ssh(["ok"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toBe(
      "step preflight\nstep up\nresult outcome=deployed version=2.30.1 previous=2.30.0 path=plain downtime=4 commands=registered backup=- restore_point=- reason=-\n",
    );
    expect(s.outputs).toMatchObject({
      connected: "true",
      outcome: "deployed",
      previous: "2.30.0",
      path: "plain",
      downtime: "4",
      commands: "registered",
      reason: "-",
    });
    // The key's variable is gone before ssh runs; the command is the last argument.
    expect(s.calls).toContain("key-variable=\n");
    expect(s.calls).toContain(`tarubot@${host}\ndeploy 2.30.1 ${commit} ${digest} 36300000042\n`);
    expect(readFileSync(join(s.dir, "ssh", "kh"), "utf8")).toBe(`${base.DEPLOY_KNOWN_HOSTS}\n`);
  });

  test("a rollback carries the live version it leaves", () => {
    const s = ssh(["ok"], { ACTION: "rollback", VERSION: "2.30.0", FROM: "2.30.1" });
    expect(s.calls).toContain(`rollback 2.30.0 ${commit} ${digest} 36300000042 2.30.1\n`);
  });

  test("retries a dropped connection with the same command, and stops on a result", () => {
    const s = ssh(["partial", "drop", "ok"]);
    expect(s.code).toBe(0);
    expect(s.attempts).toBe(3);
    expect(s.sleeps).toEqual(["20", "20"]);
    expect(s.outputs.outcome).toBe("deployed");
  });

  test("a host that needs the owner fails the job with its outcome and reason", () => {
    const s = ssh(["needs-you"]);
    expect(s.code).toBe(1);
    expect(s.outputs).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
  });

  test("passes the maintenance-window warning on as an annotation and an output", () => {
    const s = ssh(["warning"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("::warning::The host reports: db-maintenance-window\n");
    expect(s.outputs.warnings).toBe("db-maintenance-window");
  });

  test("never retries a changed host key or a rejected key", () => {
    const changed = ssh(["hostkey", "ok"]);
    expect(changed.code).toBe(1);
    expect(changed.attempts).toBe(1);
    expect(changed.outputs.reason).toBe("host-key");
    const rejected = ssh(["denied", "ok"]);
    expect(rejected.attempts).toBe(1);
    expect(rejected.outputs.reason).toBe("key-rejected");
    // ssh's own messages stay private.
    expect(changed.stdout + changed.stderr).not.toContain("Host key verification failed");
  });

  test("tells a refused format, a lost host and a host never reached apart", () => {
    expect(ssh(["usage"]).outputs).toMatchObject({ reason: "bad-request", connected: "true" });
    expect(ssh(["partial", "quiet"]).outputs).toMatchObject({
      reason: "outcome-unknown",
      connected: "true",
    });
    // A drop with nothing on stderr may have come after the host started: not "unreachable".
    expect(ssh(["drop", "quiet"]).outputs).toMatchObject({
      reason: "outcome-unknown",
      connected: "true",
    });
    // Only attempts that all failed before sshd answered, until the deadline, are unreachable.
    const never = ssh(["noconnect"]);
    expect(never.outputs).toMatchObject({ reason: "unreachable", connected: "false" });
    expect(never.attempts).toBe(6);
    // A connection that reached the host once stays "outcome unknown", whatever follows.
    expect(ssh(["partial", "noconnect"]).outputs).toMatchObject({
      reason: "outcome-unknown",
      connected: "true",
    });
  });

  test("refuses host settings that aren't one pinned ed25519 key for DEPLOY_HOST", () => {
    for (const env of [
      { DEPLOY_HOST: "Deploy.Example.Invalid" },
      { DEPLOY_HOST: `${host} -oProxyCommand=x` },
      { DEPLOY_HOST: "" },
      { DEPLOY_KNOWN_HOSTS: `other.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5` },
      { DEPLOY_KNOWN_HOSTS: `${host} ssh-rsa AAAAB3NzaC1yc2E=` },
      { DEPLOY_KNOWN_HOSTS: `${host} ssh-ed25519 AAAA\n${host} ssh-ed25519 BBBB` },
      { DEPLOY_KNOWN_HOSTS: `${host},1.2.3.4 ssh-ed25519 AAAA` },
    ]) {
      const s = ssh(["ok"], env);
      expect({ env, code: s.code, reason: s.outputs.reason, attempts: s.attempts }).toEqual({
        env,
        code: 1,
        reason: "known-hosts",
        attempts: 0,
      });
    }
    expect(ssh(["ok"], { DEPLOY_SSH_KEY: "" }).outputs.reason).toBe("no-key");
    // A trailing newline in the variable is tolerated.
    expect(ssh(["ok"], { DEPLOY_KNOWN_HOSTS: `${base.DEPLOY_KNOWN_HOSTS}\n` }).code).toBe(0);
  });

  test("names the production environment in its messages, as before", () => {
    const production = ssh(["ok"], { DEPLOY_SSH_KEY: "" });
    expect(production.stdout).toContain(
      "::error::DEPLOY_SSH_KEY isn't set in the production environment.\n",
    );
    expect(ssh(["ok"], { DEPLOY_HOST: "" }).stdout).toContain(
      "::error::DEPLOY_HOST must be the production host's DNS name.\n",
    );
  });

  test("refuses plan fields, or job settings, that don't fit the contract", () => {
    const s = ssh(["ok"], { VERSION: "2.30.1; id" });
    expect(s.outputs.reason).toBe("bad-request");
    expect(s.attempts).toBe(0);
    for (const env of [
      { RECONNECT_SECONDS: "a[$(id)]" },
      { RECONNECT_SECONDS: "" },
      { DEPLOY_ENVIRONMENT: "preview" },
    ]) {
      const bad = ssh(["ok"], env);
      expect({ env, reason: bad.outputs.reason, attempts: bad.attempts }).toEqual({
        env,
        reason: "bad-request",
        attempts: 0,
      });
    }
  });
});

describe("the notify step", () => {
  /** Run the step and return the message, priority and what curl received. */
  function notify(env: Record<string, string>) {
    const where = box();
    const result = runScript(runOf("notify", "Send one Pushover message"), where, {
      PUSHOVER_TOKEN: "app-token",
      PUSHOVER_USER: "user-key",
      PLAN_RESULT: "success",
      PLAN_DEPLOY: "true",
      PLAN_PRODUCTION: "true",
      PLAN_PRODUCTION_REASON: "-",
      PLAN_VERSION: "2.30.1",
      PLAN_REASON: "-",
      PLAN_ACTION: "deploy",
      DEPLOY_RESULT: "success",
      STARTED: "true",
      OUTCOME: "",
      REASON: "",
      PREVIOUS: "2.30.0",
      DEPLOY_PATH: "plain",
      DOWNTIME: "4",
      COMMANDS: "registered",
      BACKUP: "-",
      RESTORE_POINT: "-",
      WARNINGS: "",
      ...env,
    });
    const args = existsSync(join(where.dir, "curl-args"))
      ? readFileSync(join(where.dir, "curl-args"), "utf8").split("\n")
      : [];
    const field = (name: string) =>
      args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    return {
      ...result,
      args,
      message: field("message"),
      priority: field("priority"),
      config: existsSync(join(where.dir, "curl-config"))
        ? readFileSync(join(where.dir, "curl-config"), "utf8")
        : "",
    };
  }

  test("reads the production job's result and the plan's production output", () => {
    const env = stepOf("notify", "Send one Pushover message").env ?? {};
    expect(env.PLAN_PRODUCTION).toBe(`\${{ needs.plan.outputs.production }}`);
    // Nothing from the staging job or the run's conclusion reaches the message.
    expect(JSON.stringify(deploy.jobs.notify)).not.toMatch(/deploy-staging|staging\.outputs/u);
    for (const [name, value] of Object.entries(env))
      if (name.startsWith("DEPLOY_") || ["STARTED", "OUTCOME", "REASON"].includes(name))
        expect({ name, value }).toEqual({ name, value: expect.stringMatching(/needs\.deploy\./u) });
  });

  test("reports each outcome with its priority", () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ OUTCOME: "deployed" }, "2.30.1 deployed (restart, down 4s; commands registered)", "0"],
      [
        {
          OUTCOME: "deployed",
          DEPLOY_PATH: "migration",
          DOWNTIME: "31",
          WARNINGS: "db-maintenance-window",
        },
        "2.30.1 deployed (migration, down 31s; commands registered) The migration ran during the database maintenance window.",
        "0",
      ],
      [{ OUTCOME: "already-live" }, "2.30.1 is live and verified; commands registered", "-1"],
      [
        { OUTCOME: "superseded", PREVIOUS: "2.31.0" },
        "2.30.1 skipped: newer release 2.31.0 is live",
        "-1",
      ],
      [{ OUTCOME: "refused", REASON: "busy" }, "2.30.1 not deployed, nothing changed: busy", "0"],
      [
        { OUTCOME: "refused", REASON: "paused" },
        "2.30.1 not deployed: deploys were paused after the request (nothing changed)",
        "-1",
      ],
      [
        { OUTCOME: "recovered", REASON: "did-not-start", DOWNTIME: "40" },
        "2.30.1 not deployed; 2.30.0 is back (down 40s): did-not-start",
        "1",
      ],
      [
        {
          OUTCOME: "needs-you",
          REASON: "new-release-failed",
          BACKUP: "daily/tarubot-20260929T193000Z.dump.age",
          RESTORE_POINT: "2026-09-29T19:30:05.123456Z",
        },
        "NEEDS YOU: 2.30.1 new-release-failed; restore point 2026-09-29T19:30:05.123456Z; backup daily/tarubot-20260929T193000Z.dump.age",
        "1",
      ],
      [
        { OUTCOME: "needs-you", REASON: "new-release-took-lease" },
        "NEEDS YOU: 2.30.1 new-release-took-lease. To go back, run Deploy with version=2.30.0 rollback=true from=2.30.1.",
        "1",
      ],
      [
        { OUTCOME: "needs-you", REASON: "commands-failed" },
        "2.30.1 is live, but command registration failed; run Deploy with 2.30.1 to retry",
        "1",
      ],
      [
        { REASON: "host-key" },
        "2.30.1 not deployed: the host key changed. Check the host before updating DEPLOY_KNOWN_HOSTS.",
        "1",
      ],
      [{ REASON: "key-rejected" }, "2.30.1 not deployed: the host refused the deploy key", "1"],
      [{ REASON: "unreachable" }, "2.30.1 not deployed: host unreachable, nothing started", "1"],
      [
        { REASON: "outcome-unknown" },
        "2.30.1: outcome unknown; the host continues on its own (run 36300000042)",
        "1",
      ],
      [
        { STARTED: "", DEPLOY_RESULT: "failure" },
        "2.30.1 not approved (rejected or expired)",
        "-1",
      ],
      [
        { PLAN_DEPLOY: "false" },
        "2.30.1: no runtime change in this merge. If an earlier release wasn't deployed, run Deploy with the newest version.",
        "-1",
      ],
      // The plan went on for staging while production's gate failed: the Deploy job never ran,
      // which is neither a rejection nor an expiry.
      [
        {
          PLAN_PRODUCTION: "false",
          PLAN_PRODUCTION_REASON: "gate",
          STARTED: "",
          DEPLOY_RESULT: "skipped",
        },
        "2.30.1 not deployable: gate",
        "0",
      ],
      // Production's switch reads as true to GitHub but isn't exactly `true` (say `True`): the plan
      // paused production and went on for staging, or paused the whole run.
      [
        {
          PLAN_PRODUCTION: "false",
          PLAN_PRODUCTION_REASON: "paused",
          STARTED: "",
          DEPLOY_RESULT: "skipped",
        },
        "2.30.1 not deployed to production: DEPLOY_ENABLED must be exactly true (lowercase). Staging went ahead.",
        "-1",
      ],
      [
        {
          PLAN_DEPLOY: "false",
          PLAN_REASON: "paused",
          PLAN_VERSION: "",
          PLAN_PRODUCTION: "false",
          PLAN_PRODUCTION_REASON: "paused",
          STARTED: "",
          DEPLOY_RESULT: "skipped",
        },
        "Deploys are paused: DEPLOY_ENABLED must be exactly true (lowercase). Nothing was planned or deployed.",
        "-1",
      ],
      [
        { PLAN_DEPLOY: "false", PLAN_PRODUCTION: "false" },
        "2.30.1: no runtime change in this merge. If an earlier release wasn't deployed, run Deploy with the newest version.",
        "-1",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "digest-mismatch" },
        "2.30.1 not deployable: digest-mismatch (see the run)",
        "0",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "compare-too-large" },
        "2.30.1 not deployable: compare-too-large (see the run)",
        "0",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "unattested" },
        "2.30.1 not deployable: unattested (see the run)",
        "0",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_VERSION: "", PLAN_REASON: "" },
        "? not deployable: ? (see the run)",
        "0",
      ],
    ];
    for (const [env, message, priority] of cases) {
      const n = notify(env);
      expect({ env, message: n.message, priority: n.priority }).toEqual({ env, message, priority });
    }
  });

  test("a switch turned off after the run planned still gets the outcome reported", () => {
    // The step itself never reads a variable; the job's condition reads the plan's decision.
    const step = stepOf("notify", "Send one Pushover message");
    expect(Object.values(step.env ?? {}).join(" ")).not.toContain("vars.");
    expect(deploy.jobs.plan.outputs?.notify).toBe(`\${{ steps.plan.outputs.notify }}`);
    // Paused while the approval request waited: the host refused it, and the job still runs.
    const waiting = { switches: { production: "" }, plan: { notify: "true" } } as const;
    expect(runs("notify", waiting)).toBe(true);
    const refused = notify({ OUTCOME: "refused", REASON: "paused" });
    expect(refused.message).toBe(
      "2.30.1 not deployed: deploys were paused after the request (nothing changed)",
    );
    expect(refused.args).toContain("https://api.pushover.net/1/messages.json");
    // Paused while the deploy ran: a NEEDS YOU still reaches the owner, at priority 1.
    const running = {
      event: "workflow_dispatch",
      switches: { production: "false" },
      plan: { notify: "true" },
    } as const;
    expect(runs("notify", running)).toBe(true);
    for (const reason of ["new-release-took-lease", "migration-may-have-committed"]) {
      const n = notify({ OUTCOME: "needs-you", REASON: reason, DEPLOY_PATH: "migration" });
      expect({ reason, message: n.message, priority: n.priority, sent: n.args.length > 0 }).toEqual(
        {
          reason,
          message: expect.stringMatching(new RegExp(`^NEEDS YOU: 2\\.30\\.1 ${reason}`, "u")),
          priority: "1",
          sent: true,
        },
      );
    }
  });

  test("the way back after a needs-you depends on the path", () => {
    const plain = notify({ OUTCOME: "needs-you", REASON: "unstable", DEPLOY_PATH: "plain" });
    expect(plain.message).toBe(
      "NEEDS YOU: 2.30.1 unstable. To go back, run Deploy with version=2.30.0 rollback=true from=2.30.1.",
    );
    // After a rollback the newer release is an ordinary deploy away; a rollback of it is refused.
    const rollback = notify({
      OUTCOME: "needs-you",
      REASON: "image-mismatch",
      DEPLOY_PATH: "rollback",
      PLAN_ACTION: "rollback",
      PLAN_VERSION: "2.30.0",
      PREVIOUS: "2.30.1",
    });
    expect(rollback.message).toBe(
      "NEEDS YOU: 2.30.0 image-mismatch. To return to 2.30.1, run Deploy with version=2.30.1.",
    );
    // After a committed migration the host refuses a rollback: a fix release or a fork.
    const migration = notify({
      OUTCOME: "needs-you",
      REASON: "unstable",
      DEPLOY_PATH: "migration",
      BACKUP: "daily/tarubot-20260929T193000Z.dump.age",
      RESTORE_POINT: "2026-09-29T19:30:05.123456Z",
    });
    expect(migration.message).toBe(
      "NEEDS YOU: 2.30.1 unstable; restore point 2026-09-29T19:30:05.123456Z; backup daily/tarubot-20260929T193000Z.dump.age. The migration committed: the way back is a fix release or a point-in-time fork (HOSTING.md).",
    );
    expect(migration.message).not.toContain("rollback=true");
  });

  test("a rollback's message says what to requeue", () => {
    const n = notify({
      OUTCOME: "deployed",
      DEPLOY_PATH: "rollback",
      PLAN_ACTION: "rollback",
      PREVIOUS: "2.30.2",
    });
    expect(n.message).toBe(
      "2.30.1 deployed (rollback, down 4s; commands registered). Work only 2.30.2 understood fails as invalid_job: check /sync status and requeue it with retry.js.",
    );
  });

  test("the credentials reach curl on stdin, never in its arguments", () => {
    const n = notify({ OUTCOME: "deployed" });
    expect(n.config).toBe('form-string = "token=app-token"\nform-string = "user=user-key"\n');
    expect(n.args.join(" ")).not.toMatch(/app-token|user-key/u);
    expect(n.args).toContain("https://api.pushover.net/1/messages.json");
    expect(n.args).toContain("url=https://github.com/deconfined/tarubot/actions/runs/36300000042");
    expect(n.args).toContain("url_title=Deploy run");
  });

  test("names the workflow Deploy in every message", () => {
    expect(runOf("notify", "Send one Pushover message")).not.toContain("Deploy production");
  });

  test("values that don't match their pattern never reach the message", () => {
    const n = notify({ OUTCOME: "refused", REASON: "busy; rm -rf /", PLAN_VERSION: "2.30.1\nx" });
    expect(n.message).toBe("? not deployed, nothing changed: ?");
  });

  test("without Pushover set up, it sends nothing and succeeds", () => {
    const n = notify({ OUTCOME: "deployed", PUSHOVER_TOKEN: "" });
    expect(n.code).toBe(0);
    expect(n.args).toEqual([]);
  });
});

describe.skipIf(!hasJq)("the plan step", () => {
  const R = "repos/deconfined/tarubot";
  const sha = (seed: string) => new Bun.CryptoHasher("sha1").update(seed).digest("hex");
  const C = sha("release");
  const P = sha("previous");
  const D = `sha256:${"cd".repeat(32)}`;
  const IMAGE = "ghcr.io/deconfined/tarubot";
  /** github.sha: main's head when the run was created, which staging's Configure applies. */
  const CONFIG = sha("main");
  /** The release these runs deploy, the one before it on main, and a newer one to leave. */
  const V = "2.36.1";
  const NEWER = "2.36.2";
  /** A file of the simulated API, named as the gh stub looks it up. */
  const api = (dir: string, path: string, body: unknown) => {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(
      join(dir, "api", path.replaceAll(/[/?=]/gu, "_")),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };
  const production = {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [
      { type: "branch_policy" },
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
      },
    ],
  };
  /** The staging environment as GitHub answers for it: main only, no reviewer. */
  const staging = {
    can_admins_bypass: true,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [{ type: "branch_policy" }],
  };
  const mainOnly = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
  const owner = { login: "deconfined", id: 71469756, type: "User" };

  interface File {
    filename: string;
    status: string;
    patch?: string;
    previous_filename?: string;
  }

  /** What a test may change in the simulated repository, registry and run. */
  interface Overrides {
    readonly production?: unknown;
    /** The staging environment; null leaves it missing. */
    readonly staging?: unknown;
    readonly stagingBranches?: unknown;
    readonly notifyEnvironment?: unknown;
    readonly shaDigest?: string;
    /** The clock, "<day of week> <HHMM>" in UTC; Thursday noon by default. */
    readonly now?: string;
    /** The release at commit C (V by default). */
    readonly release?: string;
    /** package.json's version at the release commit (the release's by default). */
    readonly packageVersion?: string;
    /** The revision label on the release's image. */
    readonly revision?: string;
    /** The commit the release's attestation was signed for (C by default); null: none exists. */
    readonly attestedFor?: string | null;
    /** What gh attestation verify prints when it passes; one verified result by default. */
    readonly attestAnswer?: string;
    /** The signing certificate's identity (its SAN); main's publish.yml by default. */
    readonly signer?: string;
    /** Production's switch, DEPLOY_ENABLED: on by default. */
    readonly switches?: { readonly production?: string };
    /** github.sha (CONFIG by default). */
    readonly configCommit?: string;
  }

  /** The simulated repository and registry for the release at commit C. */
  function repository(overrides: Overrides) {
    const where = box();
    const release = overrides.release ?? V;
    writeFileSync(join(where.dir, "now"), `${overrides.now ?? "4 1200"}\n`);
    api(where.dir, `${R}/environments/production`, overrides.production ?? production);
    api(
      where.dir,
      `${R}/environments/notify`,
      overrides.notifyEnvironment ?? {
        ...production,
        can_admins_bypass: true,
        protection_rules: [],
      },
    );
    api(where.dir, `${R}/environments/production/deployment-branch-policies`, mainOnly);
    api(where.dir, `${R}/environments/notify/deployment-branch-policies`, mainOnly);
    if (overrides.staging !== null) {
      api(where.dir, `${R}/environments/staging`, overrides.staging ?? staging);
      api(
        where.dir,
        `${R}/environments/staging/deployment-branch-policies`,
        overrides.stagingBranches ?? mainOnly,
      );
    }
    api(where.dir, `${R}/contents/package.json?ref=${C}`, {
      version: overrides.packageVersion ?? release,
    });
    api(
      where.dir,
      `${R}/contents/CHANGELOG.md?ref=${C}`,
      `# Version history\n\n## ${release} — A fix\n\nFixed.\n\n## 0.0.1 — Older\n`,
    );
    api(where.dir, `${R}/contents/migrations?ref=${C}`, [
      { name: "001_init.sql" },
      { name: "010_status_notices.sql" },
    ]);
    api(where.dir, `${R}/compare/${C}...main`, { status: "identical" });
    mkdirSync(join(where.dir, "images"));
    writeFileSync(join(where.dir, "images", release), `${D} ${overrides.revision ?? C}\n`);
    writeFileSync(join(where.dir, "images", `sha-${C}`), `${overrides.shaDigest ?? D} ${C}\n`);
    mkdirSync(join(where.dir, "attested"));
    if (overrides.attestedFor !== null)
      writeFileSync(join(where.dir, "attested", D), overrides.attestedFor ?? C);
    if (overrides.attestAnswer !== undefined)
      writeFileSync(join(where.dir, "attest-answer"), overrides.attestAnswer);
    if (overrides.signer !== undefined) writeFileSync(join(where.dir, "signer"), overrides.signer);
    return where;
  }

  /** The plan's environment beyond the event and its inputs. */
  const environment = (overrides: Overrides) => ({
    GH_TOKEN: "unused",
    DEPLOY_ENABLED: overrides.switches?.production ?? "true",
    CONFIG_COMMIT: overrides.configCommit ?? CONFIG,
  });

  /** A finished plan, with the gh attestation verify calls it made (their arguments). */
  function planned(where: { dir: string }, result: ReturnType<typeof runScript>) {
    const log = join(where.dir, "attest-calls");
    const attestations = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("call\n")
          .filter(Boolean)
          .map((call) => call.trimEnd().split("\n"))
      : [];
    return { ...result, attestations };
  }

  /** Run the plan for an automatic run of the release whose merge changed `files`. */
  function plan(files: File[], overrides: Overrides = {}) {
    const where = repository(overrides);
    api(where.dir, `${R}/contents/package.json?ref=${P}`, { version: "2.36.0" });
    api(where.dir, `${R}/commits/${C}`, { parents: [{ sha: P }] });
    api(where.dir, `${R}/compare/${P}...${C}`, { files });
    return planned(
      where,
      runScript(runOf("plan", "plan"), where, {
        ...environment(overrides),
        EVENT: "workflow_run",
        HEAD_SHA: C,
        INPUT_VERSION: "",
        INPUT_ROLLBACK: "",
        INPUT_FROM: "",
        INPUT_TARGET: "",
        INPUT_ACTION: "",
      }),
    );
  }

  /** The newer release at commit C2, which a rollback to V leaves. */
  const C2 = sha("newer");
  const D2 = `sha256:${"ef".repeat(32)}`;

  /** Run the plan for a dispatch; `between` is what changed from V to NEWER. */
  function dispatch(
    inputs: {
      version: string;
      rollback?: boolean;
      from?: string;
      target?: string;
      action?: string;
    },
    overrides: Overrides & { between?: File[] } = {},
  ) {
    const where = repository(overrides);
    writeFileSync(join(where.dir, "images", NEWER), `${D2} ${C2}\n`);
    api(where.dir, `${R}/compare/${C}...${C2}`, { files: overrides.between ?? [] });
    return planned(
      where,
      runScript(runOf("plan", "plan"), where, {
        ...environment(overrides),
        EVENT: "workflow_dispatch",
        HEAD_SHA: "",
        INPUT_VERSION: inputs.version,
        INPUT_ROLLBACK: inputs.rollback ? "true" : "false",
        INPUT_FROM: inputs.from ?? "",
        INPUT_TARGET: inputs.target ?? "production",
        INPUT_ACTION: inputs.action ?? "deploy",
      }),
    );
  }
  const version = {
    filename: "package.json",
    status: "modified",
    patch: `@@ -1 +1 @@\n-  "version": "2.36.0",\n+  "version": "${V}",`,
  };
  const source = [{ filename: "src/main.ts", status: "modified" }];
  const docsOnly = [{ filename: "docs/HOSTING.md", status: "modified" }, version];
  /** Production's switch off: automatic runs go on for staging alone. */
  const productionOff = { switches: { production: "" } } as const;
  const toStaging = { version: V, target: "staging" } as const;

  test("a merge of documentation, tests, CI and OpenTofu asks for nothing", () => {
    const p = plan([
      { filename: "docs/HOSTING.md", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
      { filename: "tests/unit/x.test.ts", status: "added" },
      { filename: ".github/workflows/ci.yml", status: "modified" },
      { filename: ".github/workflows/host.yml", status: "modified" },
      { filename: ".github/CODEOWNERS", status: "added" },
      { filename: "site/src/content/docs/index.md", status: "modified" },
      { filename: "ops/tofu/main.tf", status: "modified" },
      { filename: "ops/tofu/examples/user-data-with-hash.yaml", status: "modified" },
      { filename: "ops/ansible/requirements-lint.txt", status: "modified" },
      version,
    ]);
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      deploy: "false",
      reason: "no-runtime-change",
      version: V,
      production: "false",
      staging: "false",
    });
    expect(p.summary).toContain("nothing to deploy");
    // It was verified all the same: the provenance check comes before this exit.
    expect(p.summary).toContain(`Provenance verified: publish.yml on refs/heads/main, commit ${C}`);
    expect(p.summary).toContain("run **Deploy** with the newest version");
  });

  test("source, a dependency change, publish.yml or a host file deploys both targets", () => {
    for (const files of [
      [{ filename: "src/main.ts", status: "modified" }],
      [{ ...version, patch: '@@ -1 +1 @@\n-  "zod": "4.1.0",\n+  "zod": "4.2.0",' }],
      [{ filename: "package.json", status: "modified" }],
      [{ filename: ".github/workflows/publish.yml", status: "modified" }],
      [{ filename: "ops/deploy.sh", status: "modified" }],
      [{ filename: "ops/ansible/site.yml", status: "modified" }],
      [{ filename: "ops/ansible/bot.yml", status: "modified" }],
      // Staging's Configure and Bot steps install this ansible-core.
      [{ filename: "ops/ansible/requirements.txt", status: "modified" }],
      [{ filename: "docs/moved.ts", status: "renamed", previous_filename: "src/moved.ts" }],
    ]) {
      const p = plan(files as File[]);
      expect({ file: files[0]?.filename, code: p.code, outputs: p.outputs }).toEqual({
        file: files[0]?.filename,
        code: 0,
        outputs: {
          notify: "true",
          version: V,
          action: "deploy",
          commit: C,
          digest: D,
          from: "-",
          staging_action: "deploy",
          config_commit: CONFIG,
          schema_head: "010_status_notices.sql",
          production: "true",
          staging: "true",
          production_reason: "-",
          deploy: "true",
          reason: "-",
        },
      });
    }
  });

  test("verifies the image's signed provenance with gh, logging in nowhere", () => {
    const p = plan(source);
    expect(p.code).toBe(0);
    // One call, with interfaces §6's exact flags: main's publish.yml, built from C, SLSA
    // provenance, on a GitHub-hosted runner.
    expect(p.attestations).toEqual([
      [
        "attestation",
        "verify",
        `oci://${IMAGE}@${D}`,
        "--repo",
        "deconfined/tarubot",
        "--cert-identity",
        "https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        C,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
    ]);
    expect(p.summary).toContain(`Provenance verified: publish.yml on refs/heads/main, commit ${C}`);
    // A dispatch verifies the digest it resolved, for the commit the image's label names; so does
    // a staging dispatch of a release.
    for (const target of ["production", "staging"]) {
      const d = dispatch({ version: V, target });
      expect(d.attestations.map((call) => [call[2], call[10]])).toEqual([
        [`oci://${IMAGE}@${D}`, C],
      ]);
      expect(d.summary).toContain(
        `Provenance verified: publish.yml on refs/heads/main, commit ${C}`,
      );
    }
  });

  test("an unattested image is refused before the plan can end early or deploy anything", () => {
    const refusals: [string, ReturnType<typeof plan>][] = [
      ["a quiet merge, no attestation", plan(docsOnly, { attestedFor: null })],
      ["a runtime merge, no attestation", plan(source, { attestedFor: null })],
      ["a runtime merge, signed for another commit", plan(source, { attestedFor: P })],
      ["gh passing with no result", plan(source, { attestAnswer: "[]\n" })],
      // Signed by another workflow whose name only starts like publish.yml's, or by publish.yml
      // on another branch: gh's --signer-workflow would pass the first, the exact identity doesn't.
      [
        "a prefix-sibling workflow",
        plan(source, {
          signer:
            "https://github.com/deconfined/tarubot/.github/workflows/publish.yml-canary.yml@refs/heads/main",
        }),
      ],
      [
        "publish.yml on another branch",
        plan(source, {
          signer:
            "https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/dev",
        }),
      ],
      ["gh passing with something else", plan(source, { attestAnswer: '{"a":1}\n' })],
      ["a dispatch, no attestation", dispatch({ version: V }, { attestedFor: null })],
      ["a staging dispatch, no attestation", dispatch(toStaging, { attestedFor: null })],
      [
        "a staging bot dispatch, no attestation",
        dispatch({ ...toStaging, action: "bot" }, { attestedFor: null }),
      ],
      [
        "a staging preflight, no attestation",
        dispatch({ ...toStaging, action: "preflight" }, { attestedFor: null }),
      ],
      [
        "a rollback, no attestation",
        dispatch({ version: V, rollback: true, from: NEWER }, { attestedFor: null }),
      ],
    ];
    for (const [what, p] of refusals) {
      expect({
        what,
        code: p.code,
        reason: p.outputs.reason,
        deploy: p.outputs.deploy,
        production: p.outputs.production,
        staging: p.outputs.staging,
        summary: p.summary,
      }).toEqual({
        what,
        code: 1,
        reason: "unattested",
        deploy: undefined,
        production: undefined,
        staging: undefined,
        summary: "",
      });
      // It may be a network or TUF error, and re-runs are refused: a new dispatch retries.
      expect(p.stdout).toContain("::error::");
      expect(p.stdout).toContain("start a new dispatch");
    }
    const [, missing] = refusals[0] ?? [];
    expect(missing?.stdout).toContain(
      `::error::${IMAGE}@${D} isn't attested as built from ${C} by publish.yml on main, or the attestation couldn't be verified`,
    );
    expect(missing?.stdout).toContain("Releases before 2.32.0 carry no attestation");
  });

  test("a compare GitHub may have cut at 300 files is refused, never read as complete", () => {
    /** `count` changed files: documentation, with a host-side file and an edited migration last. */
    const many = (count: number, tail: File[] = []) => [
      ...Array.from({ length: count - tail.length }, (_, i) => ({
        filename: `docs/${i}.md`,
        status: "added",
      })),
      ...tail,
    ];
    // Below the cap the list is whole: 299 documentation files are a quiet merge.
    expect(plan(many(299)).outputs).toMatchObject({ deploy: "false", reason: "no-runtime-change" });
    // At the cap the rest may be missing, so neither "no runtime change", "no host-side file" nor
    // "no edited migration" can be read from it, whatever the listed files are.
    const hidden: File[] = [
      { filename: "ops/deploy.sh", status: "modified" },
      { filename: "migrations/001_init.sql", status: "modified" },
    ];
    for (const files of [many(300), many(301), many(300, hidden)]) {
      const p = plan(files);
      expect({ files: files.length, code: p.code, reason: p.outputs.reason }).toEqual({
        files: files.length,
        code: 1,
        reason: "compare-too-large",
      });
      expect(p.outputs.deploy).toBeUndefined();
      expect(p.stdout).toContain(
        "::error::This merge changes 300 files or more, more than GitHub's compare API lists",
      );
      expect(p.summary).toBe("");
    }
    // A rollback's range is read the same way, before the migration check and the host-side list.
    const rollback = { version: V, rollback: true, from: NEWER };
    expect(dispatch(rollback, { between: many(299) }).outputs).toMatchObject({
      deploy: "true",
      action: "rollback",
    });
    for (const between of [many(300), many(300, hidden)]) {
      const p = dispatch(rollback, { between });
      expect({ code: p.code, reason: p.outputs.reason }).toEqual({
        code: 1,
        reason: "compare-too-large",
      });
      expect(p.outputs.deploy).toBeUndefined();
      expect(p.stdout).toContain(`::error::The way back from ${NEWER} to ${V} changes 300 files`);
      expect(p.summary).toBe("");
    }
    // An answer without a file list is refused too, not read as an empty merge.
    expect(plan(null as unknown as File[]).outputs.reason).toBe("compare");
  });

  test("the plan lists added migrations and host-side changes, and names the approval", () => {
    const p = plan([
      { filename: "migrations/011_more.sql", status: "added" },
      { filename: "docker-compose.production.yml", status: "modified" },
      { filename: "ops/deploy.sh", status: "modified" },
    ]);
    expect(p.outputs.deploy).toBe("true");
    expect(p.summary).toContain("**Migration files added in this merge:** migrations/011_more.sql");
    expect(p.summary).toContain(
      "**Host-side changes in this merge** (on production's Docker host they run as a docker-group user, which is root-equivalent there; on the staging host Configure runs `ops/ansible/site.yml` as root, and the release's `ops/ansible/bot.yml` runs the bot as the unprivileged `tarubot` user):",
    );
    expect(p.summary).toContain("- `ops/deploy.sh`");
    expect(p.summary).toContain(
      "The Compose file or production's settings template changed: **check production's .env first.**",
    );
    // A host may be older than the previous release: the history links cover the rest.
    expect(p.summary).toContain("the host-side changes of the releases in between run too");
    expect(p.summary).toContain(
      `[\`ops/\`](https://github.com/deconfined/tarubot/commits/${C}/ops)`,
    );
    expect(p.summary).not.toContain("staging.env.example");
    expect(p.summary).toContain(
      "**Targets:** production, once @deconfined approves it, and staging, which deploys at once beside the approval request, without one.",
    );
    expect(p.summary).toContain(`**Approving** runs Deploy ${V}`);
    expect(p.summary).toContain(`**Staging** takes ${V}`);
    expect(p.summary).toContain(`## ${V} — A fix`);
    expect(p.summary).not.toContain("## 0.0.1 — Older");
    expect(p.summary).toContain("| Newest migration at this commit | `010_status_notices.sql` |");
    // The retired staging template is still listed, but staging has no .env to check now.
    const retired = plan([{ filename: "staging.env.example", status: "removed" }, ...source]);
    expect(retired.summary).toContain("- `staging.env.example`");
    expect(retired.summary).not.toContain("check production's .env first");
    const template = plan([{ filename: "production.env.example", status: "modified" }, ...source]);
    expect(template.summary).toContain("check production's .env first");
  });

  test("a merge without host-side changes says so for this merge only, never a bare none", () => {
    const p = plan(source);
    expect(p.summary).toContain(
      "**Host-side changes in this merge**: no file under `ops/`, `docker-compose.production.yml` or `production.env.example` changed.",
    );
    expect(p.summary).toContain("the host-side changes of the releases in between run too");
    expect(p.summary).not.toMatch(/\*\*Host-side changes:\*\* none/u);
  });

  test("the approval wording ties the docker-group claim to production's Docker host alone", () => {
    const host: File[] = [{ filename: "ops/backup.sh", status: "modified" }];
    const summaries = [
      plan(host).summary,
      plan(host, productionOff).summary,
      dispatch({ version: V }).summary,
      dispatch({ version: V, rollback: true, from: NEWER }, { between: host }).summary,
      dispatch(toStaging).summary,
      dispatch({ ...toStaging, action: "bot" }).summary,
      dispatch({ ...toStaging, action: "preflight" }).summary,
    ];
    for (const summary of summaries) {
      // Every sentence that calls something root-equivalent names production's Docker host.
      for (const sentence of summary.split(/(?<=[.;:])\s+/u))
        if (/docker-group|root-equivalent/u.test(sentence))
          expect({ sentence, host: sentence.includes("production's Docker host") }).toEqual({
            sentence,
            host: true,
          });
      expect(summary).not.toMatch(/staging[^.]*docker-group/iu);
    }
    // Staging's own paragraph says how its files run there.
    expect(summaries[0]).toContain(
      `Configure runs \`ops/ansible/site.yml\` at main's head (\`${CONFIG.slice(0, 12)}\`) as root on the staging host; then ${V}'s own \`ops/ansible/bot.yml\` writes the bot's secrets, settings and unit as the unprivileged \`tarubot\` user and restarts the bot`,
    );
    // The plan script holds no other wording for them.
    const planScript = runOf("plan", "plan");
    expect(planScript).not.toContain("(root-equivalent)");
    expect(planScript).not.toContain("they run on the host as a docker-group user");
  });

  test("a dispatch takes the commit from the image's revision label and checks package.json", () => {
    const p = dispatch({ version: V });
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      deploy: "true",
      action: "deploy",
      version: V,
      commit: C,
      digest: D,
      from: "-",
      reason: "-",
      production: "true",
      staging: "false",
    });
    expect(p.summary).toContain(`## Deploy ${V}`);
    expect(p.summary).toContain(
      "**Host-side changes:** each host deploys from its live release to this commit. Before approving, check",
    );
    for (const [what, inputs, overrides, reason] of [
      ["a version that isn't X.Y.Z", { version: "2.36" }, {}, "version"],
      ["an unpublished version", { version: "2.36.9" }, {}, "image"],
      ["an image with no revision label", { version: V }, { revision: "none" }, "image"],
      [
        "package.json at the commit naming another version",
        { version: V },
        { packageVersion: "2.36.0" },
        "version-mismatch",
      ],
      ["'from' without a rollback", { version: V, from: NEWER }, {}, "from"],
      ["an unknown target", { version: V, target: "preview" }, {}, "target"],
      ["no target", { version: V, target: "" }, {}, "target"],
      [
        "a staging release that isn't X.Y.Z",
        { version: "2.36", target: "staging", action: "bot" },
        {},
        "version",
      ],
    ] as const) {
      const failed = dispatch(inputs, overrides);
      expect({ what, code: failed.code, reason: failed.outputs.reason }).toEqual({
        what,
        code: 1,
        reason,
      });
    }
  });

  test("a rollback names the live version and goes only to an older release on the same schema", () => {
    const ok = dispatch(
      { version: V, rollback: true, from: NEWER },
      {
        between: [
          { filename: "ops/deploy.sh", status: "modified" },
          { filename: "src/main.ts", status: "modified" },
        ],
      },
    );
    expect(ok.code).toBe(0);
    expect(ok.outputs).toMatchObject({
      deploy: "true",
      action: "rollback",
      commit: C,
      from: NEWER,
    });
    expect(ok.summary).toContain(`## Roll back from ${NEWER} to ${V}`);
    expect(ok.summary).toContain(`**Host-side differences between ${V} and ${NEWER}**`);
    expect(ok.summary).toContain("- `ops/deploy.sh`");
    expect(ok.summary).toContain(`**Approving** rolls production back from ${NEWER} to ${V}`);
    for (const [what, inputs, between, reason] of [
      ["no 'from'", { version: V, rollback: true, from: "" }, [], "from"],
      ["a newer target", { version: V, rollback: true, from: "2.36.0" }, [], "rollback-not-older"],
      [
        "an added migration in between",
        { version: V, rollback: true, from: NEWER },
        [{ filename: "migrations/011_x.sql", status: "added" }],
        "rollback-across-migration",
      ],
      [
        "a migration renamed away in between",
        { version: V, rollback: true, from: NEWER },
        [
          {
            filename: "docs/011_x.sql",
            status: "renamed",
            previous_filename: "migrations/011_x.sql",
          },
        ],
        "rollback-across-migration",
      ],
    ] as const) {
      const refused = dispatch(inputs, { between: [...between] });
      expect({ what, code: refused.code, reason: refused.outputs.reason }).toEqual({
        what,
        code: 1,
        reason,
      });
    }
  });

  test("an automatic run asks for both targets, a dispatch for the one it names", () => {
    const merge = plan(source);
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({
      deploy: "true",
      production: "true",
      staging: "true",
      staging_action: "deploy",
    });
    expect(merge.summary).toContain(
      "**Targets:** production, once @deconfined approves it, and staging, which deploys at once beside the approval request, without one.",
    );
    expect(merge.summary).toContain(`**Approving** runs Deploy ${V}`);
    expect(merge.summary).toContain(
      `**Staging** takes ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) at once, beside the approval request and without one.`,
    );
    // Tested on staging before production's approval (#62, answer 6).
    expect(merge.summary).toContain(
      `**Tried on staging?** Check before approving. Staging deploys beside this request: its **Deploy staging** job shows how ${V} went there`,
    );
    const toProduction = dispatch({ version: V });
    expect(toProduction.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(toProduction.summary).not.toContain("**Staging**");
    expect(toProduction.summary).toContain(
      `**Tried on staging?** Check before approving: the **Deploy staging** job of ${V}'s automatic run shows how it went there`,
    );
    const staged = dispatch(toStaging);
    expect(staged.code).toBe(0);
    expect(staged.outputs).toMatchObject({
      deploy: "true",
      production: "false",
      staging: "true",
      staging_action: "deploy",
      notify: "false",
    });
    expect(staged.summary).toContain(
      "**Target:** staging, which deploys at once, without approval.",
    );
    expect(staged.summary).toContain(`**Staging** takes ${V}`);
    expect(staged.summary).toContain("at once, without approval.");
    // Nothing waits for approval, so the plan asks for none.
    expect(staged.summary).not.toMatch(/\*\*Approving\*\*|Tried on staging|Before approving/u);
  });

  test("production has a switch and staging none: with production's off, staging goes on", () => {
    // Production paused: an automatic run deploys staging alone, and says why.
    const merge = plan(source, productionOff);
    expect(merge.outputs).toMatchObject({
      notify: "false",
      deploy: "true",
      production: "false",
      production_reason: "paused",
      staging: "true",
    });
    expect(merge.summary).toContain("**Production is paused:** `DEPLOY_ENABLED` isn't true.");
    // A production dispatch while paused plans nothing and fails nothing. Notify hears of it only
    // when the switch reads as true to GitHub (which ignores case) but isn't exactly `true`, so
    // the owner learns why nothing asked for approval.
    for (const [value, notify] of [
      ["", "false"],
      ["false", "false"],
      ["True", "true"],
    ] as const) {
      const p = dispatch({ version: V }, { switches: { production: value } });
      expect({ value, code: p.code, outputs: p.outputs }).toEqual({
        value,
        code: 0,
        outputs: {
          notify,
          deploy: "false",
          reason: "paused",
          production: "false",
          staging: "false",
          production_reason: "paused",
        },
      });
      expect(p.summary).toContain("## Deploy: paused");
      expect(p.summary).toContain("Production's switch, `DEPLOY_ENABLED`, is off");
      expect(p.attestations).toEqual([]);
    }
    // Staging has no switch: a staging dispatch deploys whatever production's reads.
    for (const value of ["", "false", "true"]) {
      const p = dispatch(toStaging, { switches: { production: value } });
      expect({ value, code: p.code, staging: p.outputs.staging }).toEqual({
        value,
        code: 0,
        staging: "true",
      });
    }
    // `True` with an automatic run: staging goes ahead, and notify names the pause.
    const cased = plan(source, { switches: { production: "True" } });
    expect(cased.outputs).toMatchObject({
      notify: "true",
      deploy: "true",
      production: "false",
      production_reason: "paused",
      staging: "true",
    });
  });

  test("decides first whether notify reports the run, and keeps that through a failure", () => {
    // An automatic run and a production dispatch are reported; a staging dispatch isn't.
    expect(plan(source).outputs).toMatchObject({ notify: "true", production_reason: "-" });
    expect(plan(source, productionOff).outputs).toMatchObject({
      notify: "false",
      production_reason: "paused",
    });
    expect(dispatch({ version: V }).outputs.notify).toBe("true");
    expect(dispatch(toStaging).outputs.notify).toBe("false");
    // Written before anything can fail: an unattested image still reaches notify's message.
    const unattested = plan(source, { attestedFor: null });
    expect({ code: unattested.code, outputs: unattested.outputs }).toMatchObject({
      code: 1,
      outputs: { notify: "true", reason: "unattested" },
    });
    // A failed production gate is named, so notify says gate rather than paused.
    const weak = plan(source, { production: { ...production, can_admins_bypass: true } });
    expect(weak.outputs).toMatchObject({
      notify: "true",
      production: "false",
      production_reason: "gate",
    });
    // A quiet merge carries it too.
    expect(plan(docsOnly).outputs).toMatchObject({ notify: "true", production_reason: "-" });
  });

  test("a failed gate turns off only its own target, and with nothing left fails the plan", () => {
    const weak = { ...production, can_admins_bypass: true };
    // Production's gate failed: an automatic run still deploys staging, and says why.
    const merge = plan(source, { production: weak });
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({ deploy: "true", production: "false", staging: "true" });
    expect(merge.stdout).toContain(
      "::error::The production environment must require @deconfined alone (self-review allowed), refuse admin bypass and accept only main.",
    );
    expect(merge.summary).toContain("**Production is off in this run:**");
    expect(merge.summary).toContain(
      "**Target:** staging, which deploys at once, without approval.",
    );
    // A production dispatch has nothing left.
    const toProduction = dispatch({ version: V }, { production: weak });
    expect({ code: toProduction.code, reason: toProduction.outputs.reason }).toEqual({
      code: 1,
      reason: "gate",
    });
    // Staging's gate is its main-only branch policy (an environment a typo auto-created has none).
    for (const [what, overrides] of [
      ["no staging environment", { staging: null }],
      ["any branch", { staging: { ...staging, deployment_branch_policy: null } }],
      [
        "protected branches",
        {
          staging: {
            ...staging,
            deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
          },
        },
      ],
      [
        "another branch too",
        {
          stagingBranches: {
            branch_policies: [
              { name: "main", type: "branch" },
              { name: "dev", type: "branch" },
            ],
          },
        },
      ],
    ] as const) {
      const p = plan(source, overrides);
      expect({
        what,
        code: p.code,
        production: p.outputs.production,
        staging: p.outputs.staging,
      }).toEqual({ what, code: 0, production: "true", staging: "false" });
      expect(p.stdout).toContain("::error::The staging environment must accept only main.");
      expect(p.summary).toContain("**Staging is off in this run:**");
      for (const action of ["deploy", "configure"]) {
        const refused = dispatch({ ...toStaging, action }, overrides);
        expect({ what, action, code: refused.code, reason: refused.outputs.reason }).toEqual({
          what,
          action,
          code: 1,
          reason: "gate",
        });
      }
    }
    // A reviewer on staging is how the owner pauses it: the plan still asks for staging, and
    // GitHub holds its job for that reviewer.
    const paused = plan(source, {
      staging: {
        ...staging,
        protection_rules: [
          { type: "branch_policy" },
          { type: "required_reviewers", reviewers: [{ type: "User", reviewer: owner }] },
        ],
      },
    });
    expect(paused.outputs).toMatchObject({ production: "true", staging: "true" });
    expect(paused.stdout).not.toContain("::error::");
    // Notify's gate still fails every plan.
    const noNotify = plan(source, {
      ...productionOff,
      notifyEnvironment: { ...staging, deployment_branch_policy: null },
    });
    expect({ code: noNotify.code, reason: noNotify.outputs.reason }).toEqual({
      code: 1,
      reason: "gate",
    });
  });

  test("the action input is staging's: production takes deploy alone, and staging no rollback", () => {
    for (const action of ["bot", "configure", "preflight", "restart", ""]) {
      const p = dispatch({ version: V, action });
      expect({ action, code: p.code, reason: p.outputs.reason, deploy: p.outputs.deploy }).toEqual({
        action,
        code: 1,
        reason: "action",
        deploy: undefined,
      });
      expect(p.attestations).toEqual([]);
    }
    for (const action of ["restart", "", "deploy ", "Bot"]) {
      const p = dispatch({ ...toStaging, action });
      expect({ action, code: p.code, reason: p.outputs.reason }).toEqual({
        action,
        code: 1,
        reason: "action",
      });
    }
    // Staging goes back with action=bot and the older version, never with rollback or from.
    for (const inputs of [
      { rollback: true, from: NEWER },
      { rollback: true },
      { from: NEWER },
      { rollback: true, from: NEWER, action: "bot" },
    ]) {
      const p = dispatch({ ...toStaging, ...inputs });
      expect({ inputs, code: p.code, reason: p.outputs.reason }).toEqual({
        inputs,
        code: 1,
        reason: "staging-rollback",
      });
      expect(p.attestations).toEqual([]);
    }
  });

  test("a staging configure dispatch configures from main's head, with no release to check", () => {
    for (const version of [V, "9.9.9", "not-a-version"]) {
      const p = dispatch({ version, target: "staging", action: "configure" });
      expect({ version, code: p.code, outputs: p.outputs }).toEqual({
        version,
        code: 0,
        outputs: {
          notify: "false",
          staging_action: "configure",
          config_commit: CONFIG,
          production: "false",
          staging: "true",
          production_reason: "-",
          deploy: "true",
          reason: "-",
        },
      });
      // No image, provenance or runtime rule: there is no release.
      expect(p.attestations).toEqual([]);
      expect(p.summary).toBe(
        `## Configure staging\n\n**Staging** runs Configure at once, without approval: \`ops/ansible/site.yml\` at main's head ([\`${CONFIG.slice(0, 12)}\`](https://github.com/deconfined/tarubot/commit/${CONFIG})), as root on the staging host. The bot and its release don't change.\n\n`,
      );
    }
    // Without a commit of main to configure from, nothing goes on.
    for (const configCommit of ["", "main", CONFIG.toUpperCase()]) {
      const p = dispatch({ ...toStaging, action: "configure" }, { configCommit });
      expect({ configCommit, code: p.code, reason: p.outputs.reason }).toEqual({
        configCommit,
        code: 1,
        reason: "config-commit",
      });
    }
  });

  test("staging's deploy, bot and preflight each say what they do, and name the schema head", () => {
    const head = "`010_status_notices.sql`";
    const deployed = dispatch(toStaging);
    expect(deployed.outputs).toMatchObject({
      staging_action: "deploy",
      config_commit: CONFIG,
      schema_head: "010_status_notices.sql",
    });
    for (const part of [
      `**Staging** takes ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) at once, without approval.`,
      `\`migrate.js\` runs before the start, to the schema head ${head}.`,
      `It waits for healthy, then registers ${V}'s commands in the test guild.`,
      "While staging's environment holds no `DISCORD_TOKEN` and no bot runs there, a deploy only configures the host.",
    ])
      expect({ part, found: deployed.summary.includes(part) }).toEqual({ part, found: true });
    const bot = dispatch({ ...toStaging, action: "bot" });
    expect(bot.code).toBe(0);
    expect(bot.outputs).toMatchObject({
      staging: "true",
      staging_action: "bot",
      action: "deploy",
      commit: C,
      digest: D,
    });
    for (const part of [
      `**Staging** moves to ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) at once, without approval, without Configure: ${V}'s own \`ops/ansible/bot.yml\``,
      `to the schema head ${head}. It refuses before anything stops if a migration lies between the live release and ${V}.`,
    ])
      expect({ part, found: bot.summary.includes(part) }).toEqual({ part, found: true });
    expect(bot.summary).not.toContain("Configure runs");
    const preflight = dispatch({ ...toStaging, action: "preflight" });
    expect(preflight.code).toBe(0);
    expect(preflight.outputs.staging_action).toBe("preflight");
    for (const part of [
      `**Staging** preflights ${V}`,
      `runs \`migrate.js\` to the schema head ${head} and one backup, and starts no bot. It refuses a host where a bot unit exists.`,
    ])
      expect({ part, found: preflight.summary.includes(part) }).toEqual({ part, found: true });
  });

  test("staging takes 2.36.0 or later, the first release whose own bot.yml deploys it", () => {
    for (const release of ["2.36.0", V, "3.0.0"])
      for (const action of ["deploy", "bot", "preflight"]) {
        const p = dispatch({ version: release, target: "staging", action }, { release });
        expect({ release, action, code: p.code, staging: p.outputs.staging }).toEqual({
          release,
          action,
          code: 0,
          staging: "true",
        });
      }
    for (const release of ["2.35.0", "2.35.99", "1.99.99"]) {
      const p = dispatch({ version: release, target: "staging", action: "bot" }, { release });
      expect({
        release,
        code: p.code,
        reason: p.outputs.reason,
        staging: p.outputs.staging,
      }).toEqual({ release, code: 1, reason: "below-floor", staging: undefined });
      expect(p.stdout).toContain(
        `::error::${release} is older than 2.36.0, the first release whose ops/ansible/bot.yml deploys staging.`,
      );
    }
    // Beside production, an older release leaves staging out, and production goes on.
    const merge = plan(source, { release: "2.35.99" });
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(merge.stdout).toContain("::warning::2.35.99 is older than 2.36.0");
    expect(merge.summary).toContain("**Staging is off in this run:** 2.35.99 is older than 2.36.0");
    // Production has no such floor: its host checks its own.
    expect(dispatch({ version: "2.35.99" }, { release: "2.35.99" }).outputs.production).toBe(
      "true",
    );
  });

  test("warns about the Tuesday maintenance window and the daily backup by the clock", () => {
    const at = (now: string) => plan(source, { now }).summary;
    const maintenance = "weekly maintenance runs Tuesdays 19:00-23:00 UTC";
    const backup = "The daily backup runs around now";
    for (const now of ["2 1800", "2 1930", "2 2259"])
      expect({ now, s: at(now) }).toEqual({ now, s: expect.stringContaining(maintenance) });
    for (const now of ["2 1759", "2 2300", "3 2000", "1 1930"])
      expect({ now, s: at(now) }).toEqual({ now, s: expect.not.stringContaining(maintenance) });
    for (const now of ["4 0415", "2 0444"])
      expect({ now, s: at(now) }).toEqual({ now, s: expect.stringContaining(backup) });
    for (const now of ["4 0414", "4 0445", "4 1200"])
      expect({ now, s: at(now) }).toEqual({ now, s: expect.not.stringContaining(backup) });
  });

  test("an edited applied migration, another image behind the commit tag or a weak gate fails", () => {
    const edited = plan([{ filename: "migrations/001_init.sql", status: "modified" }]);
    expect(edited.code).toBe(1);
    expect(edited.outputs.reason).toBe("applied-migration-changed");
    const moved = plan(source, { shaDigest: `sha256:${"ef".repeat(32)}` });
    expect(moved.outputs.reason).toBe("digest-mismatch");
    // A moved tag is refused before gh is asked about the image.
    expect(moved.attestations).toEqual([]);
    for (const weak of [
      { ...production, can_admins_bypass: true },
      {
        ...production,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
          },
        ],
      },
      { ...production, protection_rules: [] },
      { ...production, deployment_branch_policy: null },
    ]) {
      // With staging's gate failing too, nothing is left.
      const p = plan(source, { production: weak, staging: null });
      expect({ code: p.code, reason: p.outputs.reason }).toEqual({ code: 1, reason: "gate" });
    }
  });
});

describe("the runtime-change rule", () => {
  const source = runOf("plan", "plan");
  const grab = (name: string) =>
    new RegExp(new RegExp(`${name}='([^']+)'`, "u").exec(source)?.[1] ?? "^$", "u");
  const nonRuntime = grab("NON_RUNTIME");
  const alwaysRuntime = grab("ALWAYS_RUNTIME");
  const hostSide = grab("HOST_SIDE");
  const runtime = (path: string) => alwaysRuntime.test(path) || !nonRuntime.test(path);

  test("sorts paths into what runs on a host and what doesn't", () => {
    const table: [string, boolean][] = [
      ["docs/HOSTING.md", false],
      ["site/src/content/docs/index.md", false],
      ["tests/unit/deploy-script.test.ts", false],
      ["test-plans/current.json", false],
      ["CHANGELOG.md", false],
      ["README.md", false],
      [".github/workflows/ci.yml", false],
      [".github/workflows/deploy.yml", false],
      [".github/workflows/host.yml", false],
      [".github/workflows/infra.yml", false],
      [".github/CODEOWNERS", false],
      ["docker-compose.yml", false],
      ["docker-compose.devbot.yml", false],
      ["docker-compose.build.yml", false],
      ["docker-compose.tools.yml", false],
      [".env.example", false],
      ["production.env.example", false],
      ["staging.env.example", false],
      // OpenTofu reaches the hosts only through the Infrastructure workflow (2.36.0).
      ["ops/tofu/main.tf", false],
      ["ops/tofu/cloud-init.yaml.tftpl", false],
      ["ops/tofu/.terraform.lock.hcl", false],
      ["ops/tofu/README.md", false],
      // ansible-lint's pins feed only CI; requirements.txt is staging's Ansible (2.36.0).
      ["ops/ansible/requirements-lint.txt", false],
      ["ops/ansible/requirements.txt", true],
      ["ops/ansible/site.yml", true],
      ["ops/ansible/bot.yml", true],
      ["ops/ansible/vars/targets/staging.yml", true],
      ["ops/ansible/templates/bot/tarubot.container.j2", true],
      ["ops/ansible/files/bot/tarubot-tool", true],
      ["ops/tofus/main.tf", true],
      ["biome.json", false],
      [".github/workflows/publish.yml", true],
      ["src/main.ts", true],
      ["scripts/migrate.ts", true],
      ["migrations/011_x.sql", true],
      ["ops/deploy.sh", true],
      ["ops/backup.sh", true],
      ["docker-compose.production.yml", true],
      ["Dockerfile", true],
      [".dockerignore", true],
      ["bun.lock", true],
      ["bunfig.toml", true],
      ["tsconfig.json", true],
      ["tsconfig.build.json", true],
      ["package.json", true],
      ["src/docs/notes.md", true],
      ["docs.ts", true],
    ];
    for (const [path, expected] of table)
      expect({ path, runtime: runtime(path) }).toEqual({ path, runtime: expected });
  });

  test("lists what runs on a host, or shapes one, as host-side", () => {
    for (const [path, expected] of [
      ["ops/deploy.sh", true],
      ["ops/ansible/site.yml", true],
      ["ops/ansible/bot.yml", true],
      ["ops/tofu/main.tf", true],
      ["docker-compose.production.yml", true],
      ["production.env.example", true],
      ["staging.env.example", true],
      [".env.example", false],
      ["docker-compose.yml", false],
      ["src/main.ts", false],
      ["docs/ops/notes.md", false],
      [".github/workflows/host.yml", false],
    ] as const)
      expect({ path, host: hostSide.test(path) }).toEqual({ path, host: expected });
  });
});

describe("the agent rule", () => {
  test("AGENTS.md carries REQUIREMENTS.md's wording verbatim, every part confirmed", () => {
    // The rule is the blockquote in "Approved SSH-deploy amendments (2026-09-26)": the owner's
    // answer to question 1, then the clauses PR #44 proposed, which @deconfined confirmed on
    // 2026-09-26 in a comment on #41.
    const requirements = read("REQUIREMENTS.md");
    const confirmed =
      /\n> (Confirmed \(question 1\): [^\n]+)\n/u.exec(requirements)?.[1] ?? "no confirmed part";
    const clauses =
      /\n> (Confirmed by @deconfined on 2026-09-26 \(\[#41\]\(https:\/\/github\.com\/deconfined\/tarubot\/issues\/41#issuecomment-5846407419\)\): [^\n]+)\n/u.exec(
        requirements,
      )?.[1] ?? "no confirmed clauses";
    for (const clause of [
      "the owner's approval of the `production` environment in GitHub is the go-ahead",
      "a chat go-ahead doesn't replace it",
      "Claude sessions never approve a deployment",
      "a deploy by hand still needs the owner's explicit go-ahead",
      "provider, token, key, firewall and account changes stay separate owner steps",
    ])
      expect({ clause, confirmed: confirmed.includes(clause) }).toEqual({
        clause,
        confirmed: true,
      });
    // No clause was dropped when the proposal became the owner's decision.
    for (const clause of [
      "never approve, reject or bypass a deployment",
      "never create, read or hold the deploy key",
      "never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`",
      "never enable, disable, cancel or re-run the Deploy production workflow",
      "dispatch it only when the owner asks in that session",
    ])
      expect({ clause, confirmed: clauses.includes(clause) }).toEqual({ clause, confirmed: true });
    const agents = read("AGENTS.md");
    expect(agents).toContain(`- ${confirmed}\n`);
    expect(agents).toContain(`- ${clauses}\n`);
    // Nothing still calls any part of it pending: not the rule itself, and not the text in the
    // files that point to it, each of which says it was confirmed.
    expect({ confirmed: PENDING.test(confirmed), clauses: PENDING.test(clauses) }).toEqual({
      confirmed: false,
      clauses: false,
    });
    for (const file of [
      "REQUIREMENTS.md",
      "AGENTS.md",
      "CLAUDE.md",
      "docs/CI_CD.md",
      "docs/HOSTING.md",
    ]) {
      const units = agentRuleUnits(read(file));
      expect({ file, points: units.length > 0 }).toEqual({ file, points: true });
      for (const unit of units) {
        // The unit's first words name it in a failure.
        const at = unit.slice(0, 80);
        expect({
          file,
          at,
          pending: PENDING.test(unit),
          confirmed: CONFIRMATION.test(unit),
        }).toEqual({ file, at, pending: false, confirmed: true });
      }
    }
  });

  test("the unit reader keeps each mention to its own paragraph, list item or table row", () => {
    const text = [
      "# The agent rule",
      "",
      "A paragraph that names the agent rule,",
      "over two lines:",
      "",
      "- A deny rule for the pending-deployments endpoint.",
      "- The agent rule, with its parts:",
      "  - Confirmed on 2026-09-26.",
      "- Another item.",
      "",
      "| Rule | State |",
      "| agent rule | confirmed |",
      "| other | pending |",
    ].join("\n");
    expect(agentRuleUnits(text)).toEqual([
      "# The agent rule",
      "A paragraph that names the agent rule,\nover two lines:",
      "- The agent rule, with its parts:\n  - Confirmed on 2026-09-26.",
      "| agent rule | confirmed |",
    ]);
  });
});

/**
 * Words that call the agent rule unconfirmed. `\b` keeps `pending_deployments`, the REST endpoint
 * CLAUDE.md names beside the rule, from counting.
 */
const PENDING = /\bpending\b|\bin the meantime\b/iu;
/**
 * The owner's confirmation: the link to the #41 comment, or "confirmed" and 2026-09-26 in one
 * sentence. The date alone is not enough, because it is also in the amendment's heading, "Approved
 * SSH-deploy amendments (2026-09-26)", which every pointer names.
 */
const CONFIRMATION = /issuecomment-5846407419|confirmed[^.]*2026-09-26/iu;

/**
 * The Markdown units of a file that mention the agent rule (any case). A unit is a paragraph, a
 * top-level list item with its indented continuation lines and nested items, a table row, or a
 * heading. A blank line, a heading, a table row or a new top-level list item ends the unit before
 * it, so text beside the rule, such as CI_CD.md's deny rules for the pending-deployments endpoint,
 * is never tested with it.
 */
function agentRuleUnits(text: string): string[] {
  const units: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      current = null;
      continue;
    }
    const indented = /^\s/u.test(line);
    const single = !indented && (line.startsWith("|") || line.startsWith("#"));
    const item = !indented && /^(?:[-*+]|\d+\.)\s/u.test(line);
    if (current === null || single || item) {
      current = [];
      units.push(current);
    }
    current.push(line);
    // A table row or a heading is a unit of its own line.
    if (single) current = null;
  }
  return units.map((unit) => unit.join("\n")).filter((unit) => /agent rule/iu.test(unit));
}
