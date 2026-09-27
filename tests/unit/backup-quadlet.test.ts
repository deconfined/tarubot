/**
 * ops/backup.sh on a Quadlet host (#50, 2.33.0) and the release's systemd user units that run it
 * every night (ops/systemd/). The real script runs in a sandbox: a clone-shaped directory with a
 * dummy .env, and stand-ins (tests/fixtures/backup-stubs/) for podman, docker, age, curl, id, date
 * and ops/quadlet/secrets.sh first on PATH, each recording its arguments and environment. These
 * pin what keeps the dump safe on Podman:
 * - the argument picks the runtime, and anything else stops before a setting is read;
 * - only the two database secrets are synced, and the one `podman run` is as hardened as Compose's
 *   backup service, reads both secrets as files and gets nothing on stdin;
 * - no setting's value reaches an argument or an environment variable of any tool;
 * - the last line is the one ops/deploy.sh's BACKUP_DONE reads, and failures ping /fail by step.
 * The no-argument Compose path keeps its own tests in backup-job.test.ts. The byte-exact stream
 * through `--log-driver=none` was checked on a local Podman 5.8.2 with a real PostgreSQL 18.4 dump
 * (the release's verification record, docs/VERIFICATION.md).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import { filesUnder, parseUnit, read, root, valuesOf } from "../fixtures/quadlet.js";

const STUBS = root("tests/fixtures/backup-stubs");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backup-quadlet-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The stand-ins' clock: 2026-09-29T04:30:00Z, not the 1st, so there is no monthly upload. */
const NOW = Date.UTC(2026, 8, 29, 4, 30, 0) / 1000;
const STAMP = "20260929T043000Z";
/** Every secret-bearing value in the sandbox's .env carries this mark. */
const MARK = "backupmark7c1e";
/** A user id whose /run/user directory doesn't exist. */
const NO_RUNTIME_UID = "4294967294";
const USAGE = "usage: backup.sh [quadlet]\n";

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
 * The dump's image on a Quadlet host: Compose's name and tag, fully qualified, and pinned by the
 * image index digest, since the container reads the database secrets and can reach the network.
 */
const PG_IMAGE =
  "docker.io/library/postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";

/** The Quadlet path's one `podman run`, exactly (ops/backup.sh; interfaces §12). */
const dumpArgv = (stamp: string) => [
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
  'exec pg_dump --format=custom --no-owner --no-privileges "$(cat /run/secrets/database_url)"',
];

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

/**
 * A sandbox shaped like a host's clone (~/tarubot): the real ops/backup.sh copied in (a copy, not a
 * link, since the script finds its clone from its own resolved path), the release's age
 * recipients, the secrets.sh stand-in linked in as ops/quadlet/secrets.sh, and the given .env (none
 * when null). Its own HOME, TMPDIR and private runtime directory keep the run inside it.
 */
