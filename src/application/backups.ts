/**
 * Encrypted offsite backups, taken by the bot itself (2.46.0): no host script, cron entry or host
 * tool. Once a day at BACKUP_TIME_UTC while this process holds the writer lease, and immediately
 * before pending migrations apply (Database.migrate's beforeApply), it streams
 * `pg_dump --format=custom` through age encryption straight into a multipart upload, then stores
 * an encrypted copy of the bot's own settings beside it. No plaintext touches the disk or a log.
 *
 * The object layout is the one ops/bucket-lifecycle.xml's retention and the owner's age identity
 * already work with:
 *
 *   daily/tarubot-<YYYYMMDDTHHMMSSZ>.dump.age     the encrypted dump
 *   monthly/tarubot-<stamp>.dump.age              the same ciphertext, when the stamp's day is 01
 *   env/tarubot-env-<stamp>.age                   the encrypted settings copy
 *
 * The settings copy carries MODMAIL_KEY with every other setting: the owner's 2026-10-11 trade-off,
 * so a lost runtime can be rebuilt and a lost mod mail key recovered, at the price that whoever
 * holds the age identity can read every mod mail case the dumps hold.
 *
 * The settings below are plain environment variables read here, not by src/config/env.ts, so a
 * bad backup setting never stops the bot; problems name settings, never values.
 */
import { Encrypter } from "age-encryption";
import type { DeploymentName } from "../config/deployment.js";
import { project } from "../config/project.js";
import { type Environment, type ReadText, resolveSettings } from "../config/secrets.js";
import { Failure } from "../domain/values.js";
import {
  type BackupStorage,
  S3BackupStorage,
  type StorageSettings,
} from "../infrastructure/backup/storage.js";
import {
  type RunTool,
  runTool,
  type ToolProcess,
  withLibpq,
} from "../infrastructure/postgres/libpq.js";
import type { Reporter } from "./reporting.js";

/**
 * The restore step every restored database needs before a bot starts on it: a roles.self job the
 * backup caught waiting would otherwise replay a member's old role choices over newer ones
 * (docs/PERSISTENCE.md). restore.js runs it; tests compare it with the documented copies.
 */
export const RESTORED_ROLE_JOBS_SQL = `UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
       result='{"skipped":"restored"}'
 WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');`;

/** The encrypted dump must be larger than this; anything smaller can't be a real database. */
export const MIN_DUMP_BYTES = 4096;

/** The default for BACKUP_TIME_UTC. */
export const DEFAULT_BACKUP_TIME = "03:00";

/** Where a backup failed, as the healthchecks failure ping and the failure name it. */
export type BackupStage = "settings" | "dump" | "settings-copy" | "upload";

/** A failed backup. Its message names the stage and a reason, never a value. */
export class BackupFailure extends Failure {
  constructor(
    readonly stage: BackupStage,
    reason: string,
    /** Shutdown began while it ran: the run was abandoned, not broken. */
    readonly interrupted = false,
  ) {
    super("backup", `Backup failed at: ${stage}. ${reason}`);
  }
}

/** Every setting this module reads, for documentation and the manifests' pass-through. */
export const BACKUP_SETTINGS = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY",
  "BACKUP_STORAGE_SECRET_KEY",
  "BACKUP_STORAGE_REGION",
  "BACKUP_AGE_RECIPIENTS",
  "BACKUP_TIME_UTC",
  "HEALTHCHECKS_BACKUP_URL",
] as const;

/** Validated backup settings. */
export interface BackupSettings {
  readonly storage: StorageSettings;
  /** age public keys (age1...) every copy is encrypted to. */
  readonly recipients: readonly string[];
  /** HH:MM, UTC. */
  readonly time: string;
  /** The healthchecks.io check for backups, or null. */
  readonly ping: string | null;
}

