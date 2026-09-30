/**
 * The "Deploy" workflow (.github/workflows/deploy.yml): since 2.37.0 the one entry point to the
 * hosts and the infrastructure (REQUIREMENTS.md "Approved unified-pipeline amendments
 * (2026-09-29)"), built on the Compose production job (2.30.0, issue #41), the provenance check
 * (2.33.0) and staging's host job (2.36.0, issue #62). host.yml's own job is
 * tests/unit/host-workflow.test.ts's, and publish.yml's tests/unit/publish-workflow.test.ts's.
 *
 * - Shape: the two triggers and the eight inputs, the first-attempt rule on every job, the job
 *   order and graph (staging never needs prod, Report never needs staging), exact permissions per
 *   job, no workflow-level concurrency, no action but the Infrastructure plan job's checkout and
 *   upload, every ${{ }} through env:, and the run's title. The jobs' `if` expressions, the title
 *   and the host.yml calls' inputs are evaluated with a small reader of GitHub's expression syntax,
 *   with GitHub's implicit success(), so each job runs exactly when it should.
 * - The Infrastructure plan job (infra.yml's Plan job until 2.37.0): from main only, first attempt,
 *   `infra-plan` and its read-only secrets, one tofu-ci.sh phase per step, host.sh status, and only
 *   the encrypted saved plan leaving the job, for one day, only with changes or keys to pin.
 * - Which workflow, job and step may name each environment, secret and variable, literal names and
 *   names inside expressions alike: the Compose host's in the Deploy job alone, infra-plan's in the
 *   Infrastructure plan job alone, the hosts' in host.yml alone, TOFU_VARS never in host.yml, the
 *   write tokens only in host.yml's apply step, and the state write key only where OpenTofu runs or
 *   where the connect step picks it by `inputs.environment == 'prod'`.
 * - The Compose path stays byte-identical until 2.38.0: the Deploy and Notify jobs' text,
 *   ops/deploy.sh, ops/backup.sh, the Compose file, its settings template and the .env backup tool
 *   are pinned by SHA-256, with the command contract and the titles ops/deploy.sh requires.
 * - The repository names no host.
 * - Behavior: the plan, SSH, Notify and Report scripts run here with simulated gh, docker, ssh,
 *   curl and date (tests/fixtures/deploy-workflow): DEPLOY_ENABLED's choice of production's path,
 *   the target and action matrix (what plans and what doesn't), the pin scope, the floors, the
 *   refusals, no environment read (no gate), the image's provenance by its exact identity, the
 *   runtime-change rule, the compare API's 300-file cap, rollbacks, the summaries written before
 *   any approval, the clock warnings, the SSH retry rules and every message.
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
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
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
    env: z.record(z.string(), z.string()).optional(),
    outputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(step),
  })
  .strict();
/** A job that calls host.yml: it has no runner, environment or steps of its own. */
const call = z
  .object({
    name: z.string(),
    needs: z.array(z.string()),
    if: z.string(),
    permissions: z.record(z.string(), z.string()),
    uses: z.literal("./.github/workflows/host.yml"),
    with: z.record(z.string(), z.union([z.string(), z.boolean()])),
    secrets: z.literal("inherit"),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Deploy"),
    "run-name": z.string(),
    on: z
      .object({
        workflow_run: z
          .object({
            workflows: z.array(z.string()),
            types: z.array(z.string()),
            branches: z.array(z.string()),
          })
          .strict(),
        workflow_dispatch: z
          .object({
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
          })
          .strict(),
      })
      .strict(),
    permissions: z.record(z.string(), z.string()),
    defaults: z.object({ run: z.object({ shell: z.literal("bash") }) }),
    jobs: z
      .object({
        plan: job,
        "infra-plan": job,
        infra: call,
        staging: call,
        prod: call,
        report: job,
        deploy: job,
        notify: job,
      })
      .strict(),
  })
  .strict();

const text = read(".github/workflows/deploy.yml");
const deploy = workflow.parse(YAML.parse(text));
const script = read("ops/deploy.sh");
/** host.yml, which the Infrastructure, Staging and Prod jobs call. */
const hostText = read(".github/workflows/host.yml");
const host = YAML.parse(hostText) as {
  on: {
    workflow_call: {
      inputs: Record<string, { required?: boolean; type: string; default?: string | boolean }>;
      outputs: Record<string, unknown>;
    };
  };
  jobs: {
    host: {
      steps: {
        id?: string;
        name: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
      }[];
    };
  };
};
type JobName = keyof typeof deploy.jobs;
/** The jobs with steps of their own. */
type StepJob = "plan" | "infra-plan" | "report" | "deploy" | "notify";
/** The three calls of host.yml. */
const CALLS = ["infra", "staging", "prod"] as const;
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
/** A job's `needs`, always as a list. */
const needsOf = (name: JobName) => {
  const needs = deploy.jobs[name].needs;
  return needs === undefined ? [] : typeof needs === "string" ? [needs] : needs;
};
/** An expression's text with its whitespace collapsed, as GitHub reads a folded scalar. */
const flat = (value: string) => value.replace(/\s+/gu, " ").trim();

// ---------------------------------------------------------------------------------------------
// GitHub's expression syntax, as far as deploy.yml uses it
// ---------------------------------------------------------------------------------------------

/**
 * Evaluate one GitHub Actions expression against a context. It covers what deploy.yml uses:
 * dotted context paths (missing ones are null; hyphens allowed, as in needs.infra-plan), string and
 * number literals, true, false, null, `!`, `==`, `!=`, `&&`, `||`, parentheses, format(),
 * always() and cancelled() (the context's __cancelled). As in GitHub, `&&` and `||` return an
 * operand rather than a boolean, strings compare without regard to case, and null, false, 0, NaN
 * and '' are falsy. Anything else throws, so an expression this reader doesn't understand fails
 * the test rather than passing it.
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
    if (name === "cancelled" && args.length === 0) return context.__cancelled === true;
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

/**
 * What a scenario sets: the event, a dispatch's inputs, the switch, whether the run was cancelled,
 * and the results of the jobs before the one under test. A key in `plan` other than `result`
 * replaces that output of the plan (null leaves it unset, as a plan that never ran its step).
 */
interface Scenario {
  readonly event?: "workflow_run" | "workflow_dispatch";
  readonly target?: string;
  readonly action?: string;
  readonly rebuild?: boolean;
  readonly rollback?: boolean;
  readonly version?: string;
  readonly from?: string;
  readonly attempt?: string;
  readonly cancelled?: boolean;
  /** Production's switch, DEPLOY_ENABLED ("true" by default). */
  readonly switches?: { readonly production?: string };
  readonly plan?: { readonly result?: string } & Readonly<
    Record<string, string | null | undefined>
  >;
  /** The Infrastructure plan job: skipped unless the plan asked for it, then success by default. */
  readonly infraPlan?: {
    readonly result?: string;
    readonly has_changes?: string;
    readonly pins_needed?: string;
  };
  readonly infra?: { readonly result?: string };
  readonly prod?: { readonly result?: string };
}

/** The dispatch's inputs as GitHub hands them over, the input defaults filled in. */
const inputsOf = (s: Scenario) => ({
  version: s.version ?? "2.37.1",
  target: s.target ?? "staging",
  action: s.action ?? "deploy",
  rebuild: s.rebuild ?? false,
  allow_destroy: false,
  allow_access_removal: false,
  rollback: s.rollback ?? false,
  from: s.from ?? "",
});

/**
 * The target outputs the plan writes for `scenario`'s request (interfaces: target rules): an
 * automatic run deploys staging and asks for the Compose host while DEPLOY_ENABLED is exactly
 * `true`, the prod host otherwise; a dispatch asks for its target, and plans for action=infra, a
 * staging rebuild and every prod action but bot.
 */
function planOf(s: Scenario): Record<string, string> {
  const on = s.switches?.production ?? "true";
  if ((s.event ?? "workflow_run") === "workflow_run") {
    const compose = on === "true";
    return {
      production: String(compose),
      staging: "true",
      prod: String(!compose),
      infra: String(!compose),
      rebuild: "",
    };
  }
  const { target, action, rebuild } = inputsOf(s);
  return {
    production: String(target === "production" && on === "true"),
    staging: String(target === "staging" && action !== "infra"),
    prod: String(target === "prod" && action !== "infra"),
    infra: String(
      action === "infra" ||
        (target === "prod" && action !== "bot") ||
        (target === "staging" && rebuild),
    ),
    rebuild: rebuild ? target : "",
  };
}

/**
 * The plan's notify output, as its first lines decide it: the Compose host's requests, an
 * automatic run while DEPLOY_ENABLED is exactly `true` and a production dispatch while it reads as
 * true without regard to case.
 */
function notifyOf(s: Scenario): string {
  const on = s.switches?.production ?? "true";
  if ((s.event ?? "workflow_run") === "workflow_run") return String(on === "true");
  return String(inputsOf(s).target === "production" && on.toLowerCase() === "true");
}

/** The plan's report output: the new path's requests. */
function reportOf(s: Scenario): string {
  const on = s.switches?.production ?? "true";
  if ((s.event ?? "workflow_run") === "workflow_run") return String(on !== "true");
  const { target, action, rebuild } = inputsOf(s);
  return String(target === "prod" || action === "infra" || (target === "staging" && rebuild));
}

