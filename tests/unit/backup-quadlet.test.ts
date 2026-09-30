/**
 * The backup scripts, run for real against stand-ins (tests/fixtures/backup-stubs/) for podman,
 * docker, age, curl, id and date, each first on PATH and recording its arguments and environment:
 * - ops/backup.sh with no argument, the production host's Compose path, in a sandbox shaped like
 *   the host's clone (its static properties are in backup-job.test.ts). The script stays as it is
 *   until production moves (2.37.0); only its Compose path is pinned here.
 * - ops/ansible/files/bot/tarubot-backup (#62), staging's backup on a Quadlet host, which
 *   ops/ansible/bot.yml installs as ~/.local/bin/tarubot-backup with its user service and timer,
 *   in a sandbox home. Its settings come from the Podman secrets bot.yml writes, and these pin
 *   what keeps the dump safe: no value reaches an argument or an environment variable of any
 *   tool, the one `podman run` is as hardened as Compose's backup service, reads the two database
 *   secrets as files the bot's unit mounts and gets nothing on stdin, the container's shell hands
 *   the URL's parts to pg_dump as libpq's environment and never as an argument (run here too,
 *   with bash in POSIX mode standing in for the image's BusyBox sh), the dump streams into age,
 *   uploads and pings go as before, and failures ping /fail by step.
 * The byte-exact stream through `--log-driver=none` was checked on a local Podman 5.8.2 with a real
 * PostgreSQL 18.4 dump (2.33.0's verification record, linked from docs/archive/README.md).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import { deployments } from "../../src/config/deployment.js";
import { renderStaging } from "../fixtures/bot-render.js";
import { parseUnit, read, root, valuesOf } from "../fixtures/quadlet.js";

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

const STUBS = root("tests/fixtures/backup-stubs");
const BACKUP = root("ops/ansible/files/bot/tarubot-backup");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backup-quadlet-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The stand-ins' clock: 2026-09-29T04:30:00Z, not the 1st, so there is no monthly upload. */
const NOW = Date.UTC(2026, 8, 29, 4, 30, 0) / 1000;
const STAMP = "20260929T043000Z";
/** The 1st of October, when a copy also goes to monthly/. */
const FIRST = Date.UTC(2026, 9, 1, 4, 30, 0) / 1000;
/** Every secret-bearing value in a sandbox carries this mark. */
const MARK = "backupmark7c1e";
/** A user id whose /run/user directory doesn't exist. */
const NO_RUNTIME_UID = "4294967294";

/**
 * The dump's image: Compose's name and tag, fully qualified, and pinned by the image index digest,
 * since the container reads the database secrets and can reach the network.
 */
const PG_IMAGE =
  "docker.io/library/postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";

/** One recorded call of a stand-in. */
interface Call {
  tool: string;
  argv: string[];
  env: Map<string, string>;
  /** podman: "eof", "data" or "open"; curl: the --config text; otherwise null. */
  stdin: string | null;
}

/** A NUL-separated list, as the stand-ins write it. */
const fields = (text: string) => text.split("\0").slice(0, -1);

/** Every recorded call under a stand-in directory, in the order the calls started. */
function recorded(sim: string): Call[] {
  return readdirSync(join(sim, "calls"))
    .sort()
    .map((id) => {
      const directory = join(sim, "calls", id);
      const env = new Map<string, string>();
      for (const entry of fields(readFileSync(join(directory, "env"), "utf8"))) {
        const at = entry.indexOf("=");
        env.set(entry.slice(0, at), entry.slice(at + 1));
      }
      const stdin = join(directory, "stdin");
      return {
        tool: readFileSync(join(directory, "tool"), "utf8"),
        argv: fields(readFileSync(join(directory, "argv"), "utf8")),
        env,
        stdin: existsSync(stdin) ? readFileSync(stdin, "utf8") : null,
      };
    });
}

