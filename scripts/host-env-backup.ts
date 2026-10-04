/**
 * Owner-run encrypted copy of the production host's central `.env`.
 * Read `~/tarubot/.env` over SSH and encrypt it with age for `ops/age-recipients.txt`.
 * Only encrypted output is written; settings never touch this machine's disk or terminal.
 * See docs/DEPLOYMENT.md for host recovery.
 *
 * Usage: bun scripts/host-env-backup.ts --host USER@HOST [--out DIRECTORY] [--identity KEY_FILE]
 *
 * --host is required: the production host as the owner reaches it over SSH.
 * With --identity (the private key), the new file is also decrypted in memory and compared with
 * what was read, proving the key opens it. The output names only the settings present, never values.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Central runtime settings required by the production Compose manifest. */
export const REQUIRED_SETTINGS = [
  "DISCORD_APPLICATION_ID",
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "DISCORD_TOKEN",
] as const;
/** Settings a complete production `.env` also holds; their absence is reported, not refused. */
export const EXPECTED_SETTINGS = [
  "GITHUB_REPORTS_TOKEN",
  // The TaruBot GitHub App behind /suggest (2.28.0); the key is a quoted multi-line PEM.
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "HEALTHCHECKS_PING_URL",
  // The daily backup's storage and check (2.24.0; ops/backup.sh).
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "BACKUP_STORAGE_REGION",
  "HEALTHCHECKS_BACKUP_URL",
] as const;

export interface Options {
  host: string;
  out: string;
  identity: string | null;
}

/** Refusal when --host is missing; thrown before any SSH connection or file write. */
export const MISSING_HOST =
  "Name the production host with --host USER@HOST, such as --host tarubot@<production host>.";

/**
 * Parse the command line; unknown arguments are refused rather than ignored. The host has no
 * default, so a run without --host stops here, before anything reaches the network or the disk.
 */
export function parseArgs(argv: readonly string[], home = homedir()): Options {
  const options: Options = {
    host: "",
    out: `${home}/tarubot-cutover/env-backups`,
    identity: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--host" && flag !== "--out" && flag !== "--identity")
      throw new Error(`Unknown argument ${flag}. Use --host, --out or --identity.`);
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    if (flag === "--host") options.host = value;
    else if (flag === "--out") options.out = value;
    else options.identity = value;
    index++;
  }
  if (!options.host) throw new Error(MISSING_HOST);
  return options;
}

/**
 * The setting names a `.env` defines, in order. Values are skipped, including every line of a
 * quoted multi-line value such as the CA: a base64 line inside it can look like `NAME=`, and
 * reporting it would print part of a value. Quotes are tracked as Compose reads them: a value
 * opening with `"` or `'` runs until that quote closes, and a backslash escapes a double quote.
 */
export function settingNames(text: string): string[] {
  const names: string[] = [];
  let open: '"' | "'" | null = null;
  for (const line of text.split("\n")) {
    if (open) {
      if (closes(line, open)) open = null;
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    names.push(match[1] ?? "");
    const value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !closes(value.slice(1), quote)) open = quote;
  }
  return names;
}

/** Whether `text` holds the closing `quote`: any `'`, or a `"` not escaped by a backslash. */
function closes(text: string, quote: '"' | "'"): boolean {
  if (quote === "'") return text.includes("'");
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return true;
  }
  return false;
}

/**
 * Refuse a `.env` that couldn't start production, naming what's missing, never a value. Returns
 * the expected settings that are absent, which the output reports.
 */
export function checkSettings(names: readonly string[]): string[] {
  const present = new Set(names);
  const missing = REQUIRED_SETTINGS.filter((name) => !present.has(name));
  if (missing.length) throw new Error(`The host's .env lacks ${missing.join(", ")}.`);
  return EXPECTED_SETTINGS.filter((name) => !present.has(name));
}

/** A sortable, UTC-stamped file name: tarubot-env-20260925T123456Z.age. */
export function backupName(now: Date): string {
  return `tarubot-env-${now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z")}.age`;
}

/** The age public keys to encrypt for: every non-comment line of the recipients file. */
export function recipients(text: string): string[] {
  const keys = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!keys.length || keys.some((key) => !/^age1[0-9a-z]{58}$/u.test(key)))
    throw new Error("ops/age-recipients.txt must list one or more age public keys (age1…).");
  return keys;
}

/** Run a command with `input` on stdin; resolve its stdout, or throw with its exit status. */
export type Runner = (command: string[], input?: Uint8Array) => Promise<Uint8Array>;

const run: Runner = async (command, input) => {
  const child = Bun.spawn(command, {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (input && child.stdin) {
    child.stdin.write(input);
    await child.stdin.end();
  }
  const output = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  if ((await child.exited) !== 0) throw new Error(`${command[0]} failed (${child.exitCode}).`);
  return output;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Encrypt `plain` into `file` so that only a good copy ever carries the final name. age writes a
 * hidden temporary file first; with an identity, that file must decrypt to `plain` before it is
 * renamed into place. Any failure removes the temporary file and leaves no `tarubot-env-*.age`
 * behind, since the rebuild runbook restores the newest such file by name.
 */
export async function writeBackup(options: {
  plain: Uint8Array;
  file: string;
  recipientsFile: string;
  identity: string | null;
  runner?: Runner;
}): Promise<{ sha256: string; verified: boolean | null }> {
  const runner = options.runner ?? run;
  const temporary = `${dirname(options.file)}/.${basename(options.file)}.partial`;
  try {
    await runner(
      ["age", "--encrypt", "--recipients-file", options.recipientsFile, "--output", temporary],
      options.plain,
    );
    await chmod(temporary, 0o600);
    let verified: boolean | null = null;
    if (options.identity) {
      const decrypted = await runner([
        "age",
        "--decrypt",
        "--identity",
        options.identity,
        temporary,
      ]);
      verified = sha256(decrypted) === sha256(options.plain);
      if (!verified) throw new Error("The new copy did not decrypt to what was read.");
    }
    const digest = sha256(new Uint8Array(await Bun.file(temporary).arrayBuffer()));
    await rename(temporary, options.file);
    return { sha256: digest, verified };
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (!Bun.which("age")) throw new Error("age is not installed (Ubuntu: sudo apt install age).");
  const recipientsFile = fileURLToPath(new URL("../ops/age-recipients.txt", import.meta.url));
  recipients(await Bun.file(recipientsFile).text());
  // Read the settings into memory only; BatchMode refuses rather than prompting for a password.
  const plain = await run(["ssh", "-o", "BatchMode=yes", options.host, "cat ~/tarubot/.env"]);
  const names = settingNames(new TextDecoder().decode(plain));
  const absent = checkSettings(names);
  process.umask(0o077);
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  const file = `${options.out}/${backupName(new Date())}`;
  const result = await writeBackup({ plain, file, recipientsFile, identity: options.identity });
  console.log(
    JSON.stringify(
      {
        file,
        bytes: (await stat(file)).size,
        sha256: result.sha256,
        settings: names,
        notSet: absent,
        verified: result.verified,
      },
      null,
      2,
    ),
  );
}
