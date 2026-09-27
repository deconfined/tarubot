/**
 * Readers for the Quadlet unit files and Podman env files in ops/quadlet/ (#50), shared by
 * tests/unit/quadlet.test.ts and tests/unit/container-hardening.test.ts. Each reader enforces house
 * rules that keep it exact rather than reimplementing systemd's or Podman's full parsers, so a file
 * the reader accepts means the same to the reader, to Quadlet and to Podman:
 * - unit files: whole-line "#" comments (systemd has no inline comments), [Section] headers and one
 *   Key=value per line, with no line continuations, no "#" in a value and no quoting (Quadlet strips
 *   a value's surrounding double quotes); the HealthCmd JSON array is the one value with quotes;
 * - env files: Podman reads every line literally (pkg/env/env.go), so each line is a "#" comment,
 *   blank, NAME=value or a bare NAME, with no quotes, no "#" in a value, no surrounding whitespace
 *   and never NAME* (Podman's prefix pass-through).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A path in the repository. */
export const root = (path: string) => new URL(`../../${path}`, import.meta.url).pathname;
/** A repository file's text. */
export const read = (path: string) => Bun.file(root(path)).text();

/** The directory this release's Quadlet files live in. */
export const QUADLET = "ops/quadlet";
/** The two deployment targets, each a directory under ops/quadlet with a drop-in and a list. */
export const TARGETS = ["production", "staging"] as const;
export type Target = (typeof TARGETS)[number];

/** One assignment in a unit file. */
export interface UnitLine {
  section: string;
  key: string;
  value: string;
  line: number;
}

/** Parse a unit file or drop-in under the house rules, naming the file and line on a breach. */
export function parseUnit(text: string, file: string): UnitLine[] {
  const lines: UnitLine[] = [];
  let section = "";
  text.split("\n").forEach((raw, index) => {
    const where = `${file}:${index + 1}`;
    if (raw.trim() === "" || raw.startsWith("#")) return;
    if (/^\s/u.test(raw) || /\s$/u.test(raw)) throw new Error(`${where}: surrounding whitespace`);
    if (raw.endsWith("\\")) throw new Error(`${where}: a line continuation`);
    const header = /^\[([A-Za-z]+)\]$/u.exec(raw);
    if (header?.[1]) {
      section = header[1];
      return;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(raw);
    if (!assignment?.[1] || assignment[2] === undefined || !section)
      throw new Error(`${where}: not a [Section] header or a Key=value line in a section`);
    const [key, value] = [assignment[1], assignment[2]];
    if (value.includes("#")) throw new Error(`${where}: "#" in a value (no inline comments)`);
    if (/["']/u.test(value) && key !== "HealthCmd") throw new Error(`${where}: a quoted value`);
    lines.push({ section, key, value, line: index + 1 });
  });
  return lines;
}

/** Every value of a key in a section, in file order. */
export const valuesOf = (unit: UnitLine[], section: string, key: string) =>
  unit.filter((line) => line.section === section && line.key === key).map((line) => line.value);

/** The one value of a key in a section; fails when it is missing or repeated. */
export function single(unit: UnitLine[], section: string, key: string): string {
  const values = valuesOf(unit, section, key);
  if (values.length !== 1 || values[0] === undefined)
    throw new Error(`[${section}] ${key} appears ${values.length} times, not once`);
  return values[0];
}

/** The keys a section uses, sorted and without repeats. */
export const keysOf = (unit: UnitLine[], section: string) =>
  [...new Set(unit.filter((line) => line.section === section).map((line) => line.key))].sort();

/** The sections a unit file uses, in file order. */
export const sectionsOf = (unit: UnitLine[]) => [...new Set(unit.map((line) => line.section))];

/** One entry of a Podman env file: a fixed value, or null for a bare name passed from the host. */
export interface EnvEntry {
  name: string;
  value: string | null;
}

/** Parse a Podman env file under the house rules, naming the file and line on a breach. */
export function parseEnvFile(text: string, file: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const where = `${file}:${index + 1}`;
    if (raw === "" || raw.startsWith("#")) return;
    // Podman keeps a value's trailing whitespace and a name's, so neither may have any.
    const entry = /^([A-Z][A-Z0-9_]*)(?:=([^\s"'#*\\]*(?:[ ][^\s"'#*\\]+)*))?$/u.exec(raw);
    if (!entry?.[1])
      throw new Error(`${where}: not NAME=value or a bare NAME (quotes, "#", "*" or whitespace)`);
    const name = entry[1];
    if (seen.has(name)) throw new Error(`${where}: ${name} is listed twice`);
    seen.add(name);
    entries.push({ name, value: entry[2] ?? null });
  });
  return entries;
}

/** The names an env file lists. */
export const namesOf = (entries: EnvEntry[]) => entries.map((entry) => entry.name);

/**
 * The environment a container gets from env files read in order, as Podman merges them (a later
 * file wins): a fixed value, or null where the value comes from the host's environment.
 */
export function merged(...files: EnvEntry[][]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const file of files) for (const entry of file) result.set(entry.name, entry.value);
  return result;
}

/** The release's unit, parsed. */
export const unit = async () =>
  parseUnit(await read(`${QUADLET}/units/tarubot.container`), "units/tarubot.container");
/** A target's drop-in, parsed. */
export const dropIn = async (target: Target) => {
  const path = `${target}/tarubot.container.d/50-target.conf`;
  return parseUnit(await read(`${QUADLET}/${path}`), path);
};
/** The base list every host's container gets. */
export const baseList = async () =>
  parseEnvFile(await read(`${QUADLET}/units/tarubot.env`), "units/tarubot.env");
/** A target's list. */
export const targetList = async (target: Target) =>
  parseEnvFile(await read(`${QUADLET}/${target}/target.env`), `${target}/target.env`);

/** Every file under a repository directory, as paths relative to it, sorted. */
export function filesUnder(directory: string): string[] {
  const base = root(directory);
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      return statSync(full).isDirectory() ? walk(full) : [relative(base, full)];
    });
  return walk(base).sort();
}

/** Every directory under a repository directory, as paths relative to it, sorted. */
export function directoriesUnder(directory: string): string[] {
  const base = root(directory);
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      return statSync(full).isDirectory() ? [relative(base, full), ...walk(full)] : [];
    });
  return walk(base).sort();
}