/** Run a script as the timer does, with only the given variables; `undefined` leaves one out. */
function spawn(command: string[], variables: Record<string, string | undefined>) {
  const result = Bun.spawnSync(command, {
    env: Object.fromEntries(
      Object.entries(variables).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    // stdin holds data, so a stand-in that reads it shows whether the script closed it.
    stdin: new TextEncoder().encode("stdin that must not reach the dump\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/** The calls of one tool. */
const of = (calls: Call[], tool: string) => calls.filter((call) => call.tool === tool);
/** What each healthchecks ping said: the path after the check's URL, and the note. */
const pings = (calls: Call[]) =>
  of(calls, "curl")
    .filter((call) => call.argv.includes("--data-raw"))
    .map((call) => ({
      path:
        /^url = "https:\/\/hc\.invalid\/[^/"]+(\/[a-z]+)?"\n$/u.exec(call.stdin ?? "")?.[1] ?? "",
      note: call.argv[call.argv.indexOf("--data-raw") + 1],
    }));
/** The bucket keys uploaded, in order. */
const uploads = (calls: Call[]) =>
  of(calls, "curl")
    .filter((call) => call.argv.includes("--upload-file"))
    .map((call) => (call.argv.at(-1) ?? "").replace("https://bucket.invalid/", ""));
/** The last line of a script's output. */
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1) ?? "";
/** The value after each occurrence of a flag in an argument list. */
const valuesAfter = (argv: string[], flag: string) =>
  argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));
/** No call's arguments or environment hold the mark. */
function expectNoValues(calls: Call[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const seen = [...call.argv, ...[...call.env].map(([name, value]) => `${name}=${value}`)];
    expect({ tool: call.tool, leaked: seen.filter((item) => item.includes(MARK)) }).toEqual({
      tool: call.tool,
      leaked: [],
    });
  }
}

// -------------------------------------------------------------------------------------------
// ops/backup.sh's Compose path, unchanged until production moves.

/** A host's .env in the forms the script meets: a multi-line quoted CA, every secret set. */
const ENV = [
  "TARUBOT_IMAGE_TAG=2.33.0",
  `DATABASE_URL=postgresql://tarubot:${MARK}-db@db.invalid:27520/tarubot`,
  `DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----`,
  `${MARK}ca`,
  `-----END CERTIFICATE-----"`,
  `DISCORD_TOKEN=${MARK}-discord`,
  `POSTGRES_PASSWORD=${MARK}-postgres`,
  "BACKUP_STORAGE_ENDPOINT=bucket.invalid",
  `BACKUP_STORAGE_ACCESS_KEY=${MARK}-access`,
  `BACKUP_STORAGE_SECRET_KEY=${MARK}-secret`,
  "BACKUP_STORAGE_REGION=region-1",
  `HEALTHCHECKS_BACKUP_URL=https://hc.invalid/${MARK}-ping`,
  "",
].join("\n");

/**
 * A sandbox shaped like the production host's clone (~/tarubot): the real ops/backup.sh copied in
 * (a copy, not a link, since the script finds its clone from its own resolved path), the release's
 * age recipients and the given .env (none when null).
 */
function clone(name: string, env: string | null = ENV) {
  const base = join(scratch, name);
  const home = join(base, "tarubot");
  const sim = join(base, "sim");
  for (const directory of [
    join(home, "ops"),
    join(sim, "calls"),
    join(sim, "knob"),
    join(base, "tmp"),
  ])
    mkdirSync(directory, { recursive: true });
  copyFileSync(root("ops/backup.sh"), join(home, "ops/backup.sh"));
  chmodSync(join(home, "ops/backup.sh"), 0o755);
  copyFileSync(root("ops/age-recipients.txt"), join(home, "ops/age-recipients.txt"));
  if (env !== null) writeFileSync(join(home, ".env"), env, { mode: 0o600 });
  const run = (args: string[]) =>
    spawn([join(home, "ops/backup.sh"), ...args], {
      PATH: `${STUBS}:/usr/bin:/bin`,
      HOME: base,
      TMPDIR: join(base, "tmp"),
      LC_ALL: "C",
      BACKUP_SIM: sim,
      BACKUP_SIM_NOW: String(NOW),
    });
  return { run, calls: () => recorded(sim) };
}

/** ops/deploy.sh's pattern for the line that names the uploaded dump. */
const backupDone = () => {
  const match = /^readonly BACKUP_DONE='([^']+)'$/mu.exec(
    readFileSync(root("ops/deploy.sh"), "utf8"),
  );
  if (!match?.[1]) throw new Error("ops/deploy.sh has no BACKUP_DONE line");
  return new RegExp(match[1], "u");
};

