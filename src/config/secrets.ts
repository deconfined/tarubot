/**
 * File-delivered secrets support Docker secret mounts and other private setting files.
 * Plain NAME variables remain supported for Compose, local development and CI.
 * Every reader goes through this module: configuration(), the maintenance-tool guard,
 * Database's default CA and the scripts.
 *
 * The rules, for each NAME:
 * - NAME_FILE empty or unset: NAME as it is (possibly unset);
 * - NAME_FILE set: the file's UTF-8 text with exactly one trailing newline removed.
 *   An empty optional file value followed by one newline resolves to "".
 * - both set (neither empty): a configuration failure, so a stale plain value can never shadow the
 *   file or the other way round.
 *
 * Nothing here writes process.env: the resolved values go into a new object, so a secret read
 * from a file never enters the environment that child processes and dependencies can read.
 * Failures name settings only, never a value or a file path.
 */
import { readFileSync } from "node:fs";
import { Failure } from "../domain/values.js";

/** Settings that may come from a file, sorted. */
export const FILE_SETTINGS = [
  "DATABASE_CA_CERT",
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_REPORTS_TOKEN",
  "HEALTHCHECKS_PING_URL",
] as const;
export type FileSetting = (typeof FILE_SETTINGS)[number];

/** process.env or a test double (the same shape as deployment.ts's Environment). */
export type Environment = Readonly<Record<string, string | undefined>>;
/** Reads a file's text; tests pass a double. */
export type ReadText = (path: string) => string;

/** The file reader used outside tests. */
const readText: ReadText = (path) => readFileSync(path, "utf8");

/** Unset and empty both mean "not given"; a set value is used exactly as it is. */
const given = (value: string | undefined): value is string => value !== undefined && value !== "";

/** One setting's value, from NAME or from the file NAME_FILE names. */
export function secretSetting(
  env: Environment,
  name: FileSetting,
  read: ReadText = readText,
): string | undefined {
  const fileSetting = `${name}_FILE`;
  const path = env[fileSetting];
  if (!given(path)) return env[name];
  if (given(env[name]))
    throw new Failure("configuration", `Set ${name} or ${fileSetting}, not both.`);
  let text: string;
  try {
    text = read(path);
  } catch {
    // The error would carry the path (and, from some readers, file contents); name the setting.
    throw new Failure("configuration", `${fileSetting} names a file that can't be read.`);
  }
  // One newline only: a PEM's own final newline, if the value had one, stays part of the value.
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * A copy of env with every file-delivered setting resolved into its plain name. The NAME_FILE keys
 * are left out, so resolving the result again gives the same object (a tool may hand an already
 * resolved environment to the guard, which resolves it once more).
 */
export function resolveSettings(env: Environment, read: ReadText = readText): Environment {
  const resolved: Record<string, string | undefined> = { ...env };
  for (const name of FILE_SETTINGS) {
    const value = secretSetting(env, name, read);
    delete resolved[`${name}_FILE`];
    if (value === undefined) delete resolved[name];
    else resolved[name] = value;
  }
  return resolved;
}
