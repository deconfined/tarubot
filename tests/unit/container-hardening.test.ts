/**
 * Container hardening (2.30.3, issue #51). The bot runs with a read-only root filesystem, no Linux
 * capabilities and no-new-privileges in both Compose files that start it: docker-compose.yml
 * (registry deployments, and DevBot through its overlay) and docker-compose.production.yml. The
 * production backup job has the same three, plus one small tmpfs for the CA file it writes.
 * Throwaway container runs found what each process writes (docs/VERIFICATION.md): nothing at all
 * for the bot, its tools and its health check, and only /tmp/ca.crt for the backup job. These pin
 * the settings, and that no overlay file loosens them again.
 *
 * The Podman hosts run the bot as a rootless Quadlet unit (#50, ops/quadlet/), which must carry the
 * same hardening as Compose's bot service. The last tests pin that mapping, and that no target's
 * drop-in loosens it; tests/unit/quadlet.test.ts pins the rest of the unit.
 */
import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";
import {
  directoriesUnder,
  filesUnder,
  keysOf,
  parseUnit,
  QUADLET,
  root,
  single,
  unit,
  valuesOf,
} from "../fixtures/quadlet.js";

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

/** The security-relevant keys of one Compose service; everything else passes through. */
const service = z
  .object({
    read_only: z.boolean().optional(),
    cap_add: z.array(z.string()).optional(),
    cap_drop: z.array(z.string()).optional(),
    security_opt: z.array(z.string()).optional(),
    privileged: z.boolean().optional(),
    tmpfs: z.union([z.string(), z.array(z.string())]).optional(),
    user: z.string().optional(),
    volumes: z.array(z.unknown()).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
  })
  .passthrough();
const composeFile = z.object({ services: z.record(z.string(), service) }).passthrough();

/** One service from a Compose file, or a failure naming what is missing. */
async function serviceOf(path: string, name: string) {
  const found = composeFile.parse(YAML.parse(await read(path))).services[name];
  if (!found) throw new Error(`${path} has no ${name} service`);
  return found;
}

/** The three settings every hardened service carries. */
function expectHardened(settings: z.infer<typeof service>, where: string): void {
  expect(settings.read_only, where).toBe(true);
  expect(settings.cap_drop, where).toEqual(["ALL"]);
  expect(settings.security_opt, where).toEqual(["no-new-privileges:true"]);
  // Nothing hands a capability or a privileged mode back.
  expect(settings.cap_add, where).toBeUndefined();
  expect(settings.privileged, where).toBeUndefined();
}

describe("the bot container", () => {
  for (const path of ["docker-compose.yml", "docker-compose.production.yml"]) {
    test(`${path}: read-only root, no capabilities, no new privileges`, async () => {
      const bot = await serviceOf(path, "tarubot");
      expectHardened(bot, path);
      // The bot writes no file at runtime, so it has no tmpfs and no writable mount, and it keeps
      // the image's unprivileged bun user.
      expect(bot.tmpfs, path).toBeUndefined();
      expect(bot.volumes, path).toBeUndefined();
      expect(bot.user, path).toBeUndefined();
    });
  }

  test("production and the registry deployment agree on the hardening", async () => {
    // docker-compose.production.yml stands alone (the deploy runs it with no other file), so it
    // repeats the settings rather than inheriting them; they must not drift apart.
    const pick = ({ read_only, cap_drop, security_opt, tmpfs }: z.infer<typeof service>) => ({
      read_only,
      cap_drop,
      security_opt,
      tmpfs,
    });
    expect(pick(await serviceOf("docker-compose.production.yml", "tarubot"))).toEqual(
      pick(await serviceOf("docker-compose.yml", "tarubot")),
    );
  });
});

test("the backup job: read-only root with a private /tmp for the CA file only", async () => {
  const backup = await serviceOf("docker-compose.production.yml", "backup");
  expectHardened(backup, "backup");
  // The CA file pg_dump verifies the cluster with is the one thing the job writes; a 1 MiB tmpfs
  // private to the image's root user holds it, and ends with the run. Docker adds nosuid, nodev
  // and noexec to every tmpfs.
  expect(backup.tmpfs).toEqual(["/tmp:size=1m,mode=0700"]);
  expect(backup.environment?.PGSSLROOTCERT).toBe("/tmp/ca.crt");
  expect(backup.entrypoint?.join(" ")).toContain("> /tmp/ca.crt");
  expect(backup.volumes).toBeUndefined();
});