describe("ops/backup.sh with no argument (production's Compose host)", () => {
  test("runs the Compose dump, and never Podman", () => {
    const box = clone("compose");
    const result = box.run([]);
    expect(result).toMatchObject({ code: 0, err: "" });
    const calls = box.calls();
    expect(of(calls, "docker").map((call) => call.argv)).toEqual([
      [
        "compose",
        "-f",
        "docker-compose.production.yml",
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "backup",
      ],
    ]);
    expect(of(calls, "podman")).toEqual([]);
    expect(uploads(calls)).toEqual([
      `daily/tarubot-${STAMP}.dump.age`,
      `env/tarubot-env-${STAMP}.age`,
    ]);
    expect(lastLine(result.out)).toMatch(backupDone());
  });

  test("no setting's value reaches an argument or an environment variable of any tool", () => {
    const box = clone("compose-values");
    expect(box.run([]).code).toBe(0);
    const calls = box.calls();
    expectNoValues(calls);
    // The control: the credentials and the ping URL are read, and reach curl on stdin only.
    const configs = of(calls, "curl").map((call) => call.stdin ?? "");
    expect(configs.some((config) => config.includes(`${MARK}-access:${MARK}-secret`))).toBe(true);
    expect(configs.some((config) => config.includes(`${MARK}-ping`))).toBe(true);
  });

  test("any argument but quadlet exits 64 before it reads a setting or sends anything", () => {
    const cases = [["compose"], ["podman"], ["quadlet", "staging"], ["quadlet", "quadlet"], [""]];
    cases.forEach((args, index) => {
      // No .env at all: reading a setting would put sed's complaint on stderr.
      const box = clone(`usage-${index}`, null);
      expect({ args, ...box.run(args) }).toEqual({
        args,
        code: 64,
        out: "",
        err: "usage: backup.sh [quadlet]\n",
      });
      expect(box.calls()).toEqual([]);
    });
  });
});

// -------------------------------------------------------------------------------------------
// tarubot-backup on a Quadlet host.

/** The five settings as bot.yml stores them, each value followed by the newline its copy gains. */
const SECRETS: Record<string, string> = {
  "backup-storage-endpoint": "bucket.invalid",
  "backup-storage-region": "region-1",
  "backup-storage-access-key": `${MARK}-access`,
  "backup-storage-secret-key": `${MARK}-secret`,
  "healthchecks-backup-url": `https://hc.invalid/${MARK}-ping`,
};

/**
 * A sandbox home for tarubot-backup: the release's age recipients where bot.yml puts them, the
 * Podman secrets the stand-in answers `secret inspect` from (with `secrets` changing or, as
 * undefined, removing them), and a private runtime directory.
 */
function home(name: string, secrets: Record<string, string | undefined> = {}) {
  const base = join(scratch, name);
  const sim = join(base, "sim");
  const runtime = join(base, "runtime");
  for (const directory of [
    join(base, "home/.config/tarubot"),
    join(sim, "calls"),
    join(sim, "knob"),
    join(sim, "secrets"),
    join(base, "tmp"),
  ])
    mkdirSync(directory, { recursive: true });
  mkdirSync(runtime, { mode: 0o700 });
  copyFileSync(
    root("ops/age-recipients.txt"),
    join(base, "home/.config/tarubot/age-recipients.txt"),
  );
  for (const [secret, value] of Object.entries({ ...SECRETS, ...secrets }))
    if (value !== undefined) writeFileSync(join(sim, "secrets", secret), `${value}\n`);
  /** Make the dump fail, or come out too small. */
  const knob = (which: "podman" | "small") => writeFileSync(join(sim, "knob", which), "");
  const run = (args: string[] = [], extra: Record<string, string | undefined> = {}) =>
    spawn(["bash", BACKUP, ...args], {
      PATH: `${STUBS}:/usr/bin:/bin`,
      HOME: join(base, "home"),
      TMPDIR: join(base, "tmp"),
      LC_ALL: "C",
      BACKUP_SIM: sim,
      BACKUP_SIM_NOW: String(NOW),
      XDG_RUNTIME_DIR: runtime,
      ...extra,
    });
  return { base, runtime, knob, run, calls: () => recorded(sim) };
}