/** The expression context GitHub gives a run of deploy.yml in `scenario`. */
function contextOf(s: Scenario): Record<string, unknown> {
  const event = s.event ?? "workflow_run";
  const outputs: Record<string, string> = {
    // The release fields a plan of a release writes (the calls pass them on).
    version: "2.37.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    digest: `sha256:${"cd".repeat(32)}`,
    config_commit: "89abcdef0123456789abcdef0123456789abcdef",
    host_action: (s.event ?? "workflow_run") === "workflow_run" ? "deploy" : inputsOf(s).action,
    ...planOf(s),
    notify: notifyOf(s),
    report: reportOf(s),
  };
  for (const [key, value] of Object.entries(s.plan ?? {})) {
    if (key === "result") continue;
    if (value === null) delete outputs[key];
    else if (value !== undefined) outputs[key] = value;
  }
  const planResult = s.plan?.result ?? "success";
  const infraPlanResult =
    s.infraPlan?.result ??
    (planResult === "success" && outputs.infra === "true" && !s.cancelled ? "success" : "skipped");
  return {
    __cancelled: s.cancelled ?? false,
    github: {
      run_attempt: s.attempt ?? "1",
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
    inputs: event === "workflow_dispatch" ? inputsOf(s) : {},
    vars: { DEPLOY_ENABLED: s.switches?.production ?? "true" },
    needs: {
      plan: { result: planResult, outputs },
      "infra-plan": {
        result: infraPlanResult,
        outputs:
          infraPlanResult === "skipped"
            ? {}
            : {
                has_changes: s.infraPlan?.has_changes ?? "true",
                pins_needed: s.infraPlan?.pins_needed ?? "",
                digest: "ab".repeat(32),
                changes: 'update linode_instance.host["prod"]',
              },
      },
      infra: { result: s.infra?.result ?? "success" },
      prod: { result: s.prod?.result ?? "success" },
      deploy: { result: "success" },
    },
  };
}

/** A status function in a job's `if`: without one, GitHub adds success(). */
const STATUS = /\b(?:always|cancelled|success|failure)\(\)/u;

/**
 * Whether `jobName` runs in `scenario`, as GitHub decides it: an `if` without a status function
 * runs only when the run isn't cancelled and every job it needs succeeded.
 */
function runs(jobName: JobName, scenario: Scenario) {
  const context = contextOf(scenario);
  const condition = deploy.jobs[jobName].if;
  if (!STATUS.test(condition)) {
    if (scenario.cancelled) return false;
    const results = context.needs as Record<string, { result: string }>;
    if (!needsOf(jobName).every((name) => results[name]?.result === "success")) return false;
  }
  return evaluate(condition, context) === true;
}

describe("the expression reader", () => {
  test("follows GitHub's rules for the operators deploy.yml uses", () => {
    const context = { a: { b: "X", "c-d": "y" }, t: true, f: false, s: "", n: null };
    expect(evaluate("a.b == 'x'", context)).toBe(true);
    expect(evaluate("a.c-d == 'Y'", context)).toBe(true);
    expect(evaluate("a.missing", context)).toBeNull();
    expect(evaluate("t && 'yes' || 'no'", context)).toBe("yes");
    expect(evaluate("f && 'yes' || 'no'", context)).toBe("no");
    expect(evaluate("s || n || 'last'", context)).toBe("last");
    expect(evaluate("!(t && f) && a.b != 'y'", context)).toBe(true);
    expect(evaluate("format('{0}-{1}{2}', 'a', n, 'c')", context)).toBe("a-c");
    expect(evaluate("'1' == 1 && always()", context)).toBe(true);
    expect(evaluate("!cancelled()", context)).toBe(true);
    expect(evaluate("!cancelled()", { ...context, __cancelled: true })).toBe(false);
    // A boolean against a string compares as numbers, so `true == 'true'` is false in GitHub.
    expect(evaluate("t == 'true'", context)).toBe(false);
    expect(() => evaluate("contains(a.b, 'x')", context)).toThrow();
    expect(() => evaluate("a.b ==", context)).toThrow();
  });
});

describe("the workflow's shape", () => {
  test("runs after a successful publish of main, or by hand from main, with eight inputs", () => {
    const publish = z
      .object({ name: z.string() })
      .passthrough()
      .parse(YAML.parse(read(".github/workflows/publish.yml")));
    expect(deploy.on.workflow_run).toEqual({
      workflows: [publish.name],
      types: ["completed"],
      branches: ["main"],
    });
    const inputs = deploy.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual([
      "version",
      "target",
      "action",
      "rebuild",
      "allow_destroy",
      "allow_access_removal",
      "rollback",
      "from",
    ]);
    expect(inputs).toEqual({
      version: expect.objectContaining({ required: true, type: "string" }),
      target: expect.objectContaining({
        type: "choice",
        options: ["staging", "prod", "production"],
        default: "staging",
      }),
      action: expect.objectContaining({
        type: "choice",
        options: ["deploy", "bot", "configure", "preflight", "infra"],
        default: "deploy",
      }),
      rebuild: expect.objectContaining({ type: "boolean", default: false }),
      allow_destroy: expect.objectContaining({ type: "boolean", default: false }),
      allow_access_removal: expect.objectContaining({ type: "boolean", default: false }),
      rollback: expect.objectContaining({ type: "boolean", default: false }),
      from: expect.objectContaining({ type: "string", default: "" }),
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
    // No switch holds the plan back: production's path is chosen inside it.
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
      for (const scenario of [
        { attempt: "2" },
        { attempt: "2", switches: { production: "" } },
        { attempt: "2", event: "workflow_dispatch", target: "prod" },
        { attempt: "2", event: "workflow_dispatch", action: "infra" },
      ] as Scenario[])
        expect({ name, scenario, second: runs(name, scenario) }).toEqual({
          name,
          scenario,
          second: false,
        });
    // host.yml's job refuses them too, and runs from main only.
    expect(hostText).toContain(
      "\n    if: github.run_attempt == '1' && github.ref == 'refs/heads/main'\n",
    );
  });

  test("keeps the jobs in order, with the Compose jobs last, and each needs only what it reads", () => {
    expect(Object.keys(deploy.jobs)).toEqual([
      "plan",
      "infra-plan",
      "infra",
      "staging",
      "prod",
      "report",
      "deploy",
      "notify",
    ]);
    expect(
      Object.fromEntries(Object.keys(deploy.jobs).map((n) => [n, needsOf(n as JobName)])),
    ).toEqual({
      plan: [],
      "infra-plan": ["plan"],
      infra: ["plan", "infra-plan"],
      staging: ["plan", "infra-plan", "infra"],
      prod: ["plan", "infra-plan"],
      report: ["plan", "infra-plan", "infra", "prod"],
      deploy: ["plan"],
      notify: ["plan", "deploy"],
    });
    // Staging never waits for prod or its approval, prod never for staging, and the message about
    // prod and the infrastructure never for staging.
    expect(needsOf("staging")).not.toContain("prod");
    expect(needsOf("prod")).not.toContain("staging");
    expect(needsOf("report")).not.toContain("staging");
    expect(needsOf("deploy")).not.toContain("staging");
    // The job names the approval list shows, and the Compose host looks for.
    expect(Object.fromEntries(Object.entries(deploy.jobs).map(([k, j]) => [k, j.name]))).toEqual({
      plan: "Plan",
      "infra-plan": "Infrastructure plan",
      infra: "Infrastructure",
      staging: "Staging",
      prod: "Prod",
      report: "Report",
      deploy: "Deploy",
      notify: "Notify",
    });
  });

  test("the Compose host's Deploy job runs only for production, when the plan says so", () => {
    expect(deploy.jobs.deploy.if).toBe(
      "github.run_attempt == '1' && needs.plan.outputs.production == 'true' && (github.event_name == 'workflow_run' || inputs.target == 'production')",
    );
    const table: [Scenario, boolean][] = [
      [{}, true],
      [{ switches: { production: "" } }, false],
      [{ switches: { production: "True" } }, false],
      [{ event: "workflow_dispatch", target: "production" }, true],
      [{ event: "workflow_dispatch", target: "production", switches: { production: "" } }, false],
      [{ event: "workflow_dispatch", target: "prod" }, false],
      [{ event: "workflow_dispatch", target: "staging" }, false],
      // Even a plan that said yes deploys only the target a dispatch names.
      [{ event: "workflow_dispatch", target: "prod", plan: { production: "true" } }, false],
      [{ plan: { result: "failure" } }, false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("deploy", scenario) }).toEqual({ scenario, runs: expected });
  });

  test("the Infrastructure plan runs only for a request that plans", () => {
    expect(deploy.jobs["infra-plan"].if).toBe(
      "github.run_attempt == '1' && github.ref == 'refs/heads/main' && needs.plan.outputs.infra == 'true'",
    );
    const dispatch = (target: string, action: string, rebuild = false): Scenario => ({
      event: "workflow_dispatch",
      target,
      action,
      rebuild,
    });
    const table: [Scenario, boolean][] = [
      // An automatic run plans only when it asks for prod.
      [{}, false],
      [{ switches: { production: "" } }, true],
      // Staging's deploy, bot, configure and preflight never plan; a rebuild and infra do.
      ...(["deploy", "bot", "configure", "preflight"].map((a) => [
        dispatch("staging", a),
        false,
      ]) as [Scenario, boolean][]),
      [dispatch("staging", "deploy", true), true],
      [dispatch("staging", "configure", true), true],
      [dispatch("staging", "infra"), true],
      // Prod's bot, the rollback lever, never plans; every other prod action does.
      [dispatch("prod", "bot"), false],
      ...(["deploy", "configure", "preflight", "infra"].map((a) => [dispatch("prod", a), true]) as [
        Scenario,
        boolean,
      ][]),
      [dispatch("production", "deploy"), false],
      [{ switches: { production: "" }, plan: { result: "failure" } }, false],
      [{ switches: { production: "" }, cancelled: true }, false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("infra-plan", scenario) }).toEqual({
        scenario,
        runs: expected,
      });
  });

  test("the Infrastructure job runs for a plan without a Prod job, only with changes or keys to pin", () => {
    expect(flat(deploy.jobs.infra.if)).toBe(
      "github.run_attempt == '1' && needs.plan.outputs.infra == 'true' && needs.plan.outputs.prod != 'true' && needs.infra-plan.result == 'success' && (needs.infra-plan.outputs.has_changes == 'true' || needs.infra-plan.outputs.pins_needed != '')",
    );
    const infra: Scenario = { event: "workflow_dispatch", target: "staging", action: "infra" };
    const rebuild: Scenario = { event: "workflow_dispatch", target: "staging", rebuild: true };
    const table: [Scenario, boolean][] = [
      [infra, true],
      [{ ...infra, target: "prod" }, true],
      [{ ...infra, infraPlan: { has_changes: "false", pins_needed: "" } }, false],
      [{ ...infra, infraPlan: { has_changes: "false", pins_needed: "staging" } }, true],
      [{ ...infra, infraPlan: { result: "failure" } }, false],
      [{ ...infra, cancelled: true }, false],
      [rebuild, true],
      // A prod request applies in its own Prod job.
      [{ event: "workflow_dispatch", target: "prod", action: "deploy" }, false],
      [{ switches: { production: "" } }, false],
      [{ event: "workflow_dispatch", target: "staging" }, false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("infra", scenario) }).toEqual({ scenario, runs: expected });
  });

  test("staging runs whenever it is asked for, waits only for its own rebuild, and never for prod", () => {
    expect(flat(deploy.jobs.staging.if)).toBe(
      "github.run_attempt == '1' && !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.staging == 'true' && (needs.plan.outputs.rebuild != 'staging' || (needs.infra-plan.result == 'success' && (needs.infra.result == 'success' || needs.infra.result == 'skipped')))",
    );
    const rebuild: Scenario = { event: "workflow_dispatch", target: "staging", rebuild: true };
    const table: [Scenario, boolean][] = [
      [{}, true],
      [{ switches: { production: "" } }, true],
      // prod's Infrastructure plan failing (an expired read-only token) never stops staging.
      [{ switches: { production: "" }, infraPlan: { result: "failure" } }, true],
      [{ switches: { production: "" }, prod: { result: "failure" } }, true],
      ...(["deploy", "bot", "configure", "preflight"].map((action) => [
        { event: "workflow_dispatch", target: "staging", action },
        true,
      ]) as [Scenario, boolean][]),
      [{ event: "workflow_dispatch", target: "staging", action: "infra" }, false],
      [{ event: "workflow_dispatch", target: "prod" }, false],
      [{ event: "workflow_dispatch", target: "production" }, false],
      [rebuild, true],
      [{ ...rebuild, infra: { result: "failure" } }, false],
      [{ ...rebuild, infra: { result: "cancelled" } }, false],
      [{ ...rebuild, infraPlan: { result: "failure" } }, false],
      [{ ...rebuild, infra: { result: "skipped" } }, true],
      [{ plan: { result: "failure" } }, false],
      [{ cancelled: true }, false],
      [{ event: "workflow_dispatch", target: "staging", cancelled: true }, false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("staging", scenario) }).toEqual({ scenario, runs: expected });
  });

  test("prod runs when it is asked for and its plan, if it has one, succeeded", () => {
    expect(flat(deploy.jobs.prod.if)).toBe(
      "github.run_attempt == '1' && !cancelled() && needs.plan.result == 'success' && needs.plan.outputs.prod == 'true' && (needs.infra-plan.result == 'success' || (needs.infra-plan.result == 'skipped' && needs.plan.outputs.infra != 'true'))",
    );
    const prod = (action: string, extra: Partial<Scenario> = {}): Scenario => ({
      event: "workflow_dispatch",
      target: "prod",
      action,
      ...extra,
    });
    const table: [Scenario, boolean][] = [
      [{ switches: { production: "" } }, true],
      [{ switches: { production: "" }, infraPlan: { result: "failure" } }, false],
      [{}, false],
      // action=bot never plans, so it never waits for a plan.
      [prod("bot"), true],
      ...(["deploy", "configure", "preflight"].map((a) => [prod(a), true]) as [
        Scenario,
        boolean,
      ][]),
      [prod("deploy", { infraPlan: { result: "failure" } }), false],
      [prod("deploy", { infraPlan: { result: "skipped" } }), false],
      [prod("deploy", { infraPlan: { has_changes: "false", pins_needed: "" } }), true],
      [prod("infra"), false],
      [prod("deploy", { plan: { result: "failure" } }), false],
      [prod("deploy", { cancelled: true }), false],
      [{ event: "workflow_dispatch", target: "staging" }, false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("prod", scenario) }).toEqual({ scenario, runs: expected });
  });

  test("Report pages the new path's requests, as the plan decided when the run planned", () => {
    expect(flat(deploy.jobs.report.if)).toBe(
      "github.run_attempt == '1' && always() && needs.plan.result != 'skipped' && ( needs.plan.outputs.report == 'true' || (needs.plan.outputs.report == '' && ( (github.event_name == 'workflow_run' && vars.DEPLOY_ENABLED != 'true') || (github.event_name == 'workflow_dispatch' && (inputs.target == 'prod' || inputs.action == 'infra')))))",
    );
    const dispatch = (extra: Partial<Scenario>): Scenario => ({
      event: "workflow_dispatch",
      ...extra,
    });
    const table: [Scenario, boolean][] = [
      [{}, false],
      [{ switches: { production: "" } }, true],
      [dispatch({ target: "prod" }), true],
      [dispatch({ target: "prod", action: "bot" }), true],
      [dispatch({ target: "staging" }), false],
      [dispatch({ target: "staging", action: "infra" }), true],
      [dispatch({ target: "staging", rebuild: true }), true],
      [dispatch({ target: "production" }), false],
      [{ plan: { result: "skipped" } }, false],
      // A failed or cancelled run still pages.
      [{ switches: { production: "" }, plan: { result: "failure" } }, true],
      [{ switches: { production: "" }, cancelled: true }, true],
      // A plan that never wrote its output: the request decides.
      [{ switches: { production: "" }, plan: { result: "failure", report: null } }, true],
      [{ plan: { result: "failure", report: null } }, false],
      [dispatch({ target: "prod", plan: { result: "failure", report: null } }), true],
      [dispatch({ action: "infra", plan: { result: "failure", report: null } }), true],
      [dispatch({ target: "staging", plan: { result: "failure", report: null } }), false],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, runs: runs("report", scenario) }).toEqual({ scenario, runs: expected });
  });

  test("Notify still pages the Compose host alone, as the plan decided when the run planned", () => {
    expect(flat(deploy.jobs.notify.if)).toBe(
      "github.run_attempt == '1' && always() && needs.plan.result != 'skipped' && ( needs.plan.outputs.notify == 'true' || (needs.plan.outputs.notify == '' && vars.DEPLOY_ENABLED == 'true' && (github.event_name == 'workflow_run' || inputs.target != 'staging')))",
    );
    expect(needsOf("notify")).toEqual(["plan", "deploy"]);
    const table: [Scenario, boolean][] = [
      [{}, true],
      [{ plan: { result: "failure" } }, true],
      [{ plan: { result: "skipped" } }, false],
      [{ event: "workflow_dispatch", target: "production" }, true],
      [{ event: "workflow_dispatch", target: "staging" }, false],
      // Every new-path request writes notify=false.
      [{ event: "workflow_dispatch", target: "prod" }, false],
      [{ event: "workflow_dispatch", target: "staging", action: "infra" }, false],
      [{ switches: { production: "" } }, false],
      // An automatic run with `True` asks for prod now, which Report pages.
      [{ switches: { production: "True" } }, false],
      // A production dispatch with `True` is paused, and reported as such, as in 2.35.0.
      [
        { event: "workflow_dispatch", target: "production", switches: { production: "True" } },
        true,
      ],
      // Production was on when the run planned and is off now: the outcome is still reported.
      [{ switches: { production: "" }, plan: { notify: "true" } }, true],
      [{ plan: { notify: "false" } }, false],
      // A plan whose step never ran wrote no output: the switch as it reads now decides. A prod
      // dispatch then reaches Notify too, as the byte-identical job reads it (Report pages it).
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

  test("titles each run: the Compose titles unchanged, the new targets named with their action and a rebuild", () => {
    const title = deploy["run-name"];
    const titleOf = (scenario: Scenario) => evaluate(title, contextOf(scenario));
    expect(titleOf({})).toBe("Deploy 0123456789abcdef0123456789abcdef01234567");
    const dispatch = { event: "workflow_dispatch", version: "2.37.1" } as const;
    const table: [Partial<Scenario>, string][] = [
      // The Compose host's titles are 2.35.0's, whatever the action says (the plan refuses any
      // but deploy, and a rebuild).
      [{ target: "production" }, "Deploy 2.37.1"],
      [
        { target: "production", rollback: true, from: "2.37.2" },
        "Deploy 2.37.1 rollback from 2.37.2",
      ],
      [{ target: "production", action: "bot" }, "Deploy 2.37.1"],
      [{ target: "production", rebuild: true }, "Deploy 2.37.1"],
      [{ target: "staging" }, "Deploy 2.37.1 to staging"],
      [{ target: "staging", action: "bot" }, "Deploy 2.37.1 bot to staging"],
      [{ target: "staging", action: "configure" }, "Deploy 2.37.1 configure to staging"],
      [{ target: "staging", action: "preflight" }, "Deploy 2.37.1 preflight to staging"],
      [{ target: "staging", rebuild: true }, "Deploy 2.37.1 to staging (rebuild)"],
      [
        { target: "staging", action: "infra", rebuild: true },
        "Deploy 2.37.1 infra to staging (rebuild)",
      ],
      [{ target: "prod" }, "Deploy 2.37.1 to prod"],
      [{ target: "prod", action: "bot" }, "Deploy 2.37.1 bot to prod"],
      [{ target: "prod", action: "infra" }, "Deploy 2.37.1 infra to prod"],
      [
        { target: "prod", action: "configure", rebuild: true },
        "Deploy 2.37.1 configure to prod (rebuild)",
      ],
    ];
    for (const [scenario, expected] of table)
      expect({ scenario, title: titleOf({ ...dispatch, ...scenario }) }).toEqual({
        scenario,
        title: expected,
      });
    // The Compose host builds its titles and checks them: anything ending " to prod" or
    // " to staging" is another title than the one it requires.
    expect(script).toContain('title="Deploy $V rollback from $F"');
    expect(script).toContain('title="Deploy $V"');
    expect(script).toContain('.display_title == ("Deploy " + $commit)');
  });

  test("the plan and every documented check name the signer by its exact identity", () => {
    // gh turns --signer-workflow into a pattern anchored only at its start, so a workflow named
    // publish.yml-canary.yml would pass it; the certificate's full identity can't be matched so.
    const identity =
      "--cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main";
    const joined = (source: string) => source.replace(/\\\n[\s#]*/gu, " ");
    expect(joined(runOf("plan", "plan"))).toContain(identity);
    // Every workflow, operating guide and script that runs `gh attestation verify`, or shows it
    // with its flags, names the exact identity, and none uses the prefix form anywhere. The
    // maintainer records (VERIFICATION.md and the like) keep their history as it happened.
    const files = [
      "docs/HOSTING.md",
      "docs/CI_CD.md",
      "docs/DEPLOYMENT.md",
      ...["site/src/content/docs", ".github/workflows", "ops"].flatMap((dir) =>
        [...new Bun.Glob("**/*.{md,mdx,yml,sh}").scanSync({ cwd: root(dir), dot: true })]
          .filter((path) => !path.split("/").includes(".terraform"))
          .map((path) => `${dir}/${path}`),
      ),
    ];
    let verifying = 0;
    for (const path of files) {
      if (!existsSync(root(path))) continue;
      const source = joined(read(path));
      if (/attestation verify [^\n`]*--[a-z]/u.test(source)) {
        verifying++;
        expect({ path, exact: source.includes(identity) }).toEqual({ path, exact: true });
      }
      // The workflows and scripts use no --signer-workflow at all; the guides may explain why,
      // but never show its prefix form in use.
      const code = path.startsWith(".github/") || path.startsWith("ops/");
      const uncommented = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      const used = code
        ? /--signer-workflow\b/u.test(uncommented)
        : /--signer-workflow [^\s/]+\//u.test(source);
      expect({ path, signer: used }).toEqual({ path, signer: false });
    }
    // deploy.yml's plan at least; today also the hosting and CI records and the install page.
    expect(verifying).toBeGreaterThan(0);
  });

  test("holds exact permissions: nothing at the top, and per job only what it uses", () => {
    expect(deploy.permissions).toEqual({});
    expect(
      Object.fromEntries(Object.entries(deploy.jobs).map(([name, j]) => [name, j.permissions])),
    ).toEqual({
      plan: { contents: "read", attestations: "read" },
      "infra-plan": { contents: "read" },
      infra: { contents: "read" },
      staging: { contents: "read" },
      prod: { contents: "read" },
      report: {},
      deploy: {},
      notify: {},
    });
    // Each grant says what it is for.
    for (const line of text.split("\n").filter((l) => /^ {6}(contents|attestations): /u.test(l)))
      expect({ line, commented: / # \S/u.test(line) }).toEqual({ line, commented: true });
    // The package is public: the provenance check logs in nowhere and reads no package, and no job
    // reads the environments' settings (the gate is gone: decision 8).
    expect(text).not.toMatch(/^\s*(packages|actions|id-token|deployments):/mu);
    expect(text).not.toMatch(/docker\s+login|--password-stdin|ghcr\.io\/token/u);
  });

  test("uses no action but the plan job's checkout and upload, no expression in a script, no tracing, no concurrency", () => {
    for (const [name, j] of Object.entries(deploy.jobs)) {
      if (!("steps" in j)) continue;
      for (const s of j.steps) {
        expect({ name, step: s.name, expression: (s.run ?? "").includes("${{") }).toEqual({
          name,
          step: s.name,
          expression: false,
        });
        expect(s.run ?? "").not.toMatch(/set -[a-zA-Z]*x|\bset -o xtrace/u);
      }
    }
    const uses = Object.entries(deploy.jobs).flatMap(([name, j]) =>
      "steps" in j ? j.steps.filter((s) => s.uses).map((s) => `${name}: ${s.uses}`) : [],
    );
    expect(uses).toEqual([
      "infra-plan: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "infra-plan: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ]);
    for (const name of CALLS) expect(deploy.jobs[name].uses).toBe("./.github/workflows/host.yml");
    // host.yml holds the one concurrency group per environment; this file has none, so several
    // approval requests may wait, and an older one approved later ends as superseded.
    expect(text).not.toMatch(/^\s*concurrency:/mu);
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
    const expected: Record<JobName, [string | undefined, string[], string[]]> = {
      plan: [undefined, [], ["DEPLOY_ENABLED"]],
      "infra-plan": [
        "infra-plan",
        [
          "CLOUDFLARE_READ_TOKEN",
          "LINODE_READ_TOKEN",
          "TOFU_STATE_BUCKET",
          "TOFU_STATE_ENDPOINT",
          "TOFU_STATE_PASSPHRASE",
          "TOFU_STATE_READ_ACCESS_KEY",
          "TOFU_STATE_READ_SECRET_KEY",
          "TOFU_VARS",
        ],
        [],
      ],
      infra: [undefined, [], []],
      staging: [undefined, [], []],
      prod: [undefined, [], []],
      report: ["notify", ["PUSHOVER_TOKEN", "PUSHOVER_USER"], ["DEPLOY_ENABLED"]],
      deploy: [
        "production",
        ["DEPLOY_SSH_KEY"],
        ["DEPLOY_ENABLED", "DEPLOY_HOST", "DEPLOY_KNOWN_HOSTS"],
      ],
      notify: ["notify", ["PUSHOVER_TOKEN", "PUSHOVER_USER"], ["DEPLOY_ENABLED"]],
    };
    for (const [name, [environment, secrets, vars]] of Object.entries(expected)) {
      const j = deploy.jobs[name as JobName];
      expect({
        name,
        environment: "environment" in j ? j.environment : undefined,
        secrets: refs(j, "secrets"),
        vars: refs(j, "vars"),
      }).toEqual({ name, environment, secrets, vars });
    }
    // Each call names its environment for host.yml, which loads that environment's secrets.
    expect(
      Object.fromEntries(CALLS.map((name) => [name, deploy.jobs[name].with.environment])),
    ).toEqual({
      infra: "prod",
      staging: "staging",
      prod: "prod",
    });
    // Production's key file is removed even when the deploy fails or is cancelled.
    expect(deploy.jobs.deploy.steps.at(-1)).toEqual({
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
    // Nothing still points at the pull unit, the old staging SSH step, the retired Infrastructure
    // workflow or the host secrets the pin store replaced.
    expect(comments).not.toMatch(
      /pull unit|host lock|STAGING_DEPLOY_ENABLED|infra\.yml|TARGET_HOST/u,
    );
  });
});

describe("the Compose path until 2.38.0", () => {
  test("is byte-identical to 2.35.0's: the Deploy and Notify jobs and the files they use", () => {
    // SHA-256 at 92339f5 (2.35.0, live in production). The Deploy job runs from its `  deploy:`
    // line through its key removal's run line, and Notify from `  notify:` to the end of the file;
    // the comment blocks above them may change. The owner's cutover moves production to the prod
    // host, and 2.38.0 removes these.
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
    const headers = (j: string) =>
      j
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

describe("the three calls of host.yml", () => {
  const plan = (output: string) => `\${{ needs.plan.outputs.${output} }}`;
  const infraPlan = (output: string) => `\${{ needs.infra-plan.outputs.${output} }}`;

  test("pass exactly what each call needs, in one environment each", () => {
    expect(deploy.jobs.infra.with).toEqual({
      environment: "prod",
      action: "infra",
      tofu: true,
      apply: `\${{ needs.infra-plan.outputs.has_changes == 'true' }}`,
      pins: infraPlan("pins_needed"),
      plan_digest: infraPlan("digest"),
      plan_changes: infraPlan("changes"),
      config_commit: plan("config_commit"),
    });
    expect(deploy.jobs.staging.with).toEqual({
      environment: "staging",
      action: plan("host_action"),
      tofu: false,
      apply: false,
      version: plan("version"),
      commit: plan("commit"),
      digest: plan("digest"),
      config_commit: plan("config_commit"),
    });
    expect(deploy.jobs.prod.with).toEqual({
      environment: "prod",
      action: plan("host_action"),
      tofu: `\${{ needs.infra-plan.result == 'success' && (needs.infra-plan.outputs.has_changes == 'true' || needs.infra-plan.outputs.pins_needed != '') }}`,
      apply: `\${{ needs.infra-plan.outputs.has_changes == 'true' }}`,
      pins: infraPlan("pins_needed"),
      plan_digest: infraPlan("digest"),
      plan_changes: infraPlan("changes"),
      version: plan("version"),
      commit: plan("commit"),
      digest: plan("digest"),
      config_commit: plan("config_commit"),
    });
    const inputs = host.on.workflow_call.inputs;
    for (const name of CALLS) {
      const given = deploy.jobs[name].with;
      // Only host.yml's inputs, and every one it requires.
      for (const key of Object.keys(given))
        expect({ name, key, known: key in inputs }).toEqual({ name, key, known: true });
      for (const [key, input] of Object.entries(inputs))
        if (input.required)
          expect({ name, key, given: key in given }).toEqual({ name, key, given: true });
      // Every output it reads is written by the job it names.
      for (const value of Object.values(given).filter((v): v is string => typeof v === "string")) {
        for (const [, output = ""] of value.matchAll(/needs\.plan\.outputs\.([a-z_]+)/gu))
          expect({ output, from: deploy.jobs.plan.outputs?.[output] }).toEqual({
            output,
            from: `\${{ steps.plan.outputs.${output} }}`,
          });
        for (const [, output = ""] of value.matchAll(/needs\.infra-plan\.outputs\.([a-z_]+)/gu))
          expect({ output, known: output in (deploy.jobs["infra-plan"].outputs ?? {}) }).toEqual({
            output,
            known: true,
          });
      }
    }
    // tofu and apply are host.yml's booleans; the literal ones are real booleans too.
    expect(inputs.tofu?.type).toBe("boolean");
    expect(inputs.apply?.type).toBe("boolean");
  });

  test("host.yml's request check accepts what each call passes, whatever the plan found", () => {
    const request = host.jobs.host.steps.find((s) => s.id === "request");
    const defaults = Object.fromEntries(
      Object.entries(host.on.workflow_call.inputs).map(([k, v]) => [k, v.default ?? ""]),
    );
    const dispatch = (extra: Partial<Scenario>): Scenario => ({
      event: "workflow_dispatch",
      ...extra,
    });
    const prodPath: Scenario = { switches: { production: "" } };
    const cases: [string, (typeof CALLS)[number], Scenario][] = [
      [
        "an automatic prod request with changes and a key to pin",
        "prod",
        { ...prodPath, infraPlan: { has_changes: "true", pins_needed: "prod" } },
      ],
      [
        "an automatic prod request with nothing to apply or pin",
        "prod",
        { ...prodPath, infraPlan: { has_changes: "false", pins_needed: "" } },
      ],
      [
        "a prod request with a key to pin alone",
        "prod",
        { ...prodPath, infraPlan: { has_changes: "false", pins_needed: "prod" } },
      ],
      ["prod's action=bot, which never plans", "prod", dispatch({ target: "prod", action: "bot" })],
      ["prod's configure", "prod", dispatch({ target: "prod", action: "configure" })],
      ["an automatic run's staging", "staging", {}],
      ["staging's configure", "staging", dispatch({ target: "staging", action: "configure" })],
      ["a staging rebuild's own job", "staging", dispatch({ target: "staging", rebuild: true })],
      ["action=infra with changes", "infra", dispatch({ action: "infra" })],
      [
        "action=infra with keys to pin alone",
        "infra",
        dispatch({ action: "infra", infraPlan: { has_changes: "false", pins_needed: "staging" } }),
      ],
      ["a staging rebuild", "infra", dispatch({ target: "staging", rebuild: true })],
    ];
    for (const [what, call, scenario] of cases) {
      expect({ what, runs: runs(call, scenario) }).toEqual({ what, runs: true });
      const context = contextOf(scenario);
      const inputs: Record<string, unknown> = { ...defaults };
      for (const [key, value] of Object.entries(deploy.jobs[call].with))
        inputs[key] =
          typeof value === "string" && value.includes("${{") ? evaluate(value, context) : value;
      const env = Object.fromEntries(
        Object.entries(request?.env ?? {}).map(([key, value]) => [
          key,
          value.replace(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/gu, (_, name: string) =>
            String(inputs[name] ?? ""),
          ),
        ]),
      );
      const r = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", request?.run ?? "exit 9"], {
        env: { PATH: "/usr/bin:/bin", ...env },
        stdin: "ignore",
      });
      expect({ what, code: r.exitCode, stdout: r.stdout.toString() }).toEqual({
        what,
        code: 0,
        stdout: "",
      });
    }
  });

  test("prod runs OpenTofu only when its plan has changes or keys to pin, and applies only changes", () => {
    const given = deploy.jobs.prod.with;
    const table: [NonNullable<Scenario["infraPlan"]>, boolean, boolean][] = [
      [{ has_changes: "true", pins_needed: "" }, true, true],
      [{ has_changes: "true", pins_needed: "prod" }, true, true],
      [{ has_changes: "false", pins_needed: "prod" }, true, false],
      [{ has_changes: "false", pins_needed: "" }, false, false],
      [{ result: "skipped" }, false, false],
    ];
    for (const [infraPlan, tofu, apply] of table) {
      const context = contextOf({ switches: { production: "" }, infraPlan });
      expect({
        infraPlan,
        tofu: evaluate(String(given.tofu), context),
        apply: evaluate(String(given.apply), context),
      }).toEqual({ infraPlan, tofu, apply });
    }
    // action=bot never plans: no OpenTofu in the job.
    const bot = contextOf({ event: "workflow_dispatch", target: "prod", action: "bot" });
    expect(evaluate(String(given.tofu), bot)).toBe(false);
  });

  test("hand bot.yml exactly the inputs and setting names the release's vars/bot.yml declares", () => {
    const vars = YAML.parse(read("ops/ansible/vars/bot.yml")) as {
      tb_inputs: string[];
      tb_secret_env: string[];
      tb_secret_source: Record<string, string>;
      tb_setting_env: string[];
      tb_setting_source: Record<string, string>;
    };
    const botStep = host.jobs.host.steps.find((s) => s.name === "Deploy the bot");
    expect(botStep).toBeDefined();
    const run = (botStep?.run ?? "").replace(/\\\n\s*/gu, " ");
    const names = [...run.matchAll(/-e "(tarubot_[a-z_]+)=/gu)].map((m) => m[1]);
    expect(names.sort()).toEqual([...vars.tb_inputs].sort());
    // Each variable from the environment secret its *_source names for it, else from the secret
    // of its own name. GitHub refuses a secret name that starts with GITHUB_, so the GITHUB_
    // variables need an entry, and exactly they have one.
    const sources = { ...vars.tb_secret_source, ...vars.tb_setting_source };
    const all = [...vars.tb_secret_env, ...vars.tb_setting_env];
    expect(Object.keys(sources).sort()).toEqual(all.filter((n) => n.startsWith("GITHUB_")).sort());
    const env = botStep?.env ?? {};
    const secrets = Object.entries(env)
      .filter(([, value]) => value.startsWith("${{ secrets."))
      .map(([name, value]) => {
        expect({ name, value }).toEqual({
          name,
          value: `\${{ secrets.${sources[name] ?? name} }}`,
        });
        return name;
      });
    expect(secrets.sort()).toEqual(all.sort());
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
    // And the run's path: this file.
    expect(script).toContain(".github/workflows/deploy.yml");
  });

  test("the plan and the host agree on the version pattern and the reviewer", () => {
    const plan = runOf("plan", "plan");
    expect(pattern(plan, "VER")).toBe(pattern(script, "readonly VERSION"));
    // The one account that approves production and prod, by login.
    const login = /^readonly REVIEWER=([a-z0-9-]+)$/mu.exec(script)?.[1];
    expect(plan).toContain(`\nREVIEWER=${login}\n`);
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
   * check; the lookahead lets a period or hyphen follow the name, but not an underscore, which
   * continues an identifier (steps.plan.outputs.host_action).
   */
  const hostNames = (source: string) =>
    [
      ...source.matchAll(
        /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech|info|us|uk|de|eu|ca|host))(?:$|(?=[^a-z0-9_]))/gimu,
      ),
    ].map((m) => (m[1] ?? "").toLowerCase());
  // slsa.dev only names the provenance predicate type the plan requires; nothing connects to it.
  // instance.host is the end of OpenTofu's address linode_instance.host["<key>"], which the plan
  // names for a rebuild, and jobs.host is host.yml's own job in its outputs.
  const allowed = new Set([
    "github.com",
    "api.github.com",
    "ghcr.io",
    "api.pushover.net",
    "slsa.dev",
    "instance.host",
    "jobs.host",
  ]);

  test("the workflows and ops/deploy.sh name no host beyond GitHub, GHCR and Pushover", () => {
    for (const [file, source] of [
      [".github/workflows/deploy.yml", text],
      [".github/workflows/host.yml", hostText],
      ["ops/deploy.sh", script],
    ] as const) {
      const hosts = [...new Set(hostNames(source))].filter((h) => !allowed.has(h));
      expect({ file, hosts }).toEqual({ file, hosts: [] });
      // No address literal either.
      expect({ file, ip: /\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(source) }).toEqual({
        file,
        ip: false,
      });
    }
    // The Compose host comes from production's variable; the new hosts from the pin store, which
    // host.sh reads. No workflow holds a host secret any more.
    expect(runOf("deploy", "ssh")).toContain("[[ $DEPLOY_HOST =~ $HOST_NAME ]]");
    for (const source of [text, hostText]) expect(source).not.toMatch(/TARGET_HOST/u);
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

describe("which workflow names which environment, secret and variable", () => {
  const files = readdirSync(root(".github/workflows")).filter((f) => /\.ya?ml$/u.test(f));
  interface Ref {
    readonly file: string;
    readonly job: string;
    /** The step's id or name; "-" for the job's own keys. */
    readonly step: string;
    readonly stepIf: string;
    readonly kind: string;
    readonly name: string;
    readonly expression: string;
  }
  const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/gu;
  /** A context read: secrets.NAME, secrets['NAME'], or the bare context (a dynamic read). */
  const CONTEXT = /\b(secrets|vars)\b\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([^']*)'\s*\])?/gu;
  const refsIn = (value: unknown, where: Pick<Ref, "file" | "job" | "step" | "stepIf">) =>
    [...JSON.stringify(value ?? null).matchAll(EXPRESSION)].flatMap(([, body = ""]) =>
      [...body.matchAll(CONTEXT)].map(
        (m): Ref => ({
          ...where,
          kind: m[1] ?? "",
          name: m[2] ?? m[3] ?? "<dynamic>",
          expression: body.replace(/\\n/gu, " ").replace(/\s+/gu, " ").trim(),
        }),
      ),
    );
  type Loose = Record<string, unknown> & { steps?: Record<string, unknown>[] };
  const parsed = Object.fromEntries(
    files.map((file) => [
      file,
      YAML.parse(read(`.github/workflows/${file}`)) as { jobs: Record<string, Loose> },
    ]),
  );
  const refs: Ref[] = files.flatMap((file) => {
    const { jobs, ...top } = parsed[file] ?? { jobs: {} };
    return [
      ...refsIn(top, { file, job: "-", step: "-", stepIf: "" }),
      ...Object.entries(jobs).flatMap(([jobName, j]) => {
        const { steps, ...rest } = j;
        return [
          ...refsIn(rest, { file, job: jobName, step: "-", stepIf: "" }),
          ...(steps ?? []).flatMap((s) =>
            refsIn(s, {
              file,
              job: jobName,
              step: String(s.id ?? s.name ?? "?"),
              stepIf: String(s.if ?? ""),
            }),
          ),
        ];
      }),
    ];
  });
  const at = (r: Ref, file: string, jobs: string[]) => r.file === file && jobs.includes(r.job);
  const tofuGated = (r: Ref) => r.stepIf === "inputs.tofu" || r.stepIf === "inputs.apply";
  const BOT = [
    "BACKUP_STORAGE_ACCESS_KEY",
    "BACKUP_STORAGE_ENDPOINT",
    "BACKUP_STORAGE_REGION",
    "BACKUP_STORAGE_SECRET_KEY",
    "DATABASE_CA_CERT",
    "DATABASE_URL",
    "DISCORD_TOKEN",
    "SUGGEST_APP_CLIENT_ID",
    "SUGGEST_APP_PRIVATE_KEY",
    "REPORTS_GITHUB_TOKEN",
    "HEALTHCHECKS_BACKUP_URL",
    "HEALTHCHECKS_PING_URL",
  ];
  /** Where each secret and variable may be named; anything unlisted may be named nowhere. */
  const RULES: [string, (name: string) => boolean, (r: Ref) => boolean][] = [
    [
      "the Compose host's key",
      (n) => n === "DEPLOY_SSH_KEY",
      (r) => at(r, "deploy.yml", ["deploy"]),
    ],
    [
      "the Compose host's variables",
      (n) => n === "DEPLOY_HOST" || n === "DEPLOY_KNOWN_HOSTS",
      (r) => r.kind === "vars" && at(r, "deploy.yml", ["deploy"]),
    ],
    [
      "the Compose switch",
      (n) => n === "DEPLOY_ENABLED",
      (r) => r.kind === "vars" && at(r, "deploy.yml", ["plan", "deploy", "notify", "report"]),
    ],
    [
      "Pushover",
      (n) => n.startsWith("PUSHOVER_"),
      (r) => at(r, "deploy.yml", ["notify", "report"]),
    ],
    [
      "infra-plan's own",
      (n) => ["LINODE_READ_TOKEN", "CLOUDFLARE_READ_TOKEN", "TOFU_VARS"].includes(n),
      (r) => at(r, "deploy.yml", ["infra-plan"]),
    ],
    [
      "the read-only state key",
      (n) => n.startsWith("TOFU_STATE_READ_"),
      (r) =>
        at(r, "deploy.yml", ["infra-plan"]) ||
        (at(r, "host.yml", ["host"]) && r.step === "connect"),
    ],
    [
      "the state passphrase",
      (n) => n === "TOFU_STATE_PASSPHRASE",
      (r) => at(r, "deploy.yml", ["infra-plan"]) || (at(r, "host.yml", ["host"]) && tofuGated(r)),
    ],
    [
      "the state bucket",
      (n) => n === "TOFU_STATE_BUCKET" || n === "TOFU_STATE_ENDPOINT",
      (r) =>
        at(r, "deploy.yml", ["infra-plan"]) ||
        (at(r, "host.yml", ["host"]) && (tofuGated(r) || r.step === "connect")),
    ],
    [
      "the infrastructure write tokens",
      (n) => n === "LINODE_WRITE_TOKEN" || n === "CLOUDFLARE_WRITE_TOKEN",
      (r) => at(r, "host.yml", ["host"]) && r.stepIf === "inputs.apply",
    ],
    [
      "the read/write state key",
      (n) => n.startsWith("TOFU_STATE_WRITE_"),
      (r) =>
        at(r, "host.yml", ["host"]) &&
        (tofuGated(r) ||
          (r.step === "connect" &&
            /^inputs\.environment == 'prod' && secrets\.TOFU_STATE_WRITE_(ACCESS|SECRET)_KEY \|\| secrets\.TOFU_STATE_READ_\1_KEY$/u.test(
              r.expression,
            ))),
    ],
    [
      "the Configure key",
      (n) => n === "ANSIBLE_SSH_KEY",
      (r) => at(r, "host.yml", ["host"]) && r.step === "connect",
    ],
    [
      "the bot's settings",
      (n) => BOT.includes(n),
      (r) => at(r, "host.yml", ["host"]) && r.step === "bot",
    ],
    [
      "Claude's token",
      (n) => n === "CLAUDE_CODE_OAUTH_TOKEN",
      (r) => r.file === "claude.yml" || r.file === "claude-code-review.yml",
    ],
    ["the job's own token", (n) => n === "GITHUB_TOKEN", (r) => r.file === "publish.yml"],
  ];

  test("every secret and variable is named only where its rule allows, and never dynamically", () => {
    expect(refs.length).toBeGreaterThan(40);
    const misplaced = refs
      .filter((r) => {
        const rule = RULES.find(([, names]) => names(r.name));
        return !rule?.[2](r);
      })
      .map((r) => `${r.file} ${r.job} ${r.step}: ${r.kind}.${r.name}`);
    expect(misplaced).toEqual([]);
    // Nothing reads a context whole (toJSON(secrets)) or by a computed name.
    for (const file of files)
      expect({
        file,
        whole: /toJSON\(\s*(secrets|vars)\s*\)/iu.test(read(`.github/workflows/${file}`)),
      }).toEqual({
        file,
        whole: false,
      });
    // The rules' key points, spelled out: TOFU_VARS never reaches host.yml, the write tokens only
    // its apply step, and the Compose host's key only its Deploy job.
    const where = (name: string) =>
      [
        ...new Set(refs.filter((r) => r.name === name).map((r) => `${r.file} ${r.job} ${r.step}`)),
      ].sort();
    expect(where("TOFU_VARS")).toEqual(["deploy.yml infra-plan Prepare the values and the masks"]);
    expect(where("LINODE_WRITE_TOKEN")).toEqual(["host.yml host apply"]);
    expect(where("CLOUDFLARE_WRITE_TOKEN")).toEqual(["host.yml host apply"]);
    expect(where("DEPLOY_SSH_KEY")).toEqual(["deploy.yml deploy ssh"]);
    expect(where("ANSIBLE_SSH_KEY")).toEqual(["host.yml host connect"]);
  });

  test("each environment is named where it belongs, literally or inside an expression", () => {
    /** The environment names a value names: the literal, or every quoted name and input inside. */
    const namesIn = (value: unknown): string[] => {
      if (value === undefined) return [];
      const v =
        typeof value === "object" && value !== null ? (value as { name?: unknown }).name : value;
      const s = String(v);
      if (!s.includes("${{")) return [s];
      return [
        ...[...s.matchAll(/'([^']*)'/gu)].map((m) => m[1] ?? ""),
        ...[...s.matchAll(/\binputs\.[a-z_]+/gu)].map((m) => m[0]),
      ];
    };
    const found: Record<string, Record<string, string[]>> = {};
    for (const file of files)
      for (const [jobName, j] of Object.entries(parsed[file]?.jobs ?? {})) {
        const names = [
          ...namesIn(j.environment),
          ...namesIn((j.with as Record<string, unknown> | undefined)?.environment),
        ];
        if (names.length) {
          found[file] = found[file] ?? {};
          (found[file] as Record<string, string[]>)[jobName] = names;
        }
      }
    expect(found).toEqual({
      "deploy.yml": {
        "infra-plan": ["infra-plan"],
        infra: ["prod"],
        staging: ["staging"],
        prod: ["prod"],
        report: ["notify"],
        deploy: ["production"],
        notify: ["notify"],
      },
      "host.yml": { host: ["inputs.environment"] },
      "pages.yml": { deploy: ["github-pages"] },
    });
    expect(parsed["host.yml"]?.jobs.host?.environment).toBe(`\${{ inputs.environment }}`);
    // The retired `infra` environment is named nowhere, and no workflow names an environment in any
    // other key: a literal in a script or a comment is fine, an `environment:` line isn't.
    for (const file of files) {
      const source = read(`.github/workflows/${file}`);
      const lines = source.split("\n").filter((l) => /^\s*environment:\s*\S/u.test(l));
      for (const line of lines)
        expect({ file, line: line.trim(), infra: /\binfra\b(?!-plan)/u.test(line) }).toEqual({
          file,
          line: line.trim(),
          infra: false,
        });
    }
    expect(existsSync(root(".github/workflows/infra.yml"))).toBe(false);
  });

  test("every secret and variable a workflow reads is one GitHub lets the owner create", () => {
    // GitHub refuses a secret or variable name that starts with GITHUB_ (in any case) and allows
    // only letters, digits and underscores, not starting with a digit. GITHUB_TOKEN is the one
    // GITHUB_ secret, the job's own token, which nobody creates.
    const refused = refs
      .filter((r) => !(r.kind === "secrets" && r.name === "GITHUB_TOKEN"))
      .filter((r) => /^GITHUB_/iu.test(r.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(r.name))
      .map((r) => `${r.file}: ${r.kind}.${r.name}`);
    expect(refused).toEqual([]);
  });

  test("no workflow runs untrusted pull-request code with the repository's secrets", () => {
    for (const file of files)
      expect({
        file,
        target: read(`.github/workflows/${file}`).includes("pull_request_target"),
      }).toEqual({
        file,
        target: false,
      });
  });

  test("CODEOWNERS makes @deconfined the reviewer of every pull request", () => {
    const owners = read(".github/CODEOWNERS")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(owners).toEqual(["* @deconfined"]);
  });
});

describe("the Infrastructure plan job", () => {
  const j = deploy.jobs["infra-plan"];
  const plan = (output: string) => `\${{ needs.plan.outputs.${output} }}`;
  const secret = (name: string) => `\${{ secrets.${name} }}`;
  const READ = {
    AWS_ACCESS_KEY_ID: secret("TOFU_STATE_READ_ACCESS_KEY"),
    AWS_SECRET_ACCESS_KEY: secret("TOFU_STATE_READ_SECRET_KEY"),
  };

  test("plans in infra-plan, from main only, on the first attempt, with a day's artifact at most", () => {
    expect({
      environment: j.environment,
      needs: j.needs,
      if: j.if,
      permissions: j.permissions,
      env: j.env,
      timeout: j["timeout-minutes"],
    }).toEqual({
      environment: "infra-plan",
      needs: "plan",
      if: "github.run_attempt == '1' && github.ref == 'refs/heads/main' && needs.plan.outputs.infra == 'true'",
      permissions: { contents: "read" },
      env: { TF_IN_AUTOMATION: "1", TF_INPUT: "0" },
      timeout: 20,
    });
    // Its plan job requires a publish of main or a dispatch from main.
    expect(deploy.jobs.plan.if).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    expect(deploy.jobs.plan.if).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(j.outputs).toEqual({
      has_changes: `\${{ steps.summarize.outputs.has_changes }}`,
      digest: `\${{ steps.summarize.outputs.digest }}`,
      changes: `\${{ steps.summarize.outputs.changes }}`,
      pins_needed: `\${{ steps.status.outputs.pins_needed }}`,
      refused: `\${{ steps.summarize.outcome == 'failure' && steps.summarize.outputs.digest != '' && 'true' || 'false' }}`,
    });
  });

  test("runs one phase per step, each with only the secrets it needs, the rest from the plan's outputs", () => {
    expect(j.steps.map((s) => [s.name, s.run ?? s.uses, s.env ?? {}])).toEqual([
      [
        "Check out main's configuration",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        {},
      ],
      ["Install the pinned OpenTofu", "bash config/ops/tofu/ci/tofu-ci.sh install", {}],
      [
        "Write the backend settings",
        "bash config/ops/tofu/ci/tofu-ci.sh backend",
        {
          STATE_BUCKET: secret("TOFU_STATE_BUCKET"),
          STATE_ENDPOINT: secret("TOFU_STATE_ENDPOINT"),
        },
      ],
      [
        "Prepare the values and the masks",
        "bash config/ops/tofu/ci/tofu-ci.sh values",
        { TOFU_VARS: secret("TOFU_VARS"), REBUILD_TARGET: plan("rebuild") },
      ],
      [
        "Initialize OpenTofu",
        "bash config/ops/tofu/ci/tofu-ci.sh init",
        { ...READ, TF_VAR_state_passphrase: secret("TOFU_STATE_PASSPHRASE") },
      ],
      [
        "Plan",
        "bash config/ops/tofu/ci/tofu-ci.sh plan",
        {
          ...READ,
          TF_VAR_state_passphrase: secret("TOFU_STATE_PASSPHRASE"),
          LINODE_TOKEN: secret("LINODE_READ_TOKEN"),
          CLOUDFLARE_API_TOKEN: secret("CLOUDFLARE_READ_TOKEN"),
        },
      ],
      [
        "Summarize the plan",
        "bash config/ops/tofu/ci/tofu-ci.sh summarize",
        {
          TF_VAR_state_passphrase: secret("TOFU_STATE_PASSPHRASE"),
          ALLOW_DESTROY: plan("allow_destroy"),
          ALLOW_ACCESS_REMOVAL: plan("allow_access_removal"),
          REBUILD_TARGET: plan("rebuild"),
        },
      ],
      [
        "List the host keys to pin",
        "bash config/ops/tofu/ci/host.sh status",
        {
          PIN_SCOPE: plan("pin_scope"),
          STATE_BUCKET: secret("TOFU_STATE_BUCKET"),
          STATE_ENDPOINT: secret("TOFU_STATE_ENDPOINT"),
          ...READ,
        },
      ],
      [
        "Keep the saved plan for the approving job",
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        {},
      ],
      ["Clean up", `rm -rf -- "\${RUNNER_TEMP:?}/tofu" "\${RUNNER_TEMP:?}/pin"`, {}],
    ]);
    // The checkout is main's head, as the run was created, at the path host.yml applies from.
    expect(j.steps[0]?.with).toEqual({
      ref: plan("config_commit"),
      path: "config",
      "persist-credentials": false,
      "fetch-depth": 1,
    });
    // Nothing reads the event payload: the rebuild target is the plan's checked output.
    expect(JSON.stringify(j)).not.toMatch(/github\.event|GITHUB_EVENT_PATH|inputs\./u);
    expect(j.steps.map((s) => s.id).filter(Boolean)).toEqual(["summarize", "status"]);
    // Every step's name and its version comment match ci.yml's pinned checkout.
    expect(text).toContain(
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
    );
  });

  test("only the encrypted saved plan leaves the job, for one day, and only with changes or keys to pin", () => {
    const keep = j.steps.find((s) => s.name === "Keep the saved plan for the approving job");
    expect(keep?.if).toBe(
      "steps.summarize.outputs.has_changes == 'true' || steps.status.outputs.pins_needed != ''",
    );
    expect(keep?.with).toEqual({
      name: "saved-plan",
      path: `\${{ runner.temp }}/tofu/plan.bin`,
      "if-no-files-found": "error",
      "retention-days": 1,
      "compression-level": 0,
    });
    expect(text).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n",
    );
    // host.yml fetches it by the same name into the same place.
    expect(hostText).toContain(
      `uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: saved-plan\n          path: \${{ runner.temp }}/tofu\n`,
    );
    // Only this job uploads anything, and only one file.
    expect(text.match(/upload-artifact@/gu)).toHaveLength(1);
    const cleanup = j.steps.at(-1);
    expect(cleanup?.if).toBe("always()");
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
        steps: {
          name?: string;
          if?: string;
          env?: Record<string, string>;
          run?: string;
          "working-directory"?: string;
        }[];
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

  test("CI checks the host scripts, and Deploy's OpenTofu and host-key scripts, with ShellCheck", () => {
    const run = stepIn("checks", "Check the host scripts with ShellCheck").run ?? "";
    expect(run).toContain("shellcheck -S warning ops/*.sh\n");
    expect(run).toContain("shellcheck -S warning ops/tofu/ci/tofu-ci.sh ops/tofu/ci/host.sh\n");
    expect(run).not.toContain("ops/*/*.sh");
    expect(run).not.toContain("infra.yml");
  });

  test("the Host playbook job evaluates bot.yml's checks with the pinned ansible-core's templar", () => {
    const steps = ci.jobs.playbook?.steps ?? [];
    const names = steps.map((s) => s.name);
    const templar = stepIn("playbook", "Evaluate bot.yml's checks with Ansible's templar");
    expect(templar.run?.trim().split("\n").at(-1)).toBe("python tests/fixtures/bot-asserts.py");
    expect(templar.env).toEqual({
      ANSIBLE_CONFIG: `\${{ github.workspace }}/ops/ansible/ansible.cfg`,
      LC_ALL: "C.UTF-8",
    });
    // From the repository's root, after the pinned venv is on PATH.
    expect(templar["working-directory"]).toBeUndefined();
    expect(names.indexOf("Install the pinned ansible-core and ansible-lint")).toBeLessThan(
      names.indexOf("Evaluate bot.yml's checks with Ansible's templar"),
    );
    expect(existsSync(root("tests/fixtures/bot-asserts.py"))).toBe(true);
  });

  test("the renderer check compares every rendering, staging's and prod's, with Ansible's own", () => {
    const check = stepIn("playbook", "Check the test renderer against Ansible's template module");
    const dir = mkdtempSync(join(tmpdir(), "render-check-"));
    try {
      const bin = join(dir, "bin");
      const cache = join(dir, "work", ".cache", "bot");
      mkdirSync(bin, { recursive: true });
      // A stand-in ansible that "renders" by copying the renderer's own file for that target, so
      // a mismatch appears only where the test puts one; it records each call.
      writeFileSync(
        join(bin, "ansible"),
        [
          "#!/usr/bin/env bash",
          'src="" dest="" vars=""',
          `while (($#)); do case $1 in -a) for w in $2; do case $w in src=*) src=\${w#src=} ;; dest=*) dest=\${w#dest=} ;; esac; done; shift 2 ;; -e) vars=\${2#@}; shift 2 ;; *) shift ;; esac; done`,
          'echo "$src $vars" >> "$CALLS"',
          'base=$(basename "$src" .j2)',
          'cp "$(dirname "$vars")/$base" "$dest"',
          'if [[ -f $(dirname "$vars")/break ]]; then echo changed >> "$dest"; fi',
        ].join("\n"),
      );
      chmodSync(join(bin, "ansible"), 0o755);
      const render = (name: string) => {
        mkdirSync(join(cache, name), { recursive: true });
        for (const file of ["tarubot.container", "tarubot.env", "vars.json"])
          writeFileSync(join(cache, name, file), `${name} ${file}\n`);
      };
      const run = () => {
        rmSync(join(dir, "calls"), { force: true });
        const r = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", check.run ?? ""], {
          cwd: join(dir, "work"),
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            GITHUB_WORKSPACE: join(dir, "work"),
            RUNNER_TEMP: join(dir, "temp"),
            CALLS: join(dir, "calls"),
          },
        });
        const calls = existsSync(join(dir, "calls"))
          ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
          : [];
        return { code: r.exitCode, stdout: r.stdout.toString(), calls };
      };
      render("staging");
      const noProd = run();
      expect(noProd.code).toBe(1);
      expect(noProd.stdout).toContain("::error::The renderer wrote no prod rendering.");
      render("prod");
      render("prod-suggest");
      const all = run();
      expect(all.code).toBe(0);
      // Both templates for every rendering.
      expect(all.calls.map((c) => c.replace(`${cache}/`, "")).sort()).toEqual(
        ["prod", "prod-suggest", "staging"]
          .flatMap((n) => [
            `templates/bot/tarubot.container.j2 ${n}/vars.json`,
            `templates/bot/tarubot.env.j2 ${n}/vars.json`,
          ])
          .sort(),
      );
      writeFileSync(join(cache, "prod-suggest", "break"), "");
      expect(run().code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
 * Run one workflow script with the given environment; returns status, stdout, the outputs (and
 * their keys in the order written) and the summary. A prelude runs first in the same shell (the
 * SSH tests use it to move the clock on).
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
  const keys: string[] = [];
  for (const line of readFileSync(join(where.dir, "output"), "utf8").split("\n"))
    if (line.includes("=")) {
      const key = line.slice(0, line.indexOf("="));
      keys.push(key);
      outputs[key] = line.slice(line.indexOf("=") + 1);
    }
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
    keys,
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

describe("the report step", () => {
  /** Run the step and return the message, priority and what curl received. */
  function report(env: Record<string, string>) {
    const where = box();
    const result = runScript(runOf("report", "Send one Pushover message"), where, {
      PUSHOVER_TOKEN: "app-token",
      PUSHOVER_USER: "user-key",
      PLAN_RESULT: "success",
      PLAN_DEPLOY: "true",
      PLAN_REASON: "-",
      PLAN_VERSION: "2.37.1",
      PLAN_PROD: "true",
      PLAN_INFRA: "true",
      PLAN_HOST_ACTION: "deploy",
      PLAN_REBUILD: "",
      INFRA_PLAN_RESULT: "success",
      INFRA_PLAN_REFUSED: "false",
      INFRA_RESULT: "skipped",
      INFRA_OUTCOME: "",
      INFRA_STEP: "",
      INFRA_PINNED: "",
      PROD_RESULT: "success",
      OUTCOME: "deployed",
      REASON: "-",
      STEP: "-",
      PREVIOUS: "2.37.0",
      RESTORE_POINT: "2026-09-30T19:30:05.123456Z",
      WARNINGS: "",
      PINNED: "",
      INFRASTRUCTURE: "unchanged",
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
  /** A run without a Prod job: action=infra by default. */
  const infraOnly = {
    PLAN_PROD: "false",
    PLAN_HOST_ACTION: "infra",
    PLAN_VERSION: "",
    PROD_RESULT: "skipped",
    OUTCOME: "",
    PREVIOUS: "",
    RESTORE_POINT: "",
    INFRASTRUCTURE: "",
  };

  test("reads the plan, the Infrastructure plan, Infrastructure and Prod, never staging or a variable", () => {
    const env = stepOf("report", "Send one Pushover message").env ?? {};
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith("PUSHOVER_")) {
        expect(value).toBe(`\${{ secrets.${name} }}`);
        continue;
      }
      expect({ name, value }).toEqual({
        name,
        value: expect.stringMatching(
          /^\$\{\{ needs\.(plan|infra-plan|infra|prod)\.(result|outputs\.[a-z_]+) \}\}$/u,
        ),
      });
    }
    expect(JSON.stringify(env)).not.toMatch(/needs\.staging|vars\./u);
    expect(deploy.jobs.report.environment).toBe("notify");
    expect(deploy.jobs.report["timeout-minutes"]).toBe(5);
    // Every Prod output it reads is one host.yml declares.
    for (const [, output = ""] of JSON.stringify(env).matchAll(
      /needs\.(?:prod|infra)\.outputs\.([a-z_]+)/gu,
    ))
      expect({ output, declared: output in host.on.workflow_call.outputs }).toEqual({
        output,
        declared: true,
      });
  });

  test("pages each prod outcome with its priority, the infrastructure it applied and the way back", () => {
    const cases: [Record<string, string>, string, string][] = [
      [{}, "2.37.1 deployed to prod; commands registered", "0"],
      [
        { INFRASTRUCTURE: "applied", PINNED: "prod" },
        "2.37.1 deployed to prod; commands registered; infrastructure applied; host keys pinned: prod",
        "0",
      ],
      // The maintenance-window warning claims no migration (a first start names every file, even
      // on a database at the head), keeps one full stop, and stays off runs that never reached
      // migrate.js.
      [
        { WARNINGS: "db-maintenance-window" },
        "2.37.1 deployed to prod; commands registered. The run fell in the database maintenance window, with migration files new to this host.",
        "0",
      ],
      [
        {
          OUTCOME: "unhealthy",
          REASON: "not-healthy",
          STEP: "health",
          WARNINGS: "db-maintenance-window",
        },
        "NEEDS YOU: 2.37.1 isn't healthy on prod. To roll back, reject any prod request still waiting, then dispatch Deploy with target=prod, version=2.37.0 and action=bot. The run fell in the database maintenance window, with migration files new to this host.",
        "1",
      ],
      [
        {
          OUTCOME: "preflight-ok",
          PLAN_HOST_ACTION: "preflight",
          WARNINGS: "db-maintenance-window",
        },
        "2.37.1 preflight passed on prod (database and backup, no bot). The run fell in the database maintenance window, with migration files new to this host.",
        "0",
      ],
      [
        {
          OUTCOME: "refused",
          REASON: "token-application-mismatch",
          WARNINGS: "db-maintenance-window",
        },
        "2.37.1 not deployed to prod, nothing changed on the host: token-application-mismatch",
        "0",
      ],
      [{ OUTCOME: "configured", WARNINGS: "db-maintenance-window" }, "prod configured", "0"],
      [
        { OUTCOME: "superseded", PREVIOUS: "2.37.2" },
        "2.37.1 skipped on prod: newer release 2.37.2 is live",
        "-1",
      ],
      [
        {
          OUTCOME: "configured",
          PLAN_HOST_ACTION: "configure",
          PLAN_VERSION: "",
          PINNED: "prod",
          INFRASTRUCTURE: "pinned",
        },
        "prod configured; host keys pinned: prod",
        "0",
      ],
      [
        { OUTCOME: "preflight-ok", PLAN_HOST_ACTION: "preflight" },
        "2.37.1 preflight passed on prod (database and backup, no bot)",
        "0",
      ],
      [
        { OUTCOME: "refused", REASON: "settings-invalid" },
        "2.37.1 not deployed to prod, nothing changed on the host: settings-invalid",
        "0",
      ],
      [
        { OUTCOME: "unhealthy", REASON: "not-healthy", STEP: "health" },
        "NEEDS YOU: 2.37.1 isn't healthy on prod. To roll back, reject any prod request still waiting, then dispatch Deploy with target=prod, version=2.37.0 and action=bot.",
        "1",
      ],
      [
        { OUTCOME: "unhealthy", PREVIOUS: "-" },
        "NEEDS YOU: 2.37.1 isn't healthy on prod, and no earlier release is recorded there.",
        "1",
      ],
      [
        { OUTCOME: "failed", STEP: "restart", REASON: "restart-failed" },
        "NEEDS YOU: 2.37.1 failed on prod at restart (restart-failed); restore point 2026-09-30T19:30:05.123456Z. To roll back, reject any prod request still waiting, then dispatch Deploy with target=prod, version=2.37.0 and action=bot.",
        "1",
      ],
      [
        { OUTCOME: "failed", STEP: "restart", REASON: "restart-failed", PREVIOUS: "-" },
        "NEEDS YOU: 2.37.1 failed on prod at restart (restart-failed); restore point 2026-09-30T19:30:05.123456Z",
        "1",
      ],
      [
        { OUTCOME: "failed", STEP: "connect", REASON: "host-key", RESTORE_POINT: "-" },
        "NEEDS YOU: 2.37.1 failed on prod at connect (host-key)",
        "1",
      ],
      [
        {
          OUTCOME: "failed",
          STEP: "apply",
          REASON: "-",
          RESTORE_POINT: "-",
          INFRASTRUCTURE: "failed",
        },
        "NEEDS YOU: 2.37.1 failed on prod at apply (-)",
        "1",
      ],
      [
        { OUTCOME: "", PROD_RESULT: "failure" },
        "2.37.1 not approved for prod (rejected or expired)",
        "-1",
      ],
      [
        { OUTCOME: "", PROD_RESULT: "cancelled" },
        "2.37.1: the run was cancelled before prod started",
        "-1",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "unattested" },
        "2.37.1: the plan stopped (unattested); nothing ran (see the run)",
        "0",
      ],
      [
        { PLAN_DEPLOY: "false", PLAN_REASON: "no-runtime-change" },
        "2.37.1: no runtime change in this merge. If an earlier release wasn't deployed, run Deploy with the newest version.",
        "-1",
      ],
      // An expired read-only token: the way out is action=bot, which never plans.
      [
        { INFRA_PLAN_RESULT: "failure", OUTCOME: "", PROD_RESULT: "skipped" },
        "2.37.1: the Infrastructure plan failed, so nothing was applied or deployed (see the run). To deploy 2.37.1 without a plan, dispatch Deploy with target=prod, version=2.37.1 and action=bot.",
        "0",
      ],
      [
        {
          INFRA_PLAN_RESULT: "failure",
          INFRA_PLAN_REFUSED: "true",
          OUTCOME: "",
          PROD_RESULT: "skipped",
        },
        "2.37.1: the Infrastructure plan's guards refused it, so nothing was applied or deployed. Dispatch again with allow_destroy or allow_access_removal if you meant it.",
        "0",
      ],
    ];
    for (const [env, message, priority] of cases) {
      const r = report(env);
      expect({ env, code: r.code, message: r.message, priority: r.priority }).toEqual({
        env,
        code: 0,
        message,
        priority,
      });
    }
  });

  test("pages an infrastructure-only run's outcome, and a rebuild by its host", () => {
    const cases: [Record<string, string>, string, string][] = [
      [
        { INFRA_RESULT: "success", INFRA_OUTCOME: "applied", INFRA_PINNED: "staging prod" },
        "Infrastructure: applied; host keys pinned: staging prod",
        "0",
      ],
      [{ INFRA_RESULT: "success", INFRA_OUTCOME: "applied" }, "Infrastructure: applied", "0"],
      [
        { INFRA_RESULT: "success", INFRA_OUTCOME: "pinned", INFRA_PINNED: "staging" },
        "Infrastructure: host keys pinned: staging",
        "0",
      ],
      [{ INFRA_RESULT: "success", INFRA_OUTCOME: "unchanged" }, "Infrastructure: unchanged", "-1"],
      [
        { INFRA_RESULT: "skipped" },
        "Infrastructure: unchanged, with no changes and no host key to pin",
        "-1",
      ],
      [
        { INFRA_RESULT: "failure", INFRA_OUTCOME: "failed", INFRA_STEP: "apply" },
        "NEEDS YOU: Infrastructure failed at apply (see the run)",
        "1",
      ],
      [{ INFRA_RESULT: "failure" }, "Infrastructure not approved (rejected or expired)", "-1"],
      [
        { INFRA_RESULT: "cancelled" },
        "Infrastructure: the run was cancelled before the Infrastructure job started",
        "-1",
      ],
      [
        { INFRA_PLAN_RESULT: "failure" },
        "Infrastructure: the Infrastructure plan failed, so nothing was applied or deployed (see the run).",
        "0",
      ],
      [
        { INFRA_PLAN_RESULT: "failure", INFRA_PLAN_REFUSED: "true" },
        "Infrastructure: the Infrastructure plan's guards refused it, so nothing was applied or deployed. Dispatch again with allow_destroy or allow_access_removal if you meant it.",
        "0",
      ],
      // A staging rebuild: the Infrastructure job's outcome; staging's own outcome isn't paged.
      [
        {
          PLAN_HOST_ACTION: "deploy",
          PLAN_VERSION: "2.37.1",
          PLAN_REBUILD: "staging",
          INFRA_RESULT: "success",
          INFRA_OUTCOME: "applied",
          INFRA_PINNED: "staging",
        },
        "Rebuild of staging: applied; host keys pinned: staging",
        "0",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "allow", PLAN_HOST_ACTION: "infra" },
        "Infrastructure: the plan stopped (allow); nothing ran (see the run)",
        "0",
      ],
    ];
    for (const [env, message, priority] of cases) {
      const r = report({ ...infraOnly, ...env });
      expect({ env, message: r.message, priority: r.priority }).toEqual({ env, message, priority });
    }
  });

  test("the credentials reach curl on stdin, never in its arguments", () => {
    const r = report({});
    expect(r.config).toBe('form-string = "token=app-token"\nform-string = "user=user-key"\n');
    expect(r.args.join(" ")).not.toMatch(/app-token|user-key/u);
    expect(r.args).toContain("https://api.pushover.net/1/messages.json");
    expect(r.args).toContain("url=https://github.com/deconfined/tarubot/actions/runs/36300000042");
    expect(r.args).toContain("title=TaruBot deploy");
    expect(r.args).toContain("url_title=Deploy run");
  });

  test("values that don't match their pattern never reach the message", () => {
    const r = report({
      OUTCOME: "refused",
      REASON: "busy; rm -rf /",
      PLAN_VERSION: "2.37.1\nx",
    });
    expect(r.message).toBe("? not deployed to prod, nothing changed on the host: ?");
    const pinned = report({ INFRASTRUCTURE: "applied", PINNED: "prod 192.0.2.1" });
    expect(pinned.message).toBe(
      "2.37.1 deployed to prod; commands registered; infrastructure applied; host keys pinned: ?",
    );
    const step = report({ OUTCOME: "failed", STEP: "a b", REASON: "x", RESTORE_POINT: "soon" });
    expect(step.message).toBe("NEEDS YOU: 2.37.1 failed on prod at ? (x)");
  });

  test("without Pushover set up, it sends nothing and succeeds", () => {
    const r = report({ PUSHOVER_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.args).toEqual([]);
    expect(r.stdout).toContain("::notice::Pushover isn't set up in the notify environment");
  });
});

describe.skipIf(!hasJq)("the plan step", () => {
  const R = "repos/deconfined/tarubot";
  const sha = (seed: string) => new Bun.CryptoHasher("sha1").update(seed).digest("hex");
  const C = sha("release");
  const P = sha("previous");
  const D = `sha256:${"cd".repeat(32)}`;
  const IMAGE = "ghcr.io/deconfined/tarubot";
  /** github.sha: main's head when the run was created, which Configure and OpenTofu run from. */
  const CONFIG = sha("main");
  /** The release these runs deploy, a newer one to leave, and the one before it on main. */
  const V = "2.37.1";
  const NEWER = "2.37.2";
  /** A file of the simulated API, named as the gh stub looks it up. */
  const api = (dir: string, path: string, body: unknown) => {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(
      join(dir, "api", path.replaceAll(/[/?=]/gu, "_")),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };

  interface File {
    filename: string;
    status: string;
    patch?: string;
    previous_filename?: string;
  }

  /** What a test may change in the simulated repository, registry and run. */
  interface Overrides {
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

  /** The simulated repository and registry for the release at commit C. No environment is there. */
  function repository(overrides: Overrides) {
    const where = box();
    const release = overrides.release ?? V;
    writeFileSync(join(where.dir, "now"), `${overrides.now ?? "4 1200"}\n`);
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

  /** A finished plan, with the gh attestation verify calls it made and the API paths it read. */
  function planned(where: { dir: string }, result: ReturnType<typeof runScript>) {
    const log = join(where.dir, "attest-calls");
    const attestations = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("call\n")
          .filter(Boolean)
          .map((c) => c.trimEnd().split("\n"))
      : [];
    const calls = join(where.dir, "api-calls");
    const apiCalls = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    return { ...result, attestations, apiCalls };
  }

  /** A workflow_run's inputs: GitHub hands an automatic run none. */
  const NO_INPUTS = {
    INPUT_VERSION: "",
    INPUT_TARGET: "",
    INPUT_ACTION: "",
    INPUT_REBUILD: "",
    INPUT_ALLOW_DESTROY: "",
    INPUT_ALLOW_ACCESS_REMOVAL: "",
    INPUT_ROLLBACK: "",
    INPUT_FROM: "",
  };

  /** Run the plan for an automatic run of the release whose merge changed `files`. */
  function plan(files: File[], overrides: Overrides = {}) {
    const where = repository(overrides);
    api(where.dir, `${R}/contents/package.json?ref=${P}`, { version: "2.37.0" });
    api(where.dir, `${R}/commits/${C}`, { parents: [{ sha: P }] });
    api(where.dir, `${R}/compare/${P}...${C}`, { files });
    return planned(
      where,
      runScript(runOf("plan", "plan"), where, {
        ...environment(overrides),
        ...NO_INPUTS,
        EVENT: "workflow_run",
        HEAD_SHA: C,
      }),
    );
  }

  /** The newer release at commit C2, which a rollback to V leaves. */
  const C2 = sha("newer");
  const D2 = `sha256:${"ef".repeat(32)}`;

  /** A dispatch's inputs; the target is staging, as the input's default, unless named. */
  interface Inputs {
    readonly version: string;
    readonly target?: string;
    readonly action?: string;
    readonly rebuild?: boolean;
    readonly allow_destroy?: boolean;
    readonly allow_access_removal?: boolean;
    readonly rollback?: boolean;
    readonly from?: string;
  }

  /** Run the plan for a dispatch; `between` is what changed from V to NEWER. */
  function dispatch(inputs: Inputs, overrides: Overrides & { between?: File[] } = {}) {
    const where = repository(overrides);
    writeFileSync(join(where.dir, "images", NEWER), `${D2} ${C2}\n`);
    api(where.dir, `${R}/compare/${C}...${C2}`, { files: overrides.between ?? [] });
    const flag = (value?: boolean) => (value ? "true" : "false");
    return planned(
      where,
      runScript(runOf("plan", "plan"), where, {
        ...environment(overrides),
        EVENT: "workflow_dispatch",
        HEAD_SHA: "",
        INPUT_VERSION: inputs.version,
        INPUT_TARGET: inputs.target ?? "staging",
        INPUT_ACTION: inputs.action ?? "deploy",
        INPUT_REBUILD: flag(inputs.rebuild),
        INPUT_ALLOW_DESTROY: flag(inputs.allow_destroy),
        INPUT_ALLOW_ACCESS_REMOVAL: flag(inputs.allow_access_removal),
        INPUT_ROLLBACK: flag(inputs.rollback),
        INPUT_FROM: inputs.from ?? "",
      }),
    );
  }
  const version = {
    filename: "package.json",
    status: "modified",
    patch: `@@ -1 +1 @@\n-  "version": "2.37.0",\n+  "version": "${V}",`,
  };
  const source = [{ filename: "src/main.ts", status: "modified" }];
  const docsOnly = [{ filename: "docs/HOSTING.md", status: "modified" }, version];
  /** Production's path is the prod host: DEPLOY_ENABLED isn't exactly `true`. */
  const prodPath = { switches: { production: "" } } as const;
  const toStaging = { version: V, target: "staging" } as const;
  const toProd = { version: V, target: "prod" } as const;
  const toProduction = { version: V, target: "production" } as const;
  /** The target outputs, all off; a test spreads what it expects on. */
  const OFF = {
    production: "false",
    staging: "false",
    prod: "false",
    production_reason: "-",
    infra: "false",
    pin_scope: "",
    rebuild: "",
    allow_destroy: "false",
    allow_access_removal: "false",
  };
  /** The release outputs of V. */
  const RELEASE = {
    version: V,
    action: "deploy",
    commit: C,
    digest: D,
    from: "-",
    schema_head: "010_status_notices.sql",
  };

  test("a merge of documentation, tests, CI and OpenTofu asks for nothing, on either path", () => {
    const files = [
      { filename: "docs/HOSTING.md", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
      { filename: "tests/unit/x.test.ts", status: "added" },
      { filename: ".github/workflows/ci.yml", status: "modified" },
      { filename: ".github/workflows/host.yml", status: "modified" },
      { filename: ".github/workflows/deploy.yml", status: "modified" },
      { filename: ".github/CODEOWNERS", status: "added" },
      { filename: "site/src/content/docs/index.md", status: "modified" },
      { filename: "ops/tofu/main.tf", status: "modified" },
      { filename: "ops/tofu/ci/host.sh", status: "modified" },
      { filename: "ops/tofu/examples/user-data-with-hash.yaml", status: "modified" },
      { filename: "ops/ansible/requirements-lint.txt", status: "modified" },
      version,
    ];
    for (const overrides of [{}, prodPath]) {
      const p = plan(files, overrides);
      expect(p.code).toBe(0);
      expect(p.outputs).toMatchObject({
        ...OFF,
        deploy: "false",
        reason: "no-runtime-change",
        version: V,
      });
      expect(p.summary).toContain("nothing to deploy");
      // It was verified all the same: the provenance check comes before this exit.
      expect(p.summary).toContain(
        `Provenance verified: publish.yml on refs/heads/main, commit ${C}`,
      );
      expect(p.summary).toContain("run **Deploy** with the newest version");
      expect(p.summary).toContain(
        "An OpenTofu change is applied by dispatching **Deploy** with action=infra.",
      );
    }
  });

  test("a runtime merge deploys staging and asks for the Compose host while DEPLOY_ENABLED is exactly true", () => {
    for (const files of [
      [{ filename: "src/main.ts", status: "modified" }],
      [{ ...version, patch: '@@ -1 +1 @@\n-  "zod": "4.1.0",\n+  "zod": "4.2.0",' }],
      [{ filename: "package.json", status: "modified" }],
      [{ filename: ".github/workflows/publish.yml", status: "modified" }],
      [{ filename: "ops/deploy.sh", status: "modified" }],
      [{ filename: "ops/ansible/site.yml", status: "modified" }],
      [{ filename: "ops/ansible/bot.yml", status: "modified" }],
      [{ filename: "ops/ansible/vars/targets/prod.yml", status: "modified" }],
      // The hosts' Configure and Bot steps install this ansible-core.
      [{ filename: "ops/ansible/requirements.txt", status: "modified" }],
      [{ filename: "docs/moved.ts", status: "renamed", previous_filename: "src/moved.ts" }],
    ]) {
      const p = plan(files as File[]);
      expect({ file: files[0]?.filename, code: p.code, outputs: p.outputs }).toEqual({
        file: files[0]?.filename,
        code: 0,
        outputs: {
          ...OFF,
          ...RELEASE,
          notify: "true",
          report: "false",
          host_action: "deploy",
          config_commit: CONFIG,
          production: "true",
          staging: "true",
          deploy: "true",
          reason: "-",
        },
      });
    }
    // Otherwise it asks for prod, which plans first; notify leaves it to Report.
    const p = plan(source, prodPath);
    expect(p.outputs).toEqual({
      ...OFF,
      ...RELEASE,
      notify: "false",
      report: "true",
      host_action: "deploy",
      config_commit: CONFIG,
      staging: "true",
      prod: "true",
      infra: "true",
      pin_scope: "prod",
      deploy: "true",
      reason: "-",
    });
  });

  test("DEPLOY_ENABLED picks production's path until 2.38.0: exactly true is Compose, anything else prod", () => {
    for (const value of ["", "false", "True", "TRUE", "yes", "1"]) {
      const p = plan(source, { switches: { production: value } });
      expect({
        value,
        code: p.code,
        production: p.outputs.production,
        prod: p.outputs.prod,
        notify: p.outputs.notify,
        report: p.outputs.report,
      }).toEqual({
        value,
        code: 0,
        production: "false",
        prod: "true",
        notify: "false",
        report: "true",
      });
      expect(p.summary).toContain(
        "**Production is the `prod` host:** `DEPLOY_ENABLED` isn't exactly `true`, so the Compose host's job is left out.",
      );
    }
    // A production (Compose) dispatch while the switch is off plans nothing and fails nothing, as
    // in 2.35.0; Notify hears of it only when the switch reads as true to GitHub's expressions.
    for (const [value, notify] of [
      ["", "false"],
      ["false", "false"],
      ["True", "true"],
    ] as const) {
      const p = dispatch(toProduction, { switches: { production: value } });
      expect({ value, code: p.code, outputs: p.outputs }).toEqual({
        value,
        code: 0,
        outputs: {
          ...OFF,
          notify,
          report: "false",
          host_action: "deploy",
          production_reason: "paused",
          deploy: "false",
          reason: "paused",
        },
      });
      expect(p.summary).toContain("## Deploy: paused");
      expect(p.attestations).toEqual([]);
    }
    // Staging and prod have no switch: a dispatch goes on whatever DEPLOY_ENABLED reads.
    for (const value of ["", "false", "true"])
      for (const target of ["staging", "prod"]) {
        const p = dispatch({ version: V, target }, { switches: { production: value } });
        expect({ value, target, code: p.code, on: p.outputs[target] }).toEqual({
          value,
          target,
          code: 0,
          on: "true",
        });
      }
  });

  test("decides first which job reports the run, and keeps that through a failure", () => {
    expect(plan(source).outputs).toMatchObject({ notify: "true", report: "false" });
    expect(plan(source, prodPath).outputs).toMatchObject({ notify: "false", report: "true" });
    expect(dispatch(toProduction).outputs).toMatchObject({ notify: "true", report: "false" });
    expect(dispatch(toStaging).outputs).toMatchObject({ notify: "false", report: "false" });
    // Every new-path request writes notify=false and report=true.
    for (const inputs of [
      toProd,
      { ...toProd, action: "bot" },
      { ...toProd, action: "configure" },
      { ...toStaging, action: "infra" },
      { ...toProd, action: "infra" },
      { ...toStaging, rebuild: true },
    ]) {
      const p = dispatch(inputs);
      expect({ inputs, notify: p.outputs.notify, report: p.outputs.report }).toEqual({
        inputs,
        notify: "false",
        report: "true",
      });
    }
    // Written before anything can fail: an unattested image or a refused request still reaches
    // the message.
    const unattested = plan(source, { ...prodPath, attestedFor: null });
    expect({ code: unattested.code, outputs: unattested.outputs }).toMatchObject({
      code: 1,
      outputs: { notify: "false", report: "true", reason: "unattested" },
    });
    const refused = dispatch({ ...toProd, rollback: true, from: NEWER });
    expect({ code: refused.code, outputs: refused.outputs }).toMatchObject({
      code: 1,
      outputs: { notify: "false", report: "true", reason: "rollback-target" },
    });
    expect(plan(docsOnly).outputs).toMatchObject({ notify: "true", report: "false" });
  });

  test("writes each output once, so no later line can overrule the one a job reads", () => {
    for (const p of [
      plan(source),
      plan(source, prodPath),
      plan(docsOnly),
      dispatch(toProduction),
      dispatch(toProduction, { switches: { production: "" } }),
      dispatch(toStaging),
      dispatch({ ...toStaging, action: "configure", rebuild: true }),
      dispatch({ ...toProd, action: "bot" }),
      dispatch({ ...toStaging, action: "infra", allow_destroy: true }),
      dispatch({ version: V, target: "production", rollback: true, from: NEWER }),
    ]) {
      const repeated = p.keys.filter((key, i) => p.keys.indexOf(key) !== i);
      expect({ keys: p.keys.length > 5, repeated }).toEqual({ keys: true, repeated: [] });
    }
  });

  test("the target and action decide what runs, what plans, and whose host keys it pins", () => {
    type Row = [Inputs, Partial<typeof OFF> & { host_action: string; report: string }];
    const table: Row[] = [
      // Staging's actions never plan; a rebuild plans for staging's own host.
      [toStaging, { staging: "true", host_action: "deploy", report: "false" }],
      [
        { ...toStaging, action: "bot" },
        { staging: "true", host_action: "bot", report: "false" },
      ],
      [
        { ...toStaging, action: "configure" },
        { staging: "true", host_action: "configure", report: "false" },
      ],
      [
        { ...toStaging, action: "preflight" },
        { staging: "true", host_action: "preflight", report: "false" },
      ],
      [
        { ...toStaging, rebuild: true },
        {
          staging: "true",
          infra: "true",
          pin_scope: "staging",
          rebuild: "staging",
          host_action: "deploy",
          report: "true",
        },
      ],
      [
        { ...toStaging, action: "configure", rebuild: true },
        {
          staging: "true",
          infra: "true",
          pin_scope: "staging",
          rebuild: "staging",
          host_action: "configure",
          report: "true",
        },
      ],
      // action=infra: OpenTofu alone, for every host's keys; no host job.
      [
        { ...toStaging, action: "infra" },
        { infra: "true", pin_scope: "all", host_action: "infra", report: "true" },
      ],
      [
        { ...toProd, action: "infra" },
        { infra: "true", pin_scope: "all", host_action: "infra", report: "true" },
      ],
      [
        { ...toProd, action: "infra", rebuild: true },
        { infra: "true", pin_scope: "all", rebuild: "prod", host_action: "infra", report: "true" },
      ],
      // Prod plans for every action but bot, the rollback lever.
      [
        toProd,
        { prod: "true", infra: "true", pin_scope: "prod", host_action: "deploy", report: "true" },
      ],
      [
        { ...toProd, action: "bot" },
        { prod: "true", host_action: "bot", report: "true" },
      ],
      [
        { ...toProd, action: "configure" },
        {
          prod: "true",
          infra: "true",
          pin_scope: "prod",
          host_action: "configure",
          report: "true",
        },
      ],
      [
        { ...toProd, action: "preflight" },
        {
          prod: "true",
          infra: "true",
          pin_scope: "prod",
          host_action: "preflight",
          report: "true",
        },
      ],
      [
        { ...toProd, rebuild: true },
        {
          prod: "true",
          infra: "true",
          pin_scope: "prod",
          rebuild: "prod",
          host_action: "deploy",
          report: "true",
        },
      ],
      [
        { ...toProd, allow_destroy: true, allow_access_removal: true },
        {
          prod: "true",
          infra: "true",
          pin_scope: "prod",
          allow_destroy: "true",
          allow_access_removal: "true",
          host_action: "deploy",
          report: "true",
        },
      ],
      [
        { ...toStaging, rebuild: true, allow_access_removal: true },
        {
          staging: "true",
          infra: "true",
          pin_scope: "staging",
          rebuild: "staging",
          allow_access_removal: "true",
          host_action: "deploy",
          report: "true",
        },
      ],
      [toProduction, { production: "true", host_action: "deploy", report: "false" }],
    ];
    for (const [inputs, expected] of table) {
      const p = dispatch(inputs);
      const { report, host_action, ...targets } = expected;
      expect({
        inputs,
        code: p.code,
        targets: Object.fromEntries(Object.keys(OFF).map((k) => [k, p.outputs[k]])),
        host_action: p.outputs.host_action,
        report: p.outputs.report,
        deploy: p.outputs.deploy,
      }).toEqual({
        inputs,
        code: 0,
        targets: { ...OFF, ...targets },
        host_action,
        report,
        deploy: "true",
      });
    }
  });

  test("refuses what the request can't mean, before any image or provenance is read", () => {
    const table: [Inputs, string][] = [
      [{ version: V, target: "preview" }, "target"],
      [{ version: V, target: "" }, "target"],
      [{ version: V, target: "Prod" }, "target"],
      [{ ...toStaging, action: "restart" }, "action"],
      [{ ...toStaging, action: "" }, "action"],
      [{ ...toStaging, action: "deploy " }, "action"],
      [{ ...toStaging, action: "Bot" }, "action"],
      // The Compose host takes deploy alone, and never a rebuild.
      ...(["bot", "configure", "preflight", "infra"].map((action) => [
        { ...toProduction, action },
        "action",
      ]) as [Inputs, string][]),
      [{ ...toProduction, rebuild: true }, "rebuild"],
      // rollback and from are the Compose host's; staging and prod go back with action=bot.
      ...(["staging", "prod"].flatMap((target) => [
        [{ version: V, target, rollback: true, from: NEWER }, "rollback-target"],
        [{ version: V, target, rollback: true }, "rollback-target"],
        [{ version: V, target, from: NEWER }, "rollback-target"],
        [{ version: V, target, action: "bot", rollback: true, from: NEWER }, "rollback-target"],
      ]) as [Inputs, string][]),
      // action=bot never plans, so it rebuilds nothing.
      [{ ...toStaging, action: "bot", rebuild: true }, "rebuild"],
      [{ ...toProd, action: "bot", rebuild: true }, "rebuild"],
      // The switches that allow a destructive plan need a run that plans.
      [{ ...toStaging, allow_destroy: true }, "allow"],
      [{ ...toStaging, action: "configure", allow_access_removal: true }, "allow"],
      [{ ...toProd, action: "bot", allow_destroy: true }, "allow"],
      [{ ...toProduction, allow_destroy: true }, "allow"],
    ];
    for (const [inputs, reason] of table) {
      const p = dispatch(inputs);
      expect({
        inputs,
        code: p.code,
        reason: p.outputs.reason,
        deploy: p.outputs.deploy,
        attestations: p.attestations,
        summary: p.summary,
      }).toEqual({ inputs, code: 1, reason, deploy: undefined, attestations: [], summary: "" });
      expect(p.stdout).toContain("::error::");
    }
  });

  test("reads no environment's settings: the gate is gone, with its permission", () => {
    const planScript = runOf("plan", "plan");
    expect(planScript).not.toMatch(/environments|gate\(\)|protection_rules|can_admins_bypass/u);
    expect(deploy.jobs.plan.permissions).not.toHaveProperty("actions");
    for (const p of [
      plan(source),
      plan(source, prodPath),
      dispatch(toProd),
      dispatch(toProduction),
      dispatch({ ...toStaging, action: "configure" }),
    ]) {
      expect(p.code).toBe(0);
      expect(p.apiCalls.filter((c) => c.includes("environments"))).toEqual([]);
    }
  });

  test("verifies the image's signed provenance with gh by its exact identity, logging in nowhere", () => {
    const p = plan(source);
    expect(p.code).toBe(0);
    // One call, with the exact flags: main's publish.yml, built from C, SLSA provenance, on a
    // GitHub-hosted runner.
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
    // A dispatch verifies the digest it resolved, for the commit the image's label names, for
    // every target and every release action.
    for (const inputs of [
      toProduction,
      toStaging,
      toProd,
      { ...toProd, action: "bot" },
      { ...toStaging, action: "preflight" },
    ]) {
      const d = dispatch(inputs);
      expect({ inputs, calls: d.attestations }).toEqual({ inputs, calls: p.attestations });
    }
  });

  test("an unattested image is refused before the plan can end early or deploy anything", () => {
    const refusals: [string, ReturnType<typeof plan>][] = [
      ["a quiet merge, no attestation", plan(docsOnly, { attestedFor: null })],
      ["a runtime merge, no attestation", plan(source, { attestedFor: null })],
      ["the prod path, no attestation", plan(source, { ...prodPath, attestedFor: null })],
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
      ["a Compose dispatch, no attestation", dispatch(toProduction, { attestedFor: null })],
      ["a staging dispatch, no attestation", dispatch(toStaging, { attestedFor: null })],
      ["a prod dispatch, no attestation", dispatch(toProd, { attestedFor: null })],
      [
        "a prod bot dispatch, no attestation",
        dispatch({ ...toProd, action: "bot" }, { attestedFor: null }),
      ],
      [
        "a staging preflight, no attestation",
        dispatch({ ...toStaging, action: "preflight" }, { attestedFor: null }),
      ],
      [
        "a rollback, no attestation",
        dispatch({ ...toProduction, rollback: true, from: NEWER }, { attestedFor: null }),
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
        prod: p.outputs.prod,
        infra: p.outputs.infra,
        summary: p.summary,
      }).toEqual({
        what,
        code: 1,
        reason: "unattested",
        deploy: undefined,
        production: undefined,
        staging: undefined,
        prod: undefined,
        infra: undefined,
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
      for (const overrides of [{}, prodPath]) {
        const p = plan(files, overrides);
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
    }
    // A rollback's range is read the same way, before the migration check and the host-side list.
    const rollback = { ...toProduction, rollback: true, from: NEWER };
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
    const files = [
      { filename: "migrations/011_more.sql", status: "added" },
      { filename: "docker-compose.production.yml", status: "modified" },
      { filename: "ops/deploy.sh", status: "modified" },
    ];
    const p = plan(files);
    expect(p.outputs.deploy).toBe("true");
    expect(p.summary).toContain("**Migration files added in this merge:** migrations/011_more.sql");
    expect(p.summary).toContain(
      "**Host-side changes in this merge** (on production's Docker host they run as a docker-group user, which is root-equivalent there; on the staging and prod hosts Configure runs `ops/ansible/site.yml` as root, and the release's `ops/ansible/bot.yml` runs the bot as the unprivileged `tarubot` user):",
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
    // The prod path lists the same, and says what approving `prod` runs.
    const prod = plan(files, prodPath);
    expect(prod.summary).toContain(
      "**Migration files added in this merge:** migrations/011_more.sql",
    );
    expect(prod.summary).toContain("- `ops/deploy.sh`");
    expect(prod.summary).toContain(
      "**Targets:** prod, once @deconfined approves `prod`, and staging, which deploys beside the approval request, without one.",
    );
    expect(prod.summary).not.toContain(`**Approving** runs Deploy ${V}`);
    // The retired staging template is still listed, but no host has a .env to check for it.
    const retired = plan([{ filename: "staging.env.example", status: "removed" }, ...source]);
    expect(retired.summary).toContain("- `staging.env.example`");
    expect(retired.summary).not.toContain("check production's .env first");
    const template = plan([{ filename: "production.env.example", status: "modified" }, ...source]);
    expect(template.summary).toContain("check production's .env first");
  });

  test("a merge without host-side changes says so for this merge only, never a bare none", () => {
    for (const overrides of [{}, prodPath]) {
      const p = plan(source, overrides);
      expect(p.summary).toContain(
        "**Host-side changes in this merge**: no file under `ops/`, `docker-compose.production.yml` or `production.env.example` changed.",
      );
      expect(p.summary).toContain("the host-side changes of the releases in between run too");
      expect(p.summary).not.toMatch(/\*\*Host-side changes:\*\* none/u);
    }
  });

  test("approving prod is spelled out before it waits: the plan it adopts, the keys, Configure, the bot", () => {
    const cfg = CONFIG.slice(0, 12);
    const adopt =
      "adopts the **Infrastructure plan** job's saved plan (only if it is that file, with the change list that job shows under **Infrastructure plan**), applies it only if it has changes, and pins the host keys that job lists under **Host keys** (a new host's key is trusted on first use)";
    const configure = `runs Configure, \`ops/ansible/site.yml\` at main's head (\`${cfg}\`), as root on the prod host`;
    const merge = plan(source, prodPath);
    for (const part of [
      `**Approving \`prod\`** runs one job on the prod host: it ${adopt}; ${configure}; then ${V}'s own \`ops/ansible/bot.yml\` (\`${C.slice(0, 12)}\`, \`${D}\`) writes the bot's secrets, settings and unit as the unprivileged \`tarubot\` user and restarts the bot, and \`migrate.js\` runs before the start, to the schema head \`010_status_notices.sql\`.`,
      `It waits for healthy, then registers ${V}'s commands globally.`,
      "the way back is a dispatch of the previous version with target=prod and action=bot.",
      `**Infrastructure:** the **Infrastructure plan** job plans \`ops/tofu\` at main's head (\`${cfg}\`) with read-only credentials and no approval`,
      `**Tried on staging?** Check before approving. Staging deploys beside this request: its **Staging** job shows how ${V} went there`,
      `**Staging** takes ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) at once, beside the approval request and without one.`,
    ])
      expect({ part, found: merge.summary.includes(part) }).toEqual({ part, found: true });
    // action=bot, the rollback lever: no plan, no Configure, and the migration check.
    const bot = dispatch({ ...toProd, action: "bot" });
    for (const part of [
      `**Approving \`prod\`** moves prod to ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) without a plan or Configure:`,
      `It refuses before anything stops if the live bot runs and the live release has a migration ${V} lacks; if the bot is down, ${V}'s own \`migrate.js\` decides at the restart and refuses a newer schema without writing.`,
      `It waits for healthy, then registers ${V}'s commands globally.`,
      `**Tried on staging?** Check before approving: the **Staging** job of ${V}'s automatic run shows how it went there`,
    ])
      expect({ part, found: bot.summary.includes(part) }).toEqual({ part, found: true });
    expect(bot.summary).not.toMatch(/\*\*Infrastructure:\*\*|adopts the/u);
    const preflight = dispatch({ ...toProd, action: "preflight" });
    for (const part of [
      `**Approving \`prod\`** preflights ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) on the prod host: it ${adopt}; ${configure}; then`,
      "runs `migrate.js` to the schema head `010_status_notices.sql` and one backup, and starts no bot. It refuses a host where a bot unit exists.",
    ])
      expect({ part, found: preflight.summary.includes(part) }).toEqual({ part, found: true });
    // A rebuild says what it replaces, before the approval.
    const rebuild = dispatch({ ...toProd, rebuild: true });
    expect(rebuild.summary).toContain(`## Deploy ${V} (rebuild)`);
    expect(rebuild.summary).toContain(
      '**Rebuild:** the plan replaces the `prod` host\'s instance (`linode_instance.host["prod"]`) with a new Linode.',
    );
    // Replacing the instance stops its bot. A deploy starts it again on the new host; after a
    // configure or preflight the host already has its account, so the live version's bot action
    // does, and after infra (no Configure yet) a deploy.
    const stops =
      "A bot on the old instance stops with it: `action=deploy` starts the release on the new host; after `configure` or `preflight` the host runs no bot until you dispatch the live version with `action=bot`, and after `infra`, with `action=deploy`.";
    expect(rebuild.summary).toContain(stops);
    expect(dispatch({ ...toProd, action: "configure", rebuild: true }).summary).toContain(stops);
    // So do the switches that allow a destructive plan.
    const allowed = dispatch({ ...toProd, allow_destroy: true, allow_access_removal: true });
    expect(allowed.summary).toContain(
      "**Allowed in this plan:** deletes and replaces (`allow_destroy`).",
    );
    expect(allowed.summary).toContain(
      "**Allowed in this plan:** removals from a database access list (`allow_access_removal`).",
    );
    // Nothing says the Compose host's approval text for prod.
    for (const summary of [merge.summary, bot.summary, preflight.summary])
      expect(summary).not.toContain("**Approving** runs Deploy");
  });

  test("the approval wording ties the docker-group claim to production's Docker host alone", () => {
    const hostFile: File[] = [{ filename: "ops/backup.sh", status: "modified" }];
    const summaries = [
      plan(hostFile).summary,
      plan(hostFile, prodPath).summary,
      dispatch(toProduction).summary,
      dispatch({ ...toProduction, rollback: true, from: NEWER }, { between: hostFile }).summary,
      dispatch(toStaging).summary,
      dispatch({ ...toStaging, action: "bot" }).summary,
      dispatch({ ...toStaging, action: "preflight" }).summary,
      dispatch(toProd).summary,
      dispatch({ ...toProd, action: "bot" }).summary,
    ];
    for (const summary of summaries) {
      // Every sentence that calls something root-equivalent names production's Docker host.
      for (const sentence of summary.split(/(?<=[.;:])\s+/u))
        if (/docker-group|root-equivalent/u.test(sentence))
          expect({ sentence, host: sentence.includes("production's Docker host") }).toEqual({
            sentence,
            host: true,
          });
      expect(summary).not.toMatch(/(staging|prod host)[^.]*docker-group/iu);
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
    const p = dispatch(toProduction);
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      ...RELEASE,
      deploy: "true",
      reason: "-",
      production: "true",
      staging: "false",
      prod: "false",
    });
    expect(p.summary).toContain(`## Deploy ${V}`);
    expect(p.summary).toContain(
      "**Host-side changes:** each host deploys from its live release to this commit. Before approving, check",
    );
    for (const [what, inputs, overrides, reason] of [
      ["a version that isn't X.Y.Z", { ...toProduction, version: "2.37" }, {}, "version"],
      ["an unpublished version", { ...toProd, version: "2.37.9" }, {}, "image"],
      ["an image with no revision label", toProd, { revision: "none" }, "image"],
      [
        "package.json at the commit naming another version",
        toStaging,
        { packageVersion: "2.37.0" },
        "version-mismatch",
      ],
      [
        "'from' without a rollback on the Compose host",
        { ...toProduction, from: NEWER },
        {},
        "from",
      ],
      [
        "a staging release that isn't X.Y.Z",
        { version: "2.37", target: "staging", action: "bot" },
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

  test("a Compose rollback names the live version and goes only to an older release on the same schema", () => {
    const ok = dispatch(
      { ...toProduction, rollback: true, from: NEWER },
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
      ["no 'from'", { ...toProduction, rollback: true, from: "" }, [], "from"],
      [
        "a newer target",
        { ...toProduction, rollback: true, from: "2.37.0" },
        [],
        "rollback-not-older",
      ],
      [
        "an added migration in between",
        { ...toProduction, rollback: true, from: NEWER },
        [{ filename: "migrations/011_x.sql", status: "added" }],
        "rollback-across-migration",
      ],
      [
        "a migration renamed away in between",
        { ...toProduction, rollback: true, from: NEWER },
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

  test("a staging dispatch deploys at once and asks for no approval", () => {
    const staged = dispatch(toStaging);
    expect(staged.code).toBe(0);
    expect(staged.summary).toContain(
      "**Target:** staging, which deploys at once, without approval.",
    );
    expect(staged.summary).toContain(`**Staging** takes ${V}`);
    expect(staged.summary).toContain("at once, without approval.");
    // Nothing waits for approval and nothing plans, so the plan asks for neither.
    expect(staged.summary).not.toMatch(
      /\*\*Approving|Tried on staging|Before approving|\*\*Infrastructure:\*\*/u,
    );
    // Its rebuild waits for the Infrastructure job, which @deconfined approves in prod.
    const rebuilt = dispatch({ ...toStaging, rebuild: true });
    expect(rebuilt.summary).toContain(
      "**Target:** staging, once @deconfined approves its rebuild in `prod`.",
    );
    expect(rebuilt.summary).toContain(
      `**Staging** takes ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) once the **Infrastructure** job has built the new host and pinned its key, without an approval of its own.`,
    );
    expect(rebuilt.summary).toContain(
      '**Rebuild:** the plan replaces the `staging` host\'s instance (`linode_instance.host["staging"]`) with a new Linode.',
    );
  });

  test("configure and infra dispatches touch no release: no image, provenance or runtime rule", () => {
    const at = `[\`${CONFIG.slice(0, 12)}\`](https://github.com/deconfined/tarubot/commit/${CONFIG})`;
    for (const version of [V, "9.9.9", "not-a-version"]) {
      const p = dispatch({ version, target: "staging", action: "configure" });
      expect({ version, code: p.code, outputs: p.outputs }).toEqual({
        version,
        code: 0,
        outputs: {
          ...OFF,
          notify: "false",
          report: "false",
          host_action: "configure",
          config_commit: CONFIG,
          staging: "true",
          deploy: "true",
          reason: "-",
        },
      });
      expect(p.attestations).toEqual([]);
      expect(p.summary).toBe(
        `## Configure staging\n\n**Staging** runs Configure at once, without approval: \`ops/ansible/site.yml\` at main's head (${at}), as root on the staging host. The bot and its release don't change.\n\n`,
      );
    }
    const prod = dispatch({ ...toProd, action: "configure" });
    expect(prod.attestations).toEqual([]);
    expect(prod.summary).toContain("## Configure prod\n");
    expect(prod.summary).toContain(
      "**Approving `prod`** runs one job on the prod host: it adopts the **Infrastructure plan** job's saved plan",
    );
    expect(prod.summary).toContain(
      `then runs Configure, \`ops/ansible/site.yml\` at main's head (${at}), as root on the prod host. The bot and its release don't change.`,
    );
    expect(prod.summary).toContain("**Infrastructure:**");
    const rebuild = dispatch({ ...toStaging, action: "configure", rebuild: true });
    expect(rebuild.summary).toContain("## Configure staging (rebuild)\n");
    expect(rebuild.summary).toContain(
      "**Staging** runs Configure once the **Infrastructure** job has built the new host and pinned its key",
    );
    // A rebuild's bot stops with the old instance, so neither target's rebuild says it is kept.
    const prodRebuild = dispatch({ ...toProd, action: "configure", rebuild: true });
    for (const [target, summary] of [
      ["staging", rebuild.summary],
      ["prod", prodRebuild.summary],
    ] as const)
      expect({
        target,
        deploysNone: summary.includes("It deploys no release."),
        kept: summary.includes("don't change"),
      }).toEqual({ target, deploysNone: true, kept: false });
    for (const target of ["staging", "prod"]) {
      const infra = dispatch({ version: "anything", target, action: "infra" });
      expect({ target, code: infra.code, attestations: infra.attestations }).toEqual({
        target,
        code: 0,
        attestations: [],
      });
      expect(infra.summary).toContain("## Infrastructure\n");
      expect(infra.summary).toContain(
        `**Infrastructure only:** the **Infrastructure plan** job plans \`ops/tofu\` at main's head (${at}) for every host. If it has changes or host keys to pin, **approving \`prod\`** in the **Infrastructure** job adopts`,
      );
      expect(infra.summary).toContain("Nothing runs on any host.");
    }
    // Without a commit of main to configure from, nothing goes on.
    for (const configCommit of ["", "main", CONFIG.toUpperCase()])
      for (const action of ["configure", "infra"]) {
        const p = dispatch({ ...toStaging, action }, { configCommit });
        expect({ configCommit, action, code: p.code, reason: p.outputs.reason }).toEqual({
          configCommit,
          action,
          code: 1,
          reason: "config-commit",
        });
      }
  });

  test("staging's deploy, bot and preflight each say what they do, and name the schema head", () => {
    const head = "`010_status_notices.sql`";
    const deployed = dispatch(toStaging);
    expect(deployed.outputs).toMatchObject({
      host_action: "deploy",
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
      host_action: "bot",
      action: "deploy",
      commit: C,
      digest: D,
    });
    for (const part of [
      `**Staging** moves to ${V} (\`${C.slice(0, 12)}\`, \`${D}\`) at once, without approval, without Configure: ${V}'s own \`ops/ansible/bot.yml\``,
      `to the schema head ${head}. It refuses before anything stops if the live bot runs and the live release has a migration ${V} lacks; if the bot is down, ${V}'s own \`migrate.js\` decides at the restart and refuses a newer schema without writing.`,
    ])
      expect({ part, found: bot.summary.includes(part) }).toEqual({ part, found: true });
    expect(bot.summary).not.toContain("Configure runs");
    const preflight = dispatch({ ...toStaging, action: "preflight" });
    expect(preflight.code).toBe(0);
    expect(preflight.outputs.host_action).toBe("preflight");
    for (const part of [
      `**Staging** preflights ${V}`,
      `runs \`migrate.js\` to the schema head ${head} and one backup, and starts no bot. It refuses a host where a bot unit exists.`,
    ])
      expect({ part, found: preflight.summary.includes(part) }).toEqual({ part, found: true });
  });

  test("each host takes its first release or later: staging 2.36.0, prod 2.37.0", () => {
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
    for (const release of ["2.37.0", V, "3.0.0"])
      for (const action of ["deploy", "bot", "preflight"]) {
        const p = dispatch({ version: release, target: "prod", action }, { release });
        expect({ release, action, code: p.code, prod: p.outputs.prod }).toEqual({
          release,
          action,
          code: 0,
          prod: "true",
        });
      }
    for (const [target, release, floor] of [
      ["staging", "2.35.0", "2.36.0"],
      ["staging", "2.35.99", "2.36.0"],
      ["prod", "2.36.0", "2.37.0"],
      ["prod", "2.36.99", "2.37.0"],
      ["prod", "1.99.99", "2.37.0"],
    ] as const) {
      const p = dispatch({ version: release, target, action: "bot" }, { release });
      expect({
        target,
        release,
        code: p.code,
        reason: p.outputs.reason,
        on: p.outputs[target],
      }).toEqual({ target, release, code: 1, reason: "below-floor", on: undefined });
      expect(p.stdout).toContain(
        `::error::${release} is older than ${floor}, the first release whose ops/ansible/bot.yml deploys ${target}.`,
      );
    }
    // Beside another target, an older release leaves the host out, and the other goes on.
    const merge = plan(source, { release: "2.35.99" });
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(merge.stdout).toContain("::warning::2.35.99 is older than 2.36.0");
    expect(merge.summary).toContain("**Staging is off in this run:** 2.35.99 is older than 2.36.0");
    const prodOff = plan(source, { ...prodPath, release: "2.36.5" });
    expect(prodOff.code).toBe(0);
    expect(prodOff.outputs).toMatchObject({
      prod: "false",
      infra: "false",
      pin_scope: "",
      staging: "true",
    });
    expect(prodOff.summary).toContain("**Prod is off in this run:** 2.36.5 is older than 2.37.0");
    // The Compose host has no such floor: it checks its own.
    expect(
      dispatch({ ...toProduction, version: "2.35.99" }, { release: "2.35.99" }).outputs.production,
    ).toBe("true");
  });

  test("warns about the Tuesday maintenance window and the daily backup by the clock", () => {
    const maintenance = "weekly maintenance runs Tuesdays 19:00-23:00 UTC";
    const backup = "The daily backup runs around now";
    for (const overrides of [{}, prodPath]) {
      const at = (now: string) => plan(source, { ...overrides, now }).summary;
      for (const now of ["2 1800", "2 1930", "2 2259"])
        expect({ now, s: at(now) }).toEqual({ now, s: expect.stringContaining(maintenance) });
      for (const now of ["2 1759", "2 2300", "3 2000", "1 1930"])
        expect({ now, s: at(now) }).toEqual({ now, s: expect.not.stringContaining(maintenance) });
      for (const now of ["4 0415", "2 0444"])
        expect({ now, s: at(now) }).toEqual({ now, s: expect.stringContaining(backup) });
      for (const now of ["4 0414", "4 0445", "4 1200"])
        expect({ now, s: at(now) }).toEqual({ now, s: expect.not.stringContaining(backup) });
    }
    // A prod dispatch before the approval too.
    expect(dispatch(toProd, { now: "2 2000" }).summary).toContain(maintenance);
  });

  test("an edited applied migration or another image behind the commit tag fails", () => {
    const edited = plan([{ filename: "migrations/001_init.sql", status: "modified" }]);
    expect(edited.code).toBe(1);
    expect(edited.outputs.reason).toBe("applied-migration-changed");
    for (const overrides of [{}, prodPath]) {
      const moved = plan(source, { ...overrides, shaDigest: `sha256:${"ef".repeat(32)}` });
      expect(moved.outputs.reason).toBe("digest-mismatch");
      // A moved tag is refused before gh is asked about the image.
      expect(moved.attestations).toEqual([]);
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
      [".github/CODEOWNERS", false],
      ["docker-compose.yml", false],
      ["docker-compose.devbot.yml", false],
      ["docker-compose.build.yml", false],
      ["docker-compose.tools.yml", false],
      [".env.example", false],
      ["production.env.example", false],
      ["staging.env.example", false],
      // OpenTofu reaches the hosts only through the Infrastructure plan and its approval.
      ["ops/tofu/main.tf", false],
      ["ops/tofu/ci/host.sh", false],
      ["ops/tofu/cloud-init.yaml.tftpl", false],
      ["ops/tofu/.terraform.lock.hcl", false],
      ["ops/tofu/README.md", false],
      // ansible-lint's pins feed only CI; requirements.txt is the hosts' Ansible (2.36.0).
      ["ops/ansible/requirements-lint.txt", false],
      ["ops/ansible/requirements.txt", true],
      ["ops/ansible/site.yml", true],
      ["ops/ansible/bot.yml", true],
      ["ops/ansible/vars/targets/staging.yml", true],
      ["ops/ansible/vars/targets/prod.yml", true],
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
