/**
 * The PostgreSQL client tools (pg_dump for backups, pg_restore for restore.js, 2.46.0) and the
 * libpq environment they connect with. A URL or password never enters a tool's argv, where any
 * process on the machine can read it: the connection travels in the child's environment, which is
 * built from scratch rather than copied from process.env, so the bot's own settings (the Discord
 * token, MODMAIL_KEY) never reach the tool.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** The CA setting that goes with a URL setting, for refusals that need one. */
const caSetting = (setting: string): string =>
  setting === "RESTORE_DATABASE_URL"
    ? "RESTORE_DATABASE_CA_CERT (or DATABASE_CA_CERT)"
    : "DATABASE_CA_CERT";

/** libpq's own sslmode values, which a URL that asks for libpq's meaning may name. */
const LIBPQ_SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/**
 * The child environment for one tool run: the URL's parts as libpq variables (decoded), a 10 s
 * connect timeout and the application name, plus only PATH, HOME and TMPDIR from this process.
 * `rootCert` is the path of the CA file when there is one: then verify-full, whatever TLS the URL
 * names, as the bot's own pool does (connection.ts). Refusals name the setting, never a value.
 *
 * Without a CA the tool must check the server exactly as the bot's driver does: never less (a
 * backup would then hand the whole database, and the password, to whoever sits between them; a
 * self-signed server or a plaintext one the bot refuses must be refused here too), and never more
 * (a backup would fail, and with it every migrating start, where the bot connects fine). The URL
 * never reaches the tool, so its TLS parameters are translated with node-postgres's reading
 * (pg-connection-string 2.x, then pg's ConnectionParameters):
 * - sslmode=disable (or ssl=0 with no other TLS parameter): no TLS;
 * - sslmode=no-verify (or, with no sslmode or file, ssl=no-verify): encrypted, nothing verified:
 *   libpq's require, with no root certificate (libpq verifies the chain whenever one is named);
 * - any other sslmode, or none but sslrootcert, sslcert, sslkey, sslnegotiation=direct or any
 *   other ssl value (pg takes true, 1 and any other string, even "false", as TLS on): node-postgres
 *   verifies the chain and the host name, so verify-full, against sslrootcert or, without one, the
 *   system's roots (PGSSLROOTCERT=system, libpq 16 and later with the image's CA bundle, where
 *   node-postgres uses Node's);
 * - nothing TLS-related: node-postgres connects in plaintext; libpq's default tries TLS first.
 * With uselibpqcompat=true node-postgres reads sslmode as libpq does, so it passes through, except
 * prefer and allow, which libpq would let fall back to plaintext where node-postgres insists on
 * TLS (require and verify-full respectively), and verify-ca without sslrootcert, which
 * node-postgres refuses as well. sslcert and sslkey become PGSSLCERT and PGSSLKEY (withLibpq hands
 * libpq a private copy of the key).
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
  let tls: Record<
    "sslmode" | "sslrootcert" | "sslcert" | "sslkey" | "ssl" | "sslnegotiation" | "uselibpqcompat",
    string | null
  >;
  try {
    const endpoint = new URL(database.url);
    password = decodeURIComponent(endpoint.password);
    // node-postgres treats an empty parameter as absent.
    const parameter = (name: string) => endpoint.searchParams.get(name) || null;
    tls = {
      sslmode: parameter("sslmode"),
      sslrootcert: parameter("sslrootcert"),
      sslcert: parameter("sslcert"),
      sslkey: parameter("sslkey"),
      ssl: parameter("ssl"),
      sslnegotiation: parameter("sslnegotiation"),
      uselibpqcompat: parameter("uselibpqcompat"),
    };
  } catch {
    // A malformed escape: the error itself carries no value, but say only which setting.
    throw new Failure("configuration", `${database.setting} must be a PostgreSQL URL.`);
  }
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
    return environment;
  }
  const { sslmode } = tls;
  if (sslmode === "disable" || (sslmode === null && tls.ssl === "0" && !clientFiles(tls))) {
    environment.PGSSLMODE = "disable";
    return environment;
  }
  if (tls.sslcert !== null) environment.PGSSLCERT = tls.sslcert;
  if (tls.sslkey !== null) environment.PGSSLKEY = tls.sslkey;
  if (tls.sslnegotiation === "direct") environment.PGSSLNEGOTIATION = "direct";
  if (
    sslmode === "no-verify" ||
    (sslmode === null && !clientFiles(tls) && tls.ssl === "no-verify")
  ) {
    environment.PGSSLMODE = "require";
    return environment;
  }
  if (tls.uselibpqcompat === "true" && sslmode !== null && LIBPQ_SSL_MODES.includes(sslmode)) {
    if (sslmode === "verify-ca" && tls.sslrootcert === null)
      throw new Failure(
        "configuration",
        `${database.setting} names sslmode=verify-ca without sslrootcert, which the bot's driver refuses too. Set ${caSetting(database.setting)} to the provider's CA certificate, or name sslrootcert in the URL.`,
      );
    environment.PGSSLMODE = { prefer: "require", allow: "verify-full" }[sslmode] ?? sslmode;
    if (tls.sslrootcert !== null) environment.PGSSLROOTCERT = tls.sslrootcert;
    else if (environment.PGSSLMODE === "verify-full") environment.PGSSLROOTCERT = "system";
    return environment;
  }
  // ssl=0 alone returned above, so any ssl value left turns TLS on.
  const verified =
    sslmode !== null || tls.ssl !== null || clientFiles(tls) || tls.sslnegotiation === "direct";
  if (verified) {
    environment.PGSSLMODE = "verify-full";
    environment.PGSSLROOTCERT = tls.sslrootcert ?? "system";
  }
  return environment;
}

/** Whether the URL names any certificate or key file (node-postgres then turns TLS on). */
const clientFiles = (tls: {
  sslrootcert: string | null;
  sslcert: string | null;
  sslkey: string | null;
}) => tls.sslrootcert !== null || tls.sslcert !== null || tls.sslkey !== null;

/**
 * Run `use` with a tool's environment. A CA is written to a private file (a fresh 0700 directory
 * under the temporary directory, the file 0600), since libpq reads it only from a file, and so is a
 * copy of a client key the URL names (libpq demands 0600), both removed afterwards whatever `use`
 * did. The managed manifests mount a small tmpfs at /tmp for it, as the
 * container's root filesystem is read-only.
 */
export async function withLibpq<T>(
  database: ToolDatabase,
  application: ClientApplication,
  use: (environment: Record<string, string>) => Promise<T>,
): Promise<T> {
  const environment = libpqEnvironment(database, application, null);
  const key = database.ca ? undefined : environment.PGSSLKEY;
  if (!database.ca && key === undefined) return await use(environment);
  const directory = await mkdtemp(join(tmpdir(), "tarubot-libpq-"));
  try {
    if (database.ca) {
      const rootCert = join(directory, "root.crt");
      await writeFile(rootCert, database.ca, { mode: 0o600, flag: "wx" });
      return await use(libpqEnvironment(database, application, rootCert));
    }
    // libpq refuses a client key that its group or others may read (node-postgres doesn't
    // check), so it gets a private copy of the key the bot reads.
    const copy = join(directory, "client.key");
    let text: string;
    try {
      text = await readFile(key as string, "utf8");
    } catch {
      throw new Failure("configuration", `${database.setting} names an sslkey that can't be read.`);
    }
    await writeFile(copy, text, { mode: 0o600, flag: "wx" });
    return await use({ ...environment, PGSSLKEY: copy });
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