function sandbox(name: string, env: string | null = ENV) {
  const base = join(scratch, name);
  const clone = join(base, "tarubot");
  const sim = join(base, "sim");
  const runtime = join(base, "runtime");
  for (const directory of [
    join(clone, "ops/quadlet"),
    join(sim, "calls"),
    join(sim, "knob"),
    join(base, "home"),
    join(base, "tmp"),
  ])
    mkdirSync(directory, { recursive: true });
  mkdirSync(runtime, { mode: 0o700 });
  copyFileSync(root("ops/backup.sh"), join(clone, "ops/backup.sh"));
  chmodSync(join(clone, "ops/backup.sh"), 0o755);
  copyFileSync(root("ops/age-recipients.txt"), join(clone, "ops/age-recipients.txt"));
  symlinkSync(join(STUBS, "secrets.sh"), join(clone, "ops/quadlet/secrets.sh"));
  if (env !== null) writeFileSync(join(clone, ".env"), env, { mode: 0o600 });

  /** Make a stand-in fail: podman (the dump) or secrets (the sync). */
  const knob = (which: "podman" | "secrets") => writeFileSync(join(sim, "knob", which), "");

  /**
   * Run the script as the timer does, with only the sandbox's variables; `undefined` leaves one
   * out. stdin holds data, so a stand-in that reads it shows whether the script closed it.
   */
  const run = (args: string[], extra: Record<string, string | undefined> = {}) => {
    const variables: Record<string, string | undefined> = {
      PATH: `${STUBS}:/usr/bin:/bin`,
      HOME: join(base, "home"),
      TMPDIR: join(base, "tmp"),
      LC_ALL: "C",
      BACKUP_SIM: sim,
      BACKUP_SIM_NOW: String(NOW),
      XDG_RUNTIME_DIR: runtime,
      ...extra,
    };
    const result = Bun.spawnSync([join(clone, "ops/backup.sh"), ...args], {
      env: Object.fromEntries(
        Object.entries(variables).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdin: new TextEncoder().encode("stdin that must not reach the dump\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };

  /** Every recorded call, in the order the calls started. */
  const calls = (): Call[] =>
    readdirSync(join(sim, "calls"))
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

  return { clone, runtime, knob, run, calls };
}

/** The calls of one tool. */
const of = (calls: Call[], tool: string) => calls.filter((call) => call.tool === tool);
/** What each healthchecks.io ping said: the path after the check's URL, and the note. */
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
/** The last line of the script's output. */
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1) ?? "";

/** ops/deploy.sh's pattern for the line that names the uploaded dump (either runtime). */
const backupDone = () => {
  const match = /^readonly BACKUP_DONE='([^']+)'$/mu.exec(
    readFileSync(root("ops/deploy.sh"), "utf8"),
  );
  if (!match?.[1]) throw new Error("ops/deploy.sh has no BACKUP_DONE line");
  return new RegExp(match[1], "u");
};

/** One successful Quadlet run, shared by the tests that read its calls. */
let quadlet: ReturnType<typeof runQuadlet> | undefined;
function runQuadlet() {
  const box = sandbox("quadlet");
  return { box, result: box.run(["quadlet"]), calls: box.calls() };
}
const quadletRun = () => {
  quadlet ??= runQuadlet();
  return quadlet;
};
/** The shared run's one podman call; fails when there isn't exactly one. */
const dumpCall = () => {
  const [call, ...more] = of(quadletRun().calls, "podman");
  if (!call || more.length > 0) throw new Error("expected exactly one podman call");
  return call;
};
/** The value after each occurrence of a flag in an argument list. */
const valuesAfter = (argv: string[], flag: string) =>
  argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));

describe("ops/backup.sh picks its runtime from its argument", () => {
  test("with no argument it runs today's Compose dump, and never Podman or secrets.sh", () => {
    const box = sandbox("compose");
    // The Compose path never needs a runtime directory, even when the user has none.
    const result = box.run([], { XDG_RUNTIME_DIR: undefined, BACKUP_SIM_UID: NO_RUNTIME_UID });
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
    expect(calls.filter((call) => call.tool === "podman" || call.tool === "secrets.sh")).toEqual(
      [],
    );
    expect(uploads(calls)).toEqual([
      `daily/tarubot-${STAMP}.dump.age`,
      `env/tarubot-env-${STAMP}.age`,
    ]);
    expect(lastLine(result.out)).toMatch(backupDone());
  });

  test("`quadlet` syncs the two database secrets, then runs one hardened pg_dump container", () => {
    const { box, result, calls } = quadletRun();
    expect(result).toMatchObject({ code: 0, err: "" });
    // Only DATABASE_URL and DATABASE_CA_CERT: a blank Discord token never stops a backup.
    expect(of(calls, "secrets.sh").map((call) => call.argv)).toEqual([
      ["sync", join(box.clone, ".env"), "DATABASE_URL", "DATABASE_CA_CERT"],
    ]);
    const dump = dumpCall();
    expect(dump.argv).toEqual(dumpArgv(STAMP));
    // deploy.sh's backup wait finds the run by this label.
    expect(valuesAfter(dump.argv, "--label")).toEqual(["io.tarubot.role=backup"]);
    // The secret mounts are read-only only because the container is.
    expect(dump.argv).toContain("--read-only");
    // stdin is closed: nothing of the script's input reaches the container.
    expect(dump.stdin).toBe("eof");
    // The ping, then the secrets, then the dump, never Docker.
    const order = calls.map((call) => call.tool);
    expect(order[0]).toBe("curl");
    expect(order.indexOf("secrets.sh")).toBeLessThan(order.indexOf("podman"));
    expect(of(calls, "docker")).toEqual([]);
    expect(pings(calls)).toEqual([
      { path: "/start", note: "backup starting" },
      {
        path: "",
        note: expect.stringMatching(
          new RegExp(`^daily/tarubot-${STAMP}\\.dump\\.age: 8192 bytes; env/`, "u"),
        ),
      },
    ]);
    expect(uploads(calls)).toEqual([
      `daily/tarubot-${STAMP}.dump.age`,
      `env/tarubot-env-${STAMP}.age`,
    ]);
    // The last line is the one deploy.sh reads, naming the object it uploaded to daily/.
    const line = lastLine(result.out);
    expect(line).toMatch(
      new RegExp(`^\\S+ backup ok: tarubot-${STAMP} \\(8192 bytes, settings \\d+ bytes\\)$`, "u"),
    );
    expect(backupDone().exec(line)?.[1]).toBe(STAMP);
  });

  test("no setting's value reaches an argument or an environment variable of any tool", () => {
    const compose = sandbox("compose-values");
    expect(compose.run([]).code).toBe(0);
    for (const calls of [quadletRun().calls, compose.calls()]) {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const seen = [...call.argv, ...[...call.env].map(([name, value]) => `${name}=${value}`)];
        expect({ tool: call.tool, leaked: seen.filter((item) => item.includes(MARK)) }).toEqual({
          tool: call.tool,
          leaked: [],
        });
      }
      // The control: the credentials and the ping URL are read, and reach curl on stdin only.
      const configs = of(calls, "curl").map((call) => call.stdin ?? "");
      expect(configs.some((config) => config.includes(`${MARK}-access:${MARK}-secret`))).toBe(true);
      expect(configs.some((config) => config.includes(`${MARK}-ping`))).toBe(true);
    }
  });

  test("the tools see the runtime directory the caller set", () => {
    // The user manager sets it for the timer, and deploy.sh's worker exports it.
    const { box } = quadletRun();
    expect(dumpCall().env.get("XDG_RUNTIME_DIR")).toBe(box.runtime);
  });

  test("any other argument exits 64 before it reads a setting or sends anything", () => {
    const cases = [["compose"], ["podman"], ["quadlet", "staging"], ["quadlet", "quadlet"], [""]];
    cases.forEach((args, index) => {
      // No .env at all: reading a setting would put sed's complaint on stderr.
      const box = sandbox(`usage-${index}`, null);
      expect({ args, ...box.run(args) }).toEqual({ args, code: 64, out: "", err: USAGE });
      expect(box.calls()).toEqual([]);
    });
  });
});

