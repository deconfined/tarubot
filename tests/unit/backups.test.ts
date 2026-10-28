/**
 * The bot's own encrypted backups (2.46.0, src/application/backups.ts): the settings, which name
 * settings and never values; the settings copy and its env-file format; the object keys; the
 * streamed dump with its size and exit-status checks; the healthchecks.io pings; abandoning a run
 * at shutdown; the pre-migration rule and the daily schedule. pg_dump, storage and fetch are the
 * doubles in tests/fixtures/backups.ts; tests/integration/backups.test.ts runs the real tools.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import {
  BACKUP_SETTINGS,
  BackupFailure,
  type BackupTimers,
  Backups,
  backupConfiguration,
  backupKeys,
  backupStamp,
  dotenvValue,
  MIN_DUMP_BYTES,
  nextBackupAt,
  type SettingsSnapshot,
  settingsCopy,
  settingsSnapshot,
  storageSettings,
  takeBackup,
} from "../../src/application/backups.js";
import { project } from "../../src/config/project.js";
import { Failure } from "../../src/domain/values.js";
import { fixtureBytes, MemoryStorage, recordingFetch, scriptedTool } from "../fixtures/backups.js";

const PASSWORD = "invented-database-password";
const SECRET = "invented-storage-secret";
const PING = "https://hc-ping.example.org/backup-check-fixture";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
let identity = "";
let recipient = "";
beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

/** A complete, valid snapshot as a production container would hold it. */
const snapshot = (overrides: Record<string, string | undefined> = {}): SettingsSnapshot => {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    DATABASE_URL: `postgresql://tarubot:${PASSWORD}@db.example.org:5432/tarubot`,
    DISCORD_TOKEN: "invented-discord-token",
    MODMAIL_KEY: "aW52ZW50ZWQtbW9kbWFpbC1rZXktb2YtMzItYnl0ZXM=",
    BACKUP_STORAGE_ENDPOINT: "tarubot-backups.objects.example.org",
    BACKUP_STORAGE_ACCESS_KEY: "invented-access-key",
    BACKUP_STORAGE_SECRET_KEY: SECRET,
    BACKUP_STORAGE_REGION: "us-east-1",
    BACKUP_AGE_RECIPIENTS: recipient,
    HEALTHCHECKS_BACKUP_URL: PING,
    ...overrides,
  }))
    if (value !== undefined) values[name] = value;
  return Object.freeze(values);
};

const decrypt = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return await decrypter.decrypt(bytes);
};

/** A dump comfortably over the size floor, spanning several 64 KiB age chunks. */
const DUMP = fixtureBytes(200_000);
const at = (iso: string) => () => new Date(iso);