/**
 * Off when BACKUP_STORAGE_ENDPOINT is empty; on when every setting is valid; otherwise invalid,
 * with the settings at fault, and every attempt fails at stage `settings` (pinging /fail when the
 * ping URL itself is valid) until they are fixed. Daily attempts still run while invalid, at the
 * default time if BACKUP_TIME_UTC is the bad one, so a healthchecks.io check notices.
 */
export type BackupConfiguration =
  | { readonly status: "off" }
  | { readonly status: "on"; readonly settings: BackupSettings }
  | {
      readonly status: "invalid";
      readonly problems: readonly string[];
      readonly ping: string | null;
      readonly time: string;
    };

const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._/-]*)?$/u;
const REGION = /^[a-z0-9-]+$/u;
const RECIPIENT = /^age1[0-9a-z]{58}$/u;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const PING = /^https:\/\/[A-Za-z0-9./_-]+$/u;

/** Unset and empty (Compose's ${NAME:-}) both mean "not given". */
const given = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * The bucket settings alone, which restore.js needs without the rest: null when
 * BACKUP_STORAGE_ENDPOINT is empty, else the storage or the settings at fault. The endpoint is the
 * bucket's own host; `https://` may be left off, one trailing `/` is dropped, and a path becomes a
 * key prefix.
 */
export function storageSettings(
  env: Environment,
): { storage: StorageSettings } | { problems: string[] } | null {
  const raw = env.BACKUP_STORAGE_ENDPOINT;
  if (!given(raw)) return null;
  const problems: string[] = [];
  let endpoint = raw.startsWith("https://") ? raw : `https://${raw}`;
  if (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  const match = ENDPOINT.exec(endpoint);
  if (!match) problems.push("BACKUP_STORAGE_ENDPOINT");
  const accessKey = env.BACKUP_STORAGE_ACCESS_KEY;
  const secretKey = env.BACKUP_STORAGE_SECRET_KEY;
  const region = env.BACKUP_STORAGE_REGION;
  if (!given(accessKey)) problems.push("BACKUP_STORAGE_ACCESS_KEY");
  if (!given(secretKey)) problems.push("BACKUP_STORAGE_SECRET_KEY");
  // Required, with no hidden default: a wrong region fails every request's signature.
  if (!given(region) || !REGION.test(region)) problems.push("BACKUP_STORAGE_REGION");
  if (problems.length || !match || !accessKey || !secretKey || !region) return { problems };
  const path = (match[2] ?? "").replace(/^\/+/u, "");
  return {
    storage: {
      endpoint: endpoint.slice(0, endpoint.length - (match[2]?.length ?? 0)),
      prefix: path ? `${path}/` : "",
      accessKey,
      secretKey,
      region,
    },
  };
}

/**
 * age public keys, separated by whitespace or commas; null unless there is one and all are valid.
 * Valid means the X25519 shape and a key age-encryption itself decodes: the shape alone passes a
 * key with one mistyped character (only its Bech32 checksum catches that), which would otherwise
 * surface only once a backup began encrypting, as a stage `dump` failure that never names this
 * setting, and on production as every migrating release refused for a pg_dump-side reason.
 */
export function ageRecipients(value: string | undefined): string[] | null {
  const keys = (value ?? "").split(/[\s,]+/u).filter(Boolean);
  return keys.length && keys.every((key) => RECIPIENT.test(key) && decodes(key)) ? keys : null;
}

/**
 * Whether age-encryption accepts the key as a recipient. addRecipient decodes it at once
 * (checksum, prefix and length) and throws for a bad one; the error, which may quote the key, is
 * dropped, since problems name settings only.
 */
function decodes(key: string): boolean {
  try {
    new Encrypter().addRecipient(key);
    return true;
  } catch {
    return false;
  }
}

/** Read and validate every backup setting (see BackupConfiguration). */
export function backupConfiguration(env: Environment): BackupConfiguration {
  const time = given(env.BACKUP_TIME_UTC) ? env.BACKUP_TIME_UTC : DEFAULT_BACKUP_TIME;
  const pingValue = env.HEALTHCHECKS_BACKUP_URL;
  const ping = given(pingValue) && PING.test(pingValue) ? pingValue : null;
  const bucket = storageSettings(env);
  if (bucket === null) return { status: "off" };
  const problems = "problems" in bucket ? [...bucket.problems] : [];
  const recipients = ageRecipients(env.BACKUP_AGE_RECIPIENTS);
  if (recipients === null) problems.push("BACKUP_AGE_RECIPIENTS");
  if (!TIME.test(time)) problems.push("BACKUP_TIME_UTC");
  if (given(pingValue) && ping === null) problems.push("HEALTHCHECKS_BACKUP_URL");
  if (problems.length || !("storage" in bucket) || recipients === null)
    return {
      status: "invalid",
      problems,
      ping,
      time: TIME.test(time) ? time : DEFAULT_BACKUP_TIME,
    };
  return { status: "on", settings: { storage: bucket.storage, recipients, time, ping } };
}

/** The next HH:MM UTC strictly after `now`. */
export function nextBackupAt(now: Date, time: string): Date {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * The bot's settings as the container received them, for the env/ copy: captured once at startup,
 * before MODMAIL_KEY leaves process.env, and held only by the backup service. Every variable whose
 * name looks like a setting, minus what the runtime itself sets, with file-delivered secrets
 * (NAME_FILE) replaced by their values under NAME, so the copy rebuilds a runtime without the files.
 */
export type SettingsSnapshot = Readonly<Record<string, string>>;

/** Variables the runtime (the image, Docker, a shell) sets, which are no part of TaruBot's settings. */
const RUNTIME_VARIABLES = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
]);
const RUNTIME_PREFIXES = ["BUN_", "NODE_", "LC_"];

