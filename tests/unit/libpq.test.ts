/**
 * The PostgreSQL client tools' connection (src/infrastructure/postgres/libpq.ts): the URL's parts
 * as libpq variables in an environment built from scratch, the URL's TLS parameters translated as
 * node-postgres reads them when there is no CA, the CA as a private file that is always removed,
 * and refusals that name the setting only.
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

  test("without a CA, the URL's TLS parameters reach libpq as the bot's driver reads them", () => {
    const tls = (query: string, setting = "DATABASE_URL") => {
      const env = libpqEnvironment(
        { url: `postgresql://u:p@db.example.org/x${query}`, setting, ca: undefined },
        "tarubot-backup",
        null,
        {},
      );
      return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("PGSSL")));
    };
    // The URL's own files, which node-postgres reads too, become libpq's variables.
    expect(
      tls("?sslmode=verify-full&sslrootcert=/run/secrets/ca.pem&sslcert=/run/c.pem&sslkey=/run/k"),
    ).toEqual({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
      PGSSLCERT: "/run/c.pem",
      PGSSLKEY: "/run/k",
    });
    expect(tls("?sslmode=verify-ca&sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "verify-ca",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
    });
    // verify-full with no root certificate: the system's roots, where node-postgres uses Node's.
    expect(tls("?sslmode=verify-full")).toEqual({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
    });
    // node-postgres's no-verify encrypts without verifying: libpq's require, and no root
    // certificate, since libpq verifies the chain whenever one is named.
    expect(tls("?sslmode=no-verify")).toEqual({ PGSSLMODE: "require" });
    expect(tls("?sslmode=no-verify&sslrootcert=/run/secrets/ca.pem&sslcert=/run/c.pem")).toEqual({
      PGSSLMODE: "require",
      PGSSLCERT: "/run/c.pem",
    });
    // libpq's own weaker modes keep their meaning; an empty parameter is no parameter.
    for (const mode of ["disable", "allow", "prefer", "require"])
      expect(tls(`?sslmode=${mode}&sslrootcert=`)).toEqual({ PGSSLMODE: mode });
    expect(tls("?sslmode=require&sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "require",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
    });
    expect(tls("")).toEqual({});
    // verify-ca can't use the system's roots in libpq: refused, naming the CA setting.
    expect(() => tls("?sslmode=verify-ca")).toThrow(
      "DATABASE_URL names sslmode=verify-ca without sslrootcert, which pg_dump and pg_restore can't check against the system's roots. Set DATABASE_CA_CERT to the provider's CA certificate, or name sslrootcert in the URL.",
    );
    expect(() => tls("?sslmode=verify-ca", "RESTORE_DATABASE_URL")).toThrow(
      "Set RESTORE_DATABASE_CA_CERT (or DATABASE_CA_CERT) to the provider's CA certificate",
    );
  });

  test("a CA still decides alone: verify-full with its file, whatever TLS the URL names", () => {
    for (const query of [
      "?sslmode=no-verify&sslrootcert=/run/secrets/ca.pem&sslcert=/run/c.pem&sslkey=/run/k",
      "?sslmode=verify-ca",
      "?sslmode=sometimes",
      "?sslmode=disable",
    ]) {
      const env = libpqEnvironment(
        database(`postgresql://u:p@db.example.org/x${query}`, CA),
        "tarubot-restore",
        "/tmp/ca/root.crt",
        {},
      );
      expect(
        Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("PGSSL"))),
      ).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "/tmp/ca/root.crt" });
    }
  });

  test("refusals name the setting, never the URL", () => {
    for (const url of [
      "postgresql://u:secret-pass@db.example.org/x?sslmode=sometimes",
      "postgresql://u:secret-pass@db.example.org/x?sslmode=verify-ca",
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