describe("backup settings", () => {
  test("are off while BACKUP_STORAGE_ENDPOINT is empty, whatever else is set", () => {
    expect(backupConfiguration({})).toEqual({ status: "off" });
    expect(
      backupConfiguration({ BACKUP_STORAGE_ENDPOINT: "", BACKUP_STORAGE_REGION: "Not valid" }),
    ).toEqual({ status: "off" });
  });

  test("a complete set is on, with https:// optional and a path as a key prefix", () => {
    const on = backupConfiguration(snapshot());
    expect(on).toEqual({
      status: "on",
      settings: {
        storage: {
          endpoint: "https://tarubot-backups.objects.example.org",
          prefix: "",
          accessKey: "invented-access-key",
          secretKey: SECRET,
          region: "us-east-1",
        },
        recipients: [recipient],
        time: "03:00",
        ping: PING,
      },
    });
    for (const [endpoint, origin, prefix] of [
      ["https://b.example.org/", "https://b.example.org", ""],
      ["b.example.org:9000/backups/tarubot", "https://b.example.org:9000", "backups/tarubot/"],
      ["https://b.example.org/production/", "https://b.example.org", "production/"],
    ] as const)
      expect(storageSettings({ ...snapshot(), BACKUP_STORAGE_ENDPOINT: endpoint })).toMatchObject({
        storage: { endpoint: origin, prefix },
      });
  });

  test("recipients are age public keys separated by whitespace or commas", async () => {
    const other = await identityToRecipient(await generateIdentity());
    const on = backupConfiguration(
      snapshot({ BACKUP_AGE_RECIPIENTS: ` ${recipient},\n${other} `, BACKUP_TIME_UTC: "23:59" }),
    );
    expect(on).toMatchObject({ status: "on", settings: { recipients: [recipient, other] } });
    expect(on).toMatchObject({ settings: { time: "23:59" } });
  });

  test("anything wrong is invalid, named by setting and never by value", () => {
    const invalid = backupConfiguration(
      snapshot({
        BACKUP_STORAGE_ENDPOINT: `http://user:${SECRET}@example.org`,
        BACKUP_STORAGE_ACCESS_KEY: "",
        BACKUP_STORAGE_SECRET_KEY: undefined,
        BACKUP_STORAGE_REGION: undefined,
        BACKUP_AGE_RECIPIENTS: `AGE-SECRET-KEY-1${"Q".repeat(58)}`,
        BACKUP_TIME_UTC: "24:00",
        HEALTHCHECKS_BACKUP_URL: "http://hc-ping.example.org/plain-http",
      }),
    );
    expect(invalid).toEqual({
      status: "invalid",
      problems: [
        "BACKUP_STORAGE_ENDPOINT",
        "BACKUP_STORAGE_ACCESS_KEY",
        "BACKUP_STORAGE_SECRET_KEY",
        "BACKUP_STORAGE_REGION",
        "BACKUP_AGE_RECIPIENTS",
        "BACKUP_TIME_UTC",
        "HEALTHCHECKS_BACKUP_URL",
      ],
      ping: null,
      // The daily attempt still runs (and fails at settings), at the default time.
      time: "03:00",
    });
    if (invalid.status !== "invalid") throw new Error("unreachable");
    for (const problem of invalid.problems) expect(BACKUP_SETTINGS).toContain(problem as never);
    // The region has no hidden default; a valid ping URL is kept for the failure ping.
    expect(backupConfiguration(snapshot({ BACKUP_STORAGE_REGION: "" }))).toMatchObject({
      status: "invalid",
      problems: ["BACKUP_STORAGE_REGION"],
      ping: PING,
    });
  });

  test("a recipient with one mistyped character is invalid by name, so backups fail at settings", async () => {
    // One substitution keeps the age1 shape; only the Bech32 checksum catches it. The shape check
    // alone let it through, and every backup then failed at dump without naming the setting.
    const index = 20;
    const typo = `${recipient.slice(0, index)}${recipient[index] === "q" ? "p" : "q"}${recipient.slice(index + 1)}`;
    expect(typo).toMatch(/^age1[0-9a-z]{58}$/u);
    expect(typo).not.toBe(recipient);
    const settings = snapshot({ BACKUP_AGE_RECIPIENTS: `${recipient}, ${typo}` });
    expect(backupConfiguration(settings)).toEqual({
      status: "invalid",
      problems: ["BACKUP_AGE_RECIPIENTS"],
      ping: PING,
      time: "03:00",
    });
    // Reported once at start, by name and never by value.
    const reports: unknown[] = [];
    new Backups(settings, recordingLog().log, { timers: manualTimers() }).start(
      () => true,
      (error) => reports.push(error),
    );
    expect(reports).toHaveLength(1);
    expect((reports[0] as Failure).message).toContain("BACKUP_AGE_RECIPIENTS");
    expect((reports[0] as Failure).message).not.toContain(typo);
    // Each attempt fails at settings before pg_dump starts, pinging /fail with that stage.
    const fetcher = recordingFetch();
    const dump = scriptedTool({ output: DUMP });
    await expect(
      takeBackup(settings, {
        storage: () => new MemoryStorage(),
        runTool: dump.run,
        fetch: fetcher.fetch,
      }),
    ).rejects.toMatchObject({
      stage: "settings",
      message:
        "Backup failed at: settings. These backup settings are missing or invalid: BACKUP_AGE_RECIPIENTS.",
    });
    expect(dump.calls).toEqual([]);
    expect(fetcher.pings).toEqual([{ url: `${PING}/fail`, body: "backup failed at: settings" }]);
    // And a migrating release is refused with the setting's name, not a pg_dump-side reason.
    await expect(
      new Backups(settings, recordingLog().log, {
        runTool: dump.run,
        fetch: recordingFetch().fetch,
      }).beforeMigration("production", ["016_next.sql"]),
    ).rejects.toMatchObject({
      stage: "settings",
      message: expect.stringContaining("BACKUP_AGE_RECIPIENTS"),
    });
  });

  test("the committed recipients file holds production's age public key and no private key", async () => {
    const text = await Bun.file(new URL("../../ops/age-recipients.txt", import.meta.url)).text();
    expect(text).not.toContain("AGE-SECRET-KEY");
    const keys = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(keys.length).toBeGreaterThan(0);
    // As BACKUP_AGE_RECIPIENTS, the file's keys pass the same check the bot applies.
    expect(backupConfiguration(snapshot({ BACKUP_AGE_RECIPIENTS: keys.join(" ") }))).toMatchObject({
      status: "on",
      settings: { recipients: keys },
    });
  });
});