describe("ops/backup.sh quadlet's failures", () => {
  test("without XDG_RUNTIME_DIR a missing /run/user directory fails at settings", () => {
    expect(existsSync(`/run/user/${NO_RUNTIME_UID}`)).toBe(false);
    const box = sandbox("no-runtime");
    const result = box.run(["quadlet"], {
      XDG_RUNTIME_DIR: undefined,
      BACKUP_SIM_UID: NO_RUNTIME_UID,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`XDG_RUNTIME_DIR is not set, and /run/user/${NO_RUNTIME_UID}`);
    expect(result.err).toContain("backup failed at: settings");
    const calls = box.calls();
    // Nothing started: no /start ping, no secrets, no dump.
    expect(pings(calls)).toEqual([{ path: "/fail", note: "backup failed at: settings" }]);
    expect(calls.map((call) => call.tool)).toEqual(["curl"]);
  });

  test("without XDG_RUNTIME_DIR the user's own private /run/user directory is used, and only that", () => {
    // The machine's real directory decides which way this goes: it passes only when it is this
    // user's own, mode 700, and then the dump gets it.
    const uid = process.getuid?.() ?? -1;
    const directory = `/run/user/${uid}`;
    let usable = false;
    try {
      const status = lstatSync(directory);
      usable = status.isDirectory() && status.uid === uid && (status.mode & 0o777) === 0o700;
    } catch {
      usable = false;
    }
    const box = sandbox("own-runtime");
    const result = box.run(["quadlet"], { XDG_RUNTIME_DIR: undefined });
    if (usable) {
      expect(result.code).toBe(0);
      expect(of(box.calls(), "podman")[0]?.env.get("XDG_RUNTIME_DIR")).toBe(directory);
    } else {
      expect(result.code).toBe(1);
      expect(result.err).toContain("backup failed at: settings");
      expect(of(box.calls(), "podman")).toEqual([]);
    }
  });

  test("a failed secrets sync stops before the dump and pings /fail naming secrets", () => {
    const box = sandbox("secrets-fail");
    box.knob("secrets");
    const result = box.run(["quadlet"]);
    expect(result.code).toBe(1);
    // secrets.sh names the setting, never its value.
    expect(result.err).toContain("secrets: DATABASE_URL is required and empty");
    expect(result.err).toContain("backup failed at: secrets");
    const calls = box.calls();
    expect(pings(calls)).toEqual([
      { path: "/start", note: "backup starting" },
      { path: "/fail", note: "backup failed at: secrets" },
    ]);
    expect(of(calls, "podman")).toEqual([]);
    expect(uploads(calls)).toEqual([]);
  });

  test("a failed pg_dump fails the run at dump, although age finished", () => {
    const box = sandbox("dump-fail");
    box.knob("podman");
    const result = box.run(["quadlet"]);
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

describe("the Quadlet dump against Compose's backup service", () => {
  test("the same image, TLS mode, pg_dump options and hardening", async () => {
    const backup = await composeBackup();
    const argv = dumpCall().argv;
    // Compose's short name, fully qualified the way Docker resolves it, and pinned by digest on
    // the Quadlet side only (Compose's own tag-only reference is a follow-up for the Compose-path
    // cleanup, docs/OPEN_ITEMS.md).
    expect(valuesAfter(argv, "--entrypoint")).toEqual(["sh"]);
    const image = argv[argv.indexOf("--entrypoint") + 2] ?? "";
    const [named, digest] = image.split("@");
    expect(named).toBe(`docker.io/library/${backup.image}`);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(backup.image).not.toContain("@");
    expect(valuesAfter(argv, "--env")).toContain(`PGSSLMODE=${backup.environment.PGSSLMODE}`);
    // The same pg_dump call; only where the URL comes from differs.
    const options = (command: string) => /pg_dump( --[^"]+) "/u.exec(command)?.[1];
    expect(options(argv.at(-1) ?? "")).toBe(options(backup.entrypoint.join(" ")));
    expect(options(argv.at(-1) ?? "")).toBe(" --format=custom --no-owner --no-privileges");
    // read_only, cap_drop: [ALL] and no-new-privileges, as Podman spells them.
    expect(backup.read_only).toBe(true);
    expect(argv).toContain("--read-only");
    expect(backup.cap_drop).toEqual(["ALL"]);
    expect(argv).toContain("--cap-drop=all");
    expect(backup.security_opt).toEqual(["no-new-privileges:true"]);
    expect(argv).toContain("--security-opt=no-new-privileges");
    // The log driver the verification kept: `none`, as Compose's, so Podman stores no plaintext.
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
      }).toEqual({
        flag,
        present: false,
      });
  });

  test("the documented differences: secrets as files, the CA from its mount, no tmpfs", async () => {
    const backup = await composeBackup();
    const argv = dumpCall().argv;
    // Compose passes the URL and CA in the environment and writes the CA to a private /tmp tmpfs.
    expect(Object.keys(backup.environment).sort()).toEqual([
      "DATABASE_CA_CERT",
      "DATABASE_URL",
      "PGSSLMODE",
      "PGSSLROOTCERT",
    ]);
    expect(backup.environment.PGSSLROOTCERT).toBe("/tmp/ca.crt");
    expect(backup.tmpfs).toEqual(["/tmp:size=1m,mode=0700"]);
    // Podman mounts both as secret files instead, so the job writes no file and needs no tmpfs.
    expect(valuesAfter(argv, "--env")).toEqual([
      "PGSSLMODE=verify-full",
      "PGSSLROOTCERT=/run/secrets/database_ca_cert",
    ]);
    expect(valuesAfter(argv, "--secret").map((value) => value.split(",")[0])).toEqual([
      "tarubot-database-url",
      "tarubot-database-ca-cert",
    ]);
    expect(argv).toContain("--read-only-tmpfs=false");
    expect(argv.at(-1)).toContain('"$(cat /run/secrets/database_url)"');
  });
});

/** A `--secret` or `Secret=` value's options, by name, after the secret's own name. */
const secretOptions = (value: string) => {
  const [name, ...options] = value.split(",");
  const settings: Record<string, string | undefined> = Object.fromEntries(
    options.map((option) => option.split("=", 2) as [string, string]),
  );
  return { name: name ?? "", options: settings };
};

describe("the Quadlet dump against the release's other files", () => {
  test("its two secrets are the bot unit's database secrets, at the same targets", async () => {
    const unit = parseUnit(
      await read("ops/quadlet/units/tarubot.container"),
      "units/tarubot.container",
    );
    const mounted = new Map(
      valuesOf(unit, "Container", "Secret").map((value) => {
        const secret = secretOptions(value);
        return [secret.name, secret.options] as const;
      }),
    );
    const backup = valuesAfter(dumpCall().argv, "--secret").map(secretOptions);
    expect(backup).toHaveLength(2);
    for (const { name, options } of backup) {
      const bot = mounted.get(name);
      expect({ name, bot: bot !== undefined }).toEqual({ name, bot: true });
      expect(options.type).toBe("mount");
      expect(options.type).toBe(bot?.type);
      expect(options.target).toBe(bot?.target);
      expect(options.mode).toBe(bot?.mode);
      // The bot reads its copies as the image's bun user; pg_dump runs as the postgres image's
      // root, Podman's default owner for a secret file.
      expect(bot?.uid).toBe("1000");
      expect(options.uid).toBeUndefined();
      expect(options.gid).toBeUndefined();
    }
  });

  test("each synced setting is the secret the dump mounts, by secrets.sh's naming rule", () => {
    // tarubot- and the setting's name in lower case with dashes (ops/quadlet/secrets.sh).
    const synced = of(quadletRun().calls, "secrets.sh")[0]?.argv.slice(2) ?? [];
    expect(synced.map((name) => `tarubot-${name.toLowerCase().replaceAll("_", "-")}`)).toEqual(
      valuesAfter(dumpCall().argv, "--secret").map((value) => secretOptions(value).name),
    );
    const script = readFileSync(root("ops/quadlet/secrets.sh"), "utf8");
    expect(script).toContain("tarubot-database-ca-cert");
  });

  test("ops/deploy.sh calls it as `quadlet` within the service's time limit, and waits on its unit", () => {
    const deploy = readFileSync(root("ops/deploy.sh"), "utf8");
    expect(deploy).toMatch(/timeout 900 "\$ROOT\/ops\/backup\.sh" quadlet /u);
    expect(deploy).toContain("--filter label=io.tarubot.role=backup");
    expect(deploy).toContain("systemctl --user is-active tarubot-backup.service");
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

describe("the release's backup units (ops/systemd/)", () => {
  const service = () =>
    unitLines(readFileSync(root("ops/systemd/tarubot-backup.service"), "utf8"), "service");
  const timer = () =>
    unitLines(readFileSync(root("ops/systemd/tarubot-backup.timer"), "utf8"), "timer");

  test("the directory holds exactly the service and its timer", () => {
    expect(filesUnder("ops/systemd")).toEqual(["tarubot-backup.service", "tarubot-backup.timer"]);
  });

  test("the service is one run of `backup.sh quadlet`, with no environment of its own", () => {
    expect(service()).toEqual([
      "[Unit] Description=TaruBot's daily encrypted database backup",
      "[Unit] Wants=podman-user-wait-network-online.service",
      "[Unit] After=podman-user-wait-network-online.service",
      "[Service] Type=oneshot",
      "[Service] ExecStart=%h/tarubot/ops/backup.sh quadlet",
      "[Service] TimeoutStartSec=900",
    ]);
    // The script reads .env itself; a unit setting would put the values in Podman's environment.
    expect(service().some((line) => /\] Environment(File)?=/u.test(line))).toBe(false);
    // The timer starts it; it has no [Install] of its own.
    expect(service().some((line) => line.startsWith("[Install]"))).toBe(false);
    // ExecStart runs the script straight from the clone, so it must stay executable.
    expect(statSync(root("ops/backup.sh")).mode & 0o111).toBe(0o111);
  });

  test("the timer starts it at 04:30 UTC every day and catches up after downtime", () => {
    expect(timer()).toEqual([
      "[Timer] OnCalendar=*-*-* 04:30:00 UTC",
      "[Timer] Persistent=true",
      "[Install] WantedBy=timers.target",
    ]);
    // With no Unit=, the timer starts the service of its own name.
    expect(timer().some((line) => line.includes("Unit="))).toBe(false);
  });

  test("the files name no host or address", () => {
    for (const file of ["tarubot-backup.service", "tarubot-backup.timer"]) {
      const text = readFileSync(root(`ops/systemd/${file}`), "utf8");
      // A dotted name is a unit, a file or a release; anything else (a domain) would be a host.
      const dotted = [...text.matchAll(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu)].map((m) => m[0]);
      const known = /\.(service|timer|target|sh|ts|md)$|^\d+\.\d+\.\d+$/u;
      expect({ file, hosts: dotted.filter((name) => !known.test(name)) }).toEqual({
        file,
        hosts: [],
      });
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
      expect(text).not.toMatch(/[0-9a-f]*::[0-9a-f]|(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{1,4}/iu);
    }
  });
});
