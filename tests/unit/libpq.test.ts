/**
 * The PostgreSQL client tools' connection (src/infrastructure/postgres/libpq.ts): the URL's parts
 * as libpq variables in an environment built from scratch, the URL's TLS parameters translated as
 * node-postgres reads them when there is no CA, the CA as a private file that is always removed,
 * and refusals that name the setting only.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ConnectionParameters from "pg/lib/connection-parameters";
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

  test("a CA means verify-full whatever the URL says; without one the URL's TLS follows the driver", () => {
    const url = "postgresql://u:p@db.example.org/x?sslmode=require";
    expect(libpqEnvironment(database(url), "tarubot-backup", "/tmp/ca/root.crt", {})).toMatchObject(
      {
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/tmp/ca/root.crt",
      },
    );
    // node-postgres verifies a require URL fully, so the tool does too.
    expect(libpqEnvironment(database(url), "tarubot-backup", null, {})).toMatchObject({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
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
    // Every mode node-postgres verifies is verify-full here, against the URL's root or the system's.
    for (const mode of ["prefer", "require", "verify-ca", "verify-full", "allow", "sometimes"]) {
      expect(tls(`?sslmode=${mode}`)).toEqual({
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "system",
      });
      expect(tls(`?sslmode=${mode}&sslrootcert=/run/secrets/ca.pem`)).toEqual({
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/run/secrets/ca.pem",
      });
    }
    // So do ssl=true, a bare certificate file and direct negotiation, which turn TLS on.
    expect(tls("?ssl=true")).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" });
    expect(tls("?ssl=1")).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" });
    // pg takes any other ssl string as TLS on, even "false".
    expect(tls("?ssl=false")).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" });
    expect(tls("?sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
    });
    expect(tls("?sslnegotiation=direct")).toEqual({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGSSLNEGOTIATION: "direct",
    });
    // node-postgres's no-verify encrypts without verifying: libpq's require, and no root
    // certificate, since libpq verifies the chain whenever one is named.
    expect(tls("?sslmode=no-verify")).toEqual({ PGSSLMODE: "require" });
    expect(tls("?ssl=no-verify")).toEqual({ PGSSLMODE: "require" });
    expect(tls("?sslmode=no-verify&sslrootcert=/run/secrets/ca.pem&sslcert=/run/c.pem")).toEqual({
      PGSSLMODE: "require",
      PGSSLCERT: "/run/c.pem",
    });
    // disable, or ssl=0 alone, is plaintext; an empty parameter is no parameter.
    expect(tls("?sslmode=disable&sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "disable",
    });
    expect(tls("?ssl=0")).toEqual({ PGSSLMODE: "disable" });
    expect(tls("?ssl=0&sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
    });
    expect(tls("?sslmode=&sslrootcert=")).toEqual({});
    expect(tls("")).toEqual({});
    // uselibpqcompat=true asks node-postgres for libpq's meaning: kept, but never one that lets
    // libpq fall back to plaintext where node-postgres insists on TLS.
    const compat = (query: string) => tls(`?uselibpqcompat=true&${query}`);
    expect(compat("sslmode=require")).toEqual({ PGSSLMODE: "require" });
    expect(compat("sslmode=prefer")).toEqual({ PGSSLMODE: "require" });
    expect(compat("sslmode=allow")).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" });
    expect(compat("sslmode=verify-ca&sslrootcert=/run/secrets/ca.pem")).toEqual({
      PGSSLMODE: "verify-ca",
      PGSSLROOTCERT: "/run/secrets/ca.pem",
    });
    expect(compat("sslmode=disable")).toEqual({ PGSSLMODE: "disable" });
    // verify-ca with nothing to check against: node-postgres refuses it too.
    expect(() => compat("sslmode=verify-ca")).toThrow(
      "DATABASE_URL names sslmode=verify-ca without sslrootcert, which the bot's driver refuses too. Set DATABASE_CA_CERT to the provider's CA certificate, or name sslrootcert in the URL.",
    );
    expect(() => tls("?uselibpqcompat=true&sslmode=verify-ca", "RESTORE_DATABASE_URL")).toThrow(
      "Set RESTORE_DATABASE_CA_CERT (or DATABASE_CA_CERT) to the provider's CA certificate",
    );
  });

  test("the translation never verifies less than node-postgres itself (pg's ConnectionParameters)", () => {
    const ROOT = join(mkdtempSync(join(tmpdir(), "libpq-root-test-")), "root.crt");
    writeFileSync(ROOT, "invented root\n");
    // pg falls back to PGSSLMODE when a URL names no TLS; the bot's containers never set it.
    const inheritedMode = process.env.PGSSLMODE;
    delete process.env.PGSSLMODE;
    // What the bot's pool does with each URL (connection.ts hands pg the URL alone without a CA):
    // no TLS, TLS without verification, or verified TLS. Any truthy ssl value turns TLS on, and
    // only rejectUnauthorized: false turns verification off.
    const driver = (query: string): "plain" | "unverified" | "verified" => {
      const { ssl } = new ConnectionParameters(`postgresql://u:p@db.example.org/x${query}`);
      if (!ssl) return "plain";
      if (typeof ssl === "object" && ssl.rejectUnauthorized === false) return "unverified";
      return "verified";
    };
    const tool = (query: string): "plain" | "unverified" | "verified" | "prefer" => {
      const env = libpqEnvironment(
        database(`postgresql://u:p@db.example.org/x${query}`),
        "tarubot-backup",
        null,
        {},
      );
      if (env.PGSSLMODE === undefined) return "prefer";
      if (env.PGSSLMODE === "disable") return "plain";
      return env.PGSSLMODE === "require" ? "unverified" : "verified";
    };
    try {
      for (const query of [
        "",
        "?ssl=true",
        "?ssl=1",
        "?ssl=0",
        "?ssl=false",
        "?ssl=no-verify",
        // pg reads the file named, so this one exists.
        `?ssl=0&sslrootcert=${ROOT}`,
        "?sslnegotiation=direct",
        ...["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"].map(
          (mode) => `?sslmode=${mode}`,
        ),
        "?uselibpqcompat=true&sslmode=require",
        "?uselibpqcompat=true&sslmode=prefer",
        "?uselibpqcompat=true&sslmode=disable",
        "?uselibpqcompat=true&sslmode=verify-full",
      ]) {
        // A URL with no TLS at all is plaintext for the driver; libpq's default only adds a try.
        const expected = driver(query);
        expect({ query, tool: tool(query) }).toEqual({
          query,
          tool: expected === "plain" && query === "" ? "prefer" : expected,
        });
      }
    } finally {
      if (inheritedMode !== undefined) process.env.PGSSLMODE = inheritedMode;
      rmSync(dirname(ROOT), { recursive: true, force: true });
    }
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
      "postgresql://u:secret-pass@db.example.org/x?uselibpqcompat=true&sslmode=verify-ca",
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

  test("a client key reaches libpq as a private copy, which is always removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "libpq-key-test-"));
    try {
      // A key its group and others may read, as a copy on a single-user host often is: the bot's
      // driver reads it, and libpq would refuse it.
      const key = join(directory, "client.key");
      await writeFile(key, "invented key\n", { mode: 0o644 });
      let path = "";
      await withLibpq(
        database(`postgresql://u:p@db.example.org/x?sslmode=no-verify&sslkey=${key}`),
        "tarubot-backup",
        async (env) => {
          path = env.PGSSLKEY ?? "";
          expect(path).not.toBe(key);
          expect(await Bun.file(path).text()).toBe("invented key\n");
          expect((await stat(path)).mode & 0o777).toBe(0o600);
        },
      );
      expect(existsSync(dirname(path))).toBe(false);
      // A key that can't be read is refused by setting name, before the tool runs.
      await expect(
        withLibpq(
          database(`postgresql://u:p@db.example.org/x?sslkey=${join(directory, "missing.key")}`),
          "tarubot-backup",
          async () => {},
        ),
      ).rejects.toThrow("RESTORE_DATABASE_URL names an sslkey that can't be read.");
    } finally {
      await rm(directory, { recursive: true, force: true });
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