describe("the settings copy", () => {
  test("holds every setting the container received, minus the runtime's own variables", () => {
    const captured = settingsSnapshot(
      {
        PATH: "/usr/bin",
        HOME: "/home/bun",
        HOSTNAME: "abc123",
        TZ: "UTC",
        LANG: "C",
        LC_CTYPE: "C",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        NODE_ENV: "production",
        lowercase: "ignored",
        "NOT-A-NAME": "ignored",
        DISCORD_TOKEN: "invented-token",
        MODMAIL_KEY: "invented-key",
        EMPTY: "",
        // File-delivered secrets travel as their values, under the plain name.
        DATABASE_CA_CERT_FILE: "/run/secrets/ca",
      },
      () => `${CA}\n`,
    );
    expect(captured).toEqual({
      DISCORD_TOKEN: "invented-token",
      MODMAIL_KEY: "invented-key",
      EMPTY: "",
      DATABASE_CA_CERT: CA,
    });
    expect(Object.isFrozen(captured)).toBe(true);
  });

  test("is a Compose env file: sorted, single-quoted, double-quoted around a quote or backslash", () => {
    expect(dotenvValue(`plain $HOME \${X} \`x\` # = "q"`)).toBe(
      `'plain $HOME \${X} \`x\` # = "q"'`,
    );
    expect(dotenvValue(`it's "$5" \\ back`)).toBe(`"it's \\"$$5\\" \\\\ back"`);
    // A backslash anywhere means double quotes, so a trailing one can't escape a closing quote.
    expect(dotenvValue("secret\\")).toBe(`"secret\\\\"`);
    expect(dotenvValue("literal \\n")).toBe(`"literal \\\\n"`);
    expect(
      settingsCopy(
        { ZED: "z", CA_CERT: `${CA}\n`, ALPHA: "it's", KEY: "ends\\" },
        "2.46.0",
        "20261028T030000Z",
      ),
    ).toBe(
      [
        "# TaruBot 2.46.0 settings copy, 20261028T030000Z",
        `ALPHA="it's"`,
        `CA_CERT='${CA}\n'`,
        `KEY="ends\\\\"`,
        "ZED='z'",
        "",
      ].join("\n"),
    );
  });

  test("reads back exactly as Compose's dotenv rules read it", () => {
    // Compose's rules (compose-go's dotenv parser) for the two forms written. In both, a quoted
    // value ends at the first matching quote with no odd run of backslashes before it: inside
    // single quotes too, which is how `'secret\'` ran on into the next line. Single-quoted text is
    // otherwise literal. Double-quoted text takes Go-style escapes (`\n` is a newline), then
    // interpolation, where $$ is a literal $ (a lone $ would interpolate; dotenvValue never leaves
    // one). The scratch read-back through `docker compose --env-file ... config` checks the same.
    const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };
    const read = (written: string): string => {
      const quote = written[0];
      if (quote !== "'" && quote !== '"') throw new Error(`unquoted: ${written}`);
      let end = 0;
      for (;;) {
        end = written.indexOf(quote, end + 1);
        if (end < 0) throw new Error(`unterminated: ${written}`);
        let backslashes = 0;
        while (written[end - 1 - backslashes] === "\\") backslashes += 1;
        if (backslashes % 2 === 0) break;
      }
      if (end !== written.length - 1) throw new Error(`runs on past its closing quote: ${written}`);
      const body = written.slice(1, -1);
      if (quote === "'") return body;
      return body.replace(/\\(.)|\$(\$|\{|[A-Za-z_])?/gsu, (match, escaped, after) => {
        if (escaped !== undefined) return ESCAPES[escaped] ?? match;
        if (after === "$") return "$";
        throw new Error(`interpolates: ${written}`);
      });
    };
    for (const value of [
      "",
      "a b",
      "it's",
      "'",
      `"'"`,
      "$$'$",
      "\\'\\n",
      "multi\nline'\n",
      // A backslash at the end, alone, doubled, before a quote, a dollar or a newline.
      "secret\\",
      "\\",
      "two\\\\",
      "it's\\",
      "a\\'b",
      'a\\"b',
      "a\\$b",
      "literal \\n and \\t",
      "line\\\nnext\\",
      // Interpolation, comments and separators stay literal.
      `\${HOME} $X $$`,
      "# not a comment = still the value",
      `${CA}\n`,
    ])
      expect({ value, read: read(dotenvValue(value)) }).toEqual({ value, read: value });
  });
});

