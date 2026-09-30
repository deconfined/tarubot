/** Automatic release admission uses public GitHub/registry evidence, never deployment credentials. */
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { releaseIdentity, verifyReleaseProvenance } from "./release-policy.js";

export function requireMainEnvironment(
  value: unknown,
  policies: unknown,
  automaticWriter = false,
): void {
  const environment = value as {
    deployment_branch_policy?: unknown;
    protection_rules?: { type?: unknown }[];
  };
  const branches = policies as {
    total_count?: unknown;
    branch_policies?: { name?: unknown; type?: unknown }[];
  };
  const policy = environment.deployment_branch_policy as
    | { protected_branches?: unknown; custom_branch_policies?: unknown }
    | undefined;
  if (
    policy?.protected_branches !== false ||
    policy.custom_branch_policies !== true ||
    branches.total_count !== 1 ||
    !Array.isArray(branches.branch_policies) ||
    branches.branch_policies.length !== 1 ||
    branches.branch_policies[0]?.name !== "main" ||
    branches.branch_policies[0]?.type !== "branch" ||
    !Array.isArray(environment.protection_rules) ||
    (automaticWriter && environment.protection_rules.some((r) => r.type === "required_reviewers"))
  )
    throw new Error("invalid-release-environment");
}
if (import.meta.main) {
  let directory: string | undefined;
  try {
    const root = process.cwd();
    const schema = readdirSync(join(root, "migrations"))
      .filter((name) => /^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(name))
      .sort()
      .at(-1);
    const release = releaseIdentity({
      version: process.env.VERSION,
      commit: process.env.COMMIT,
      digest: process.env.DIGEST,
      config_commit: process.env.COMMIT,
      publication_run: process.env.PUBLICATION_RUN,
      schema_head: schema,
    });
    if (
      process.env.GITHUB_REPOSITORY !== "deconfined/tarubot" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_RUN_ATTEMPT !== "1" ||
      process.env.GITHUB_EVENT_NAME !== "push" ||
      process.env.GITHUB_SHA !== release.commit ||
      process.env.GITHUB_RUN_ID !== release.publication_run
    )
      throw new Error("invalid-release-caller");
    if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== release.version)
      throw new Error("invalid-release-version");
    const privateDirectory = join(process.env.RUNNER_TEMP ?? "", "release-admission");
    if (!process.env.RUNNER_TEMP || !process.env.GITHUB_OUTPUT || !process.env.GH_TOKEN)
      throw new Error("invalid-release-runner");
    // A fresh private home prevents inherited gh configuration, credentials or repository hooks.
    mkdirSync(privateDirectory, { mode: 0o700 });
    directory = privateDirectory;
    const run = (args: string[], name: string): unknown => {
      const result = Bun.spawnSync(["gh", ...args], {
        cwd: privateDirectory,
        stdin: "ignore",
        env: {
          PATH: process.env.PATH,
          HOME: privateDirectory,
          GH_CONFIG_DIR: join(privateDirectory, "config"),
          GH_HOST: "github.com",
          GH_TOKEN: process.env.GH_TOKEN,
          GH_PROMPT_DISABLED: "1",
        },
        // Public API and attestation errors must stop admission within the job's deadline.
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: "SIGKILL",
      });
      writeFileSync(join(privateDirectory, `${name}.stdout`), result.stdout, { mode: 0o600 });
      writeFileSync(join(privateDirectory, `${name}.stderr`), result.stderr, { mode: 0o600 });
      if (!result.success || result.exitedDueToTimeout || result.exitedDueToMaxBuffer)
        throw new Error("invalid-release-public-evidence");
      return JSON.parse(result.stdout.toString());
    };
    const main = run(["api", "repos/deconfined/tarubot/git/ref/heads/main"], "main") as {
      object?: { sha?: unknown };
    };
    if (main.object?.sha !== release.commit) throw new Error("superseded-release");
    for (const name of ["infra-plan", "infra-auto", "staging"]) {
      const env = run(
        ["api", `repos/deconfined/tarubot/environments/${name}`],
        `environment-${name}`,
      );
      const policies = run(
        ["api", `repos/deconfined/tarubot/environments/${name}/deployment-branch-policies`],
        `branches-${name}`,
      );
      requireMainEnvironment(env, policies, name === "infra-auto");
    }
    const verified = run(
      [
        "attestation",
        "verify",
        `oci://ghcr.io/deconfined/tarubot@${release.digest}`,
        "--repo",
        "deconfined/tarubot",
        "--cert-identity",
        "https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        release.commit,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      "provenance",
    );
    verifyReleaseProvenance(verified, release, "deconfined/tarubot");
    // Every field is validated public identity data, not provider state or host inventory.
    for (const [key, value] of Object.entries(release))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  } catch {
    console.log(
      "::error::Release identity, provenance, freshness or environment admission failed; no infrastructure/host credentials may load.",
    );
    process.exitCode = 1;
  } finally {
    // Keep public identity outputs only; neither API diagnostics nor attestation logs are artifacts.
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      console.log(
        "::error::Private admission output cleanup failed; credential gates stay closed.",
      );
      process.exitCode = 1;
    }
  }
}
