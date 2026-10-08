import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  deployments,
  MANAGED_DIRECT_PORTS,
  STAGING_DATABASE,
} from "../../src/config/deployment.js";
import {
  deploy,
  deployScript,
  envContents,
  events,
  hostSandbox,
  hostToolsAvailable,
  knob,
  subprocess,
  type HostSandbox,
  type HostTarget,
} from "../fixtures/host-runtime.js";

setDefaultTimeout(120_000);
const boxes: HostSandbox[] = [];
afterAll(() => {
  for (const box of boxes) rmSync(box.directory, { recursive: true, force: true });
});
const sandbox = (releases = true, target: HostTarget = "production") => {
  const box = hostSandbox(releases, target);
  boxes.push(box);
  return box;
};
const configureWeb = (box: HostSandbox, overrides: Record<string, string> = {}) => {
  const settings = {
    COMPOSE_PROFILES: "web",
    WEB_PUBLIC_ORIGIN: "https://dashboard.example.org",
    WEB_PORT: "8080",
    DISCORD_CLIENT_SECRET: "private-oauth-secret",
    ...overrides,
  };
  const file = join(box.root, ".env");
  let contents = readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(settings)) {
    contents = contents.replace(new RegExp(`^${key}=.*\\n?`, "mu"), "");
    contents += `${key}=${value}\n`;
  }
  writeFileSync(file, contents);
};

