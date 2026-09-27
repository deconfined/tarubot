/**
 * The "Deploy" workflow (.github/workflows/deploy.yml: production since 2.30.0, issue #41; staging
 * and the provenance check since 2.33.0, issue #50) and what the other workflows must not do
 * around it.
 *
 * - Shape: the triggers and the `target` input, the first-attempt rule on every job, least
 *   permissions (no packages, no registry login), no action and no checkout, every ${{ }} through
 *   env:, no concurrency group, and which job may see which environment, secret and variable. The
 *   jobs' `if` expressions and the run's title are evaluated here with a small reader of GitHub's
 *   expression syntax, so each target's jobs run exactly when they should.
 * - The command contract and the result line are the same patterns as ops/deploy.sh's, in both SSH
 *   steps, which are the same script. The staging job's name, the staging title, the reviewer and
 *   the capability declaration agree with ops/deploy.sh.
 * - The repository names no host: the workflow and ops/deploy.sh carry no host name beyond
 *   GitHub's, the registry's and Pushover's.
 * - Behavior: the plan, SSH and notify scripts run here with simulated gh, docker, ssh, curl and
 *   date (tests/fixtures/deploy-workflow) to check the targets and their switches, gates and
 *   dispatcher rule, the image's provenance, the staging capability check, the runtime-change
 *   rule, the compare API's 300-file cap, dispatches and rollbacks, the host-side summary, the
 *   clock warnings, the SSH retry rules and the messages.
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

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");
const STUBS = root("tests/fixtures/deploy-workflow");
const hasJq = Bun.which("jq") !== null;

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
    jobs: z.object({ plan: job, deploy: job, "deploy-staging": job, notify: job }).strict(),
  })
  .strict();

const text = read(".github/workflows/deploy.yml");
const deploy = workflow.parse(YAML.parse(text));
const script = read("ops/deploy.sh");
type JobName = keyof typeof deploy.jobs;
/** One step, by its id or name. */
const stepOf = (jobName: JobName, key: string) => {
  const found = deploy.jobs[jobName].steps.find((s) => s.id === key || s.name === key);
  if (!found) throw new Error(`no step ${key} in ${jobName}`);
  return found;
};
/** One step's script, by its id or name. */
const runOf = (jobName: JobName, key: string) => {
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
/** The two deploy jobs, with the host each one reaches. */
const TARGETS = [
  { job: "deploy", name: "Deploy", environment: "production", minutes: 90, reconnect: 4800 },
  {
    job: "deploy-staging",
    name: "Deploy staging",
    environment: "staging",
    minutes: 30,
    reconnect: 300,
  },
] as const;
/** The capability declaration of interfaces §2: one line of ops/deploy.sh, its words sorted. */
const CAPABILITY_LINE = '^readonly CAPABILITIES="([a-z0-9]+( [a-z0-9]+)*)"$';

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

/** What a scenario sets: the event, a dispatch's inputs, the switches and the plan's result. */
interface Scenario {
  readonly event?: "workflow_run" | "workflow_dispatch";
  readonly target?: string;
  readonly rollback?: boolean;
  readonly version?: string;
  readonly from?: string;
  readonly attempt?: string;
  readonly switches?: { readonly production?: string; readonly staging?: string };
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
            version: scenario.version ?? "2.33.0",
            rollback: scenario.rollback ?? false,
            from: scenario.from ?? "",
            target: scenario.target ?? "production",
          }
        : {},
    vars: {
      DEPLOY_ENABLED: scenario.switches?.production ?? "true",
      STAGING_DEPLOY_ENABLED: scenario.switches?.staging ?? "true",
    },
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
    });
    const plan = deploy.jobs.plan.if;
    for (const term of [
      "github.run_attempt == '1' && (vars.DEPLOY_ENABLED == 'true' || vars.STAGING_DEPLOY_ENABLED == 'true') && (",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.path == '.github/workflows/publish.yml'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    ])
      expect({ term, present: plan.includes(term) }).toEqual({ term, present: true });
    // Either switch starts the plan; with both off nothing runs and no secret loads.
    for (const [production, staging, expected] of [
      ["true", "", true],
      ["", "true", true],
      ["true", "true", true],
      ["", "", false],
      ["false", "TRUE-ish", false],
    ] as const)
      for (const event of ["workflow_run", "workflow_dispatch"] as const)
        expect({
          production,
          staging,
          event,
          runs: runs("plan", { event, switches: { production, staging } }),
        }).toEqual({
          production,
          staging,
          event,
          runs: expected,
        });
  });

  test("refuses re-runs: every job requires the first attempt", () => {
    for (const [name, j] of Object.entries(deploy.jobs))
      expect({ name, first: j.if.trim().startsWith("github.run_attempt == '1' &&") }).toEqual({
        name,
        first: true,
      });
    for (const name of Object.keys(deploy.jobs) as JobName[])
      expect({ name, second: runs(name, { attempt: "2" }) }).toEqual({ name, second: false });
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

  test("titles each run with its target, as ops/deploy.sh expects", () => {
    const title = deploy["run-name"];
    expect(title).toContain("format('Deploy {0}{1}{2}', inputs.version,");
    expect(title).toContain("inputs.rollback && format(' rollback from {0}', inputs.from) || ''");
    expect(title).toContain("inputs.target == 'staging' && ' to staging' || ''");
    expect(title).toContain("format('Deploy {0}', github.event.workflow_run.head_sha)");
    const titleOf = (scenario: Scenario) => evaluate(title, contextOf(scenario));
    expect(titleOf({})).toBe("Deploy 0123456789abcdef0123456789abcdef01234567");
    const dispatch = { event: "workflow_dispatch", version: "2.33.0" } as const;
    expect(titleOf(dispatch)).toBe("Deploy 2.33.0");
    expect(titleOf({ ...dispatch, rollback: true, from: "2.33.1" })).toBe(
      "Deploy 2.33.0 rollback from 2.33.1",
    );
    expect(titleOf({ ...dispatch, target: "staging" })).toBe("Deploy 2.33.0 to staging");
    expect(titleOf({ ...dispatch, target: "staging", rollback: true, from: "2.33.1" })).toBe(
      "Deploy 2.33.0 rollback from 2.33.1 to staging",
    );
    // The host builds the same titles: production's three, and staging's with the suffix.
    expect(script).toContain('title="Deploy $V rollback from $F"');
    expect(script).toContain('title="Deploy $V"');
    expect(script).toContain('.display_title == ("Deploy " + $commit)');
    expect({ staging: script.includes('title+=" to staging"') }).toEqual({ staging: true });
  });

  test("the plan and every documented workstation check name the signer by its exact identity", () => {
    // gh turns --signer-workflow into a pattern anchored only at its start, so a workflow named
    // publish.yml-canary.yml would pass it; the certificate's full identity can't be matched so.
    const identity =
      "--cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main";
    const flat = (text: string) => text.replace(/\\\n[\s#]*/gu, " ");
    expect(flat(runOf("plan", "plan"))).toContain(identity);
    for (const path of [
      ".github/workflows/deploy.yml",
      "ops/ansible/site.yml",
      "docs/HOSTING.md",
      "docs/CI_CD.md",
      "site/src/content/docs/deploy/install.md",
    ]) {
      const text = read(path);
      expect({ path, exact: text.includes(identity) }).toEqual({ path, exact: true });
      expect({ path, prefix: /--signer-workflow [^\s/]+\//u.test(text) }).toEqual({
        path,
        prefix: false,
      });
    }
  });

  test("holds least permissions: nothing at the top, read-only for the plan, no packages", () => {
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
    for (const name of ["deploy", "deploy-staging", "notify"] as const)
      expect({ name, permissions: deploy.jobs[name].permissions }).toEqual({
        name,
        permissions: {},
      });
    // The package is public: the provenance check logs in nowhere and reads no package.
    expect(text).not.toMatch(/^\s*packages:/mu);
    expect(text).not.toMatch(/docker\s+login|--password-stdin|ghcr\.io\/token/u);
  });

  test("uses no action, no checkout, no expression inside a script, no tracing, no concurrency", () => {
    for (const j of Object.values(deploy.jobs))
      for (const s of j.steps) {
        expect(s.uses).toBeUndefined();
        expect(s.run ?? "").not.toContain("${{");
        expect(s.run ?? "").not.toMatch(/set -[a-zA-Z]*x/u);
      }
    expect(text).not.toMatch(/^\s*concurrency:/mu);
    expect(text).not.toContain("actions/checkout");
    // Each SSH step is written out, not shared through a YAML anchor.
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
    expect(refs(plan, "vars")).toEqual(["DEPLOY_ENABLED", "STAGING_DEPLOY_ENABLED"]);
    const production = deploy.jobs.deploy;
    expect(production.environment).toBe("production");
    expect(refs(production, "secrets")).toEqual(["DEPLOY_SSH_KEY"]);
    expect(refs(production, "vars")).toEqual([
      "DEPLOY_ENABLED",
      "DEPLOY_HOST",
      "DEPLOY_KNOWN_HOSTS",
    ]);
    // Staging's own key and host come from its own environment under the same names.
    const staging = deploy.jobs["deploy-staging"];
    expect(staging.environment).toBe("staging");
    expect(refs(staging, "secrets")).toEqual(["DEPLOY_SSH_KEY"]);
    expect(refs(staging, "vars")).toEqual([
      "DEPLOY_HOST",
      "DEPLOY_KNOWN_HOSTS",
      "STAGING_DEPLOY_ENABLED",
    ]);
    expect(notify.environment).toBe("notify");
    expect(refs(notify, "secrets")).toEqual(["PUSHOVER_TOKEN", "PUSHOVER_USER"]);
    expect(refs(notify, "vars")).toEqual(["DEPLOY_ENABLED"]);
    // Each key's file is removed even when the deploy fails or is cancelled.
    for (const j of [production, staging])
      expect(j.steps.at(-1)).toEqual({
        name: "Remove the key",
        if: "always()",
        run: 'rm -rf "$RUNNER_TEMP/ssh"',
      });
  });

  test("each deploy job checks its own switch again before its key loads", () => {
    for (const [name, variable] of [
      ["deploy", "DEPLOY_ENABLED"],
      ["deploy-staging", "STAGING_DEPLOY_ENABLED"],
    ] as const) {
      const first = deploy.jobs[name].steps[0];
      expect({ name, id: first?.id, env: first?.env }).toEqual({
        name,
        id: "start",
        env: { [variable]: `\${{ vars.${variable} }}` },
      });
      expect(first?.run).toContain(`if [ "$${variable}" != true ]; then`);
      expect(first?.run).toContain("reason=paused");
    }
  });

  test("pins the host key and uses only the deploy key", () => {
    for (const { job: name } of TARGETS) {
      const ssh = runOf(name, "ssh");
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
        expect({ name, option, present: ssh.includes(option) }).toEqual({
          name,
          option,
          present: true,
        });
      expect(ssh).not.toMatch(/accept-new|StrictHostKeyChecking=no|VerifyHostKeyDNS/u);
      expect(ssh).toContain("unset DEPLOY_SSH_KEY");
      expect(ssh).toContain("KNOWN_HOST='^([^ ]+) ssh-ed25519 [A-Za-z0-9+/]+={0,2}$'");
      expect(ssh).toContain('"tarubot@$DEPLOY_HOST" "$CMD"');
    }
  });

  test("the two SSH steps are one script, set apart only by their environment and deadline", () => {
    const production = stepOf("deploy", "ssh");
    const staging = stepOf("deploy-staging", "ssh");
    expect(staging.run).toBe(production.run);
    expect(staging.name).toBe(production.name);
    const {
      DEPLOY_ENVIRONMENT: pe,
      RECONNECT_SECONDS: pr,
      ...productionRest
    } = production.env ?? {};
    const { DEPLOY_ENVIRONMENT: se, RECONNECT_SECONDS: sr, ...stagingRest } = staging.env ?? {};
    expect(stagingRest).toEqual(productionRest);
    expect([pe, pr, se, sr]).toEqual(["production", "4800", "staging", "300"]);
    expect(production.run).toContain("deadline=$((SECONDS + RECONNECT_SECONDS))");
  });

  test("gives each host's run time to report before its job times out", () => {
    for (const target of TARGETS) {
      const j = deploy.jobs[target.job];
      const seconds = Number(stepOf(target.job, "ssh").env?.RECONNECT_SECONDS);
      // Production: ops/deploy.sh's waits and timeouts add up to about 68 minutes in the worst
      // case. Staging: the accepted plan's 30 minutes and 5-minute reconnect deadline.
      expect({
        job: target.job,
        name: j.name,
        environment: j.environment,
        minutes: j["timeout-minutes"],
        seconds,
      }).toEqual({
        job: target.job,
        name: target.name,
        environment: target.environment,
        minutes: target.minutes,
        seconds: target.reconnect,
      });
      expect(j["timeout-minutes"] * 60).toBeGreaterThan(seconds + 300);
    }
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
    expect(comments).toContain("the host-configuration pull unit (2.34.0) must too");
    // The recorded staging limits, and what happens to a staging run that outlives them.
    expect(comments).toContain("The trade-off: a staging run can outlive this job");
    expect(comments).toContain("the host's run directory");
    expect(comments).toContain("the next staging dispatch waits up to 300 s for the host lock");
  });
});

describe("the contract with ops/deploy.sh", () => {
  test("the command forms and the result line are the same patterns on both sides", () => {
    for (const { job: name } of TARGETS) {
      const ssh = runOf(name, "ssh");
      for (const form of [
        "DEPLOY_FORM",
        "ROLLBACK_FORM",
        "RESULT_FORM",
        "STEP_LINE",
        "WARNING_LINE",
      ])
        expect({ name, form, same: pattern(ssh, form) }).toEqual({
          name,
          form,
          same: pattern(script, form),
        });
    }
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

  test("the host looks for each deploy job by the name the workflow gives it", () => {
    // ops/deploy.sh requires a job with this name to be in progress; a rename would refuse every run.
    expect(deploy.jobs.deploy.name).toBe("Deploy");
    expect(script).toContain('.name == "Deploy" and .status == "in_progress"');
    expect(/^readonly STAGING_JOB='([^']+)'$/mu.exec(script)?.[1]).toBe(
      deploy.jobs["deploy-staging"].name,
    );
  });

  test("the plan and the host agree on the version pattern, the reviewer and the capability line", () => {
    const plan = runOf("plan", "plan");
    expect(pattern(plan, "VER")).toBe(pattern(script, "readonly VERSION"));
    // The one account that approves production and may dispatch staging, by login and id.
    const login = /^readonly REVIEWER=([a-z0-9-]+)$/mu.exec(script)?.[1];
    const id = /^readonly REVIEWER_ID=([0-9]+)$/mu.exec(script)?.[1];
    expect(plan).toContain(`\nREVIEWER=${login}\n`);
    expect(plan).toContain(`\nREVIEWER_ID=${id}\n`);
    expect(plan).toContain(`[{type: "User", login: "${login}"}]`);
    // The staging target's declaration is read with interfaces §2's exact pattern, and the
    // release carrying this workflow declares both words the plan asks for.
    expect(pattern(plan, "CAPABILITY_LINE")).toBe(CAPABILITY_LINE);
    expect(pattern(script, "readonly CAPABILITY_LINE")).toBe(CAPABILITY_LINE);
    const line = new RegExp(CAPABILITY_LINE, "u");
    const declared = script
      .split("\n")
      .filter((l) => line.test(l))
      .map((l) => line.exec(l)?.[1]?.split(" ").sort());
    expect(declared).toEqual([["quadlet", "staging"]]);
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
  const allowed = new Set([
    "github.com",
    "api.github.com",
    "ghcr.io",
    "api.pushover.net",
    "slsa.dev",
  ]);

  test("the workflow and ops/deploy.sh name no host beyond GitHub, GHCR and Pushover", () => {
    for (const [file, source] of [
      [".github/workflows/deploy.yml", text],
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
    // Each host comes from its environment's variable.
    for (const { job: name } of TARGETS)
      expect(runOf(name, "ssh")).toContain("[[ $DEPLOY_HOST =~ $HOST_NAME ]]");
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

  test("only deploy.yml names the deploy environments, switches, key, host and Pushover secrets", () => {
    for (const file of files) {
      const source = read(`.github/workflows/${file}`);
      const named =
        /environment:\s*(?:production|staging|notify)\b|DEPLOY_ENABLED|DEPLOY_SSH_KEY|DEPLOY_KNOWN_HOSTS|DEPLOY_HOST|PUSHOVER_/u.test(
          source,
        );
      expect({ file, named }).toEqual({ file, named: file === "deploy.yml" });
      // No workflow runs untrusted pull-request code with the repository's secrets.
      expect({ file, target: source.includes("pull_request_target") }).toEqual({
        file,
        target: false,
      });
    }
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
    expect(ci).toContain("shellcheck -S warning ops/*.sh");
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

describe("the SSH step", () => {
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
   * Run a deploy job's SSH step, with its own DEPLOY_ENVIRONMENT and RECONNECT_SECONDS from the
   * workflow, and ssh behaviors, one per connection attempt.
   */
  function ssh(
    behaviors: string[],
    env: Record<string, string> = {},
    jobName: "deploy" | "deploy-staging" = "deploy",
  ) {
    const where = box();
    writeFileSync(join(where.dir, "plan"), `${behaviors.join("\n")}\n`);
    const own = stepOf(jobName, "ssh").env ?? {};
    const settings = {
      DEPLOY_ENVIRONMENT: own.DEPLOY_ENVIRONMENT ?? "",
      RECONNECT_SECONDS: own.RECONNECT_SECONDS ?? "",
    };
    const result = runScript(runOf(jobName, "ssh"), where, { ...base, ...settings, ...env }, clock);
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

  test("the staging job sends the same command to its own host", () => {
    const s = ssh(["ok"], {}, "deploy-staging");
    expect(s.code).toBe(0);
    expect(s.outputs.outcome).toBe("deployed");
    expect(s.calls).toContain(`tarubot@${host}\ndeploy 2.30.1 ${commit} ${digest} 36300000042\n`);
    const rollback = ssh(
      ["ok"],
      { ACTION: "rollback", VERSION: "2.30.0", FROM: "2.30.1" },
      "deploy-staging",
    );
    expect(rollback.calls).toContain(`rollback 2.30.0 ${commit} ${digest} 36300000042 2.30.1\n`);
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

  test("staging's 5-minute reconnect deadline gives up much sooner than production's", () => {
    // Each pause moves the clock 1,000 s: production tries 6 times within 4,800 s, staging twice
    // within 300 s.
    const never = ssh(["noconnect"], {}, "deploy-staging");
    expect(never.outputs).toMatchObject({ reason: "unreachable", connected: "false" });
    expect(never.attempts).toBe(2);
    expect(ssh(["partial", "noconnect"], {}, "deploy-staging").outputs).toMatchObject({
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

  test("names the environment each job reads its settings from, production's as before", () => {
    const production = ssh(["ok"], { DEPLOY_SSH_KEY: "" });
    expect(production.stdout).toContain(
      "::error::DEPLOY_SSH_KEY isn't set in the production environment.\n",
    );
    expect(ssh(["ok"], { DEPLOY_HOST: "" }).stdout).toContain(
      "::error::DEPLOY_HOST must be the production host's DNS name.\n",
    );
    const staging = ssh(["ok"], { DEPLOY_SSH_KEY: "" }, "deploy-staging");
    expect(staging.stdout).toContain(
      "::error::DEPLOY_SSH_KEY isn't set in the staging environment.\n",
    );
    expect(ssh(["ok"], { DEPLOY_HOST: "" }, "deploy-staging").stdout).toContain(
      "::error::DEPLOY_HOST must be the staging host's DNS name.\n",
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
  const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
  /** ops/deploy.sh at a release that deploys staging; a comment alone never counts. */
  const capable = [
    "#!/usr/bin/env bash",
    '# The line: readonly CAPABILITIES="staging quadlet"',
    "readonly FLOOR=2.30.0",
    'readonly CAPABILITIES="staging quadlet"',
    "",
  ].join("\n");

  interface File {
    filename: string;
    status: string;
    patch?: string;
    previous_filename?: string;
  }

  /** What a test may change in the simulated repository, registry and run. */
  interface Overrides {
    readonly production?: unknown;
    /** The staging environment; null leaves it missing, as before its owner creates it. */
    readonly staging?: unknown;
    readonly stagingBranches?: unknown;
    readonly notifyEnvironment?: unknown;
    readonly shaDigest?: string;
    /** The clock, "<day of week> <HHMM>" in UTC; Thursday noon by default. */
    readonly now?: string;
    /** package.json's version at the release commit. */
    readonly packageVersion?: string;
    /** The revision label on the 2.30.1 image. */
    readonly revision?: string;
    /** The commit 2.30.1's attestation was signed for (C by default); null: none exists. */
    readonly attestedFor?: string | null;
    /** What gh attestation verify prints when it passes; one verified result by default. */
    readonly attestAnswer?: string;
    /** The signing certificate's identity (its SAN); main's publish.yml by default. */
    readonly signer?: string;
    /** ops/deploy.sh at C; null makes it unreadable. */
    readonly deploySh?: string | null;
    /** The switches: production's on and staging's off by default, as before 2.33.0's rollout. */
    readonly switches?: { readonly production?: string; readonly staging?: string };
    /** This run as the runs API answers for it; null makes the API fail. */
    readonly run?: unknown;
    /** github.triggering_actor. */
    readonly triggeringActor?: string;
  }

  /** The simulated repository and registry for release 2.30.1 at commit C. */
  function repository(overrides: Overrides) {
    const where = box();
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
      version: overrides.packageVersion ?? "2.30.1",
    });
    api(
      where.dir,
      `${R}/contents/CHANGELOG.md?ref=${C}`,
      "# Version history\n\n## 2.30.1 — A fix\n\nFixed.\n\n## 2.30.0 — Older\n",
    );
    api(where.dir, `${R}/contents/migrations?ref=${C}`, [
      { name: "001_init.sql" },
      { name: "010_status_notices.sql" },
    ]);
    if (overrides.deploySh !== null)
      api(where.dir, `${R}/contents/ops/deploy.sh?ref=${C}`, overrides.deploySh ?? capable);
    api(where.dir, `${R}/compare/${C}...main`, { status: "identical" });
    if (overrides.run !== null)
      api(
        where.dir,
        `${R}/actions/runs/36300000042`,
        overrides.run ?? { id: 36300000042, actor: owner, triggering_actor: owner },
      );
    mkdirSync(join(where.dir, "images"));
    writeFileSync(join(where.dir, "images", "2.30.1"), `${D} ${overrides.revision ?? C}\n`);
    writeFileSync(join(where.dir, "images", `sha-${C}`), `${overrides.shaDigest ?? D} ${C}\n`);
    mkdirSync(join(where.dir, "attested"));
    if (overrides.attestedFor !== null)
      writeFileSync(join(where.dir, "attested", D), overrides.attestedFor ?? C);
    if (overrides.attestAnswer !== undefined)
      writeFileSync(join(where.dir, "attest-answer"), overrides.attestAnswer);
    if (overrides.signer !== undefined) writeFileSync(join(where.dir, "signer"), overrides.signer);
    return where;
  }

  /** The plan's environment for an event, with the switches and the dispatcher. */
  const environment = (overrides: Overrides) => ({
    GH_TOKEN: "unused",
    DEPLOY_ENABLED: overrides.switches?.production ?? "true",
    STAGING_DEPLOY_ENABLED: overrides.switches?.staging ?? "",
    TRIGGERING_ACTOR: overrides.triggeringActor ?? "deconfined",
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

  /** Run the plan for an automatic run of release 2.30.1 whose merge changed `files`. */
  function plan(files: File[], overrides: Overrides = {}) {
    const where = repository(overrides);
    api(where.dir, `${R}/contents/package.json?ref=${P}`, { version: "2.30.0" });
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
      }),
    );
  }

  /** The newer release 2.30.2 at commit C2, which a rollback to 2.30.1 leaves. */
  const C2 = sha("newer");
  const D2 = `sha256:${"ef".repeat(32)}`;

  /** Run the plan for a dispatch; `between` is what changed from 2.30.1 to 2.30.2. */
  function dispatch(
    inputs: { version: string; rollback?: boolean; from?: string; target?: string },
    overrides: Overrides & { between?: File[] } = {},
  ) {
    const where = repository(overrides);
    writeFileSync(join(where.dir, "images", "2.30.2"), `${D2} ${C2}\n`);
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
      }),
    );
  }
  const version = {
    filename: "package.json",
    status: "modified",
    patch: '@@ -1 +1 @@\n-  "version": "2.30.0",\n+  "version": "2.30.1",',
  };
  const source = [{ filename: "src/main.ts", status: "modified" }];
  const docsOnly = [{ filename: "docs/HOSTING.md", status: "modified" }, version];
  const both = { switches: { production: "true", staging: "true" } } as const;
  const stagingOnly = { switches: { production: "", staging: "true" } } as const;

  test("a merge of documentation, tests and CI asks for nothing", () => {
    const p = plan([
      { filename: "docs/HOSTING.md", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
      { filename: "tests/unit/x.test.ts", status: "added" },
      { filename: ".github/workflows/ci.yml", status: "modified" },
      { filename: "site/src/content/docs/index.md", status: "modified" },
      version,
    ]);
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      deploy: "false",
      reason: "no-runtime-change",
      version: "2.30.1",
      production: "false",
      staging: "false",
    });
    expect(p.summary).toContain("nothing to deploy");
    // It was verified all the same: the provenance check comes before this exit.
    expect(p.summary).toContain(`Provenance verified: publish.yml on refs/heads/main, commit ${C}`);
    expect(p.summary).toContain("run **Deploy** with the newest version");
    // With both targets on, a quiet merge deploys neither.
    expect(plan(docsOnly, both).outputs).toMatchObject({
      deploy: "false",
      production: "false",
      staging: "false",
    });
  });

  test("source, a dependency change, publish.yml or a host file asks for approval", () => {
    for (const files of [
      [{ filename: "src/main.ts", status: "modified" }],
      [{ ...version, patch: '@@ -1 +1 @@\n-  "zod": "4.1.0",\n+  "zod": "4.2.0",' }],
      [{ filename: "package.json", status: "modified" }],
      [{ filename: ".github/workflows/publish.yml", status: "modified" }],
      [{ filename: "ops/deploy.sh", status: "modified" }],
      [{ filename: "ops/quadlet/secrets.sh", status: "modified" }],
      [{ filename: "docs/moved.ts", status: "renamed", previous_filename: "src/moved.ts" }],
    ]) {
      const p = plan(files as File[]);
      expect({ files: files.length, code: p.code, deploy: p.outputs.deploy }).toEqual({
        files: files.length,
        code: 0,
        deploy: "true",
      });
      expect(p.outputs).toMatchObject({
        action: "deploy",
        commit: C,
        digest: D,
        from: "-",
        reason: "-",
        production: "true",
        staging: "false",
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
    // A dispatch verifies the digest it resolved, for the commit the image's label names.
    const d = dispatch({ version: "2.30.1" });
    expect(d.attestations.map((call) => [call[2], call[10]])).toEqual([[`oci://${IMAGE}@${D}`, C]]);
    expect(d.summary).toContain(`Provenance verified: publish.yml on refs/heads/main, commit ${C}`);
  });

  test("an unattested image is refused before the plan can end early or deploy anything", () => {
    const refusals: [string, ReturnType<typeof plan>][] = [
      ["a quiet merge, no attestation", plan(docsOnly, { attestedFor: null })],
      ["a runtime merge, no attestation", plan(source, { ...both, attestedFor: null })],
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
      ["a dispatch, no attestation", dispatch({ version: "2.30.1" }, { attestedFor: null })],
      [
        "a staging dispatch, no attestation",
        dispatch({ version: "2.30.1", target: "staging" }, { ...stagingOnly, attestedFor: null }),
      ],
      [
        "a rollback, no attestation",
        dispatch({ version: "2.30.1", rollback: true, from: "2.30.2" }, { attestedFor: null }),
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
    const rollback = { version: "2.30.1", rollback: true, from: "2.30.2" };
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
      expect(p.stdout).toContain("::error::The way back from 2.30.2 to 2.30.1 changes 300 files");
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
      "**Host-side changes in this merge** (on production's Docker host they run as a docker-group user, which is root-equivalent there; on the staging host as the unprivileged `tarubot` user under rootless Podman; `ops/ansible/` runs as root when the playbook is applied):",
    );
    expect(p.summary).toContain("- `ops/deploy.sh`");
    expect(p.summary).toContain("check the host's .env first");
    // A host may be older than the previous release: the history links cover the rest.
    expect(p.summary).toContain("the host-side changes of the releases in between run too");
    expect(p.summary).toContain(
      `[\`ops/\`](https://github.com/deconfined/tarubot/commits/${C}/ops)`,
    );
    expect(p.summary).toContain(
      `[\`staging.env.example\`](https://github.com/deconfined/tarubot/commits/${C}/staging.env.example)`,
    );
    expect(p.summary).toContain("**Target:** production, once @deconfined approves it.");
    expect(p.summary).toContain("**Staging is paused:** `STAGING_DEPLOY_ENABLED` isn't true.");
    expect(p.summary).toContain("**Approving** runs Deploy 2.30.1");
    expect(p.summary).not.toContain("**Staging** takes");
    expect(p.summary).toContain("## 2.30.1 — A fix");
    expect(p.summary).not.toContain("## 2.30.0 — Older");
    expect(p.summary).toContain("| Newest migration at this commit | `010_status_notices.sql` |");
    // The staging template is a host-side file, and a settings template asks for the .env check.
    const template = plan([{ filename: "staging.env.example", status: "modified" }, ...source]);
    expect(template.summary).toContain("- `staging.env.example`");
    expect(template.summary).toContain("check the host's .env first");
  });

  test("a merge without host-side changes says so for this merge only, never a bare none", () => {
    const p = plan(source);
    expect(p.summary).toContain(
      "**Host-side changes in this merge**: no file under `ops/`, `docker-compose.production.yml`, `production.env.example` or `staging.env.example` changed.",
    );
    expect(p.summary).toContain("the host-side changes of the releases in between run too");
    expect(p.summary).not.toMatch(/\*\*Host-side changes:\*\* none/u);
  });

  test("the approval wording ties the docker-group claim to production's Docker host alone", () => {
    const host: File[] = [{ filename: "ops/backup.sh", status: "modified" }];
    const summaries = [
      plan(host, both).summary,
      plan(host).summary,
      dispatch({ version: "2.30.1" }, both).summary,
      dispatch({ version: "2.30.1", rollback: true, from: "2.30.2" }, { ...both, between: host })
        .summary,
      dispatch({ version: "2.30.1", target: "staging" }, stagingOnly).summary,
      plan(host, stagingOnly).summary,
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
      "There this commit's host-side files run as the unprivileged `tarubot` user under rootless Podman, and `ops/ansible/` as root when the playbook is applied.",
    );
    // The plan script holds no other wording for them.
    const planScript = runOf("plan", "plan");
    expect(planScript).not.toContain("(root-equivalent)");
    expect(planScript).not.toContain("they run on the host as a docker-group user");
  });

  test("a dispatch takes the commit from the image's revision label and checks package.json", () => {
    const p = dispatch({ version: "2.30.1" });
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      deploy: "true",
      action: "deploy",
      version: "2.30.1",
      commit: C,
      digest: D,
      from: "-",
      reason: "-",
      production: "true",
      staging: "false",
    });
    expect(p.summary).toContain("## Deploy 2.30.1");
    expect(p.summary).toContain(
      "**Host-side changes:** each host deploys from its live release to this commit. Before approving, check",
    );
    for (const [what, inputs, overrides, reason] of [
      ["a version that isn't X.Y.Z", { version: "2.30" }, {}, "version"],
      ["an unpublished version", { version: "2.30.9" }, {}, "image"],
      ["an image with no revision label", { version: "2.30.1" }, { revision: "none" }, "image"],
      [
        "package.json at the commit naming another version",
        { version: "2.30.1" },
        { packageVersion: "2.30.0" },
        "version-mismatch",
      ],
      ["'from' without a rollback", { version: "2.30.1", from: "2.30.2" }, {}, "from"],
      ["an unknown target", { version: "2.30.1", target: "preview" }, both, "target"],
      ["no target", { version: "2.30.1", target: "" }, both, "target"],
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
      { version: "2.30.1", rollback: true, from: "2.30.2" },
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
      from: "2.30.2",
    });
    expect(ok.summary).toContain("## Roll back from 2.30.2 to 2.30.1");
    expect(ok.summary).toContain("**Host-side differences between 2.30.1 and 2.30.2**");
    expect(ok.summary).toContain("- `ops/deploy.sh`");
    expect(ok.summary).toContain("**Approving** rolls production back from 2.30.2 to 2.30.1");
    for (const [what, inputs, between, reason] of [
      ["no 'from'", { version: "2.30.1", rollback: true, from: "" }, [], "from"],
      [
        "a newer target",
        { version: "2.30.1", rollback: true, from: "2.30.0" },
        [],
        "rollback-not-older",
      ],
      [
        "an added migration in between",
        { version: "2.30.1", rollback: true, from: "2.30.2" },
        [{ filename: "migrations/011_x.sql", status: "added" }],
        "rollback-across-migration",
      ],
      [
        "a migration renamed away in between",
        { version: "2.30.1", rollback: true, from: "2.30.2" },
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
    const merge = plan(source, both);
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({ deploy: "true", production: "true", staging: "true" });
    expect(merge.summary).toContain(
      "**Targets:** production, once @deconfined approves it, and staging, which deploys at once beside the approval request, without one.",
    );
    expect(merge.summary).toContain("**Approving** runs Deploy 2.30.1");
    expect(merge.summary).toContain(
      "**Staging** takes 2.30.1 (`" +
        C.slice(0, 12) +
        "`, `" +
        D +
        "`) at once, beside the approval request and without one.",
    );
    expect(merge.summary).toContain("its **Deploy staging** job shows how 2.30.1 went there");
    const toProduction = dispatch({ version: "2.30.1" }, both);
    expect(toProduction.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(toProduction.summary).not.toContain("**Staging**");
    const toStaging = dispatch({ version: "2.30.1", target: "staging" }, both);
    expect(toStaging.code).toBe(0);
    expect(toStaging.outputs).toMatchObject({
      deploy: "true",
      production: "false",
      staging: "true",
    });
    expect(toStaging.summary).toContain(
      "**Target:** staging, which deploys at once, without approval.",
    );
    expect(toStaging.summary).toContain("**Staging** takes 2.30.1");
    expect(toStaging.summary).toContain("at once, without approval.");
    // Nothing waits for approval, so the plan asks for none.
    expect(toStaging.summary).not.toMatch(/\*\*Approving\*\*|Tried on DevBot|Before approving/u);
    const back = dispatch(
      { version: "2.30.1", rollback: true, from: "2.30.2", target: "staging" },
      stagingOnly,
    );
    expect(back.outputs).toMatchObject({
      action: "rollback",
      production: "false",
      staging: "true",
    });
    expect(back.summary).toContain("**Staging** rolls back from 2.30.2 to 2.30.1");
  });

  test("each target has its own switch; with the requested ones off the run is paused", () => {
    // Production paused, staging on: an automatic run deploys staging alone.
    const merge = plan(source, stagingOnly);
    expect(merge.outputs).toMatchObject({ deploy: "true", production: "false", staging: "true" });
    expect(merge.summary).toContain("**Production is paused:** `DEPLOY_ENABLED` isn't true.");
    // A dispatch whose target's switch is off plans nothing and fails nothing. Notify hears of
    // it only when production's switch reads as true to GitHub (which ignores case) but isn't
    // exactly `true`, so the owner learns why nothing asked for approval.
    for (const [target, switches, notify, why] of [
      ["staging", { production: "true", staging: "" }, "false", "-"],
      ["production", { production: "", staging: "true" }, "false", "paused"],
      ["staging", { production: "true", staging: "yes" }, "false", "-"],
      ["production", { production: "True", staging: "" }, "true", "paused"],
    ] as const) {
      const p = dispatch({ version: "2.30.1", target }, { switches });
      expect({ target, switches, code: p.code, outputs: p.outputs }).toEqual({
        target,
        switches,
        code: 0,
        outputs: {
          notify,
          deploy: "false",
          reason: "paused",
          production: "false",
          staging: "false",
          production_reason: why,
        },
      });
      expect(p.summary).toContain("## Deploy: paused");
      expect(p.attestations).toEqual([]);
    }
    // `True` on production with staging on: staging goes ahead, and notify names the pause.
    const cased = plan(source, { switches: { production: "True", staging: "true" } });
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
    expect(plan(source, stagingOnly).outputs).toMatchObject({
      notify: "false",
      production_reason: "paused",
    });
    expect(dispatch({ version: "2.30.1" }).outputs.notify).toBe("true");
    expect(dispatch({ version: "2.30.1", target: "staging" }, both).outputs.notify).toBe("false");
    // Written before anything can fail: an unattested image still reaches notify's message.
    const unattested = plan(source, { attestedFor: null });
    expect({ code: unattested.code, outputs: unattested.outputs }).toMatchObject({
      code: 1,
      outputs: { notify: "true", reason: "unattested" },
    });
    // A failed production gate is named, so notify says gate rather than paused.
    const weak = plan(source, { ...both, production: { ...production, can_admins_bypass: true } });
    expect(weak.outputs).toMatchObject({
      notify: "true",
      production: "false",
      production_reason: "gate",
    });
    // A quiet merge carries it too.
    expect(plan(docsOnly, both).outputs).toMatchObject({
      notify: "true",
      production_reason: "-",
    });
  });

  test("a failed gate turns off only its own target, and with nothing left fails the plan", () => {
    const weak = { ...production, can_admins_bypass: true };
    // Production's gate failed: an automatic run still deploys staging, and says why.
    const merge = plan(source, { ...both, production: weak });
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
    const toProduction = dispatch({ version: "2.30.1" }, { ...both, production: weak });
    expect({ code: toProduction.code, reason: toProduction.outputs.reason }).toEqual({
      code: 1,
      reason: "gate",
    });
    // Staging's gate: main only, and no reviewer, since its host checks no approval.
    for (const [what, overrides] of [
      ["no staging environment", { staging: null }],
      [
        "a reviewer on staging",
        {
          staging: {
            ...staging,
            protection_rules: [
              { type: "branch_policy" },
              { type: "required_reviewers", reviewers: [{ type: "User", reviewer: owner }] },
            ],
          },
        },
      ],
      ["any branch", { staging: { ...staging, deployment_branch_policy: null } }],
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
      const p = plan(source, { ...both, ...overrides });
      expect({
        what,
        code: p.code,
        production: p.outputs.production,
        staging: p.outputs.staging,
      }).toEqual({
        what,
        code: 0,
        production: "true",
        staging: "false",
      });
      expect(p.stdout).toContain(
        "::error::The staging environment must accept only main and require no reviewer.",
      );
      expect(p.summary).toContain("**Staging is off in this run:**");
      const toStaging = dispatch(
        { version: "2.30.1", target: "staging" },
        { ...both, ...overrides },
      );
      expect({ what, code: toStaging.code, reason: toStaging.outputs.reason }).toEqual({
        what,
        code: 1,
        reason: "gate",
      });
    }
    // A switch that is off leaves its gate unasked: staging's environment may not exist yet.
    const before = plan(source, { staging: null });
    expect(before.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(before.stdout).not.toContain("::error::");
    // Notify's gate still fails every plan.
    const noNotify = plan(source, {
      ...stagingOnly,
      notifyEnvironment: { ...staging, deployment_branch_policy: null },
    });
    expect({ code: noNotify.code, reason: noNotify.outputs.reason }).toEqual({
      code: 1,
      reason: "gate",
    });
  });

  test("only @deconfined may dispatch staging, by login and id, as actor and triggering actor", () => {
    const toStaging = (overrides: Overrides) =>
      dispatch({ version: "2.30.1", target: "staging" }, { ...stagingOnly, ...overrides });
    expect(toStaging({}).outputs).toMatchObject({ deploy: "true", staging: "true" });
    const someone = { login: "someone", id: 12345, type: "User" };
    for (const [what, overrides] of [
      ["another triggering actor", { triggeringActor: "someone" }],
      [
        "a workflow token's dispatch",
        { triggeringActor: "github-actions[bot]", run: { actor: bot, triggering_actor: bot } },
      ],
      ["a bot as the actor", { run: { actor: bot, triggering_actor: owner } }],
      [
        "someone else as the triggering actor",
        { run: { actor: owner, triggering_actor: someone } },
      ],
      [
        "the login with another id",
        { run: { actor: { ...owner, id: 1 }, triggering_actor: owner } },
      ],
      [
        "the triggering login with another id",
        { run: { actor: owner, triggering_actor: { ...owner, id: 1 } } },
      ],
      ["no actor", { run: { triggering_actor: owner } }],
      ["no answer", { run: null }],
    ] as [string, Overrides][]) {
      const p = toStaging(overrides);
      expect({ what, code: p.code, reason: p.outputs.reason, staging: p.outputs.staging }).toEqual({
        what,
        code: 1,
        reason: "dispatcher",
        staging: undefined,
      });
      expect(p.attestations).toEqual([]);
    }
    // Production has its approval: its dispatches, and automatic runs, aren't checked here.
    const otherRun = { run: { actor: bot, triggering_actor: bot }, triggeringActor: "someone" };
    expect(dispatch({ version: "2.30.1" }, { ...both, ...otherRun }).outputs.production).toBe(
      "true",
    );
    expect(plan(source, { ...both, ...otherRun }).outputs.staging).toBe("true");
  });

  test("staging takes only a release whose ops/deploy.sh declares Quadlet staging deploys", () => {
    const toStaging = (deploySh: string | null) =>
      dispatch({ version: "2.30.1", target: "staging" }, { ...stagingOnly, deploySh });
    const declared = (words: string) => `#!/usr/bin/env bash\nreadonly CAPABILITIES="${words}"\n`;
    for (const words of ["staging quadlet", "quadlet staging", "preview quadlet staging"])
      expect({ words, staging: toStaging(declared(words)).outputs.staging }).toEqual({
        words,
        staging: "true",
      });
    for (const [what, deploySh] of [
      ["no declaration (2.32.x)", "#!/usr/bin/env bash\nreadonly FLOOR=2.30.0\n"],
      ["production Quadlet only", declared("quadlet")],
      ["staging without Quadlet", declared("staging")],
      ["a comment", '# readonly CAPABILITIES="staging quadlet"\n'],
      ["an indented line", '  readonly CAPABILITIES="staging quadlet"\n'],
      ["a word that only contains one", declared("quadlets staging")],
      ["a malformed line", 'readonly CAPABILITIES="staging  quadlet"\n'],
      ["an unreadable file", null],
    ] as const) {
      const p = toStaging(deploySh);
      expect({ what, code: p.code, reason: p.outputs.reason, staging: p.outputs.staging }).toEqual({
        what,
        code: 1,
        reason: "below-floor",
        staging: undefined,
      });
    }
    // Beside production, an old release turns staging off and production goes on.
    const merge = plan(source, { ...both, deploySh: declared("quadlet") });
    expect(merge.code).toBe(0);
    expect(merge.outputs).toMatchObject({ production: "true", staging: "false" });
    expect(merge.stdout).toContain(
      "::warning::2.30.1's ops/deploy.sh doesn't declare Quadlet staging deploys",
    );
    expect(merge.summary).toContain("**Staging is off in this run:**");
    // Production doesn't read the declaration: its host checks its own floor.
    expect(dispatch({ version: "2.30.1" }, { deploySh: null }).outputs.production).toBe("true");
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
      const p = plan(source, { production: weak });
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
      ["docker-compose.yml", false],
      ["docker-compose.devbot.yml", false],
      ["docker-compose.build.yml", false],
      ["docker-compose.tools.yml", false],
      [".env.example", false],
      ["production.env.example", false],
      ["staging.env.example", false],
      ["ops/ansible/requirements.txt", false],
      ["ops/ansible/requirements-lint.txt", false],
      ["ops/ansible/site.yml", true],
      ["ops/quadlet/check-env.sh", true],
      ["ops/quadlet/secrets.sh", true],
      ["ops/quadlet/run-tool.sh", true],
      ["ops/systemd/tarubot-backup.service", true],
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

  test("lists what runs on a host, or shapes its .env, as host-side", () => {
    for (const [path, expected] of [
      ["ops/deploy.sh", true],
      ["ops/ansible/site.yml", true],
      ["ops/quadlet/units/tarubot.container", true],
      ["ops/systemd/tarubot-backup.timer", true],
      ["docker-compose.production.yml", true],
      ["production.env.example", true],
      ["staging.env.example", true],
      [".env.example", false],
      ["docker-compose.yml", false],
      ["src/main.ts", false],
      ["docs/ops/notes.md", false],
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