/** The program tarubot-backup's DUMP gives the container's shell, from its heredoc. */
const dumpProgram = async () => {
  const found = /^DUMP=\$\(\n {2}cat <<'SH'\n([\s\S]*?)\nSH\n\)\nreadonly DUMP$/mu.exec(
    await read("ops/ansible/files/bot/tarubot-backup"),
  )?.[1];
  if (found === undefined) throw new Error("no DUMP heredoc in tarubot-backup");
  return found;
};

/** The one `podman run`, exactly. */
const dumpArgv = (stamp: string, program: string) => [
  "run",
  "--rm",
  "--name",
  `tarubot-backup-${stamp}`,
  "--label",
  "io.tarubot.role=backup",
  "--pull=missing",
  "--log-driver=none",
  "--env-host=false",
  "--http-proxy=false",
  "--read-only",
  "--read-only-tmpfs=false",
  "--cap-drop=all",
  "--security-opt=no-new-privileges",
  "--secret",
  "tarubot-database-url,type=mount,target=/run/secrets/database_url,mode=0400",
  "--secret",
  "tarubot-database-ca-cert,type=mount,target=/run/secrets/database_ca_cert,mode=0400",
  "--env",
  "PGSSLMODE=verify-full",
  "--env",
  "PGSSLROOTCERT=/run/secrets/database_ca_cert",
  "--entrypoint",
  "sh",
  PG_IMAGE,
  "-c",
  program,
];

/** One successful run, shared by the tests that read its calls. */
let shared: ReturnType<typeof runShared> | undefined;
function runShared() {
  const box = home("shared");
  return { box, result: box.run(), calls: box.calls() };
}
const sharedRun = () => {
  shared ??= runShared();
  return shared;
};
/** The shared run's one dump; fails when there isn't exactly one. */
const dumpCall = () => {
  const runs = of(sharedRun().calls, "podman").filter((call) => call.argv[0] === "run");
  if (runs.length !== 1 || !runs[0]) throw new Error("expected exactly one podman run");
  return runs[0];
};