/** Capture the snapshot (see SettingsSnapshot). Throws as configuration() does for a bad NAME_FILE. */
export function settingsSnapshot(env: Environment, read?: ReadText): SettingsSnapshot {
  const resolved = resolveSettings(env, read);
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(resolved))
    if (
      value !== undefined &&
      /^[A-Z][A-Z0-9_]*$/u.test(name) &&
      !RUNTIME_VARIABLES.has(name) &&
      !RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
      snapshot[name] = value;
  return Object.freeze(snapshot);
}

/**
 * One value as Compose's dotenv reads it back exactly (checked against `docker compose --env-file`
 * itself). Single-quoted only when it holds neither a single quote nor a backslash: Compose reads
 * such a value literally (no interpolation, and it may span lines). Compose's parser still takes a
 * backslash before a quote as an escape inside single quotes, so a value ending in a backslash
 * would run on into the next line and make Compose refuse the whole copy. Any other value is
 * double-quoted with backslash, double quote and dollar escaped (`\\`, `\"`, `$$`): every
 * backslash is then part of one of these escapes, so none can start another (`\n`, say), and
 * Compose reads each back as the one character it stands for.
 */
export function dotenvValue(value: string): string {
  if (!value.includes("'") && !value.includes("\\")) return `'${value}'`;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "$$$$")}"`;
}

/**
 * The settings copy: a Compose-compatible env file, one NAME='value' (or NAME="value", see
 * dotenvValue) per setting, sorted by name.
 */
export function settingsCopy(snapshot: SettingsSnapshot, version: string, stamp: string): string {
  const lines = Object.keys(snapshot)
    .sort()
    .map((name) => `${name}=${dotenvValue(snapshot[name] ?? "")}`);
  return `# TaruBot ${version} settings copy, ${stamp}\n${lines.join("\n")}\n`;
}

/** A sortable UTC stamp: 20261028T030000Z. */
export function backupStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
}

/** A dump's key, daily or monthly. */
export const DUMP_KEY = /^(daily|monthly)\/tarubot-\d{8}T\d{6}Z\.dump\.age$/u;
/** A settings copy's key. */
export const SETTINGS_KEY = /^env\/tarubot-env-\d{8}T\d{6}Z\.age$/u;

