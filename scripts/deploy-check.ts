/**
 * The in-image settings check (2.37.0): the release's own configuration and tool guard, run over
 * the settings a deploy is about to give the bot, before anything is written to the host or the
 * running bot stops. ops/ansible/bot.yml's Settings phase runs it in a throwaway container of the
 * release image, with no network, a read-only root, no capabilities and no log:
 *
 *   podman run --rm -i --pull=never --network=none --read-only ... --entrypoint bun IMAGE \
 *     dist/scripts/deploy-check.js   < {"action":"deploy","env":{...}}
 *
 * stdin is one JSON object: the action (deploy, bot or preflight) and the container's environment,
 * exactly what tarubot.env and the mounted secrets give the bot (the secrets by their plain names
 * rather than NAME_FILE, which src/config/secrets.ts resolves to the same values). It prints one
 * line and nothing else, never a value or a guard's message (those name hosts and databases):
 *
 *   {"ok":true}                                                  exit 0
 *   {"ok":false,"check":"configuration"|"migrate"|"register"}    exit 1
 *
 * - deploy and bot: configuration() as the bot's startup runs it, then the tool guard for migrate.js
 *   (ExecStartPre runs it before every start) and for register.js in the profile's own scope (the
 *   Commands phase registers there);
 * - preflight: the guard for migrate.js only, since a preflight has no Discord token yet.
 *
 * The scope builders come from migrate.js and register.js themselves, so this check can't drift
 * from what those tools enforce. Both modules only declare functions at the top level (their work
 * is behind import.meta.main), so importing them opens no database or network connection. Nothing
 * here reads process.env or the working directory's env files: the environment is the input.
 */
import {
  assertToolScope,
  type Environment,
  type Launch,
  resolveDeployment,
} from "../src/config/deployment.js";
import { configuration } from "../src/config/env.js";
import { migrateToolScope } from "./migrate.js";
import { registerToolScope } from "./register.js";

/** The actions bot.yml runs (vars/bot.yml tb_actions). */
export const CHECK_ACTIONS = ["deploy", "bot", "preflight"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

/** Which part refused: the only detail the output carries. */
export type SettingsCheck = "configuration" | "migrate" | "register";
export type CheckResult = { ok: true } | { ok: false; check: SettingsCheck };

/** Inside the release's container: no env file in /app and no Bun flags. */
const CONTAINER: Launch = { execArgv: [], envFiles: [] };

/** An environment variable's name, as tarubot.env and the secrets use them. */
const NAME = /^[A-Z][A-Z0-9_]*$/u;

/** The input's action and environment, or null when it isn't the expected shape. */
function parse(value: unknown): { action: CheckAction; env: Environment } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { action, env, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (!(CHECK_ACTIONS as readonly unknown[]).includes(action)) return null;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const entries = Object.entries(env);
  if (!entries.every(([name, setting]) => NAME.test(name) && typeof setting === "string"))
    return null;
  return { action: action as CheckAction, env: Object.fromEntries(entries) as Environment };
}

/**
 * Check one deploy's settings. Every failure, a malformed input included, becomes the name of the
 * check that refused; the thrown error, which can name a host or a database, is dropped.
 */
export function checkSettings(input: unknown): CheckResult {
  let check: SettingsCheck = "configuration";
  try {
    const parsed = parse(input);
    if (parsed === null) return { ok: false, check };
    const { action, env } = parsed;
    // The bot's own startup check; a preflight has no Discord token, so it skips this.
    if (action !== "preflight") configuration(env);
    check = "migrate";
    assertToolScope(env, migrateToolScope({ restoreRehearsal: false }), CONTAINER);
    if (action === "preflight") return { ok: true };
    check = "register";
    // The scope the profile registers in, as bot.yml's Commands phase passes it to register.js.
    const scope = resolveDeployment(env).registrationScope;
    assertToolScope(
      env,
      registerToolScope(scope === "global" ? { kind: "global" } : { kind: "guild", guild: scope }),
      CONTAINER,
    );
    return { ok: true };
  } catch {
    return { ok: false, check };
  }
}

if (import.meta.main) {
  let result: CheckResult;
  try {
    result = checkSettings(JSON.parse(await Bun.stdin.text()));
  } catch {
    // Not JSON: the settings never reached a check.
    result = { ok: false, check: "configuration" };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