describe("tarubot-backup", () => {
  test("is bash in strict mode with a private umask", async () => {
    const script = await read("ops/ansible/files/bot/tarubot-backup");
    expect(script).toStartWith("#!/usr/bin/env bash\n");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("umask 077");
    expect(Bun.spawnSync(["bash", "-n", BACKUP]).exitCode).toBe(0);
  });

  test("reads its five settings from Podman's secrets, then runs one hardened pg_dump into age", async () => {
    const { result, calls } = sharedRun();
    expect(result).toMatchObject({ code: 0, err: "" });
    // The ping URL first, so every later failure can report itself, then the bucket's four.
    expect(
      of(calls, "podman")
        .filter((call) => call.argv[0] === "secret")
        .map((call) => call.argv),
    ).toEqual(
      [
        "healthchecks-backup-url",
        "backup-storage-endpoint",
        "backup-storage-region",
        "backup-storage-access-key",
        "backup-storage-secret-key",
      ].map((name) => [
        "secret",
        "inspect",
        "--showsecret",
        "--format",
        "{{.SecretData}}",
        `tarubot-${name}`,
      ]),
    );
    const dump = dumpCall();
    expect(dump.argv).toEqual(dumpArgv(STAMP, await dumpProgram()));
    // stdin is closed: nothing of the script's input reaches the container.
    expect(dump.stdin).toBe("eof");
    // The dump streams into age, for the recipients bot.yml installed, never onto the disk.
    expect(of(calls, "age").map((call) => call.argv.slice(0, 3))).toEqual([
      [
        "--encrypt",
        "--recipients-file",
        expect.stringMatching(/\/\.config\/tarubot\/age-recipients\.txt$/u),
      ],
    ]);
    expect(of(calls, "docker")).toEqual([]);
    expect(pings(calls)).toEqual([
      { path: "/start", note: "backup starting" },
      { path: "", note: `daily/tarubot-${STAMP}.dump.age: 8192 bytes` },
    ]);
    // Only the dump, with https:// added to the endpoint; no settings copy any more.
    expect(uploads(calls)).toEqual([`daily/tarubot-${STAMP}.dump.age`]);
    expect(
      of(calls, "curl")
        .filter((call) => call.argv.includes("--upload-file"))
        .map((call) => valuesAfter(call.argv, "--aws-sigv4")),
    ).toEqual([["aws:amz:region-1:s3"]]);
    expect(lastLine(result.out)).toMatch(
      new RegExp(`^\\S+ backup ok: tarubot-${STAMP} \\(8192 bytes\\)$`, "u"),
    );
  });

  test("no setting's value reaches an argument or an environment variable of any tool", () => {
    const { calls } = sharedRun();
    expectNoValues(calls);
    // The control: the credentials and the ping URL are read, and reach curl on stdin only.
    const configs = of(calls, "curl").map((call) => call.stdin ?? "");
    expect(configs.some((config) => config.includes(`${MARK}-access:${MARK}-secret`))).toBe(true);
    expect(configs.some((config) => config.includes(`${MARK}-ping`))).toBe(true);
  });

  test("the tools see the runtime directory the user manager set", () => {
    expect(dumpCall().env.get("XDG_RUNTIME_DIR")).toBe(sharedRun().box.runtime);
  });

  test("on the 1st a copy also goes to monthly/", () => {
    const box = home("first");
    expect(box.run([], { BACKUP_SIM_NOW: String(FIRST) }).code).toBe(0);
    expect(uploads(box.calls())).toEqual([
      "daily/tarubot-20261001T043000Z.dump.age",
      "monthly/tarubot-20261001T043000Z.dump.age",
    ]);
  });

  test("an endpoint with https:// is used as it is, and without a ping URL nothing is pinged", () => {
    const box = home("no-ping", {
      "backup-storage-endpoint": "https://bucket.invalid/",
      "healthchecks-backup-url": undefined,
    });
    expect(box.run().code).toBe(0);
    expect(uploads(box.calls())).toEqual([`daily/tarubot-${STAMP}.dump.age`]);
    expect(pings(box.calls())).toEqual([]);
  });

  test("any argument exits 64 before it reads a setting or sends anything", () => {
    for (const [index, args] of [["quadlet"], ["--dry-run"], [""]].entries()) {
      const box = home(`usage-${index}`);
      expect({ args, ...box.run(args) }).toEqual({
        args,
        code: 64,
        out: "",
        err: "usage: tarubot-backup\n",
      });
      expect(box.calls()).toEqual([]);
    }
  });
});

describe("tarubot-backup's failures", () => {
  test("a missing setting fails at settings, before the start ping, naming the setting only", () => {
    const box = home("missing", { "backup-storage-region": undefined });
    const result = box.run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("BACKUP_STORAGE_REGION is empty or missing");
    expect(result.err).toContain("backup failed at: settings");
    expect(result.out + result.err).not.toContain(MARK);
    const calls = box.calls();
    expect(pings(calls)).toEqual([{ path: "/fail", note: "backup failed at: settings" }]);
    expect(of(calls, "podman").filter((call) => call.argv[0] === "run")).toEqual([]);
  });

  test("an endpoint that isn't https is refused at settings", () => {
    const box = home("http", { "backup-storage-endpoint": "http://bucket.invalid" });
    const result = box.run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("BACKUP_STORAGE_ENDPOINT must use https.");
    expect(uploads(box.calls())).toEqual([]);
  });

  test("without XDG_RUNTIME_DIR a missing /run/user directory fails before anything runs", () => {
    expect(existsSync(`/run/user/${NO_RUNTIME_UID}`)).toBe(false);
    const box = home("no-runtime");
    const result = box.run([], { XDG_RUNTIME_DIR: undefined, BACKUP_SIM_UID: NO_RUNTIME_UID });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `/run/user/${NO_RUNTIME_UID} is not this user's private directory`,
    );
    // No secret can be read yet, so nothing is pinged.
    expect(box.calls()).toEqual([]);
  });

  test("a failed pg_dump fails the run at dump, although age finished", () => {
    const box = home("dump-fail");
    box.knob("podman");
    const result = box.run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("backup failed at: dump");
    const calls = box.calls();
    expect(of(calls, "age")).toHaveLength(1);
    expect(pings(calls)).toEqual([
      { path: "/start", note: "backup starting" },
      { path: "/fail", note: "backup failed at: dump" },
    ]);
    expect(uploads(calls)).toEqual([]);
    expect(result.out).not.toContain("backup ok:");
  });

  test("a dump of 4096 bytes or less fails at the size guard", () => {
    const box = home("small");
    box.knob("small");
    const result = box.run();
    expect(result.code).toBe(1);
    expect(pings(box.calls()).at(-1)).toEqual({
      path: "/fail",
      note: "backup failed at: dump size (100 bytes)",
    });
    expect(uploads(box.calls())).toEqual([]);
  });
});