/** One backup's keys. The monthly copy is decided from the same stamp, once. */
export function backupKeys(stamp: string): { daily: string; monthly: string | null; env: string } {
  return {
    daily: `daily/tarubot-${stamp}.dump.age`,
    monthly: stamp.slice(6, 8) === "01" ? `monthly/tarubot-${stamp}.dump.age` : null,
    env: `env/tarubot-env-${stamp}.age`,
  };
}

/** What one successful backup stored. */
export interface StoredBackup {
  readonly stamp: string;
  readonly daily: { readonly key: string; readonly bytes: number };
  readonly monthly: { readonly key: string; readonly bytes: number } | null;
  readonly env: { readonly key: string; readonly bytes: number };
}

/** A fetch for the healthchecks.io pings; tests pass a recording double. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** What a backup runs with; production uses the defaults, tests replace each one. */
export interface BackupTools {
  readonly storage?: (settings: StorageSettings) => BackupStorage;
  readonly runTool?: RunTool;
  readonly fetch?: Fetcher;
  readonly now?: () => Date;
}

/** A ping's deadline; pings are best effort and never fail or hold up a backup for long. */
const PING_TIMEOUT_MS = 10_000;

/**
 * One healthchecks.io ping with the protocol the host script used: `<url>/start`, `<url>` and
 * `<url>/fail`, each with a one-line body. The URL is a credential of sorts and isn't logged.
 */
