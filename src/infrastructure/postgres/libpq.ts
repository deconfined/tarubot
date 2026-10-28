/**
 * The PostgreSQL client tools (pg_dump for backups, pg_restore for restore.js, 2.46.0) and the
 * libpq environment they connect with. A URL or password never enters a tool's argv, where any
 * process on the machine can read it: the connection travels in the child's environment, which is
 * built from scratch rather than copied from process.env, so the bot's own settings (the Discord
 * token, MODMAIL_KEY) never reach the tool.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseIdentity } from "../../config/deployment.js";
import { Failure } from "../../domain/values.js";

/** Which tool is connecting, for pg_stat_activity's application_name. */
export type ClientApplication = "tarubot-backup" | "tarubot-restore";

/** One database to connect a tool to: its URL, the setting it came from, and its CA, if any. */
export interface ToolDatabase {
  readonly url: string;
  /** The setting's name, the only thing a refusal names. */
  readonly setting: string;
  /** The provider's CA certificate (PEM); empty or unset means none. */
  readonly ca: string | undefined;
}

/** libpq's sslmode values; anything else in a URL is refused rather than passed on. */
const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/**
 * The child environment for one tool run: the URL's parts as libpq variables (decoded), a 10 s
 * connect timeout and the application name, plus only PATH, HOME and TMPDIR from this process.
 * `rootCert` is the path of the CA file when there is one: then verify-full, whatever sslmode the
 * URL names, as the bot's own pool does (connection.ts). Without one the URL's sslmode is kept, and
 * an absent sslmode leaves libpq's default. Refusals name the setting, never a value.
 */
export function libpqEnvironment(
  database: ToolDatabase,
  application: ClientApplication,
  rootCert: string | null,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  // Refuses host, port, user and database parameters that would redirect the connection.
  const target = databaseIdentity(database.url, database.setting);
  let password: string;
  let sslmode: string | null;
  try {
    const endpoint = new URL(database.url);
    password = decodeURIComponent(endpoint.password);
    sslmode = endpoint.searchParams.get("sslmode");
  } catch {
    // A malformed escape: the error itself carries no value, but say only which setting.
    throw new Failure("configuration", `${database.setting} must be a PostgreSQL URL.`);
  }
  if (rootCert === null && sslmode !== null && !SSL_MODES.includes(sslmode))
    throw new Failure("configuration", `${database.setting} names an sslmode libpq doesn't know.`);
  const environment: Record<string, string> = {
    PATH: inherited.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGDATABASE: target.name,
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: application,
  };
  // A URL without a user or password leaves libpq's own defaults, as node-postgres does.
  if (target.user) environment.PGUSER = target.user;
  if (password) environment.PGPASSWORD = password;
  for (const name of ["HOME", "TMPDIR"] as const) {
    const value = inherited[name];
    if (value) environment[name] = value;
  }
  if (rootCert !== null) {
    environment.PGSSLMODE = "verify-full";
    environment.PGSSLROOTCERT = rootCert;
  } else if (sslmode !== null) environment.PGSSLMODE = sslmode;
  return environment;
}

/**
 * Run `use` with a tool's environment. A CA is written to a private file (a fresh 0700 directory
 * under the temporary directory, the file 0600), since libpq reads it only from a file, and removed
 * afterwards whatever `use` did. The managed manifests mount a small tmpfs at /tmp for it, as the
 * container's root filesystem is read-only.
 */
export async function withLibpq<T>(
  database: ToolDatabase,
  application: ClientApplication,
  use: (environment: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!database.ca) return await use(libpqEnvironment(database, application, null));
  const directory = await mkdtemp(join(tmpdir(), "tarubot-libpq-"));
  try {
    const rootCert = join(directory, "root.crt");
    await writeFile(rootCert, database.ca, { mode: 0o600, flag: "wx" });
    return await use(libpqEnvironment(database, application, rootCert));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One running client tool. Its standard error goes to this process's, never into a log record. */
export interface ToolProcess {
  /** The tool's standard output when it was asked for (pg_dump's archive), else null. */
  readonly stdout: ReadableStream<Uint8Array> | null;
  /** Its exit status; a signal counts as a failure. */
  readonly exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/**
 * Start a tool: with `stdin` it reads that stream and its output is left on this process's
 * (pg_restore); without, its output is piped back (pg_dump). Tests pass a double.
 */
export type RunTool = (
  command: readonly string[],
  options: { env: Readonly<Record<string, string>>; stdin?: ReadableStream<Uint8Array> },
) => ToolProcess;

/** The tool runner used outside tests. */
export const runTool: RunTool = (command, { env, stdin }) => {
  if (stdin) {
    const child = Bun.spawn([...command], { env, stdin, stdout: "inherit", stderr: "inherit" });
    return { stdout: null, exited: child.exited, kill: (signal) => child.kill(signal) };
  }
  const child = Bun.spawn([...command], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  return { stdout: child.stdout, exited: child.exited, kill: (signal) => child.kill(signal) };
};
