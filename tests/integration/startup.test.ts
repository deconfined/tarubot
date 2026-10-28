/**
 * main.ts after a startup migration that fails on the database itself (2.46.0): the real
 * composition root, spawned against the test database with a migration that always fails. It
 * pauses holding nothing, logs the file and SQLSTATE by code, and still ends at once on SIGTERM or
 * SIGINT. tests/unit/startup.test.ts covers the pause's parts and the refusals that exit at once.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILED_MIGRATION_PAUSED } from "../../src/application/startup.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";

const url = process.env.TEST_DATABASE_URL;

/** A TCP port nothing listens on right now, for the spawned bot's health server. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
}

describe.skipIf(!url)("main.ts after a failed startup migration", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");

  test("pauses holding nothing, logs the file and SQLSTATE, and SIGTERM or SIGINT still ends it at once with exit 0", async () => {
    const schema = "startup_pause";
    const db = new Database(url);
    const confined = new URL(url);
    confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${schema}`);
    const password = decodeURIComponent(confined.password);
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        const port = freePort();
        // No .env in the working directory, so Bun loads none; its migrations directory holds the
        // one file, which fails whatever the rows.
        const cwd = mkdtempSync(join(tmpdir(), "tarubot-pause-"));
        mkdirSync(join(cwd, "migrations"));
        writeFileSync(join(cwd, "migrations", "900_fails.sql"), "SELECT 1/0;");
        const child = Bun.spawn(
          [process.execPath, fileURLToPath(new URL("../../src/main.ts", import.meta.url))],
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: cwd,
              // An unmanaged installation without backups: it migrates with a warning, no backup.
              DISCORD_TOKEN: "sentinel-token-for-startup",
              DISCORD_APPLICATION_ID: "222222222222222222",
              DATABASE_URL: confined.toString(),
              HEALTH_PORT: String(port),
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        try {
          // Read the log until the pause begins (or the process ends without one).
          const reader = child.stdout.getReader();
          const decoder = new TextDecoder();
          let text = "";
          const records = () =>
            text
              .split("\n")
              .filter((entry) => entry.startsWith("{"))
              .map((entry) => JSON.parse(entry) as Record<string, unknown>);
          const pauseLine = async () => {
            for (;;) {
              const line = records().find((record) => record.msg === FAILED_MIGRATION_PAUSED);
              if (line) return line;
              const { done, value } = await reader.read();
              if (done) return null;
              text += decoder.decode(value, { stream: true });
            }
          };
          const line = await Promise.race([pauseLine(), Bun.sleep(60_000).then(() => null)]);
          expect(line).toMatchObject({
            level: 50,
            code: "schema",
            source: "Failure",
            diagnostic: "Migration 900_fails.sql failed (SQLSTATE 22012); nothing was applied.",
            pauseMinutes: 10,
          });
          expect(
            records().some((record) =>
              String(record.msg).startsWith("Migrating without a pre-migration backup"),
            ),
          ).toBe(true);
          expect(text).not.toContain(password);
          expect(text).not.toContain("sentinel-token-for-startup");
          // Still running a moment later, with the lifecycle stopped: its health server is closed,
          // and the migration's transaction rolled back, bookkeeping table and all.
          await Bun.sleep(500);
          expect(child.exitCode).toBeNull();
          expect(
            await fetch(`http://127.0.0.1:${port}/health/live`).then(
              () => "listening",
              () => "closed",
            ),
          ).toBe("closed");
          expect(
            await db.query("SELECT to_regclass($1) IS NULL AS absent", [
              `${schema}.schema_migrations`,
            ]),
          ).toEqual([{ absent: true }]);
          const sent = performance.now();
          child.kill(signal);
          expect(await child.exited).toBe(0);
          expect(performance.now() - sent).toBeLessThan(5_000);
          reader.releaseLock();
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    }
  }, 120_000);
});