async function ping(fetcher: Fetcher, url: string | null, path: string, body: string) {
  if (url === null) return;
  try {
    const response = await fetcher(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain", "user-agent": "TaruBot-backup" },
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    // Best effort: a missed ping shows up in healthchecks.io itself.
  }
}

/**
 * Take one backup with the given settings snapshot (which also supplies DATABASE_URL and its CA).
 * Rejects with a BackupFailure naming the stage; `signal` abandons a run in progress: pg_dump is
 * killed and the upload aborted, so no object is left half-written.
 */
export async function takeBackup(
  snapshot: SettingsSnapshot,
  tools: BackupTools = {},
  signal: AbortSignal = new AbortController().signal,
  version: string = project.version,
): Promise<StoredBackup> {
  const fetcher = tools.fetch ?? fetch;
  if (signal.aborted) throw new BackupFailure("dump", "Shutdown began.", true);
  const configuration = backupConfiguration(snapshot);
  if (configuration.status !== "on") {
    if (configuration.status === "off")
      throw new BackupFailure(
        "settings",
        "Backups aren't configured (BACKUP_STORAGE_ENDPOINT is empty).",
      );
    await ping(fetcher, configuration.ping, "/fail", "backup failed at: settings");
    throw new BackupFailure(
      "settings",
      `These backup settings are missing or invalid: ${configuration.problems.join(", ")}.`,
    );
  }
  const { settings } = configuration;
  let stage: BackupStage = "dump";
  await ping(fetcher, settings.ping, "/start", "backup starting");
  try {
    const url = snapshot.DATABASE_URL;
    if (!url) throw new BackupFailure("dump", "DATABASE_URL is empty.");
    const storage = (tools.storage ?? ((bucket) => new S3BackupStorage(bucket)))(settings.storage);
    const stamp = backupStamp((tools.now ?? (() => new Date()))());
    const keys = backupKeys(stamp);
    const encrypter = new Encrypter();
    for (const recipient of settings.recipients) encrypter.addRecipient(recipient);

    const dailyBytes = await storeDump({
      storage,
      key: keys.daily,
      encrypter,
      database: { url, setting: "DATABASE_URL", ca: snapshot.DATABASE_CA_CERT },
      runTool: tools.runTool ?? runTool,
      signal,
    });
    stage = "upload";
    let monthly: StoredBackup["monthly"] = null;
    if (keys.monthly) {
      // The same ciphertext, read back from the daily copy just stored.
      const bytes = await storage.put(keys.monthly, storage.get(keys.daily));
      if (bytes !== dailyBytes)
        throw new BackupFailure("upload", "The monthly copy's size differs from the daily one.");
      monthly = { key: keys.monthly, bytes };
    }
    if (signal.aborted) throw new BackupFailure(stage, "Shutdown began.", true);

    stage = "settings-copy";
    const copy = await encrypter.encrypt(settingsCopy(snapshot, version, stamp));
    stage = "upload";
    const envBytes = await storage.put(keys.env, copy);
    if (envBytes !== copy.length)
      throw new BackupFailure("upload", "The stored settings copy's size differs.");
    await ping(
      fetcher,
      settings.ping,
      "",
      `${keys.daily}: ${dailyBytes} bytes; ${keys.env}: ${envBytes} bytes`,
    );
    return {
      stamp,
      daily: { key: keys.daily, bytes: dailyBytes },
      monthly,
      env: { key: keys.env, bytes: envBytes },
    };
  } catch (error) {
    // Storage and encryption errors can carry bucket paths or SDK text; only the stage is kept.
    let failure: BackupFailure;
    if (error instanceof BackupFailure) failure = error;
    else if (signal.aborted) failure = new BackupFailure(stage, "Shutdown began.", true);
    else if (stage === "upload")
      failure = new BackupFailure(stage, "Storage refused or failed the upload.");
    else failure = new BackupFailure(stage, "Encryption failed.");
    // Only a real failure pings /fail. A run abandoned at shutdown (a restart, a tag move) broke
    // nothing: its /start stays open, the next run's success closes it, and healthchecks.io marks
    // the check down by itself if none succeeds within its grace time. Skipping the ping also
    // keeps up to PING_TIMEOUT_MS out of a shutdown that drain caps at 20 s.
    if (!failure.interrupted)
      await ping(fetcher, settings.ping, "/fail", `backup failed at: ${failure.stage}`);
    throw failure;
  }
}

/**
 * Stream pg_dump through age into `key` and resolve with the ciphertext's size. The body the upload
 * reads closes only after pg_dump exited 0 and the ciphertext passed MIN_DUMP_BYTES, so a dump that
 * failed part-way (whose output age would otherwise finish as a valid, truncated file) or a
 * shutdown errors the body instead, and storage drops the upload. Failures on the dump's side are
 * stage `dump`; the upload's own are `upload`.
 */
async function storeDump(input: {
  storage: BackupStorage;
  key: string;
  encrypter: Encrypter;
  database: { url: string; setting: string; ca: string | undefined };
  runTool: RunTool;
  signal: AbortSignal;
}): Promise<number> {
  const { signal } = input;
  if (signal.aborted) throw new BackupFailure("dump", "Shutdown began.", true);
  const run = async (env: Record<string, string>): Promise<number> => {
    let child: ToolProcess;
    try {
      child = input.runTool(["pg_dump", "--format=custom", "--no-owner", "--no-privileges"], {
        env,
      });
    } catch {
      throw new BackupFailure("dump", "pg_dump could not be started.");
    }
    const state = {
      exited: false,
      /** Set once the body errored on the dump's side; the upload's rejection then reports it. */
      failure: null as BackupFailure | null,
      body: null as ReadableStreamDefaultController<Uint8Array> | null,
      reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
      bytes: 0,
    };
    const status = child.exited.then((code) => {
      state.exited = true;
      return code;
    });
    const stopDump = () => {
      void state.reader?.cancel().catch(() => {});
      if (!state.exited) child.kill();
    };
    const fail = (reason: BackupFailure) => {
      if (state.failure) return;
      state.failure = reason;
      try {
        state.body?.error(reason);
      } catch {
        // Already closed or errored.
      }
      stopDump();
    };
    const stop = () => fail(new BackupFailure("dump", "Shutdown began.", true));
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (!child.stdout) throw new BackupFailure("dump", "pg_dump has no output.");
      const source = (await input.encrypter.encrypt(child.stdout)).getReader();
      state.reader = source;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          state.body = controller;
        },
        async pull(controller) {
          try {
            const { done, value } = await source.read();
            if (state.failure) return;
            if (!done) {
              state.bytes += value.length;
              controller.enqueue(value);
              return;
            }
            const code = await status;
            if (code !== 0) throw new BackupFailure("dump", `pg_dump exited with status ${code}.`);
            if (state.bytes <= MIN_DUMP_BYTES)
              throw new BackupFailure("dump", `The encrypted dump is only ${state.bytes} bytes.`);
            if (!state.failure) controller.close();
          } catch (error) {
            fail(
              error instanceof BackupFailure
                ? error
                : new BackupFailure("dump", "Encrypting the dump failed."),
            );
          }
        },
        // The upload gave up (a storage failure): stop reading and stop pg_dump.
        cancel: stopDump,
      });
      let stored: number;
      try {
        stored = await input.storage.put(input.key, stream);
      } catch {
        throw state.failure ?? new BackupFailure("upload", "Storage refused or failed the upload.");
      }
      if (state.failure) throw state.failure;
      if (stored !== state.bytes)
        throw new BackupFailure("upload", "The stored dump's size differs.");
      return state.bytes;
    } finally {
      signal.removeEventListener("abort", stop);
      if (!state.exited) child.kill();
      await status;
    }
  };
  try {
    return await withLibpq(input.database, "tarubot-backup", run);
  } catch (error) {
    // libpq refusals (a URL it can't take) name the setting; the private CA file can't be written.
    if (error instanceof BackupFailure) throw error;
    throw new BackupFailure(
      "dump",
      error instanceof Failure ? error.message : "The database CA couldn't be written to a file.",
    );
  }
}

