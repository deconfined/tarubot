/**
 * restore.js (2.46.0): its arguments and usage, the age identity read from standard input only,
 * the choice of `latest`, refusing a target that already has tables, the decrypted dump reaching
 * pg_restore exactly, a broken download stopping pg_restore before it can commit, and the two
 * closing statements every restored database needs. Storage and pg_restore are the doubles in
 * tests/fixtures/backups.ts; tests/integration/backups.test.ts restores a real dump.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import type { PoolClient } from "pg";
import { RESTORED_ROLE_JOBS_SQL } from "../../src/application/backups.js";
import type { Database } from "../../src/infrastructure/postgres/database.js";
import { Failure } from "../../src/domain/values.js";
import {
  ageIdentities,
  chooseObject,
  closeRestoredDatabase,
  newestFirst,
  RESTORE_USAGE,
  restoreArguments,
  restoreDatabase,
  restoreSettings,
} from "../../scripts/restore.js";
import { fixtureBytes, MemoryStorage, scriptedTool } from "../fixtures/backups.js";

// A spawned Bun loads the script's modules, slowly under QEMU in the arm64 image build.
setDefaultTimeout(60_000);

let identity = "";
let encrypter: Encrypter;
beforeAll(async () => {
  identity = await generateIdentity();
  encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
});

const KEY = "daily/tarubot-20261028T030000Z.dump.age";
const DUMP = fixtureBytes(150_000);
const TARGET = {
  url: "postgresql://tarubot:sentinel-password@db.example.org:27520/tarubot_restore",
  setting: "RESTORE_DATABASE_URL",
  ca: undefined,
};

describe("arguments", () => {
  test("list, database and settings take exactly what they need", () => {
    expect(restoreArguments(["list"])).toEqual({ kind: "list", group: null });
    expect(restoreArguments(["list", "monthly"])).toEqual({ kind: "list", group: "monthly" });
    expect(restoreArguments(["database", "latest"])).toEqual({ kind: "database", key: "latest" });
    expect(restoreArguments(["database", KEY])).toEqual({ kind: "database", key: KEY });
    expect(
      restoreArguments(["database", "monthly/tarubot-20261101T030000Z.dump.age"]),
    ).toMatchObject({ kind: "database" });
    expect(restoreArguments(["settings", "env/tarubot-env-20261028T030000Z.age"])).toEqual({
      kind: "settings",
      key: "env/tarubot-env-20261028T030000Z.age",
    });
    for (const argv of [
      [],
      ["restore"],
      ["list", "weekly"],
      ["database"],
      ["database", "env/tarubot-env-20261028T030000Z.age"],
      ["database", "../daily/tarubot-20261028T030000Z.dump.age"],
      ["settings", KEY],
      ["database", "latest", "AGE-SECRET-KEY-1X"],
    ])
      expect(() => restoreArguments(argv)).toThrow(Failure);
  });

  test("without arguments the script prints its usage and exits 2", () => {
    const result = Bun.spawnSync(
      [process.execPath, fileURLToPath(new URL("../../scripts/restore.ts", import.meta.url))],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "ignore" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(RESTORE_USAGE);
  });
});

describe("the age identity", () => {
  test("is one or more AGE-SECRET-KEY-1 lines on standard input, with comments", () => {
    expect(
      ageIdentities(`# created: 2026-09-25\r\n# public key: age1...\r\n${identity}\r\n\n`),
    ).toEqual([identity]);
    expect(ageIdentities(`${identity}\n${identity}\n`)).toHaveLength(2);
  });

  test("anything else is refused without repeating it", () => {
    for (const text of ["", "# only a comment\n", "age1publickeyinstead\n", `${identity}x\n`]) {
      let message = "";
      try {
        ageIdentities(text);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message.toLowerCase()).toContain("standard input");
      if (text.trim()) expect(message).not.toContain(text.trim().split("\n").at(-1) ?? "");
    }
  });
});

describe("choosing an object", () => {
  test("latest is the newest daily dump, or the newest settings copy; strays are ignored", async () => {
    const storage = new MemoryStorage();
    for (const key of [
      "daily/tarubot-20261026T030000Z.dump.age",
      "daily/tarubot-20261028T030000Z.dump.age",
      "daily/tarubot-20261027T030000Z.dump.age",
      "daily/zz-not-a-backup.txt",
      "monthly/tarubot-20261101T030000Z.dump.age",
      "env/tarubot-env-20261027T030000Z.age",
      "env/tarubot-env-20261028T030000Z.age",
    ])
      storage.objects.set(key, new Uint8Array(8));
    expect((await chooseObject(storage, "database", "latest")).key).toBe(
      "daily/tarubot-20261028T030000Z.dump.age",
    );
    expect((await chooseObject(storage, "settings", "latest")).key).toBe(
      "env/tarubot-env-20261028T030000Z.age",
    );
    expect(
      newestFirst(await storage.list("daily/"), "daily").map(({ key }) => key.slice(14, 22)),
    ).toEqual(["20261028", "20261027", "20261026"]);
    await expect(
      chooseObject(storage, "database", "daily/tarubot-20250101T030000Z.dump.age"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(chooseObject(new MemoryStorage(), "database", "latest")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

test("a settings copy decrypts with the identity, and a wrong identity is refused by key", async () => {
  const storage = new MemoryStorage();
  storage.objects.set(
    "env/tarubot-env-20261028T030000Z.age",
    (await encrypter.encrypt("DISCORD_TOKEN='x'\n")).slice(),
  );
  const plain = await restoreSettings(storage, "env/tarubot-env-20261028T030000Z.age", [identity]);
  expect(new TextDecoder().decode(plain)).toBe("DISCORD_TOKEN='x'\n");
  const other = await generateIdentity();
  await expect(
    restoreSettings(storage, "env/tarubot-env-20261028T030000Z.age", [other]),
  ).rejects.toMatchObject({ code: "input", message: expect.not.stringContaining(other) });
});

/** A target database double: its table count, server version, the SQL it ran and its schema head. */
function target(tables = 0, webSessions = true, version = 180006) {
  const statements: string[] = [];
  const client = {
    query: async (text: string) => {
      statements.push(text);
      if (text.includes("to_regclass")) return { rows: [{ present: webSessions }], rowCount: 1 };
      if (text.startsWith("DELETE FROM web_sessions")) return { rows: [], rowCount: 3 };
      if (text === RESTORED_ROLE_JOBS_SQL) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected ${text}`);
    },
  };
  const db: Pick<Database, "query" | "transaction"> = {
    query: async <T>(text: string) => {
      statements.push(text);
      // The server's version comes from the same statement as the emptiness check.
      if (text.includes("pg_tables") && text.includes("current_setting('server_version_num')"))
        return [{ tables, version }] as T[];
      if (text.includes("schema_migrations")) return [{ version: "015_member_blocks.sql" }] as T[];
      throw new Error(`unexpected ${text}`);
    },
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      statements.push("BEGIN");
      const result = await operation(client as unknown as PoolClient);
      statements.push("COMMIT");
      return result;
    },
  } as Pick<Database, "query" | "transaction">;
  return { db, statements };
}

describe("a database restore", () => {
  test("streams the decrypted dump into one pg_restore transaction, then closes the database", async () => {
    const storage = new MemoryStorage();
    storage.objects.set(
      KEY,
      new Uint8Array(
        await new Response(await encrypter.encrypt(new Blob([DUMP]).stream())).arrayBuffer(),
      ),
    );
    const tool = scriptedTool();
    const { db, statements } = target();
    const restored = await restoreDatabase({
      storage,
      key: KEY,
      identities: [identity],
      target: TARGET,
      db,
      runTool: tool.run,
    });
    expect(restored).toEqual({
      key: KEY,
      target: "db.example.org/tarubot_restore",
      schema: "015_member_blocks.sql",
      webSessions: 3,
      roleJobs: 1,
    });
    const [call] = tool.calls;
    expect(call?.input).toEqual(DUMP);
    expect(call?.command).toEqual([
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
      "--dbname=dbname='tarubot_restore'",
    ]);
    expect(JSON.stringify(call?.command)).not.toContain("sentinel-password");
    expect(call?.env).toMatchObject({
      PGAPPNAME: "tarubot-restore",
      PGPASSWORD: "sentinel-password",
    });
    // The closing statements ran after the restore, in one transaction.
    expect(statements.slice(1)).toEqual([
      "BEGIN",
      "SELECT to_regclass('public.web_sessions') IS NOT NULL AS present",
      "DELETE FROM web_sessions",
      RESTORED_ROLE_JOBS_SQL,
      "COMMIT",
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ]);
  });

  test("a target whose public schema has tables is refused before anything is read", async () => {
    const storage = new MemoryStorage();
    const tool = scriptedTool();
    const { db, statements } = target(4);
    await expect(
      restoreDatabase({
        storage,
        key: KEY,
        identities: [identity],
        target: TARGET,
        db,
        runTool: tool.run,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining(
        "RESTORE_DATABASE_URL (db.example.org/tarubot_restore) already has tables",
      ),
    });
    expect(tool.calls).toEqual([]);
    expect(statements).toHaveLength(1);
  });

  test("a target server older than PostgreSQL 17 is refused before anything is read", async () => {
    // pg_restore 18 starts with SET transaction_timeout, which PostgreSQL 16 and older reject.
    for (const [version, named] of [
      [160004, "PostgreSQL 16.4"],
      [150012, "PostgreSQL 15.12"],
      [90624, "PostgreSQL 9.6.24"],
    ] as const) {
      const storage = new MemoryStorage();
      storage.objects.set(KEY, (await encrypter.encrypt(DUMP)).slice());
      const tool = scriptedTool();
      // Refused even when empty, and ahead of the emptiness refusal.
      for (const tables of [0, 4]) {
        const { db, statements } = target(tables, true, version);
        await expect(
          restoreDatabase({
            storage,
            key: KEY,
            identities: [identity],
            target: TARGET,
            db,
            runTool: tool.run,
          }),
        ).rejects.toMatchObject({
          code: "configuration",
          message: `RESTORE_DATABASE_URL (db.example.org/tarubot_restore) runs ${named}; restore targets must run PostgreSQL 17 or newer (TaruBot supports 18), because restore.js's pg_restore 18 sets transaction_timeout, which older servers reject.`,
        });
        expect(statements).toHaveLength(1);
      }
      expect(tool.calls).toEqual([]);
    }
    // PostgreSQL 17 and 18 are restored into.
    for (const version of [170000, 180006]) {
      const storage = new MemoryStorage();
      storage.objects.set(KEY, (await encrypter.encrypt(DUMP)).slice());
      const tool = scriptedTool();
      await restoreDatabase({
        storage,
        key: KEY,
        identities: [identity],
        target: TARGET,
        db: target(0, true, version).db,
        runTool: tool.run,
      });
      expect(tool.calls).toHaveLength(1);
    }
  });

  test("a failed pg_restore leaves the closing statements unrun", async () => {
    const storage = new MemoryStorage();
    storage.objects.set(KEY, (await encrypter.encrypt(DUMP)).slice());
    const { db, statements } = target();
    await expect(
      restoreDatabase({
        storage,
        key: KEY,
        identities: [identity],
        target: TARGET,
        db,
        runTool: scriptedTool({ exit: 1 }).run,
      }),
    ).rejects.toMatchObject({ code: "incomplete", message: expect.stringContaining("status 1") });
    expect(statements).toHaveLength(1);
  });

  test("a dump that fails its integrity check part-way stops pg_restore before it can commit", async () => {
    const storage = new MemoryStorage();
    const ciphertext = (await encrypter.encrypt(DUMP)).slice();
    // Corrupt the last chunk: every earlier 64 KiB chunk decrypts and reaches pg_restore first.
    const last = ciphertext.length - 10;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 0xff;
    storage.objects.set(KEY, ciphertext);
    const tool = scriptedTool();
    const { db, statements } = target();
    await expect(
      restoreDatabase({
        storage,
        key: KEY,
        identities: [identity],
        target: TARGET,
        db,
        runTool: tool.run,
      }),
    ).rejects.toMatchObject({
      code: "incomplete",
      message: expect.stringContaining("still empty"),
    });
    expect(tool.calls[0]?.killed).toBe("SIGKILL");
    expect(statements).toHaveLength(1);
  });

  test("closing a restore without a web_sessions table only closes the role jobs", async () => {
    const { db, statements } = target(0, false);
    expect(await closeRestoredDatabase(db)).toEqual({ webSessions: null, roleJobs: 1 });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT to_regclass('public.web_sessions') IS NOT NULL AS present",
      RESTORED_ROLE_JOBS_SQL,
      "COMMIT",
    ]);
  });
});