/** The production Compose file's backup service, the fields these compare. */
const composeBackup = async () => {
  const compose = z
    .object({
      services: z.object({
        backup: z.object({
          image: z.string(),
          environment: z.record(z.string(), z.string()),
          entrypoint: z.array(z.string()),
          logging: z.object({ driver: z.string() }),
          read_only: z.boolean(),
          tmpfs: z.array(z.string()),
          cap_drop: z.array(z.string()),
          security_opt: z.array(z.string()),
        }),
      }),
    })
    .parse(YAML.parse(await read("docker-compose.production.yml")));
  return compose.services.backup;
};

describe("tarubot-backup's dump against Compose's backup service and the release's other files", () => {
  test("the same image, TLS mode, pg_dump options and hardening", async () => {
    const backup = await composeBackup();
    const argv = dumpCall().argv;
    const image = argv[argv.indexOf("--entrypoint") + 2] ?? "";
    const [named, digest] = image.split("@");
    expect(named).toBe(`docker.io/library/${backup.image}`);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(valuesAfter(argv, "--env")).toContain(`PGSSLMODE=${backup.environment.PGSSLMODE}`);
    // The same pg_dump options; only where the connection comes from differs.
    const options = (command: string) =>
      /exec pg_dump((?: --[a-z-]+(?:=[a-z]+)?)+)/u.exec(command)?.[1];
    expect(options(argv.at(-1) ?? "")).toBe(options(backup.entrypoint.join(" ")));
    expect(options(argv.at(-1) ?? "")).toBe(" --format=custom --no-owner --no-privileges");
    expect(backup.read_only).toBe(true);
    expect(argv).toContain("--read-only");
    expect(backup.cap_drop).toEqual(["ALL"]);
    expect(argv).toContain("--cap-drop=all");
    expect(backup.security_opt).toEqual(["no-new-privileges:true"]);
    expect(argv).toContain("--security-opt=no-new-privileges");
    // `none`, as Compose's, so Podman stores no plaintext.
    expect(backup.logging.driver).toBe("none");
    expect(argv).toContain("--log-driver=none");
    // Nothing else gets in: no mount, capability, device, network or privilege flag.
    for (const flag of [
      "-v",
      "--volume",
      "--mount",
      "--tmpfs",
      "--cap-add",
      "--device",
      "--privileged",
      "--network",
      "--env-file",
      "--user",
      "-i",
      "-t",
    ])
      expect({
        flag,
        present: argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
      }).toEqual({ flag, present: false });
    // The secrets as files instead of Compose's environment and /tmp tmpfs.
    expect(backup.tmpfs).toEqual(["/tmp:size=1m,mode=0700"]);
    expect(argv).toContain("--read-only-tmpfs=false");
    // The URL is read from its file inside the container, and pg_dump's line ends with its
    // options: no connection argument.
    expect(argv.at(-1)).toContain("u=$(cat /run/secrets/database_url)");
    expect(argv.at(-1)).toMatch(/\nexec pg_dump --format=custom --no-owner --no-privileges$/u);
  });

  test("its PostgreSQL image line is byte-equal to ops/backup.sh's", async () => {
    const line = (text: string) => /^readonly PG_IMAGE=.*$/mu.exec(text)?.[0];
    const ours = line(await read("ops/ansible/files/bot/tarubot-backup"));
    expect(ours).toBe(`readonly PG_IMAGE=${PG_IMAGE}`);
    expect(ours).toBe(line(await read("ops/backup.sh")));
  });

  test("its two secrets are the bot unit's database secrets, at the same targets", async () => {
    const unit = parseUnit(
      (
        await renderStaging(`sha256:${"0".repeat(64)}`, {
          applicationId: deployments.devbot.applicationId,
          registrationScope: deployments.devbot.registrationScope,
        })
      ).container,
      "tarubot.container",
    );
    const options = (value: string) => {
      const [name, ...rest] = value.split(",");
      const settings: Record<string, string | undefined> = Object.fromEntries(
        rest.map((option) => option.split("=", 2) as [string, string]),
      );
      return { name: name ?? "", settings };
    };
    const mounted = new Map(
      valuesOf(unit, "Container", "Secret").map((value) => {
        const secret = options(value);
        return [secret.name, secret.settings] as const;
      }),
    );
    const backup = valuesAfter(dumpCall().argv, "--secret").map(options);
    expect(backup.map((secret) => secret.name)).toEqual([
      "tarubot-database-url",
      "tarubot-database-ca-cert",
    ]);
    for (const { name, settings } of backup) {
      const bot = mounted.get(name);
      expect({ name, bot: bot !== undefined }).toEqual({ name, bot: true });
      expect(settings.type).toBe(bot?.type);
      expect(settings.target).toBe(bot?.target);
      expect(settings.mode).toBe(bot?.mode);
      // The bot reads its copies as the image's bun user; pg_dump runs as the postgres image's
      // root, Podman's default owner for a secret file.
      expect(bot?.uid).toBe("1000");
      expect(settings.uid).toBeUndefined();
    }
  });
});