describe("object keys", () => {
  test("carry one UTC stamp, with the monthly copy on the 1st only", () => {
    expect(backupStamp(new Date("2026-11-01T03:00:00.987Z"))).toBe("20261101T030000Z");
    expect(backupKeys("20261101T030000Z")).toEqual({
      daily: "daily/tarubot-20261101T030000Z.dump.age",
      monthly: "monthly/tarubot-20261101T030000Z.dump.age",
      env: "env/tarubot-env-20261101T030000Z.age",
    });
    expect(backupKeys("20261102T030000Z").monthly).toBeNull();
  });

  test("the daily schedule is the next HH:MM UTC strictly after now", () => {
    const now = new Date("2026-10-28T02:59:59.000Z");
    expect(nextBackupAt(now, "03:00").toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(nextBackupAt(new Date("2026-10-28T03:00:00.000Z"), "03:00").toISOString()).toBe(
      "2026-10-29T03:00:00.000Z",
    );
    expect(nextBackupAt(new Date("2026-12-31T23:30:00.000Z"), "00:15").toISOString()).toBe(
      "2027-01-01T00:15:00.000Z",
    );
  });
});

describe("one backup", () => {
  test("streams the dump through age into daily/ and stores the settings copy, pinging start and success", async () => {
    const storage = new MemoryStorage();
    const dump = scriptedTool({ output: DUMP });
    const fetcher = recordingFetch();
    const stored = await takeBackup(snapshot({ DATABASE_CA_CERT: CA }), {
      storage: () => storage,
      runTool: dump.run,
      fetch: fetcher.fetch,
      now: at("2026-10-28T03:00:00Z"),
    });
    const stamp = "20261028T030000Z";
    const daily = storage.objects.get(`daily/tarubot-${stamp}.dump.age`);
    const env = storage.objects.get(`env/tarubot-env-${stamp}.age`);
    if (!daily || !env) throw new Error("missing objects");
    expect(stored).toEqual({
      stamp,
      daily: { key: `daily/tarubot-${stamp}.dump.age`, bytes: daily.length },
      monthly: null,
      env: { key: `env/tarubot-env-${stamp}.age`, bytes: env.length },
    });
    expect([...storage.objects.keys()].sort()).toEqual([
      `daily/tarubot-${stamp}.dump.age`,
      `env/tarubot-env-${stamp}.age`,
    ]);
    // Ciphertext only, which the owner's identity opens to exactly the dump and the settings.
    expect(daily.length).toBeGreaterThan(MIN_DUMP_BYTES);
    expect(Buffer.from(daily).includes(Buffer.from(DUMP.slice(0, 64)))).toBe(false);
    expect(await decrypt(daily)).toEqual(DUMP);
    const settings = new TextDecoder().decode(await decrypt(env));
    expect(settings.split("\n")[0]).toBe(`# TaruBot ${project.version} settings copy, ${stamp}`);
    expect(settings).toContain(`MODMAIL_KEY='${snapshot().MODMAIL_KEY}'`);
    expect(settings).toContain(`BACKUP_STORAGE_SECRET_KEY='${SECRET}'`);
    // healthchecks.io: the same protocol the host script used.
    expect(fetcher.pings).toEqual([
      { url: `${PING}/start`, body: "backup starting" },
      {
        url: PING,
        body: `daily/tarubot-${stamp}.dump.age: ${daily.length} bytes; env/tarubot-env-${stamp}.age: ${env.length} bytes`,
      },
    ]);
  });

  test("pg_dump gets the connection in a fresh environment, never in argv, with a private CA file", async () => {
    const dump = scriptedTool({ output: DUMP });
    let caFile = "";
    const storage = new MemoryStorage();
    const run: typeof dump.run = (command, options) => {
      caFile = options.env.PGSSLROOTCERT ?? "";
      return dump.run(command, options);
    };
    await takeBackup(
      snapshot({
        DATABASE_URL: `${snapshot().DATABASE_URL}?sslmode=require`,
        DATABASE_CA_CERT: CA,
      }),
      {
        storage: () => storage,
        runTool: run,
        fetch: recordingFetch().fetch,
      },
    );
    const [call] = dump.calls;
    expect(call?.command).toEqual(["pg_dump", "--format=custom", "--no-owner", "--no-privileges"]);
    expect(call?.env).toMatchObject({
      PGHOST: "db.example.org",
      PGPORT: "5432",
      PGUSER: "tarubot",
      PGPASSWORD: PASSWORD,
      PGDATABASE: "tarubot",
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "tarubot-backup",
      // The CA decides: verify-full, whatever the URL's own sslmode said.
      PGSSLMODE: "verify-full",
    });
    expect(
      Object.keys(call?.env ?? {})
        .filter((name) => !name.startsWith("PG"))
        .sort(),
    ).toEqual(["HOME", "PATH", "TMPDIR"].filter((name) => process.env[name]));
    expect(JSON.stringify(call?.command)).not.toContain(PASSWORD);
    // The CA file existed only for the run.
    expect(caFile).toContain("tarubot-libpq-");
    expect(await Bun.file(caFile).exists()).toBe(false);
  });

  test("on the 1st of the month the same ciphertext is also stored under monthly/", async () => {
    const storage = new MemoryStorage();
    const stored = await takeBackup(snapshot(), {
      storage: () => storage,
      runTool: scriptedTool({ output: DUMP }).run,
      fetch: recordingFetch().fetch,
      now: at("2026-11-01T03:00:00Z"),
    });
    expect(stored.monthly).toEqual({
      key: "monthly/tarubot-20261101T030000Z.dump.age",
      bytes: stored.daily.bytes,
    });
    expect(storage.objects.get("monthly/tarubot-20261101T030000Z.dump.age")).toEqual(
      storage.objects.get("daily/tarubot-20261101T030000Z.dump.age") ?? new Uint8Array([0]),
    );
  });

  test("a pg_dump that fails, even after writing most of a dump, leaves no object", async () => {
    const storage = new MemoryStorage();
    const fetcher = recordingFetch();
    const failure = takeBackup(snapshot(), {
      storage: () => storage,
      runTool: scriptedTool({ output: DUMP, exit: 1 }).run,
      fetch: fetcher.fetch,
    });
    await expect(failure).rejects.toBeInstanceOf(BackupFailure);
    await expect(failure).rejects.toMatchObject({
      stage: "dump",
      code: "backup",
      message: "Backup failed at: dump. pg_dump exited with status 1.",
    });
    expect(storage.attempts).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
    expect(fetcher.pings.map((ping) => [ping.url, ping.body])).toEqual([
      [`${PING}/start`, "backup starting"],
      [`${PING}/fail`, "backup failed at: dump"],
    ]);
  });

  test("an encrypted dump of 4096 bytes or less is refused and not stored", async () => {
    const storage = new MemoryStorage();
    await expect(
      takeBackup(snapshot(), {
        storage: () => storage,
        runTool: scriptedTool({ output: fixtureBytes(1000) }).run,
        fetch: recordingFetch().fetch,
      }),
    ).rejects.toMatchObject({ stage: "dump", message: expect.stringContaining("only") });
    expect(storage.objects.size).toBe(0);
  });

  test("a storage failure is stage upload, stops pg_dump and stores nothing", async () => {
    const storage = new MemoryStorage();
    const dump = scriptedTool({ output: DUMP, hang: true });
    const fetcher = recordingFetch();
    storage.failures.set("daily/tarubot-20261028T030000Z.dump.age", 1);
    await expect(
      takeBackup(snapshot(), {
        storage: () => storage,
        runTool: dump.run,
        fetch: fetcher.fetch,
        now: at("2026-10-28T03:00:00Z"),
      }),
    ).rejects.toMatchObject({ stage: "upload", interrupted: false });
    expect(dump.calls[0]?.killed).toBe("SIGTERM");
    expect(storage.objects.size).toBe(0);
    expect(fetcher.pings.at(-1)).toEqual({ url: `${PING}/fail`, body: "backup failed at: upload" });
    // The settings copy's upload failing after the dump was stored is stage upload too.
    const second = new MemoryStorage();
    second.failures.set("env/tarubot-env-20261028T030000Z.age", 0);
    await expect(
      takeBackup(snapshot(), {
        storage: () => second,
        runTool: scriptedTool({ output: DUMP }).run,
        fetch: recordingFetch().fetch,
        now: at("2026-10-28T03:00:00Z"),
      }),
    ).rejects.toMatchObject({ stage: "upload" });
    expect([...second.objects.keys()]).toEqual(["daily/tarubot-20261028T030000Z.dump.age"]);
  });

  test("shutdown abandons a dump in progress: pg_dump is killed and the upload dropped", async () => {
    const storage = new MemoryStorage();
    const dump = scriptedTool({ output: DUMP, hang: true });
    const stopping = new AbortController();
    const fetcher = recordingFetch();
    const running = takeBackup(
      snapshot(),
      { storage: () => storage, runTool: dump.run, fetch: fetcher.fetch },
      stopping.signal,
    );
    await Bun.sleep(50);
    stopping.abort();
    await expect(running).rejects.toMatchObject({ stage: "dump", interrupted: true });
    expect(dump.calls[0]?.killed).toBe("SIGTERM");
    expect(storage.attempts).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
    // Abandoned, not failed: no /fail ping. The open /start is closed by the next run's success,
    // or healthchecks.io marks the check down itself if none succeeds within its grace time.
    expect(fetcher.pings).toEqual([{ url: `${PING}/start`, body: "backup starting" }]);
    // Once shutdown has begun, nothing new starts.
    await expect(
      takeBackup(snapshot(), { storage: () => storage, runTool: dump.run }, stopping.signal),
    ).rejects.toMatchObject({ interrupted: true });
    expect(dump.calls).toHaveLength(1);
  });

  test("invalid settings fail at settings before any work, pinging only /fail", async () => {
    const fetcher = recordingFetch();
    const dump = scriptedTool({ output: DUMP });
    const failure = takeBackup(
      snapshot({ BACKUP_STORAGE_REGION: "", BACKUP_STORAGE_SECRET_KEY: "" }),
      {
        storage: () => new MemoryStorage(),
        runTool: dump.run,
        fetch: fetcher.fetch,
      },
    );
    await expect(failure).rejects.toMatchObject({
      stage: "settings",
      message:
        "Backup failed at: settings. These backup settings are missing or invalid: BACKUP_STORAGE_SECRET_KEY, BACKUP_STORAGE_REGION.",
    });
    expect(fetcher.pings).toEqual([{ url: `${PING}/fail`, body: "backup failed at: settings" }]);
    expect(dump.calls).toHaveLength(0);
    // Off is a settings failure too, with no check to ping.
    await expect(
      takeBackup(snapshot({ BACKUP_STORAGE_ENDPOINT: "" }), { fetch: fetcher.fetch }),
    ).rejects.toMatchObject({ stage: "settings" });
    expect(fetcher.pings).toHaveLength(1);
  });

  test("a ping that fails never fails the backup", async () => {
    const storage = new MemoryStorage();
    await takeBackup(snapshot(), {
      storage: () => storage,
      runTool: scriptedTool({ output: DUMP }).run,
      fetch: recordingFetch(true).fetch,
    });
    expect(storage.objects.size).toBe(2);
  });

  test("no failure message carries a setting's value", async () => {
    const messages: string[] = [];
    const cases: SettingsSnapshot[] = [
      snapshot({ BACKUP_STORAGE_ENDPOINT: `https://${SECRET}@x`, BACKUP_STORAGE_REGION: SECRET }),
      snapshot({ DATABASE_URL: `postgresql://tarubot:${PASSWORD}@db.example.org/tarubot?host=x` }),
    ];
    for (const settings of cases)
      await takeBackup(settings, {
        storage: () => new MemoryStorage(),
        runTool: scriptedTool({ output: DUMP }).run,
        fetch: recordingFetch().fetch,
      }).catch((error: unknown) => messages.push(error instanceof Error ? error.message : ""));
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(PASSWORD);
    }
    expect(messages[1]).toContain("DATABASE_URL");
  });
});