test("no overlay file loosens the hardening", async () => {
  // Compose merges an overlay into the base service: a scalar such as read_only can be switched
  // off, cap_add hands capabilities back, and the !reset and !override tags drop base values.
  // DevBot, source builds and local tools must run with exactly the base file's settings.
  const loosening = ["read_only", "cap_add", "cap_drop", "security_opt", "privileged", "tmpfs"];
  for (const path of [
    "docker-compose.devbot.yml",
    "docker-compose.build.yml",
    "docker-compose.tools.yml",
  ]) {
    const text = await read(path);
    expect(text, path).not.toMatch(/!reset|!override/u);
    for (const [name, settings] of Object.entries(composeFile.parse(YAML.parse(text)).services)) {
      for (const key of loosening) expect(settings, `${path} ${name}`).not.toHaveProperty(key);
      expect(settings.user, `${path} ${name}`).toBeUndefined();
      // A mount added to the bot is read-only (the source build's test plans).
      if (name === "tarubot")
        for (const volume of settings.volumes ?? [])
          expect(String(volume), `${path} ${name}`).toEndWith(":ro");
    }
  }
});

describe("the Quadlet unit (#50)", () => {
  test("carries the bot's Compose hardening, one setting for each", async () => {
    const compose = await serviceOf("docker-compose.production.yml", "tarubot");
    const bot = await unit();
    // read_only: true. ReadOnlyTmpfs= defaults to true, which mounts writable tmpfs on /dev,
    // /dev/shm, /run, /tmp and /var/tmp; Compose's bot has no tmpfs, so it is false, and no Tmpfs=
    // or VolatileTmp= adds one back.
    expect(compose.read_only).toBe(true);
    expect(compose.tmpfs).toBeUndefined();
    expect(single(bot, "Container", "ReadOnly")).toBe("true");
    expect(single(bot, "Container", "ReadOnlyTmpfs")).toBe("false");
    // cap_drop: [ALL], and nothing handed back.
    expect(compose.cap_drop).toEqual(["ALL"]);
    expect(valuesOf(bot, "Container", "DropCapability")).toEqual(["all"]);
    // no-new-privileges:true.
    expect(compose.security_opt).toEqual(["no-new-privileges:true"]);
    expect(single(bot, "Container", "NoNewPrivileges")).toBe("true");
    // No writable mount and the image's own unprivileged bun user, as under Compose; Podman's
    // environment and proxy settings stay out of the container too.
    expect(compose.volumes).toBeUndefined();
    expect(compose.user).toBeUndefined();
    const loosening = [
      "AddCapability",
      "Tmpfs",
      "VolatileTmp",
      "Volume",
      "Mount",
      "User",
      "Group",
      "UserNS",
      "PodmanArgs",
      "GlobalArgs",
      "SecurityLabelDisable",
      "SecurityLabelType",
      "Unmask",
    ];
    expect(keysOf(bot, "Container").filter((key) => loosening.includes(key))).toEqual([]);
    expect(single(bot, "Container", "EnvironmentHost")).toBe("false");
    expect(single(bot, "Container", "HttpProxy")).toBe("false");
  });

  test("no target's drop-in loosens the hardening", async () => {
    // Quadlet merges every tarubot.container.d/*.conf it finds in a linked directory into the unit,
    // so a drop-in could switch ReadOnly off or hand a capability back, as a Compose overlay could.
    // Drop-ins live only in the target directories; none sits under units/, which every host links.
    const dropIns = filesUnder(QUADLET).filter((path) => /\.d\/[^/]+$/u.test(path));
    expect(dropIns.length).toBeGreaterThan(0);
    expect(directoriesUnder(QUADLET).filter((path) => path.startsWith("units/"))).toEqual([]);
    const hardening =
      /^(ReadOnly|ReadOnlyTmpfs|DropCapability|AddCapability|NoNewPrivileges|Tmpfs|VolatileTmp|Volume|Mount|User|Group|UserNS|PodmanArgs|GlobalArgs|SecurityLabel\w*|Unmask|EnvironmentHost|HttpProxy|Image|Pull)$/u;
    for (const path of dropIns) {
      expect(path).not.toStartWith("units/");
      const lines = parseUnit(await Bun.file(root(`${QUADLET}/${path}`)).text(), path);
      for (const line of lines)
        expect({ path, key: line.key, loosens: hardening.test(line.key) }).toEqual({
          path,
          key: line.key,
          loosens: false,
        });
    }
  });
});