/**
 * A systemd unit file's assignments as "[Section] Key=value" lines. It keeps the house rules
 * tests/fixtures/quadlet.ts parseUnit enforces (whole-line comments, no line continuations, no "#"
 * in a value, no surrounding whitespace) but lets a value hold an apostrophe: systemd reads
 * Description= literally, and these files quote nothing else.
 */
function unitLines(text: string, file: string): string[] {
  const lines: string[] = [];
  let section = "";
  text.split("\n").forEach((raw, index) => {
    const where = `${file}:${index + 1}`;
    if (raw === "" || raw.startsWith("#")) return;
    if (/^\s|\s$/u.test(raw) || raw.endsWith("\\")) throw new Error(`${where}: not a plain line`);
    const header = /^\[([A-Za-z]+)\]$/u.exec(raw);
    if (header?.[1]) {
      section = header[1];
      return;
    }
    const assignment = /^([A-Za-z]+)=([^#"]*)$/u.exec(raw);
    if (!assignment || !section) throw new Error(`${where}: not Key=value in a section`);
    if (/'/u.test(assignment[2] ?? "") && assignment[1] !== "Description")
      throw new Error(`${where}: a quote outside Description=`);
    lines.push(`[${section}] ${raw}`);
  });
  return lines;
}

describe("tarubot-backup's units (ops/ansible/files/bot/)", () => {
  const service = async () =>
    unitLines(await read("ops/ansible/files/bot/tarubot-backup.service"), "service");
  const timer = async () =>
    unitLines(await read("ops/ansible/files/bot/tarubot-backup.timer"), "timer");

  test("the service is one run of tarubot-backup, with no environment of its own", async () => {
    expect(await service()).toEqual([
      "[Unit] Description=TaruBot's daily encrypted database backup",
      "[Unit] Wants=podman-user-wait-network-online.service",
      "[Unit] After=podman-user-wait-network-online.service",
      "[Service] Type=oneshot",
      "[Service] ExecStart=%h/.local/bin/tarubot-backup",
      "[Service] TimeoutStartSec=900",
    ]);
    // The script reads Podman's secrets itself; a unit setting would put values in its environment.
    expect((await service()).some((line) => /\] Environment(File)?=/u.test(line))).toBe(false);
  });

  test("the timer starts it at 04:30 UTC every day and catches up after downtime", async () => {
    expect(await timer()).toEqual([
      "[Timer] OnCalendar=*-*-* 04:30:00 UTC",
      "[Timer] Persistent=true",
      "[Install] WantedBy=timers.target",
    ]);
    // With no Unit=, the timer starts the service of its own name.
    expect((await timer()).some((line) => line.includes("Unit="))).toBe(false);
  });
});

/**
 * The dump container's program (tarubot-backup's DUMP), run by bash in POSIX mode with a stand-in
 * pg_dump that prints its arguments and libpq's variables. The image runs it with BusyBox sh; the
 * lab ran these same URLs there, and a real dump with a percent-encoded password
 * (docs/archive/README.md). bash stands in because it also expands \xHH in printf's %b.
 */
describe("tarubot-backup's dump program", () => {
  const run = async (url: string) => {
    const dir = join(scratch, `dump-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "database_url"), url);
    writeFileSync(
      join(dir, "bin", "pg_dump"),
      `#!/bin/sh\nprintf '%s\\n' "argv=$*" "host=\${PGHOST-unset}" "port=\${PGPORT-unset}" "user=\${PGUSER-unset}" "password=\${PGPASSWORD-unset}" "database=\${PGDATABASE-unset}"\n`,
    );
    chmodSync(join(dir, "bin", "pg_dump"), 0o755);
    const program = (await dumpProgram()).replace(
      "/run/secrets/database_url",
      join(dir, "database_url"),
    );
    const result = Bun.spawnSync(["bash", "--posix", "-c", program], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, LC_ALL: "C" },
      stdin: "ignore",
    });
    return {
      code: result.exitCode,
      out: result.stdout.toString().trimEnd().split("\n"),
      err: result.stderr.toString(),
    };
  };

  test("hands every part of the URL to libpq's environment, decoded, and none to pg_dump's arguments", async () => {
    const cases: [string, string[]][] = [
      [
        "postgresql://tarubot_staging:p%40ss%2Fw%3Aord%25x@db.example.org:27520/tarubot_staging?sslmode=verify-full",
        ["db.example.org", "27520", "tarubot_staging", "p@ss/w:ord%x", "tarubot_staging"],
      ],
      [
        "postgres://tarubot_staging:plain@db.example.org/tarubot_staging",
        ["db.example.org", "unset", "tarubot_staging", "plain", "tarubot_staging"],
      ],
      [
        "postgresql://tarubot_staging:pw@[2001:db8::5]:27520/tarubot_staging",
        ["2001:db8::5", "27520", "tarubot_staging", "pw", "tarubot_staging"],
      ],
      [
        "postgresql://tarubot_staging:a\\b%41B%zz:c@db.example.org:27520/tarubot%5Fstaging#x",
        ["db.example.org", "27520", "tarubot_staging", "a\\bAB%zz:c", "tarubot_staging"],
      ],
      [
        "postgresql://tarubot_staging@db.example.org:27520/tarubot_staging",
        ["db.example.org", "27520", "tarubot_staging", "unset", "tarubot_staging"],
      ],
    ];
    for (const [url, [host, port, user, password, database]] of cases) {
      const r = await run(url);
      expect({ url, code: r.code, err: r.err, out: r.out }).toEqual({
        url,
        code: 0,
        err: "",
        out: [
          "argv=--format=custom --no-owner --no-privileges",
          `host=${host}`,
          `port=${port}`,
          `user=${user}`,
          `password=${password}`,
          `database=${database}`,
        ],
      });
    }
  });

  test("refuses anything but a postgresql:// URL, naming no value", async () => {
    const r = await run("mysql://user:secret@db.example.org/db");
    expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: [""] });
    expect(r.err).toBe("DATABASE_URL is not a postgresql:// URL.\n");
  });
});