/** Timers the test fires by hand. */
function manualTimers(): BackupTimers & { pending: { delayMs: number; run: () => void }[] } {
  const pending: { delayMs: number; run: () => void }[] = [];
  return {
    pending,
    set: (delayMs, run) => {
      const timer = { delayMs, run };
      pending.push(timer);
      return timer;
    },
    clear: (handle) => {
      const index = pending.indexOf(handle as (typeof pending)[number]);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

/** A log that records what it is given. */
function recordingLog() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    log: (level: "info" | "warn", fields: Record<string, unknown>, message: string) =>
      lines.push({ level, fields, message }),
  };
}

describe("the backup service", () => {
  test("the pre-migration rule: a backup when configured, a refusal for managed profiles without", async () => {
    const storage = new MemoryStorage();
    const { log, lines } = recordingLog();
    const on = new Backups(snapshot(), log, {
      storage: () => storage,
      runTool: scriptedTool({ output: DUMP }).run,
      fetch: recordingFetch().fetch,
    });
    const stored = await on.beforeMigration("production", ["016_next.sql"]);
    expect(stored?.daily.key).toMatch(/^daily\//u);
    expect(lines.at(-1)).toMatchObject({ level: "info", message: "Backup stored" });
    expect(lines.at(-1)?.fields).toMatchObject({ reason: "pre-migration" });

    const off = new Backups(snapshot({ BACKUP_STORAGE_ENDPOINT: "" }), log);
    for (const profile of ["production", "staging"] as const)
      await expect(off.beforeMigration(profile, ["016_next.sql"])).rejects.toMatchObject({
        code: "configuration",
        message: expect.stringContaining(`the ${profile} profile never migrates without`),
      });
    for (const profile of ["devbot", "rehearsal", "unmanaged"] as const)
      expect(await off.beforeMigration(profile, ["016_next.sql"])).toBeNull();
    expect(lines.at(-1)).toMatchObject({ level: "warn", fields: { pending: 1 } });

    // A first start: the database has no TaruBot schema, so there is nothing to back up (its
    // dump would be too small to pass), but production still needs backups configured.
    const first = scriptedTool({ output: DUMP });
    const fresh = new Backups(snapshot(), log, {
      storage: () => new MemoryStorage(),
      runTool: first.run,
      fetch: recordingFetch().fetch,
    });
    expect(await fresh.beforeMigration("production", ["001_initial.sql", "002_x.sql"])).toBeNull();
    expect(first.calls).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ level: "info", fields: { pending: 2 } });
    await expect(off.beforeMigration("production", ["001_initial.sql"])).rejects.toMatchObject({
      code: "configuration",
    });

    // Configured but invalid: the backup fails at settings, which stops the migration.
    const invalid = new Backups(snapshot({ BACKUP_AGE_RECIPIENTS: "" }), log, {
      fetch: recordingFetch().fetch,
    });
    await expect(invalid.beforeMigration("unmanaged", ["016_next.sql"])).rejects.toMatchObject({
      stage: "settings",
    });
  });

  test("the rehearsal profile never backs up: its database is disposable", async () => {
    // A rehearsal one-off inherits production's backup settings; its dump would otherwise become
    // the newest daily/ object, the one restore.js restores as latest. The rule comes before the
    // configuration is looked at: configured backs up nothing, invalid doesn't fail, off doesn't
    // warn.
    for (const settings of [
      snapshot(),
      snapshot({ BACKUP_AGE_RECIPIENTS: "" }),
      snapshot({ BACKUP_STORAGE_ENDPOINT: "" }),
    ]) {
      const storage = new MemoryStorage();
      const dump = scriptedTool({ output: DUMP });
      const fetcher = recordingFetch();
      const { log, lines } = recordingLog();
      const backups = new Backups(settings, log, {
        storage: () => storage,
        runTool: dump.run,
        fetch: fetcher.fetch,
      });
      expect(await backups.beforeMigration("rehearsal", ["016_next.sql", "017_x.sql"])).toBeNull();
      expect(dump.calls).toEqual([]);
      expect(storage.attempts).toEqual([]);
      expect(fetcher.pings).toEqual([]);
      expect(lines).toEqual([
        {
          level: "info",
          fields: { pending: 2 },
          message: "No pre-migration backup: a rehearsal database is disposable",
        },
      ]);
    }
  });

  test("daily: scheduled at BACKUP_TIME_UTC, only while holding the writer lease, failures reported", async () => {
    const storage = new MemoryStorage();
    const timers = manualTimers();
    const { log, lines } = recordingLog();
    const reports: { error: unknown; operation: string }[] = [];
    let writer = true;
    let dump = scriptedTool({ output: DUMP });
    const backups = new Backups(snapshot({ BACKUP_TIME_UTC: "04:30" }), log, {
      storage: () => storage,
      runTool: (command, options) => dump.run(command, options),
      fetch: recordingFetch().fetch,
      now: at("2026-10-28T04:00:00Z"),
      timers,
    });
    backups.start(
      () => writer,
      (error, operation) => reports.push({ error, operation }),
    );
    expect(lines.at(-1)).toMatchObject({
      message: "Daily backups scheduled (UTC)",
      fields: { time: "04:30" },
    });
    expect(timers.pending.map((timer) => timer.delayMs)).toEqual([30 * 60_000]);

    timers.pending.shift()?.run();
    await Bun.sleep(50);
    expect(storage.objects.size).toBe(2);
    expect(timers.pending).toHaveLength(1);

    writer = false;
    timers.pending.shift()?.run();
    expect(lines.at(-1)?.message).toContain("doesn't hold the writer lease");
    expect(dump.calls).toHaveLength(1);

    writer = true;
    dump = scriptedTool({ output: DUMP, exit: 2 });
    timers.pending.shift()?.run();
    await Bun.sleep(50);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ operation: "backup", error: { stage: "dump" } });
    expect(timers.pending).toHaveLength(1);

    await backups.stop();
    expect(timers.pending).toHaveLength(0);
  });

  test("off is logged once; invalid settings are reported once, by name", () => {
    const off = recordingLog();
    new Backups(snapshot({ BACKUP_STORAGE_ENDPOINT: "" }), off.log).start(
      () => true,
      () => {},
    );
    expect(off.lines).toEqual([
      {
        level: "info",
        fields: {},
        message: "Daily backups are off: BACKUP_STORAGE_ENDPOINT is empty",
      },
    ]);
    const reports: unknown[] = [];
    const timers = manualTimers();
    new Backups(snapshot({ BACKUP_STORAGE_SECRET_KEY: "" }), recordingLog().log, { timers }).start(
      () => true,
      (error) => reports.push(error),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toBeInstanceOf(Failure);
    expect((reports[0] as Failure).message).toContain("BACKUP_STORAGE_SECRET_KEY");
    expect((reports[0] as Failure).message).not.toContain("invented");
    // Attempts still run daily, so the check notices; each one fails at settings.
    expect(timers.pending).toHaveLength(1);
  });

  test("a pre-migration backup cut off by shutdown sends no /fail ping", async () => {
    // A restart or a tag move during the pre-migration backup: the migration rolls back and the
    // next start backs up again, so nothing failed and healthchecks.io must not be told so.
    const storage = new MemoryStorage();
    const fetcher = recordingFetch();
    const backups = new Backups(snapshot(), recordingLog().log, {
      storage: () => storage,
      runTool: scriptedTool({ output: DUMP, hang: true }).run,
      fetch: fetcher.fetch,
    });
    const migrating = backups.beforeMigration("production", ["016_next.sql"]);
    const settled = migrating.catch((error: unknown) => error);
    await Bun.sleep(50);
    await backups.stop();
    expect(await settled).toMatchObject({ stage: "dump", interrupted: true });
    expect(storage.objects.size).toBe(0);
    expect(fetcher.pings).toEqual([{ url: `${PING}/start`, body: "backup starting" }]);
  });

  test("stop abandons a backup in progress and waits for it; a daily one is logged, not reported", async () => {
    const storage = new MemoryStorage();
    const timers = manualTimers();
    const { log, lines } = recordingLog();
    const reports: unknown[] = [];
    const dump = scriptedTool({ output: DUMP, hang: true });
    const fetcher = recordingFetch();
    const backups = new Backups(snapshot(), log, {
      storage: () => storage,
      runTool: dump.run,
      fetch: fetcher.fetch,
      timers,
    });
    backups.start(
      () => true,
      (error) => reports.push(error),
    );
    timers.pending.shift()?.run();
    await Bun.sleep(50);
    await backups.stop();
    expect(dump.calls[0]?.killed).toBe("SIGTERM");
    expect(storage.objects.size).toBe(0);
    await Bun.sleep(10);
    expect(reports).toEqual([]);
    expect(lines.at(-1)).toMatchObject({
      level: "warn",
      message: "Daily backup abandoned at shutdown",
    });
    expect(fetcher.pings.map((ping) => ping.url)).toEqual([`${PING}/start`]);
    expect(timers.pending).toHaveLength(0);
  });
});

test("an encrypter is reusable for both copies (the dump stream and the settings text)", async () => {
  // takeBackup encrypts the stream and then the settings copy with one Encrypter.
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const stream = await encrypter.encrypt(new Blob([DUMP]).stream());
  const first = new Uint8Array(await new Response(stream).arrayBuffer());
  const second = await encrypter.encrypt("SETTING='x'\n");
  expect(await decrypt(first)).toEqual(DUMP);
  expect(new TextDecoder().decode(await decrypt(second))).toBe("SETTING='x'\n");
});