for (const request of [
  "",
  "deploy",
  "deploy staging 2.40.0 bad sha256:bad 1",
  "rollback staging 2.40.0 a b 1",
  `deploy staging 02.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1`,
  `deploy staging 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 0`,
  `deploy staging 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1\ntouch /tmp/unwanted`,
  `deploy staging 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1 extra`,
  `deploy development 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1`,
  `deploy 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1`,
]) {
  test(`refuses malformed forced commands before filesystem or tool access: ${JSON.stringify(request)}`, () => {
    const box = sandbox(false);
    const result = deploy(box, request);
    expect(result).toEqual({ code: 64, stdout: "result refused\n", stderr: "" });
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}
for (const args of [[], ["unexpected"], ["production", "staging"]]) {
  test(`refuses missing, unknown or extra owner-bound targets: ${JSON.stringify(args)}`, () => {
    const box = sandbox(false);
    expect(deploy(box, undefined, args).code).toBe(64);
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}
for (const target of ["production", "staging"] as const) {
  test(`refuses a request for the other target before accessing the ${target} host`, () => {
    const box = sandbox(false, target);
    const other = target === "staging" ? "production" : "staging";
    const request = `deploy ${other} ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`;
    expect(deploy(box, request)).toEqual({ code: 64, stdout: "result refused\n", stderr: "" });
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}

describe.skipIf(!hostToolsAvailable)("published release backup compatibility", () => {
  for (const target of ["production", "staging"] as const) {
    test(`deploys a published default-profile backup on ${target}`, () => {
      const box = sandbox(true, target);
      const origin = join(box.directory, "origin");
      // Preserve 2.36.43's published script: updating the stable backup entry cannot
      // change the backup invoked from an immutable requested release worktree.
      writeFileSync(
        join(origin, "ops/backup.sh"),
        readFileSync(
          new URL("../fixtures/host-runtime/backup-default-profile.sh", import.meta.url),
        ),
      );
      const gitExecutable = box.environment.GIT_REAL;
      if (gitExecutable === undefined) throw new Error("Missing fixture Git executable");
      const git = (...args: string[]) => {
        const result = subprocess([gitExecutable, ...args], box.environment, origin);
        if (result.code !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      git("add", "ops/backup.sh");
      git("commit", "-m", "Published default-profile backup");
      box.target.commit = git("rev-parse", "HEAD");
      const configuration = JSON.parse(readFileSync(join(box.sim, "config.json"), "utf8"));
      configuration.target = box.target;
      writeFileSync(join(box.sim, "config.json"), JSON.stringify(configuration));

      expect(deploy(box).code).toBe(0);
      expect(JSON.parse(readFileSync(join(box.state, "current"), "utf8"))).toMatchObject({
        target,
        version: box.target.version,
        commit: box.target.commit,
        digest: box.target.digest,
      });
      expect(existsSync(join(box.state, "pending"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(true);
    });
  }
});

describe.skipIf(!hostToolsAvailable)("isolated production host deployment", () => {
  test("stops, backs up offsite, migrates, registers globally and starts the exact digest", () => {
    const box = sandbox();
    const result = deploy(box);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const stdoutLines = result.stdout.split("\n");
    expect(stdoutLines.pop()).toBe("");
    expect(stdoutLines.pop()).toBe("result deployed");
    // Require each public phase once without pinning progress order.
    expect(stdoutLines.sort()).toEqual([
      "step backup",
      "step fetch",
      "step migrate",
      "step observe",
      "step preflight",
      "step pull",
      "step record",
      "step register",
      "step start",
      "step stop",
    ]);
    const actions = events(box);
    expect(actions.indexOf("stop")).toBeLessThan(actions.indexOf("backup"));
    expect(actions.indexOf("upload-database")).toBeLessThan(actions.indexOf("migrate"));
    expect(actions.indexOf("upload-settings")).toBeLessThan(actions.indexOf("migrate"));
    expect(actions.indexOf("migrate")).toBeLessThan(actions.indexOf("register"));
    expect(actions.indexOf("register")).toBeLessThan(actions.indexOf("start"));
    expect(actions).toContain("register-global");
    expect(actions).not.toContain("register-guild");
    expect(actions.indexOf("scope-live")).toBeLessThan(actions.indexOf("stop"));
    expect(actions.indexOf("scope-candidate")).toBeLessThan(actions.indexOf("stop"));
    expect(actions.lastIndexOf("observe")).toBeLessThan(actions.indexOf("restart-policy"));
    expect(
      JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].HostConfig.RestartPolicy
        .Name,
    ).toBe("unless-stopped");
    expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
    expect(statSync(join(box.root, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(box.state, "pending"))).toBe(false);
    const current = JSON.parse(readFileSync(join(box.state, "current"), "utf8"));
    expect(current).toMatchObject({
      target: "production",
      version: box.target.version,
      commit: box.target.commit,
      digest: box.target.digest,
      schema: "001_initial.sql",
    });
    expect(existsSync(join(current.worktree, "docker-compose.production.yml"))).toBe(true);
    expect(statSync(join(box.state, "current")).mode & 0o777).toBe(0o600);
    const argv = readFileSync(join(box.sim, "argv"), "utf8");
    expect(argv).not.toContain("legacy-image-override");
    expect(argv).not.toContain(" checkout ");
    for (const secret of ["private-database-password", "private-discord-token", "backup-secret"])
      expect(result.stdout + result.stderr + argv).not.toContain(secret);
  });

  for (const failure of ["fetch", "pull", "label", "digest", "config", "restart-config"]) {
    test(`${failure} failure refuses without stopping the existing writer`, () => {
      const box = sandbox();
      knob(box, failure);
      const result = deploy(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith("result refused\n");
      expect(result.stderr).toBe("");
      expect(events(box)).not.toContain("stop");
      expect(existsSync(join(box.state, "pending"))).toBe(false);
      expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
    });
  }

  test("refuses downgrades and same-version conflicting identities", () => {
    for (const version of ["2.38.9", "2.39.0"]) {
      const box = sandbox();
      const result = deploy(
        box,
        `deploy production ${version} ${box.target.commit} ${box.target.digest} 1234`,
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith("result refused\n");
      expect(events(box)).not.toContain("stop");
      expect(events(box)).not.toContain("config");
    }
  });

  test("a durable pending boundary blocks every new request", () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    writeFileSync(join(box.state, "pending"), "owner reconciliation required");
    expect(deploy(box).stdout).toEndWith("result refused\n");
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });

  test("another local writer holding the shared host lock prevents deployment", async () => {
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
      const held = await reader.read();
      expect(new TextDecoder().decode(held.value)).toBe("held\n");
      reader.releaseLock();
      expect(deploy(box).stdout).toEndWith("result refused\n");
      expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  });

  test("an uncertain stop failure leaves pending and requires owner reconciliation", () => {
    const box = sandbox();
    knob(box, "stop");
    const result = deploy(box);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toEndWith("result needs-owner\n");
    expect(existsSync(join(box.state, "pending"))).toBe(true);
    expect(existsSync(join(box.state, "current"))).toBe(false);
    expect(events(box)).not.toContain("backup");
    expect(events(box)).not.toContain("start");
  });

  for (const failure of [
    "backup",
    "age",
    "upload",
    "migrate",
    "register",
    "start",
    "probe",
    "restart",
    "inspect",
    "restart-policy",
  ]) {
    test(`${failure} failure leaves pending and never restores old code or announces success`, () => {
      const box = sandbox();
      knob(box, failure);
      const result = deploy(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith("result needs-owner\n");
      expect(result.stdout).not.toContain("result deployed");
      expect(result.stderr).toBe("");
      expect(JSON.parse(readFileSync(join(box.state, "pending"), "utf8"))).toMatchObject({
        target: "production",
        digest: box.target.digest,
        commit: box.target.commit,
      });
      expect(existsSync(join(box.state, "current"))).toBe(failure === "restart-policy");
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(false);
      const actions = events(box);
      expect(actions.filter((action) => action === "start").length).toBeLessThanOrEqual(1);
      if (["backup", "age", "upload"].includes(failure)) expect(actions).not.toContain("migrate");
      if (["migrate", "register"].includes(failure)) expect(actions).not.toContain("start");
      expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(envContents);
      expect(
        deploy(
          box,
          `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
        ).stdout,
      ).toEndWith("result refused\n");
    });
  }

  test("an exact already-live request observes but does not migrate or register again", () => {
    const box = sandbox();
    expect(deploy(box).code).toBe(0);
    writeFileSync(join(box.sim, "events"), "");
    const result = deploy(
      box,
      `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toEndWith("result already-live\n");
    const actions = events(box);
    expect(actions).not.toContain("stop");
    expect(actions).not.toContain("migrate");
    expect(actions).not.toContain("register");
    expect(actions.lastIndexOf("observe")).toBeLessThan(actions.indexOf("restart-policy"));
  });

  for (const [targetName, signal] of [
    ["production", "SIGTERM"],
    ["production", "SIGKILL"],
    ["staging", "SIGTERM"],
    ["staging", "SIGKILL"],
  ] as const) {
    test(`${targetName} ${signal} before acceptance preserves pending and cannot automatically restart the target`, async () => {
      const box = sandbox(true, targetName);
      writeFileSync(join(box.sim, "hold-observe"), "");
      // Signal only after the actual target reaches observation, not a guessed timer.
      let reachedBoundary!: () => void;
      const boundary = new Promise<void>((resolve) => {
        reachedBoundary = resolve;
      });
      const watcher = watch(box.sim, () => {
        if (existsSync(join(box.sim, "observe-held"))) reachedBoundary();
      });
      const process = Bun.spawn(["bash", deployScript, box.deploymentTarget], {
        env: {
          ...box.environment,
          SSH_ORIGINAL_COMMAND: `deploy ${targetName} ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await Promise.race([
          boundary,
          process.exited.then((code) => {
            throw new Error(`Host exited before signal boundary: ${code}`);
          }),
        ]);
        const target = JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0];
        expect(target.HostConfig.RestartPolicy.Name).toBe("no");
        expect(existsSync(join(box.state, "current"))).toBe(false);
        process.kill(signal);
        rmSync(join(box.sim, "hold-observe"));
        expect(await process.exited).not.toBe(0);
        const output = await new Response(process.stdout).text();
        if (signal === "SIGTERM") expect(output).toEndWith("result needs-owner\n");
        else expect(output).not.toContain("result deployed");
        expect(existsSync(join(box.state, "pending"))).toBe(true);
        expect(JSON.parse(readFileSync(join(box.state, "pending"), "utf8")).target).toBe(
          targetName,
        );
        const state = JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0];
        expect(state.HostConfig.RestartPolicy.Name).toBe("no");
        expect(state.State.Running).toBe(signal === "SIGKILL");
      } finally {
        watcher.close();
        rmSync(join(box.sim, "hold-observe"), { force: true });
        process.kill();
        await process.exited;
      }
    });
  }
});

function changeScope(
  box: HostSandbox,
  location: "live" | "candidate",
  settings: Record<string, string>,
) {
  if (location === "live") {
    const file = join(box.sim, "live-env.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...settings }));
  } else {
    const file = join(box.root, ".env");
    let contents = readFileSync(file, "utf8");
    for (const [key, value] of Object.entries(settings))
      contents = contents.replace(new RegExp(`^${key}=.*$`, "mu"), `${key}=${value}`);
    writeFileSync(file, contents);
  }
}

describe.skipIf(!hostToolsAvailable)("target-bound staging host transitions", () => {
  test("uses the staging manifest, scoped guild registration, isolated backup bucket and target-bound state", () => {
    const box = sandbox(true, "staging");
    const before = readFileSync(join(box.root, ".env"), "utf8");
    const result = deploy(box);
    expect(result.code).toBe(0);
    expect(result.stdout).toEndWith("result deployed\n");
    expect(result.stderr).toBe("");
    const actions = events(box);
    expect(actions).toContain("register-guild");
    expect(actions).not.toContain("register-global");
    expect(actions.indexOf("scope-live")).toBeLessThan(actions.indexOf("stop"));
    expect(actions.indexOf("scope-candidate")).toBeLessThan(actions.indexOf("stop"));
    expect(actions.indexOf("stop")).toBeLessThan(actions.indexOf("backup"));
    expect(actions.indexOf("upload-settings")).toBeLessThan(actions.indexOf("migrate"));
    expect(actions.indexOf("migrate")).toBeLessThan(actions.indexOf("register-guild"));
    expect(actions.indexOf("register-guild")).toBeLessThan(actions.indexOf("start"));
    expect(actions.lastIndexOf("observe")).toBeLessThan(actions.indexOf("restart-policy"));
    const current = JSON.parse(readFileSync(join(box.state, "current"), "utf8"));
    expect(current).toMatchObject({
      target: "staging",
      digest: box.target.digest,
      schema: "001_initial.sql",
    });
    expect(existsSync(join(box.state, "pending"))).toBe(false);
    expect(readFileSync(join(box.sim, "upload-urls"), "utf8").split("\n").filter(Boolean)).toEqual([
      "https://staging-backups.example.org/daily/tarubot-20261003T120000Z.dump.age",
      "https://staging-backups.example.org/env/tarubot-env-20261003T120000Z.age",
    ]);
    expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(before);
    expect(
      deploy(
        box,
        `deploy staging ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
      ).stdout,
    ).toEndWith("result already-live\n");
    expect(events(box).filter((action) => action === "register-guild")).toHaveLength(1);
  });

  for (const location of ["live", "candidate"] as const) {
    const endpoint = `@database.example.org:${MANAGED_DIRECT_PORTS[0]}/`;
    for (const [name, settings] of Object.entries({
      application: { DISCORD_APPLICATION_ID: deployments.production.applicationId },
      guild: { TEST_GUILD_ID: deployments.production.guilds[0] },
      "missing-guild": { TEST_GUILD_ID: "" },
      "production-database": {
        DATABASE_URL: `postgresql://${STAGING_DATABASE}:private-database-password${endpoint}tarubot`,
      },
      "production-role": {
        DATABASE_URL: `postgresql://tarubot:private-database-password${endpoint}${STAGING_DATABASE}`,
      },
      "pool-port": {
        DATABASE_URL: `postgresql://${STAGING_DATABASE}:private-database-password@database.example.org:27521/${STAGING_DATABASE}`,
      },
      "missing-ca": { DATABASE_CA_CERT: "" },
    })) {
      test(`${location} ${name} refuses before pending, stop or backup`, () => {
        const box = sandbox(true, "staging");
        changeScope(box, location, settings);
        const result = deploy(box);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toEndWith("result refused\n");
        expect(result.stderr).toBe("");
        expect(events(box)).not.toContain("stop");
        expect(events(box)).not.toContain("backup");
        expect(existsSync(join(box.state, "pending"))).toBe(false);
        expect(
          JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
        ).toBe(true);
      });
    }
  }

  test("a healthy production-profile baseline cannot admit staging", () => {
    const box = sandbox(true, "staging");
    changeScope(box, "live", {
      TARUBOT_ENVIRONMENT: "production",
      DISCORD_APPLICATION_ID: deployments.production.applicationId,
      TEST_GUILD_ID: "",
      DATABASE_URL: `postgresql://tarubot:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/tarubot`,
    });
    expect(deploy(box).stdout).toEndWith("result refused\n");
    expect(events(box)).not.toContain("stop");
    expect(existsSync(join(box.state, "pending"))).toBe(false);
  });

  for (const target of ["production", "staging"] as const) {
    test(`${target} refuses disagreement between individually valid live and candidate database endpoints`, () => {
      const box = sandbox(true, target);
      const file = join(box.root, ".env");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("database.example.org", "different.example.org"),
      );
      expect(deploy(box).stdout).toEndWith("result refused\n");
      expect(events(box)).toContain("scope-candidate");
      expect(events(box)).not.toContain("stop");
      expect(existsSync(join(box.state, "pending"))).toBe(false);
    });
    for (const recordedTarget of [undefined, target === "production" ? "staging" : "production"]) {
      test(`${target} refuses legacy or other-target current state without touching Docker`, () => {
        const box = sandbox(true, target);
        mkdirSync(box.state, { recursive: true });
        const current = JSON.stringify({ ...box.live, target: recordedTarget, worktree: box.root });
        writeFileSync(join(box.state, "current"), current);
        expect(deploy(box).stdout).toEndWith("result refused\n");
        expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
        expect(readFileSync(join(box.state, "current"), "utf8")).toBe(current);
      });
    }
  }

  for (const failure of [
    "backup",
    "upload",
    "migrate",
    "register",
    "start",
    "probe",
    "restart-policy",
  ]) {
    test(`staging ${failure} failure fences the writer and retains target-bound pending intent`, () => {
      const box = sandbox(true, "staging");
      knob(box, failure);
      const result = deploy(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith("result needs-owner\n");
      expect(JSON.parse(readFileSync(join(box.state, "pending"), "utf8"))).toMatchObject({
        target: "staging",
        digest: box.target.digest,
      });
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(false);
      expect(events(box)).not.toContain("register-global");
      expect(deploy(box).stdout).toEndWith("result refused\n");
    });
  }

  for (const location of ["live", "candidate"] as const) {
    for (const [name, settings] of Object.entries({
      application: { DISCORD_APPLICATION_ID: deployments.devbot.applicationId },
      "staging-database": {
        DATABASE_URL: `postgresql://${STAGING_DATABASE}:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/${STAGING_DATABASE}`,
      },
    })) {
      test(`production ${location} ${name} refuses without touching the existing writer`, () => {
        const box = sandbox();
        changeScope(box, location, settings);
        expect(deploy(box).stdout).toEndWith("result refused\n");
        expect(events(box)).not.toContain("stop");
        expect(events(box)).not.toContain("backup");
        expect(existsSync(join(box.state, "pending"))).toBe(false);
      });
    }
  }

  test("production live guild refuses without touching the existing writer", () => {
    const box = sandbox();
    changeScope(box, "live", { TEST_GUILD_ID: deployments.devbot.guilds[0] });
    expect(deploy(box).stdout).toEndWith("result refused\n");
    expect(events(box)).not.toContain("stop");
    expect(events(box)).not.toContain("backup");
    expect(existsSync(join(box.state, "pending"))).toBe(false);
  });
});

describe.skipIf(!hostToolsAvailable)("optional native web transitions", () => {
  test("bot-only upgrades remain compatible with candidate images that predate web modules", () => {
    const box = sandbox();
    rmSync(join(box.sim, "runtime/dist/src/web"), { recursive: true });
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(events(box)).not.toContain("proxy-start");
  });

  for (const target of ["production", "staging"] as const) {
    test(`${target} upgrades opted-in web from the release, preserving backup and proxy profiles`, () => {
      const box = sandbox(true, target);
      configureWeb(box);
      const before = readFileSync(join(box.root, ".env"), "utf8");
      // Central settings stay put, but shared includes and mounts must not use
      // a drifting owner checkout instead of the immutable requested release.
      writeFileSync(join(box.root, "docker-compose.web.yml"), "services: {}\n");
      writeFileSync(join(box.root, "ops/Caddyfile"), "invalid owner checkout\n");
      expect(deploy(box).stdout).toEndWith("result deployed\n");
      const actions = events(box);
      for (const action of ["web-candidate", "proxy-pull", "proxy-validate"])
        expect(actions.indexOf(action)).toBeLessThan(actions.indexOf("stop"));
      expect(actions.indexOf("start")).toBeLessThan(actions.indexOf("proxy-start"));
      expect(actions.indexOf("proxy-ready")).toBeLessThan(actions.indexOf("restart-policy"));
      const model = JSON.parse(readFileSync(join(box.sim, "compose.json"), "utf8"));
      expect(model.services.backup).toBeDefined();
      expect(model.services.caddy).toBeDefined();
      expect(model.services.tarubot.environment.WEB_PUBLIC_ORIGIN).toBe(
        "https://dashboard.example.org",
      );
      expect(model.services.caddy.environment.WEB_PORT).toBe("8080");
      expect(
        JSON.parse(readFileSync(join(box.sim, "proxy.json"), "utf8"))[0].HostConfig.RestartPolicy
          .Name,
      ).toBe("unless-stopped");
      expect(readFileSync(join(box.root, ".env"), "utf8")).toBe(before);
      expect(existsSync(join(box.state, "pending"))).toBe(false);
    });
  }

  for (const [name, settings] of Object.entries({
    "missing OAuth secret": { DISCORD_CLIENT_SECRET: "" },
    "invalid external-proxy origin": {
      COMPOSE_PROFILES: "",
      WEB_PUBLIC_ORIGIN: "https://dashboard.example.org/path",
    },
    "invalid external-proxy port": { COMPOSE_PROFILES: "", WEB_PORT: "65536" },
    "external-proxy health port collision": { COMPOSE_PROFILES: "", WEB_PORT: "3000" },
    "disabled backend with bundled proxy": { WEB_PUBLIC_ORIGIN: "" },
    "unsupported bundled public port": { WEB_PUBLIC_ORIGIN: "https://dashboard.example.org:8443" },
  })) {
    test(`${name} refuses before stopping the writer`, () => {
      const box = sandbox();
      configureWeb(box, settings);
      expect(deploy(box).stdout).toEndWith("result refused\n");
      expect(events(box)).toContain("web-candidate");
      expect(events(box)).not.toContain("stop");
      expect(existsSync(join(box.state, "pending"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(true);
    });
  }

  for (const failure of ["proxy-pull", "proxy-validate"]) {
    test(`${failure} refuses before the writer boundary`, () => {
      const box = sandbox();
      configureWeb(box);
      knob(box, failure);
      expect(deploy(box).stdout).toEndWith("result refused\n");
      expect(events(box)).not.toContain("stop");
      expect(existsSync(join(box.state, "pending"))).toBe(false);
    });
  }

  for (const failure of ["proxy-start", "proxy-ready", "proxy-restart-policy"]) {
    test(`${failure} preserves pending and fences the writer instead of accepting`, () => {
      const box = sandbox();
      configureWeb(box);
      knob(box, failure);
      const result = deploy(box);
      expect(result.stdout).toEndWith("result needs-owner\n");
      expect(result.stdout).not.toContain("result deployed");
      expect(existsSync(join(box.state, "pending"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(false);
      expect(events(box)).not.toContain("restart-policy");
      expect(deploy(box).stdout).toEndWith("result refused\n");
    });
  }

  test("external-proxy web is validated without starting bundled Caddy", () => {
    const box = sandbox();
    configureWeb(box, { COMPOSE_PROFILES: "" });
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(events(box)).toContain("web-candidate");
    expect(events(box)).not.toContain("proxy-pull");
    expect(events(box)).not.toContain("proxy-start");
  });

  test("a real upgrade recreates changed proxy settings and stops a disabled proxy", () => {
    const box = sandbox();
    writeFileSync(
      join(box.sim, "proxy.json"),
      JSON.stringify([{ Id: "cadd10000000", State: { Running: true } }]),
    );
    configureWeb(box, { WEB_PUBLIC_ORIGIN: "https://new-dashboard.example.org", WEB_PORT: "8081" });
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(events(box)).toContain("proxy-start");
    expect(
      JSON.parse(readFileSync(join(box.sim, "compose.json"), "utf8")).services.caddy.environment,
    ).toEqual({ WEB_PUBLIC_ORIGIN: "https://new-dashboard.example.org", WEB_PORT: "8081" });

    const disabled = sandbox();
    writeFileSync(
      join(disabled.sim, "proxy.json"),
      JSON.stringify([{ Id: "cadd10000000", State: { Running: true } }]),
    );
    expect(deploy(disabled).stdout).toEndWith("result deployed\n");
    expect(events(disabled)).toContain("proxy-stop");
    expect(events(disabled)).not.toContain("proxy-start");
    expect(
      JSON.parse(readFileSync(join(disabled.sim, "proxy.json"), "utf8"))[0].State.Running,
    ).toBe(false);
  });

  test("already-live never becomes web settings reconciliation or proxy bootstrap", () => {
    const box = sandbox();
    expect(deploy(box).code).toBe(0);
    configureWeb(box, { WEB_PUBLIC_ORIGIN: "invalid-origin", DISCORD_CLIENT_SECRET: "" });
    writeFileSync(join(box.sim, "events"), "");
    const result = deploy(
      box,
      `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
    );
    expect(result.stdout).toEndWith("result already-live\n");
    for (const action of [
      "web-candidate",
      "proxy-pull",
      "proxy-validate",
      "proxy-start",
      "proxy-stop",
      "stop",
      "start",
    ])
      expect(events(box)).not.toContain(action);
    expect(existsSync(join(box.sim, "proxy.json"))).toBe(false);
  });
});
