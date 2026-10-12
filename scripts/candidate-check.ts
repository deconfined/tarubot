/**
 * Offline check of a candidate release from inside its own image, before a delivery stops anything:
 *
 *   bun dist/scripts/candidate-check.js VERSION SCHEMA --global     (production)
 *   bun dist/scripts/candidate-check.js VERSION SCHEMA --guild ID   (a staging or development guild)
 *
 * The deploy entry (ops/deploy.sh) runs it with `compose run --rm --no-deps` in the new image and the
 * host's settings, so a release Discord would refuse, or one the host's settings can't start, is
 * refused while the old bot still runs. It checks four parts and measures each one:
 *
 *   identity      the compiled package version and schema are the release asked for, and the
 *                 migrations folder in the image ends at that schema
 *   config        configuration(process.env), the very validation the bot runs at startup
 *   modules       every command, component and event module imports and passes its type guard
 *   registration  register.js's own deployment guard accepts this environment and scope, and the
 *                 command definitions pass Discord's registration rules (registration-rules.ts)
 *
 * Nothing here reaches Discord or the database, so it can run beside the live bot. It prints one
 * JSON line of booleans and the first failing part, the way the entry's observation probe does;
 * problem text names settings, commands and options (never a value) and goes to stderr, which the
 * entry keeps in its private log. Exit 0 when every part passes, 1 when one fails, 2 for arguments
 * this script can't read. A run that dies before it prints its line (an import fails) also exits 1
 * with nothing on stdout, and an image that predates the script has no such file, so the entry asks
 * whether the file exists first and reads the line, not the exit status, to learn which part failed.
 */
import { readdir } from "node:fs/promises";
import { loadCommands, loadComponents, loadEvents } from "../src/bot/discovery.js";
import { configuration } from "../src/config/env.js";
import { project } from "../src/config/project.js";
import { assertToolScope, type Launch } from "../src/config/deployment.js";
import { commandSetProblems, type RegistrableCommand } from "../src/discord/registration-rules.js";
import { MIGRATION_FILE, SCHEMA_VERSION } from "../src/infrastructure/postgres/database.js";
import { registerToolScope, registrationScope } from "./register.js";

/** The parts, in the order the first failure is named. */
export const PARTS = ["identity", "config", "modules", "registration"] as const;
export type Part = (typeof PARTS)[number];

export interface CandidateReport {
  /** `ok`, or the first part that failed. */
  check: "ok" | Part;
  identity: boolean;
  config: boolean;
  modules: boolean;
  registration: boolean;
}

/** What each part reads; tests replace the loaders with invented definitions. */
export interface CandidateInputs {
  version: string;
  schema: string;
  /** The register.js scope arguments (`--global` or `--guild ID`), read with the environment. */
  scopeArguments: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** How the process started, for the deployment guard; tests state it, the image reads its own. */
  launch?: Launch;
  /** The compiled package version and schema this image was built with. */
  built: { version: string; schema: string };
  /** File names in the image's migrations folder. */
  migrations: () => Promise<readonly string[]>;
  /** The command definitions as register.js would send them (each command's toJSON()). */
  commands: () => Promise<readonly RegistrableCommand[]>;
  modules: () => Promise<unknown>;
}

/** Run every part; a part that throws fails alone and its message joins `problems`. */
export async function candidateCheck(
  inputs: CandidateInputs,
): Promise<{ report: CandidateReport; problems: string[] }> {
  const problems: string[] = [];
  const attempt = async (
    part: Part,
    run: () => Promise<string[] | undefined>,
  ): Promise<boolean> => {
    try {
      const found = (await run()) ?? [];
      for (const problem of found) problems.push(`${part}: ${problem}`);
      return found.length === 0;
    } catch (error) {
      problems.push(`${part}: ${error instanceof Error ? error.message : "failed"}`);
      return false;
    }
  };

  const identity = await attempt("identity", async () => {
    const found: string[] = [];
    if (inputs.built.version !== inputs.version)
      found.push(`the image holds version ${inputs.built.version}, not the requested one`);
    if (inputs.built.schema !== inputs.schema)
      found.push(`the image holds schema ${inputs.built.schema}, not the requested one`);
    // As Database.migrate reads the folder: every .sql file, sorted, each one a migration name.
    const files = (await inputs.migrations()).filter((file) => file.endsWith(".sql")).sort();
    const misnamed = files.filter((file) => !MIGRATION_FILE.test(file));
    if (misnamed.length > 0)
      found.push(`${misnamed.length} file(s) in the migrations folder are not migration names`);
    if (files.at(-1) !== inputs.schema)
      found.push(`the migrations folder ends at ${files.at(-1) ?? "nothing"}, not the schema`);
    return found;
  });

  const config = await attempt("config", async () => {
    configuration({ ...inputs.env });
    return [];
  });

  const modules = await attempt("modules", async () => {
    await inputs.modules();
    return [];
  });

  const registration = await attempt("registration", async () => {
    const found: string[] = [];
    try {
      // The scope is read here with the environment, as register.js does: --global is refused
      // while TEST_GUILD_ID is set, a fact about this host's settings, not about the arguments.
      const scope = registrationScope(inputs.scopeArguments, inputs.env);
      assertToolScope(inputs.env, registerToolScope(scope), inputs.launch);
    } catch (error) {
      found.push(error instanceof Error ? error.message : "the deployment guard refused");
    }
    // Measured either way, so one run lists every reason the set can't be registered.
    found.push(...commandSetProblems(await inputs.commands()));
    return found;
  });

  const results = { identity, config, modules, registration };
  const failed = PARTS.find((part) => !results[part]);
  return { report: { check: failed ?? "ok", ...results }, problems };
}

/**
 * VERSION SCHEMA then the register.js scope arguments. Only their shape is read here, so a host
 * setting that register.js would refuse (--global beside TEST_GUILD_ID) is a failed registration
 * part, measured with the others, and not an unreadable command line.
 */
export function candidateArguments(argv: readonly string[]): {
  version: string;
  schema: string;
  scopeArguments: readonly string[];
} {
  const [version, schema, ...scopeArguments] = argv;
  if (!/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/u.test(version ?? ""))
    throw new TypeError("The first argument must be the release version.");
  if (!/^\d{3}_[a-z0-9_]{1,60}\.sql$/u.test(schema ?? ""))
    throw new TypeError("The second argument must be the schema file name.");
  registrationScope(scopeArguments, {});
  return { version: version as string, schema: schema as string, scopeArguments };
}

if (import.meta.main) {
  let args: ReturnType<typeof candidateArguments>;
  try {
    args = candidateArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unreadable arguments.");
    process.exit(2);
  }
  const { report, problems } = await candidateCheck({
    ...args,
    env: process.env,
    built: { version: project.version, schema: SCHEMA_VERSION },
    migrations: () => readdir("migrations"),
    commands: async () =>
      [...(await loadCommands()).values()].map((command) => command.toJSON() as RegistrableCommand),
    modules: async () => {
      await loadComponents();
      await loadEvents();
      await loadCommands();
    },
  });
  for (const problem of problems) console.error(problem);
  console.log(JSON.stringify(report));
  process.exit(report.check === "ok" ? 0 : 1);
}
