/**
 * The PostgreSQL client tools' connection (src/infrastructure/postgres/libpq.ts): the URL's parts
 * as libpq variables in an environment built from scratch, the CA as a private file that is
 * always removed, and refusals that name the setting only.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { libpqEnvironment, withLibpq } from "../../src/infrastructure/postgres/libpq.js";

const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const database = (url: string, ca?: string) => ({ url, setting: "RESTORE_DATABASE_URL", ca });

describe("libpq environment", () => {
  test("decodes the URL into libpq variables and inherits only PATH, HOME and TMPDIR", () => {
    const env = libpqEnvironment(
      database("postgresql://app%40user:p%40ss%3Aw0rd@[2001:db8::1]:27520/tarubot_restore"),
      "tarubot-restore",
      null,
      {
        PATH: "/bin",
        HOME: "/home/bun",
        TMPDIR: "/tmp",
        DISCORD_TOKEN: "invented",
        MODMAIL_KEY: "k",
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/bun",
      TMPDIR: "/tmp",
      PGHOST: "2001:db8::1",
      PGPORT: "27520",
      PGUSER: "app@user",
      PGPASSWORD: "p@ss:w0rd",
      PGDATABASE: "tarubot_restore",
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "tarubot-restore",
    });
  });

  test("a CA means verify-full whatever the URL says; without one the URL's sslmode is kept", () => {
    const url = "postgresql://u:p@db.example.org/x?sslmode=require";
    expect(libpqEnvironment(database(url), "tarubot-backup", "/tmp/ca/root.crt", {})).toMatchObject(
      {
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/tmp/ca/root.crt",
      },
    );
    expect(libpqEnvironment(database(url), "tarubot-backup", null, {})).toMatchObject({
      PGSSLMODE: "require",
    });
    const none = libpqEnvironment(
      database("postgresql://db.example.org/x"),
      "tarubot-backup",
      null,
      {},
    );
    expect(none.PGSSLMODE).toBeUndefined();
    // No user or password in the URL leaves libpq's own defaults.
    expect(none.PGUSER).toBeUndefined();
    expect(none.PGPASSWORD).toBeUndefined();
  });

  test("refusals name the setting, never the URL", () => {
    for (const url of [
      "postgresql://u:secret-pass@db.example.org/x?sslmode=sometimes",
      "postgresql://u:secret-pass@db.example.org/x?host=elsewhere.example.org",
      "mysql://u:secret-pass@db.example.org/x",
      "postgresql://u:%E0%A4%A@db.example.org/x",
    ]) {
      let message = "";
      try {
        libpqEnvironment(database(url), "tarubot-restore", null, {});
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toContain("RESTORE_DATABASE_URL");
      expect(message).not.toContain("secret-pass");
    }
  });

  test("the CA file is private while the tool runs and removed afterwards, even after a failure", async () => {
    let path = "";
    await withLibpq(
      database("postgresql://u:p@db.example.org/x", CA),
      "tarubot-backup",
      async (env) => {
        path = env.PGSSLROOTCERT ?? "";
        expect(await Bun.file(path).text()).toBe(CA);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      },
    );
    expect(existsSync(dirname(path))).toBe(false);
    await expect(
      withLibpq(
        database("postgresql://u:p@db.example.org/x", CA),
        "tarubot-backup",
        async (env) => {
          path = env.PGSSLROOTCERT ?? "";
          throw new Error("the tool failed");
        },
      ),
    ).rejects.toThrow("the tool failed");
    expect(existsSync(dirname(path))).toBe(false);
    // Without a CA nothing is written.
    await withLibpq(
      database("postgresql://u:p@db.example.org/x", ""),
      "tarubot-backup",
      async (env) => {
        expect(env.PGSSLROOTCERT).toBeUndefined();
      },
    );
  });
});
