import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  deployments,
  MANAGED_DIRECT_PORTS,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import { join } from "node:path";
import {
  backup,
  envContents,
  events,
  hostSandbox,
  hostToolsAvailable,
  knob,
  type HostSandbox,
  type HostTarget,
} from "../fixtures/host-runtime.js";

setDefaultTimeout(120_000);
const boxes: HostSandbox[] = [];
afterAll(() => {
  for (const box of boxes) rmSync(box.directory, { recursive: true, force: true });
});
const sandbox = (target: HostTarget = "production") => {
  const box = hostSandbox(false, target);
  boxes.push(box);
  return box;
};

for (const args of [[], ["unexpected"], ["production", "staging"]]) {
  test(`backup refuses invalid owner-bound target arguments: ${JSON.stringify(args)}`, () => {
    const box = sandbox();
    const result = backup(box, {}, args);
    expect(result.code).toBe(64);
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}

describe.skipIf(!hostToolsAvailable)("isolated encrypted offsite backup", () => {
  test("streams the dump to encryption, uploads ciphertext and a settings copy, and cleans temporary files", () => {
    const box = sandbox();
    const result = backup(box);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("backup ok: tarubot-20261003T120000Z\n");
    expect(events(box)).toEqual([
      "config",
      "scope-candidate",
      "backup",
      "age-database",
      "age-settings",
      "upload-database",
      "upload-settings",
    ]);
    expect(readdirSync(join(box.directory, "tmp"))).toEqual([]);
    const uploads = join(box.sim, "uploads");
    expect(readdirSync(uploads).sort()).toEqual([
      "tarubot-20261003T120000Z.dump.age",
      "tarubot-env-20261003T120000Z.age",
    ]);
    for (const path of readdirSync(uploads)) {
      const ciphertext = readFileSync(join(uploads, path), "utf8");
      expect(ciphertext).toContain("AGE-ENCRYPTED");
      expect(ciphertext).not.toContain("database-plaintext-marker");
      expect(ciphertext).not.toContain("private-database-password");
    }
    const argv = readFileSync(join(box.sim, "argv"), "utf8");
    for (const secret of [
      "backup-access",
      "backup-secret",
      "private-check",
      "private-database-password",
      "private-discord-token",
    ])
      expect(argv).not.toContain(secret);
    expect(readFileSync(join(box.sim, "pings"), "utf8")).toContain("/private-check/start");
    expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
  });

  test("the first day of the month also uploads the encrypted dump to monthly", () => {
    const box = sandbox();
    writeFileSync(join(box.sim, "monthly"), "");
    expect(backup(box).code).toBe(0);
    expect(events(box)).toContain("upload-monthly");
    expect(readFileSync(join(box.sim, "upload-urls"), "utf8").split("\n").filter(Boolean)).toEqual([
      "https://backups.example.org/daily/tarubot-20261003T120000Z.dump.age",
      "https://backups.example.org/monthly/tarubot-20261003T120000Z.dump.age",
      "https://backups.example.org/env/tarubot-env-20261003T120000Z.age",
    ]);
  });

  for (const failure of ["backup", "age", "upload"]) {
    test(`${failure} failure cannot announce backup success and removes encrypted temporary files`, () => {
      const box = sandbox();
      knob(box, failure);
      const result = backup(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("backup ok");
      expect(readFileSync(join(box.sim, "pings"), "utf8")).toContain("/private-check/fail");
      expect(readdirSync(join(box.directory, "tmp"))).toEqual([]);
      expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
    });
  }

  for (const target of ["production", "staging"] as const) {
    test(`${target} daily backup uses the accepted manifest despite root checkout drift`, () => {
      const box = sandbox(target);
      const before = readFileSync(join(box.root, ".env"), "utf8");
      const worktree = join(box.state, "releases/current");
      const manifest = `docker-compose.${target}.yml`;
      mkdirSync(worktree, { recursive: true });
      cpSync(join(box.root, manifest), join(worktree, manifest));
      const config = Bun.YAML.parse(readFileSync(join(box.root, manifest), "utf8")) as {
        services: { backup: { environment: Record<string, string> } };
      };
      config.services.backup.environment.DATABASE_URL =
        "postgresql://other:password@database.example.org:27520/other";
      writeFileSync(join(box.root, manifest), JSON.stringify(config));
      writeFileSync(
        join(box.state, "current"),
        JSON.stringify({ target, worktree, digest: box.target.digest }),
      );
      expect(backup(box, { TARUBOT_IMAGE_DIGEST: "", TARUBOT_COMPOSE_FILE: "" }).code).toBe(0);
      const endpoint =
        target === "staging"
          ? "https://staging-backups.example.org"
          : "https://backups.example.org";
      expect(
        readFileSync(join(box.sim, "upload-urls"), "utf8").split("\n").filter(Boolean),
      ).toEqual([
        `${endpoint}/daily/tarubot-20261003T120000Z.dump.age`,
        `${endpoint}/env/tarubot-env-20261003T120000Z.age`,
      ]);
      expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(before);
    });
  }

  test("an unheld inherited-lock flag is refused", () => {
    const box = sandbox();
    expect(backup(box, { TARUBOT_HOST_LOCK_HELD: "true" }).code).not.toBe(0);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });

  test("the shared local host lock prevents daily backup from overlapping a release", async () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    const holder = Bun.spawn(
      [
        "bash",
        "-c",
        'exec 9>"$1"; flock -n 9; printf "held\\n"; read -r line',
        "holder",
        join(box.state, "host.lock"),
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    try {
      const reader = holder.stdout.getReader();
      const signal = await reader.read();
      expect(new TextDecoder().decode(signal.value)).toBe("held\n");
      reader.releaseLock();
      expect(backup(box).code).not.toBe(0);
      expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  });
});

describe.skipIf(!hostToolsAvailable)("staging backup isolation and target refusal", () => {
  test("staging writes common object keys to its own bucket without mutating host settings", () => {
    const box = sandbox("staging");
    writeFileSync(join(box.sim, "monthly"), "");
    const before = readFileSync(join(box.root, ".env"), "utf8");
    expect(backup(box).code).toBe(0);
    const urls = readFileSync(join(box.sim, "upload-urls"), "utf8").split("\n").filter(Boolean);
    expect(urls).toEqual([
      "https://staging-backups.example.org/daily/tarubot-20261003T120000Z.dump.age",
      "https://staging-backups.example.org/monthly/tarubot-20261003T120000Z.dump.age",
      "https://staging-backups.example.org/env/tarubot-env-20261003T120000Z.age",
    ]);
    expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(before);
    expect(events(box)).not.toContain("register-global");
    expect(readdirSync(join(box.directory, "tmp"))).toEqual([]);
  });

  for (const target of ["production", "staging"] as const) {
    test(`${target} daily backup refuses absent accepted current state, rather than falling back to root`, () => {
      const box = sandbox(target);
      expect(backup(box, { TARUBOT_COMPOSE_FILE: "" }).code).not.toBe(0);
      expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
      expect(existsSync(join(box.sim, "uploads"))).toBe(false);
    });
    test(`${target} refuses an explicit other-target manifest before container access`, () => {
      const box = sandbox(target);
      const other = target === "staging" ? "production" : "staging";
      expect(
        backup(box, { TARUBOT_COMPOSE_FILE: join(box.root, `docker-compose.${other}.yml`) }).code,
      ).not.toBe(0);
      expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
      expect(existsSync(join(box.sim, "uploads"))).toBe(false);
    });
    for (const record of ["current", "pending"]) {
      for (const recordedTarget of [undefined, target === "staging" ? "production" : "staging"]) {
        test(`${target} refuses legacy/mixed ${record} even under a direct override`, () => {
          const box = sandbox(target);
          mkdirSync(box.state, { recursive: true });
          const contents = JSON.stringify({
            target: recordedTarget,
            worktree: box.root,
            digest: box.target.digest,
          });
          writeFileSync(join(box.state, record), contents);
          expect(backup(box).code).not.toBe(0);
          expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
          expect(readFileSync(join(box.state, record), "utf8")).toBe(contents);
        });
      }
    }
  }

  const endpoint = `@database.example.org:${MANAGED_DIRECT_PORTS[0]}/`;
  for (const [name, settings] of Object.entries({
    application: { DISCORD_APPLICATION_ID: deployments.production.applicationId },
    guild: { TEST_GUILD_ID: deployments.production.guilds[0] },
    "production-database": {
      DATABASE_URL: `postgresql://${STAGING_DATABASE}:private-database-password${endpoint}tarubot`,
    },
    "production-role": {
      DATABASE_URL: `postgresql://tarubot:private-database-password${endpoint}${STAGING_DATABASE}`,
    },
    "missing-ca": { DATABASE_CA_CERT: "" },
  })) {
    test(`staging ${name} refuses before dumping, encrypting or uploading`, () => {
      const box = sandbox("staging");
      const file = join(box.root, ".env");
      let contents = readFileSync(file, "utf8");
      for (const [key, value] of Object.entries(settings))
        contents = contents.replace(new RegExp(`^${key}=.*$`, "mu"), `${key}=${value}`);
      writeFileSync(file, contents);
      const result = backup(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("backup ok");
      expect(events(box)).not.toContain("backup");
      expect(events(box)).not.toContain("age-database");
      expect(existsSync(join(box.sim, "uploads"))).toBe(false);
      expect(existsSync(join(box.sim, "pings"))).toBe(false);
    });
  }

  for (const failure of ["backup", "age", "upload"]) {
    test(`staging ${failure} failure has no success or production object writes`, () => {
      const box = sandbox("staging");
      knob(box, failure);
      const result = backup(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("backup ok");
      if (existsSync(join(box.sim, "upload-urls")))
        for (const url of readFileSync(join(box.sim, "upload-urls"), "utf8")
          .split("\n")
          .filter(Boolean))
          expect(new URL(url).hostname).toBe("staging-backups.example.org");
      expect(readdirSync(join(box.directory, "tmp"))).toEqual([]);
    });
  }

  for (const field of ["database", "target-marker"]) {
    test(`staging refuses a resolved ${field} mismatch before starting the dump client`, () => {
      const box = sandbox("staging");
      const manifest = join(box.root, "docker-compose.staging.yml");
      const config = Bun.YAML.parse(readFileSync(manifest, "utf8")) as {
        services: {
          tarubot: { environment: Record<string, string> };
          backup: { environment: Record<string, string> };
        };
      };
      if (field === "database")
        config.services.backup.environment.DATABASE_URL = `postgresql://tarubot:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/tarubot`;
      else config.services.tarubot.environment.TARUBOT_ENVIRONMENT = "production";
      writeFileSync(manifest, JSON.stringify(config));
      expect(backup(box).code).not.toBe(0);
      expect(events(box)).not.toContain("backup");
      expect(events(box)).not.toContain("age-database");
      expect(existsSync(join(box.sim, "uploads"))).toBe(false);
      expect(existsSync(join(box.sim, "pings"))).toBe(false);
    });
  }
});
