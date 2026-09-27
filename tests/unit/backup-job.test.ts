/**
 * The daily database backup (2.24.0): ops/backup.sh runs on the production host and, with no
 * argument, the production Compose file's `backup` service dumps the database. These pin the
 * properties that keep it safe: strict shell error handling, no unencrypted dump on disk, secrets
 * kept out of process arguments, a failure reported to healthchecks.io, and a service `up` never
 * starts. The live run is recorded in docs/VERIFICATION.md. The Quadlet path (`backup.sh quadlet`,
 * 2.33.0) and its systemd units are pinned in backup-quadlet.test.ts, which also runs the Compose
 * path with stand-ins.
 */
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

test("the backup script is valid bash with strict error handling and private files", async () => {
  const check = Bun.spawnSync([
    "bash",
    "-n",
    new URL("../../ops/backup.sh", import.meta.url).pathname,
  ]);
  expect(check.exitCode).toBe(0);
  const script = await read("ops/backup.sh");
  expect(script).toStartWith("#!/usr/bin/env bash\n");
  expect(script).toContain("set -Eeuo pipefail");
  expect(script).toContain("umask 077");
  // Any failure after the start reports which step failed.
  expect(script).toMatch(/trap '.*notify \/fail/u);
});

test("the dump is encrypted as it streams, and secrets never reach curl's arguments", async () => {
  const script = await read("ops/backup.sh");
  // pg_dump's output goes straight into age: no plaintext file exists at any point.
  expect(script).toMatch(
    /compose run --rm --no-deps -T backup \| age --encrypt --recipients-file/u,
  );
  expect(script).not.toMatch(/pg_dump[^\n]*> /u);
  // Credentials and ping URLs go through --config on stdin, never --user or a URL argument.
  expect(script).not.toMatch(/--user\b|-u "\$/u);
  expect(script.match(/curl --config -/gu)).toHaveLength(2);
  // Only https storage is accepted.
  expect(script).toContain("BACKUP_STORAGE_ENDPOINT must use https.");
});

test("the backup service is off by default and dumps with the bot's verified TLS settings", async () => {
  const compose = z
    .object({
      services: z.record(
        z.string(),
        z
          .object({
            image: z.string(),
            profiles: z.array(z.string()).optional(),
            environment: z.record(z.string(), z.string()).optional(),
            entrypoint: z.array(z.string()).optional(),
            ports: z.unknown().optional(),
            logging: z.unknown().optional(),
          })
          .passthrough(),
      ),
    })
    .parse(YAML.parse(await read("docker-compose.production.yml")));
  const backup = compose.services.backup;
  if (!backup) throw new Error("Missing the backup service");
  // Behind a profile, `up` never starts it; `docker compose run backup` does.
  expect(backup.profiles).toEqual(["backup"]);
  expect(backup.ports).toBeUndefined();
  // Its stdout is the unencrypted dump: a logging driver would copy it to disk even while piped.
  expect(backup.logging).toEqual({ driver: "none" });
  // The same PostgreSQL image as the registry deployment, so pg_dump matches the server's major.
  const base = YAML.parse(await read("docker-compose.yml")) as {
    services: { postgres: { image: string } };
  };
  expect(backup.image).toBe(base.services.postgres.image);
  expect(backup.environment).toMatchObject({
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/tmp/ca.crt",
  });
  expect(backup.environment?.DATABASE_URL).toStartWith("${DATABASE_URL:?");
  expect(backup.environment?.DATABASE_CA_CERT).toStartWith("${DATABASE_CA_CERT:?");
  // $$ keeps Compose from splicing the multi-line CA into the command.
  const command = backup.entrypoint?.join(" ") ?? "";
  expect(command).toContain('"$$DATABASE_CA_CERT"');
  expect(command).toContain('pg_dump --format=custom --no-owner --no-privileges "$$DATABASE_URL"');
});

test("the bucket keeps daily copies for 30 days and monthly dumps for a year", async () => {
  const rules = [
    ...(await read("ops/bucket-lifecycle.xml")).matchAll(
      /<Prefix>([^<]+)<\/Prefix>\s*<\/Filter>\s*<Status>Enabled<\/Status>\s*<Expiration><Days>(\d+)<\/Days>/gu,
    ),
  ].map((match) => [match[1], Number(match[2])]);
  expect(rules).toEqual([
    ["daily/", 30],
    ["env/", 30],
    ["monthly/", 365],
  ]);
});
