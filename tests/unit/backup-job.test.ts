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
import { join } from "node:path";
import {
  backup,
  envContents,
  events,
  hostSandbox,
  hostToolsAvailable,
  knob,
  type HostSandbox,
} from "../fixtures/host-runtime.js";

setDefaultTimeout(120_000);
const boxes: HostSandbox[] = [];
afterAll(() => {
  for (const box of boxes) rmSync(box.directory, { recursive: true, force: true });
});
const sandbox = () => {
  const box = hostSandbox();
  boxes.push(box);
  return box;
};

test("backup rejects positional arguments before reading settings or acquiring a lock", () => {
  const box = sandbox();
  const result = backup(box, {}, ["unexpected"]);
  expect(result.code).toBe(64);
  expect(existsSync(box.state)).toBe(false);
  expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
});

describe.skipIf(!hostToolsAvailable)("isolated encrypted offsite backup", () => {
  test("streams the dump to encryption, uploads ciphertext and a settings copy, and cleans temporary files", () => {
    const box = sandbox();
    const result = backup(box);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("backup ok: tarubot-20261003T120000Z\n");
    expect(events(box)).toEqual([
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

  test("daily backup uses the durable successful worktree and digest without changing root settings", () => {
    const box = sandbox();
    const worktree = join(box.state, "releases/current");
    mkdirSync(worktree, { recursive: true });
    cpSync(
      join(box.root, "docker-compose.production.yml"),
      join(worktree, "docker-compose.production.yml"),
    );
    writeFileSync(
      join(box.state, "current"),
      JSON.stringify({ worktree, digest: box.target.digest }),
    );
    expect(backup(box, { TARUBOT_IMAGE_DIGEST: "" }).code).toBe(0);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toContain(
      `-f ${worktree}/docker-compose.production.yml`,
    );
    expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
  });

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