/** Structured log output, as the composition root's logger provides it. */
export type BackupLog = (
  level: "info" | "warn",
  fields: Record<string, unknown>,
  message: string,
) => void;

/** Profiles that never migrate without a pre-migration backup. */
const BACKED_UP_PROFILES: readonly DeploymentName[] = ["production", "staging"];

/**
 * The first migration file. Migrations apply in order and applied files never change, so while
 * this one is pending the database holds no TaruBot data.
 */
const FIRST_MIGRATION = "001_initial.sql";

/** Timers for the daily schedule; tests replace them. */
export interface BackupTimers {
  set(delayMs: number, run: () => void): unknown;
  clear(handle: unknown): void;
}
const realTimers: BackupTimers = {
  set: (delayMs, run) => {
    const handle = setTimeout(run, delayMs);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The bot's backups: the daily schedule, the pre-migration backup and one-off runs, all sharing
 * one shutdown. stop() abandons whatever is running (pg_dump killed, upload aborted) and waits for
 * it, so the lease is never handed over with a dump still reading.
 */
export class Backups {
  readonly configuration: BackupConfiguration;
  private readonly stopping = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private timer: unknown;

  constructor(
    private readonly snapshot: SettingsSnapshot,
    private readonly log: BackupLog,
    private readonly tools: BackupTools & { timers?: BackupTimers } = {},
  ) {
    this.configuration = backupConfiguration(snapshot);
  }

  /** One backup now, logged when stored. Rejects with a BackupFailure. */
  async run(reason: "daily" | "pre-migration" | "one-off"): Promise<StoredBackup> {
    const started = performance.now();
    const run = takeBackup(this.snapshot, this.tools, this.stopping.signal);
    const tracked = run.catch(() => {});
    this.running.add(tracked);
    try {
      const stored = await run;
      this.log(
        "info",
        {
          reason,
          daily: stored.daily.key,
          dailyBytes: stored.daily.bytes,
          monthly: stored.monthly?.key ?? null,
          env: stored.env.key,
          envBytes: stored.env.bytes,
          durationMs: Math.round(performance.now() - started),
        },
        "Backup stored",
      );
      return stored;
    } finally {
      this.running.delete(tracked);
    }
  }

  /**
   * Database.migrate's beforeApply rule (2.46.0): with backups configured, take one and let any
   * failure stop the migration (nothing is applied); without, production and staging refuse to
   * migrate, and other profiles warn and migrate without one. A database whose very first
   * migration is still pending has never held TaruBot's schema, so it has nothing to back up (and
   * its dump would fail MIN_DUMP_BYTES): a first start skips the backup, not the rule. Resolves
   * with what was stored.
   *
   * The rehearsal profile never backs up, configured or not: its *_rehearsal database is
   * disposable, and its one-off containers inherit production's backup settings, so a backup
   * would land in production's bucket as the newest daily/ and env/ objects, which
   * `restore.js database latest` and `settings latest` then choose over production's own.
   */
  async beforeMigration(
    profile: DeploymentName,
    pending: readonly string[],
  ): Promise<StoredBackup | null> {
    if (profile === "rehearsal") {
      this.log(
        "info",
        { pending: pending.length },
        "No pre-migration backup: a rehearsal database is disposable",
      );
      return null;
    }
    const fresh = pending.includes(FIRST_MIGRATION);
    if (this.configuration.status !== "off") {
      if (!fresh) return await this.run("pre-migration");
      this.log(
        "info",
        { pending: pending.length },
        "No pre-migration backup: the database has no TaruBot schema yet",
      );
      return null;
    }
    if (BACKED_UP_PROFILES.includes(profile))
      throw new Failure(
        "configuration",
        `Backups aren't configured (BACKUP_STORAGE_ENDPOINT is empty), and the ${profile} profile never migrates without a pre-migration backup, so ${pending.length} pending migration(s) were not applied.`,
      );
    this.log(
      "warn",
      { pending: pending.length },
      "Migrating without a pre-migration backup: backups aren't configured (BACKUP_STORAGE_ENDPOINT is empty)",
    );
    return null;
  }

  /**
   * Back up daily at BACKUP_TIME_UTC while `writer()` says this process holds the writer lease.
   * Off is logged once; invalid settings are reported once by name, and each daily attempt then
   * fails at `settings`. A failed backup is reported; one abandoned at shutdown is only logged.
   */
  start(writer: () => boolean, report: Reporter): void {
    if (this.timer !== undefined || this.stopping.signal.aborted) return;
    const configuration = this.configuration;
    if (configuration.status === "off") {
      this.log("info", {}, "Daily backups are off: BACKUP_STORAGE_ENDPOINT is empty");
      return;
    }
    if (configuration.status === "invalid")
      report(
        new Failure(
          "configuration",
          `Backups are configured, but these settings are missing or invalid: ${configuration.problems.join(", ")}. Every backup fails until they are fixed.`,
        ),
        "backup settings",
      );
    const time = configuration.status === "on" ? configuration.settings.time : configuration.time;
    const timers = this.tools.timers ?? realTimers;
    const now = this.tools.now ?? (() => new Date());
    const schedule = () => {
      if (this.stopping.signal.aborted) return;
      const at = nextBackupAt(now(), time);
      this.timer = timers.set(Math.max(0, at.getTime() - now().getTime()), pass);
    };
    const pass = () => {
      if (!writer()) {
        this.log("info", {}, "Daily backup skipped: this process doesn't hold the writer lease");
        schedule();
        return;
      }
      void this.run("daily")
        .catch((error: unknown) => {
          if (error instanceof BackupFailure && error.interrupted)
            this.log("warn", { stage: error.stage }, "Daily backup abandoned at shutdown");
          else report(error, "backup");
        })
        .finally(schedule);
    };
    this.log("info", { time }, "Daily backups scheduled (UTC)");
    schedule();
  }

  /** Stop the schedule and abandon any backup in progress, waiting for it. Never rejects. */
  async stop(): Promise<void> {
    this.stopping.abort();
    if (this.timer !== undefined) (this.tools.timers ?? realTimers).clear(this.timer);
    this.timer = undefined;
    await Promise.all(this.running);
  }
}
