import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
import type { ObserveScenario } from "../fixtures/host-runtime/observe-scenario.js";

setDefaultTimeout(120_000);
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** The entry's first public line after `step preflight`: its own identity (2026-10-10). */
const entryLine = `reason entry sha256=${sha256(readFileSync(deployScript))}`;
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

/**
 * Commit `change` to the sandbox's origin on top of the target release and make that commit the
 * requested one, as a published release whose files differ would be.
 */
const retarget = (box: HostSandbox, change: (origin: string) => void, message: string) => {
  const origin = join(box.directory, "origin");
  const gitExecutable = box.environment.GIT_REAL;
  if (gitExecutable === undefined) throw new Error("Missing fixture Git executable");
  const git = (...args: string[]) => {
    const result = subprocess([gitExecutable, ...args], box.environment, origin);
    if (result.code !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  change(origin);
  git("add", "--all");
  git("commit", "-m", message);
  box.target.commit = git("rev-parse", "HEAD");
  const configuration = JSON.parse(readFileSync(join(box.sim, "config.json"), "utf8"));
  configuration.target = box.target;
  writeFileSync(join(box.sim, "config.json"), JSON.stringify(configuration));
};

/** The permission bits of `path` in the requested release's worktree. */
const releaseMode = (box: HostSandbox, path: string) =>
  statSync(join(box.state, "releases", `1234-${box.target.commit}`, path)).mode & 0o777;

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
    expect(result).toEqual({
      code: 64,
      stdout: "reason refused step=request code=request-form\nresult refused\n",
      stderr: "",
    });
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}
for (const args of [[], ["unexpected"], ["production", "staging"]]) {
  test(`refuses missing, unknown or extra owner-bound targets: ${JSON.stringify(args)}`, () => {
    const box = sandbox(false);
    expect(deploy(box, undefined, args)).toEqual({
      code: 64,
      stdout: "reason refused step=request code=entry-target\nresult refused\n",
      stderr: "",
    });
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}
for (const target of ["production", "staging"] as const) {
  test(`refuses a request for the other target before accessing the ${target} host`, () => {
    const box = sandbox(false, target);
    const other = target === "staging" ? "production" : "staging";
    const request = `deploy ${other} ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`;
    expect(deploy(box, request)).toEqual({
      code: 64,
      stdout: "reason refused step=request code=target-mismatch\nresult refused\n",
      stderr: "",
    });
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
    // Require each public phase once without pinning progress order, and the entry's identity.
    expect(stdoutLines.sort()).toEqual([
      entryLine,
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
    for (const [version, code] of [
      ["2.38.9", "downgrade"],
      ["2.39.0", "same-version-mismatch"],
    ]) {
      const box = sandbox();
      const result = deploy(
        box,
        `deploy production ${version} ${box.target.commit} ${box.target.digest} 1234`,
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith(
        `reason refused step=preflight code=${code}\nresult refused\n`,
      );
      expect(events(box)).not.toContain("stop");
      expect(events(box)).not.toContain("config");
    }
  });

  test("a durable pending boundary blocks every new request", () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    writeFileSync(join(box.state, "pending"), "owner reconciliation required");
    expect(deploy(box).stdout).toEndWith(
      "reason refused step=preflight code=pending-present\nresult refused\n",
    );
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
      expect(deploy(box).stdout).toEndWith(
        "reason refused step=preflight code=lock-held\nresult refused\n",
      );
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
      expect(deploy(box).stdout).toEndWith(
        "reason refused step=pull code=scope-mismatch\nresult refused\n",
      );
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
        expect(deploy(box).stdout).toEndWith(
          "reason refused step=preflight code=current-target\nresult refused\n",
        );
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

  test.skipIf(!process.env.CADDY_FIXTURE_IMAGE)(
    "validates Caddy from a private managed worktree without read-override capabilities",
    () => {
      const docker = Bun.which("docker");
      if (!docker) throw new Error("CADDY_FIXTURE_IMAGE requires Docker");
      const box = sandbox();
      configureWeb(box);
      box.environment.CADDY_NATIVE_DOCKER = docker;
      box.environment.CADDY_NATIVE_PROJECT = `tarubot-private-caddy-${crypto.randomUUID()}`;
      box.environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
      for (const name of [
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ]) {
        const value = process.env[name];
        if (value) box.environment[name] = value;
      }
      writeFileSync(
        join(box.sim, "native-caddy.yml"),
        `services:\n  caddy:\n    image: ${JSON.stringify(process.env.CADDY_FIXTURE_IMAGE)}\n`,
      );
      const worktree = join(box.state, "releases", `1234-${box.target.commit}`);
      try {
        expect(deploy(box).stdout).toEndWith("result deployed\n");
        expect(JSON.parse(readFileSync(join(box.state, "current"), "utf8")).version).toBe(
          box.target.version,
        );
        expect(statSync(join(box.root, ".env")).mode & 0o777).toBe(0o600);
        // Caddy, without DAC_OVERRIDE, reads the offline page from the private worktree (2.41.0).
        const read = subprocess(
          [
            docker,
            "compose",
            "--project-name",
            box.environment.CADDY_NATIVE_PROJECT,
            "--project-directory",
            worktree,
            "--env-file",
            join(box.root, ".env"),
            "-f",
            join(worktree, "docker-compose.production.yml"),
            "-f",
            join(box.sim, "native-caddy.yml"),
            "run",
            "--rm",
            "--no-deps",
            "--pull",
            "never",
            "-T",
            "caddy",
            "cat",
            "/srv/offline/index.html",
            "/srv/offline/assets/offline.css",
          ],
          { ...box.environment, TARUBOT_IMAGE_DIGEST: box.target.digest },
        );
        expect(read.stderr).not.toContain("Permission denied");
        expect(read.code).toBe(0);
        expect(read.stdout).toContain("TaruBot is offline right now");
      } finally {
        if (existsSync(worktree)) {
          const cleanup = subprocess(
            [
              docker,
              "compose",
              "--project-name",
              box.environment.CADDY_NATIVE_PROJECT,
              "--project-directory",
              worktree,
              "--env-file",
              join(box.root, ".env"),
              "-f",
              join(worktree, "docker-compose.production.yml"),
              "-f",
              join(box.sim, "native-caddy.yml"),
              "down",
              "--volumes",
              "--remove-orphans",
            ],
            { ...box.environment, TARUBOT_IMAGE_DIGEST: box.target.digest },
          );
          expect(cleanup.code).toBe(0);
        }
      }
    },
  );

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

  test("a web upgrade makes the release's offline page readable to Caddy, and nothing more", () => {
    const box = sandbox();
    configureWeb(box);
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(releaseMode(box, "ops/Caddyfile")).toBe(0o644);
    for (const directory of ["ops/offline", "ops/offline/assets"])
      expect({ directory, mode: releaseMode(box, directory) }).toEqual({ directory, mode: 0o755 });
    const files = [
      "ops/offline/index.html",
      ...readdirSync(
        join(box.state, "releases", `1234-${box.target.commit}`, "ops/offline/assets"),
      ).map((name) => `ops/offline/assets/${name}`),
    ];
    expect(files).toHaveLength(11);
    for (const file of files)
      expect({ file, mode: releaseMode(box, file) }).toEqual({ file, mode: 0o644 });
    // Everything else in the release stays as umask 077 left it.
    for (const file of ["package.json", "docker-compose.web.yml", "ops/age-recipients.txt"])
      expect({ file, mode: releaseMode(box, file) }).toEqual({ file, mode: 0o600 });
    expect(releaseMode(box, "ops")).toBe(0o700);
  });

  test("a bot-only upgrade leaves the offline page private, like the Caddyfile", () => {
    const box = sandbox();
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(releaseMode(box, "ops/Caddyfile")).toBe(0o600);
    expect(releaseMode(box, "ops/offline")).toBe(0o700);
    expect(releaseMode(box, "ops/offline/index.html")).toBe(0o600);
  });

  test("a web upgrade to a release without the offline page deploys unchanged", () => {
    const box = sandbox();
    configureWeb(box);
    retarget(
      box,
      (origin) => rmSync(join(origin, "ops/offline"), { recursive: true }),
      "A release before the offline page",
    );
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    expect(
      existsSync(join(box.state, "releases", `1234-${box.target.commit}`, "ops/offline")),
    ).toBe(false);
    expect(releaseMode(box, "ops/Caddyfile")).toBe(0o644);
  });

  test("a symlinked offline page is never followed: what it points at keeps its permissions", () => {
    const box = sandbox();
    configureWeb(box);
    const outside = join(box.directory, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "private.txt"), "private\n", { mode: 0o600 });
    chmodSync(outside, 0o700);
    retarget(
      box,
      (origin) => {
        rmSync(join(origin, "ops/offline"), { recursive: true });
        symlinkSync(outside, join(origin, "ops/offline"));
      },
      "An offline page that is a symlink",
    );
    expect(deploy(box).stdout).toEndWith("result deployed\n");
    const link = join(box.state, "releases", `1234-${box.target.commit}`, "ops/offline");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o700);
    expect(statSync(join(outside, "private.txt")).mode & 0o777).toBe(0o600);
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

/*
 * Public failure reasons (2026-10-10): the owner asked that a failed delivery say why. Each
 * scenario below fails one check for real and pins the `reason` lines the entry sends, in order,
 * then scans everything public for the sandbox's private settings and for secret-shaped values
 * planted in the bot's log, its probe errors and a migration's crash output.
 */
const REASON_FORM =
  /^reason [a-z][a-z-]{0,23}( [A-Za-z][A-Za-z0-9_-]{0,23}=("[A-Za-z0-9 _.,:;!?()/+=<>'-]{0,160}"|[A-Za-z0-9._-]{1,64})){0,16}$/;
// Secret-shaped values, assembled from readable text at runtime rather than written as literals.
const hostile = {
  token: ["tarubot fixture application identity", "fixture issued", "readable signature text"]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join("."),
  secret: Buffer.from("private session secret used only in tests").toString("hex"),
  snowflake: String(3n * 10n ** 17n + 42n),
  url: "https://private-hook.example.org/api/webhooks/path?key=value",
  email: "officer@example.org",
  database: `postgresql://tarubot:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/tarubot`,
  unicode: "ünïcödé ✓",
};
/** The bot container's log tail: pino records and Bun's report of an uncaught error. */
const botLog = [
  JSON.stringify({ level: 30, msg: "Modules loaded", commands: 40 }),
  `plain text ${hostile.token} ${hostile.database}`,
  JSON.stringify({
    level: 50,
    msg: "Operation failed; inspect scoped work status.",
    operation: "startup",
    code: "unexpected",
    source: "DiscordjsError",
    diagnostic: `token ${hostile.token}`,
  }),
  JSON.stringify({
    level: 60,
    msg: `Discord login failed for ${hostile.token} see ${hostile.url} ${hostile.email} id ${hostile.snowflake} ::set-output name=leak::value ::add-mask::${hostile.secret} %0A \`whoami\` ${hostile.unicode} ${"long ".repeat(400)}`,
    err: {
      type: "DiscordjsError",
      message: `An invalid token was provided: ${hostile.token}`,
      stack: `Error: ${hostile.database}\n    at login`,
      code: "TokenInvalid",
    },
  }),
  JSON.stringify({
    level: 50,
    msg: "Database writer lease lost; stopping this writer.",
    err: { type: "DatabaseError", code: "57P01", message: hostile.database },
  }),
  `DiscordjsError: An invalid token was provided. ${hostile.token}`,
  ` code: "TokenInvalid"`,
  "",
  "      at login (/app/node_modules/discord.js/src/client/Client.js:1:1)",
].join("\n");
/** A record whose code is secret-shaped: it is relayed without the code. */
const secretCode = JSON.stringify({
  level: 50,
  msg: "Lease check failed.",
  err: { type: "Error", code: hostile.secret },
});
const botErrors = [
  /^reason bot-error msg="Database writer lease lost; stopping this writer\." code=57P01 type=DatabaseError$/,
  /^reason bot-error msg="uncaught error" code=TokenInvalid type=DiscordjsError$/,
];
/** Bun's report of a migration that crashed on authentication, message and source line included. */
const migrationCrash = [
  `1 | const url = "${hostile.database}";`,
  "    ^",
  `error: password authentication failed for user "tarubot" at ${hostile.database}`,
  ` code: "${hostile.secret.slice(0, 32)}"`,
  ' severity: "FATAL",',
  '     code: "28P01"',
  "",
  "      at /app/dist/scripts/migrate.js:1:1",
  "",
  "Bun v1.4.2 (Linux x64)",
].join("\n");

const reasonLines = (stdout: string) =>
  stdout.split("\n").filter((line) => line.startsWith("reason "));
/** Each expected reason appears, in this order, among the entry's reason lines. */
function expectReasons(stdout: string, expected: (string | RegExp)[]) {
  const lines = reasonLines(stdout);
  let from = 0;
  for (const want of expected) {
    const at = lines.findIndex(
      (line, index) =>
        index >= from && (typeof want === "string" ? line === want : want.test(line)),
    );
    expect({ want: String(want), lines, found: at >= 0 }).toMatchObject({ found: true });
    from = at + 1;
  }
}
/** Nothing private or secret-shaped reaches the public channel, and every line has a fixed shape. */
function assertPublic(result: { stdout: string; stderr: string }, box: HostSandbox) {
  expect(result.stderr).toBe("");
  const lines = result.stdout.split("\n");
  expect(lines.pop()).toBe("");
  for (const line of lines) {
    expect(line).toMatch(/^(step [a-z]+|result [a-z-]+|reason .*)$/);
    if (line.startsWith("reason ")) {
      expect(line).toMatch(REASON_FORM);
      expect(line.length).toBeLessThanOrEqual(400);
    }
    expect(line).not.toContain("::");
    expect(line).not.toMatch(/[%@`#$\\]|:\/\//);
    expect(line).toMatch(/^[ -~]*$/);
    expect(line.replace(/^reason entry sha256=[0-9a-f]{64}$/, "")).not.toMatch(/[0-9]{6,}/);
  }
  const privateValues = [
    ...readFileSync(join(box.root, ".env"), "utf8")
      .split("\n")
      .map((setting) => setting.slice(setting.indexOf("=") + 1))
      .filter((value) => value.length >= 6 && !["production", "staging", "false"].includes(value)),
    ...hostile.token.split("."),
    hostile.secret.slice(0, 16),
    hostile.snowflake,
    "private-hook",
    "officer",
    "example.org",
    box.directory,
  ];
  for (const value of privateValues)
    expect({ value, leaked: result.stdout.includes(value) }).toEqual({ value, leaked: false });
}

type FailureScenario = {
  name: string;
  target?: HostTarget;
  web?: boolean;
  knobs?: string[];
  observe?: ObserveScenario;
  /** A jq filter applied to the new container once Compose has started it. */
  afterStart?: string;
  setup?: (box: HostSandbox) => void;
  result: "needs-owner" | "refused";
  reasons: (string | RegExp)[];
};
const started =
  "reason container exit=unknown oom=false restarts=0 health=healthy running=true uptime=unknown";
const ready = "http=200 live=true ready=true database=true writerLease=true discord=true";
const fenced = "reason fence writers=stopped";
const failureScenarios: FailureScenario[] = [
  {
    name: "observation: the release isn't ready because Discord isn't connected",
    observe: {
      readiness: {
        status: 503,
        body: { live: true, ready: false, database: true, writerLease: true, discord: false },
      },
    },
    setup: (box) => writeFileSync(join(box.sim, "bot.log"), botLog),
    result: "needs-owner",
    reasons: [
      entryLine,
      "reason failed step=observe check=readiness status=1",
      started,
      "reason readiness identity=true schema=true http=503 live=true ready=false database=true writerLease=true discord=false",
      // Cleaned, then cut at 120 characters; a lone colon can't start a workflow command.
      'reason bot-error msg="Discord login failed for <redacted> see <url> <redacted> id <n> :set-output name=<redacted> :add-mask:<redacted> <redact" code=TokenInvalid type=DiscordjsError',
      ...botErrors,
      fenced,
    ],
  },
  {
    name: "observation: the schema check fails with a database error carrying credentials",
    observe: { schemaError: { message: `connect to ${hostile.database} failed`, code: "schema" } },
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=schema-checksum status=1",
      started,
      `reason readiness identity=true schema=false ${ready} schemaCode=schema`,
      fenced,
    ],
  },
  {
    name: "observation: a code-shaped secret in a probe error is dropped",
    observe: { schemaError: { message: hostile.token, code: "Secret0123456789ab" } },
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=schema-checksum status=1",
      `reason readiness identity=true schema=false ${ready}`,
    ],
  },
  {
    name: "observation: the container runs another package version",
    observe: { version: "9.9.9" },
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=identity status=1",
      `reason readiness identity=false schema=true ${ready}`,
    ],
  },
  {
    name: "observation: the health endpoint doesn't answer",
    observe: {
      fetchError: { message: `Unable to connect ${hostile.url}`, code: "ConnectionRefused" },
    },
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=readiness status=1",
      "reason readiness identity=true schema=true http=none readinessCode=ConnectionRefused",
    ],
  },
  {
    name: "observation: the probe can't run at all",
    knobs: ["probe"],
    result: "needs-owner",
    reasons: ["reason failed step=observe check=probe status=1", started, fenced],
  },
  {
    name: "observation: the container was killed out of memory",
    afterStart:
      '.[0].State += {Running: false, ExitCode: 137, OOMKilled: true, StartedAt: "2026-10-10T01:00:00.123456789Z", FinishedAt: "2026-10-10T01:00:42.5Z", Health: {Status: "unhealthy"}}',
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=not-running status=1",
      "reason container exit=137 oom=true restarts=0 health=unhealthy running=false uptime=42",
      fenced,
    ],
  },
  {
    name: "observation: the container restarted",
    knobs: ["restart"],
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=container-restarted status=1",
      "reason container exit=unknown oom=false restarts=1 health=healthy running=true uptime=unknown",
    ],
  },
  {
    name: "observation: Docker reports the container unhealthy",
    afterStart: '.[0].State.Health.Status = "unhealthy"',
    result: "needs-owner",
    reasons: ["reason failed step=observe check=health status=1 health=unhealthy"],
  },
  {
    name: "observation: the container runs another image",
    afterStart: `.[0].Image = "sha256:${"3".repeat(64)}"`,
    result: "needs-owner",
    reasons: ["reason failed step=observe check=image-identity status=1", started],
  },
  {
    name: "observation: the container's labels name another commit",
    afterStart: `.[0].Config.Labels["org.opencontainers.image.revision"] = "${"c".repeat(40)}"`,
    result: "needs-owner",
    reasons: ["reason failed step=observe check=labels status=1"],
  },
  {
    name: "observation: the container disappears",
    knobs: ["gone"],
    result: "needs-owner",
    reasons: ["reason failed step=observe check=gone status=1", fenced],
  },
  {
    name: "observation: bundled Caddy turns unhealthy",
    web: true,
    knobs: ["proxy-health"],
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=proxy-health status=1 health=unhealthy",
      started,
      "reason proxy exit=unknown oom=false restarts=unknown health=unhealthy running=true uptime=unknown",
    ],
  },
  {
    name: "start: the container exits while Compose waits",
    knobs: ["start"],
    afterStart:
      '.[0].State += {Running: false, ExitCode: 1, StartedAt: "2026-10-10T01:00:00Z", FinishedAt: "2026-10-10T01:00:03Z"}',
    setup: (box) => writeFileSync(join(box.sim, "bot.log"), `${botLog}\n${secretCode}\n`),
    result: "needs-owner",
    reasons: [
      "reason failed step=start check=compose-up status=1",
      "reason container exit=1 oom=false restarts=0 health=healthy running=false uptime=3",
      ...botErrors,
      'reason bot-error msg="Lease check failed." type=Error',
      fenced,
    ],
  },
  {
    name: "start: the container never becomes healthy",
    knobs: ["start"],
    afterStart: '.[0].State.Health.Status = "starting"',
    result: "needs-owner",
    reasons: [
      "reason failed step=start check=compose-up status=1",
      "reason container exit=unknown oom=false restarts=0 health=starting running=true uptime=unknown",
    ],
  },
  {
    name: "migrate: the migration crashes on database authentication",
    knobs: ["migrate"],
    setup: (box) => writeFileSync(join(box.sim, "migrate-output"), migrationCrash),
    result: "needs-owner",
    reasons: [
      "reason failed step=migrate check=migrate status=1",
      'reason bot-error msg="uncaught error" type=Error',
      fenced,
    ],
  },
  {
    name: "register: command registration fails",
    knobs: ["register"],
    result: "needs-owner",
    reasons: ["reason failed step=register check=register status=1", fenced],
  },
  {
    name: "backup: the dump fails",
    knobs: ["backup"],
    result: "needs-owner",
    reasons: [
      "reason failed step=backup check=backup status=1",
      "reason backup stage=dump",
      fenced,
    ],
  },
  {
    name: "backup: the upload fails",
    knobs: ["upload"],
    result: "needs-owner",
    reasons: ["reason failed step=backup check=backup status=1", "reason backup stage=upload"],
  },
  {
    name: "stop: the writer can't be confirmed stopped",
    knobs: ["stop"],
    result: "needs-owner",
    reasons: [
      "reason failed step=stop check=stop-writers status=1",
      "reason fence writers=unconfirmed",
    ],
  },
  {
    name: "observation: codes, types and operations ending in a newline are dropped, not split",
    observe: {
      readiness: {
        status: 503,
        body: { live: true, ready: false, database: true, writerLease: true, discord: true },
      },
    },
    setup: (box) =>
      writeFileSync(
        join(box.sim, "bot.log"),
        `${JSON.stringify({ level: 50, msg: "x", code: "ECONNREFUSED\n", operation: "startup\n", err: { type: "Error\n" } })}\n`,
      ),
    result: "needs-owner",
    reasons: ['reason bot-error msg="x"', fenced],
  },
  {
    name: "observation: a jq that cleans the self-test sample differently gets no say",
    observe: {
      readiness: {
        status: 503,
        body: { live: true, ready: false, database: true, writerLease: true, discord: true },
      },
    },
    setup: (box) => {
      writeFileSync(join(box.sim, "bot.log"), botLog);
      // Stands in for an older jq or another regex engine: it answers the cleaner its own way.
      writeFileSync(
        join(box.directory, "bin", "jq"),
        `#!/bin/bash\nif [[ $1 == -rRn ]]; then printf '%s\\n' 'bot-error msg="tampered"'; exit 0; fi\nexec ${JSON.stringify(Bun.which("jq") ?? "/usr/bin/jq")} "$@"\n`,
        { mode: 0o755 },
      );
    },
    result: "needs-owner",
    reasons: [
      "reason failed step=observe check=readiness status=1",
      'reason bot-error msg="unavailable"',
      fenced,
    ],
  },
  {
    name: "preflight: no bot container to replace",
    setup: (box) => rmSync(join(box.sim, "container.json")),
    result: "refused",
    reasons: [entryLine, "reason refused step=preflight code=live-writer-count"],
  },
  {
    name: "preflight: the running bot is unhealthy",
    setup: (box) => {
      const file = join(box.sim, "container.json");
      const live = JSON.parse(readFileSync(file, "utf8"));
      live[0].State.Health.Status = "unhealthy";
      writeFileSync(file, JSON.stringify(live));
      writeFileSync(join(box.sim, "bot.log"), botLog);
    },
    result: "refused",
    reasons: [
      "reason failed step=preflight check=live-health status=1",
      "reason container exit=unknown oom=false restarts=0 health=unhealthy running=true uptime=unknown",
      ...botErrors,
    ],
  },
  {
    name: "preflight: the central settings are readable by others",
    setup: (box) => chmodSync(join(box.root, ".env"), 0o644),
    result: "refused",
    reasons: ["reason failed step=preflight check=settings-mode status=1"],
  },
  {
    name: "fetch: main can't be fetched",
    knobs: ["fetch"],
    result: "refused",
    reasons: ["reason failed step=fetch check=git-fetch status=1"],
  },
  {
    name: "pull: the image can't be pulled",
    knobs: ["pull"],
    result: "refused",
    reasons: ["reason failed step=pull check=image-pull status=1"],
  },
  {
    name: "pull: the dashboard settings don't validate",
    setup: (box) => configureWeb(box, { DISCORD_CLIENT_SECRET: "" }),
    result: "refused",
    reasons: [
      "reason failed step=pull check=web-settings status=1",
      /^reason bot-error msg="uncaught error" type=Error$/,
    ],
  },
  {
    name: "pull: the candidate refuses staging's production database",
    target: "staging",
    setup: (box) =>
      changeScope(box, "candidate", {
        DATABASE_URL: `postgresql://${STAGING_DATABASE}:private-database-password@database.example.org:${MANAGED_DIRECT_PORTS[0]}/tarubot`,
      }),
    result: "refused",
    reasons: ["reason failed step=pull check=candidate-scope status=1"],
  },
];

describe.skipIf(!hostToolsAvailable)("public failure reasons", () => {
  for (const scenario of failureScenarios) {
    test(scenario.name, () => {
      const box = sandbox(true, scenario.target);
      if (scenario.web) configureWeb(box);
      for (const name of scenario.knobs ?? []) knob(box, name);
      if (scenario.observe)
        writeFileSync(join(box.sim, "observe.json"), JSON.stringify(scenario.observe));
      if (scenario.afterStart) writeFileSync(join(box.sim, "after-start.jq"), scenario.afterStart);
      scenario.setup?.(box);
      const result = deploy(box);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toEndWith(`\nresult ${scenario.result}\n`);
      expectReasons(result.stdout, scenario.reasons);
      expect(
        reasonLines(result.stdout).filter((line) => line.startsWith("reason bot-error")).length,
      ).toBeLessThanOrEqual(3);
      assertPublic(result, box);
      expect(result.stdout).not.toContain("reason malformed");
      expect(existsSync(join(box.state, "pending"))).toBe(scenario.result === "needs-owner");
    });
  }

  test("an already-live request that isn't ready says why and changes nothing", () => {
    const box = sandbox();
    expect(deploy(box).code).toBe(0);
    writeFileSync(
      join(box.sim, "observe.json"),
      JSON.stringify({
        readiness: {
          status: 503,
          body: { live: true, ready: false, database: false, writerLease: false, discord: true },
        },
      }),
    );
    const result = deploy(
      box,
      `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
    );
    expect(result.stdout).toEndWith("\nresult refused\n");
    expectReasons(result.stdout, [
      "reason failed step=observe check=readiness status=1",
      "reason readiness identity=true schema=true http=503 live=true ready=false database=false writerLease=false discord=true",
    ]);
    expect(result.stdout).not.toContain("reason fence");
    assertPublic(result, box);
  });

  test("a damaged installed entry refuses before any tool, lock or writer is touched", () => {
    const box = sandbox();
    const installed = join(box.directory, "tarubot-deploy");
    const text = readFileSync(deployScript, "utf8");
    // As the copy that failed 2.40.0: intact up to a line past the writer boundary.
    const broken = text.replace("public_step record\n", "public_step record )\n");
    expect(broken).not.toBe(text);
    writeFileSync(installed, broken, { mode: 0o700 });
    const line = text.slice(0, text.indexOf("public_step record\n")).split("\n").length;
    const result = deploy(box, undefined, undefined, installed);
    expect(result).toEqual({
      code: 1,
      stdout: [
        "step preflight",
        `reason entry sha256=${sha256(broken)}`,
        `reason entry syntax=invalid line=${line}`,
        "reason refused step=preflight code=entry-syntax",
        "result refused",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
    expect(existsSync(join(box.state, "host.lock"))).toBe(false);
    expect(existsSync(join(box.state, "pending"))).toBe(false);
    expect(events(box)).not.toContain("stop");
    expect(JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running).toBe(
      true,
    );
    // The private log keeps Bash's own message, the line's text included.
    const [log] = readdirSync(join(box.state, "logs"));
    expect(readFileSync(join(box.state, "logs", log ?? ""), "utf8")).toContain(
      "syntax error near unexpected token",
    );
  });

  test("an entry rewritten during delivery names the line it couldn't parse, after fencing", async () => {
    const box = sandbox();
    const installed = join(box.directory, "tarubot-deploy");
    copyFileSync(deployScript, installed);
    writeFileSync(join(box.sim, "hold-observe"), "");
    let reachedObservation!: () => void;
    const observation = new Promise<void>((resolve) => {
      reachedObservation = resolve;
    });
    const watcher = watch(box.sim, () => {
      if (existsSync(join(box.sim, "observe-held"))) reachedObservation();
    });
    const child = Bun.spawn(["bash", installed, "production"], {
      env: {
        ...box.environment,
        SSH_ORIGINAL_COMMAND: `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await Promise.race([
        observation,
        child.exited.then((code) => {
          throw new Error(`Host exited before observation: ${code}`);
        }),
      ]);
      // Rewrite the file in place, as a reinstall during a delivery would. Bash reads a script as
      // it runs, so it meets the broken line once observation ends.
      const text = readFileSync(installed, "utf8");
      const original = "public_step record\n";
      writeFileSync(installed, text.replace(original, `${")".padEnd(original.length - 1)}\n`));
      const line = text.slice(0, text.indexOf(original)).split("\n").length;
      rmSync(join(box.sim, "hold-observe"));
      expect(await child.exited).toBe(2);
      const stdout = await new Response(child.stdout).text();
      expect(stdout).toEndWith("\nresult needs-owner\n");
      expectReasons(stdout, [
        "reason failed step=observe check=unlabelled status=2",
        `reason entry syntax=invalid line=${line}`,
        started,
        fenced,
      ]);
      assertPublic({ stdout, stderr: await new Response(child.stderr).text() }, box);
      expect(existsSync(join(box.state, "pending"))).toBe(true);
      expect(existsSync(join(box.state, "current"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
      ).toBe(false);
    } finally {
      watcher.close();
      rmSync(join(box.sim, "hold-observe"), { force: true });
      child.kill();
      await child.exited;
    }
  });
});

/*
 * The cleaner itself (BOT_ERRORS_JQ's `clean`), read from the entry exactly as it ships. Every
 * case pins an exact result, and removing any one rule must change at least one of them, so no
 * rule can be dropped or weakened unnoticed.
 */
const entryText = readFileSync(deployScript, "utf8");
const botErrorsProgram = (() => {
  const marker = "readonly BOT_ERRORS_JQ='";
  const start = entryText.indexOf(marker) + marker.length;
  return entryText.slice(start, entryText.indexOf("\n'\n", start)).replaceAll(`'"'"'`, "'");
})();
const jqExecutable = Bun.which("jq") ?? "jq";
function cleaned(program: string, msg: string) {
  const result = Bun.spawnSync([jqExecutable, "-rRn", program], {
    stdin: new TextEncoder().encode(`${JSON.stringify({ level: 50, msg })}\n`),
  });
  if (result.exitCode !== 0) throw new Error(`jq failed: ${result.stderr.toString()}`);
  const line = result.stdout.toString().trim();
  const match = /^bot-error(?: msg="(.*)")?$/.exec(line);
  return match ? (match[1] ?? "") : `unexpected: ${line}`;
}
const lettersOnly = "privatesessiontokenletters";
const mixedWord = "session2026secret";
const cleanerCases: [string, string, string][] = [
  [
    "a word with a disallowed character goes whole",
    "pw Xk9$mQ2#pL7&vR4 then",
    "pw <redacted> then",
  ],
  ["a quote can't join two halves", `${"A".repeat(16)}"${"B".repeat(16)}`, "<redacted>"],
  ["non-ASCII and control characters take their word", "café\tok fine", "<redacted> fine"],
  ["a URL", "see https://hook.example.org/path?key=value now", "see <url> now"],
  ["a key=value value", "query failed code=Secret1 now", "query failed code=<redacted> now"],
  ["a dotted name", "connect db.internal.example failed", "connect <redacted> failed"],
  ["an IPv6 address", "at 2600:3c0a::f03c:95ff:fe5e:1a2b failed", "at <ip> failed"],
  ["a letters-only word of 24 or more", `token ${lettersOnly} end`, "token <redacted> end"],
  ["a mixed word of 12 to 23", `token ${mixedWord} end`, "token <redacted> end"],
  [
    "a snowflake split by separators",
    "member 3000-0000-0000-0000-42 or 3000 0000 0000 0000 42",
    "member <n> or <n>",
  ],
  ["a snowflake", `id ${hostile.snowflake}`, "id <n>"],
  ["short numbers stay", "attempt 2 of 5, code 42", "attempt 2 of 5, code 42"],
  ["a workflow command loses its ::", "::set-output name", ":set-output name"],
  ["runs of spaces collapse", "lease   lost", "lease lost"],
  ["leading spaces go", "   leading", "leading"],
  ["trailing spaces go", "trailing   ", "trailing"],
  [
    "the cut comes after redaction",
    `lead https://${"a".repeat(200)}.example tail`,
    "lead <url> tail",
  ],
  ["the cut is at 120 characters", "word ".repeat(40), "word ".repeat(24).trim()],
  [
    "a word the work bound cuts in two is dropped whole",
    `https://${"a".repeat(4070)} ${"b".repeat(30)}`,
    "<url>",
  ],
];

describe.skipIf(!hostToolsAvailable)("the bot-error cleaner", () => {
  for (const [name, msg, expected] of cleanerCases)
    test(name, () => expect(cleaned(botErrorsProgram, msg)).toBe(expected));

  test("every cleaning rule is needed: removing any one changes a pinned result", () => {
    const head = "  def clean:\n";
    const start = botErrorsProgram.indexOf(head) + head.length;
    const end = botErrorsProgram.indexOf("\n  def code:");
    const [first, ...rules] = botErrorsProgram.slice(start, end).split(/\n(?= {4}\| )/);
    expect(rules.length).toBeGreaterThanOrEqual(13);
    for (const [index, rule] of rules.entries()) {
      let body = [first, ...rules.filter((_, other) => other !== index)].join("\n");
      if (!body.endsWith(";")) body += ";";
      const program = botErrorsProgram.slice(0, start) + body + botErrorsProgram.slice(end);
      const changed = cleanerCases.filter(
        ([, msg, expected]) => cleaned(program, msg) !== expected,
      );
      expect({ rule: rule.trim(), changed: changed.length > 0 }).toEqual({
        rule: rule.trim(),
        changed: true,
      });
    }
  });

  test("the entry's own line check turns anything off-shape into reason malformed", () => {
    const form = entryText.match(/^readonly REASON_FORM=.*$/m)?.[0];
    const check = entryText.match(/^reason_line\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
    if (!form || !check) throw new Error("reason_line not found in ops/deploy.sh");
    const line = (text: string) =>
      Bun.spawnSync([
        "bash",
        "-c",
        `set -euo pipefail\nexport LC_ALL=C\n${form}\n${check}\nreason_line "$1"\nprintf '%s' "$REASON"`,
        "reason-line",
        text,
      ]).stdout.toString();
    for (const text of [
      "bot-error code=ECONNREFUSED\n",
      "bot-error type=Error\n",
      "bot-error op=startup\n",
      'bot-error msg="x"\nreason fence writers=stopped',
      "failed check=a::b",
      'bot-error msg="100%"',
      `long key=${"a".repeat(65)}`,
      `long msg="${"x".repeat(161)}"`,
      `many${" k=v".repeat(17)}`,
      "fine key=é",
      "Upper key=value",
    ])
      expect({ text, line: line(text) }).toEqual({ text, line: "reason malformed" });
    expect(line("fence writers=stopped")).toBe("reason fence writers=stopped");
    expect(line('bot-error msg="Lease lost; stopping." code=57P01 type=DatabaseError')).toBe(
      'reason bot-error msg="Lease lost; stopping." code=57P01 type=DatabaseError',
    );
  });
});

describe.skipIf(!hostToolsAvailable)("signals during diagnosis", () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`${signal} while the entry diagnoses a failure can't keep it from fencing`, async () => {
      const box = sandbox();
      writeFileSync(
        join(box.sim, "observe.json"),
        JSON.stringify({
          readiness: {
            status: 503,
            body: { live: true, ready: false, database: true, writerLease: true, discord: false },
          },
        }),
      );
      writeFileSync(join(box.sim, "bot.log"), botLog);
      // Hold the entry inside diagnosis, at its `docker logs` call, until the signal is sent.
      writeFileSync(join(box.sim, "hold-logs"), "");
      let reachedDiagnosis!: () => void;
      const diagnosis = new Promise<void>((resolve) => {
        reachedDiagnosis = resolve;
      });
      const watcher = watch(box.sim, () => {
        if (existsSync(join(box.sim, "logs-held"))) reachedDiagnosis();
      });
      const child = Bun.spawn(["bash", deployScript, "production"], {
        env: {
          ...box.environment,
          SSH_ORIGINAL_COMMAND: `deploy production ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await Promise.race([
          diagnosis,
          child.exited.then((code) => {
            throw new Error(`Host exited before diagnosis: ${code}`);
          }),
        ]);
        expect(existsSync(join(box.state, "pending"))).toBe(true);
        child.kill(signal);
        // An entry that didn't ignore the signal would be gone within this grace period; one that
        // does keeps waiting on the held Docker call. The bound is for the kernel, not the entry.
        await Promise.race([child.exited, Bun.sleep(300)]);
        rmSync(join(box.sim, "hold-logs"));
        expect(await child.exited).toBe(1);
        const stdout = await new Response(child.stdout).text();
        expect(stdout).toEndWith("reason fence writers=stopped\nresult needs-owner\n");
        expectReasons(stdout, [
          "reason failed step=observe check=readiness status=1",
          ...botErrors,
        ]);
        expect(stdout).not.toContain("signal=");
        expect(
          JSON.parse(readFileSync(join(box.sim, "container.json"), "utf8"))[0].State.Running,
        ).toBe(false);
      } finally {
        watcher.close();
        rmSync(join(box.sim, "hold-logs"), { force: true });
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  }
});
