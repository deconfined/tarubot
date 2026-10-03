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
  deploy,
  deployScript,
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
const sandbox = (releases = true) => {
  const box = hostSandbox(releases);
  boxes.push(box);
  return box;
};

for (const request of [
  "",
  "deploy",
  "deploy 2.40.0 bad sha256:bad 1",
  "rollback 2.40.0 a b 1",
  `deploy 02.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1`,
  `deploy 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 0`,
  `deploy 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1\ntouch /tmp/unwanted`,
  `deploy 2.40.0 ${"a".repeat(40)} sha256:${"a".repeat(64)} 1 extra`,
]) {
  test(`refuses malformed forced commands before filesystem or tool access: ${JSON.stringify(request)}`, () => {
    const box = sandbox(false);
    const result = deploy(box, request);
    expect(result).toEqual({ code: 64, stdout: "result refused\n", stderr: "" });
    expect(existsSync(box.state)).toBe(false);
    expect(readFileSync(join(box.sim, "argv"), "utf8")).toBe("");
  });
}
test("refuses positional arguments before filesystem or tool access", () => {
  const box = sandbox(false);
  expect(deploy(box, undefined, ["unexpected"]).code).toBe(64);
  expect(existsSync(box.state)).toBe(false);
});

describe.skipIf(!hostToolsAvailable)("isolated production host deployment", () => {
  test("stops, backs up offsite, migrates, registers globally and starts the exact digest", () => {
    const box = sandbox();
    const result = deploy(box);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "step preflight",
        "step fetch",
        "step pull",
        "step stop",
        "step backup",
        "step migrate",
        "step register",
        "step start",
        "step observe",
        "step record",
        "result deployed",
        "",
      ].join("\n"),
    );
    const actions = events(box);
    expect(actions.indexOf("stop")).toBeLessThan(actions.indexOf("backup"));
    expect(actions.indexOf("upload-database")).toBeLessThan(actions.indexOf("migrate"));
    expect(actions.indexOf("upload-settings")).toBeLessThan(actions.indexOf("migrate"));
    expect(actions.indexOf("migrate")).toBeLessThan(actions.indexOf("register"));
    expect(actions.indexOf("register")).toBeLessThan(actions.indexOf("start"));
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
        `deploy ${version} ${box.target.commit} ${box.target.digest} 1234`,
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
        deploy(box, `deploy ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`)
          .stdout,
      ).toEndWith("result refused\n");
    });
  }

  test("an exact already-live request observes but does not migrate or register again", () => {
    const box = sandbox();
    expect(deploy(box).code).toBe(0);
    writeFileSync(join(box.sim, "events"), "");
    const result = deploy(
      box,
      `deploy ${box.target.version} ${box.target.commit} ${box.target.digest} 1235`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toEndWith("result already-live\n");
    const actions = events(box);
    expect(actions).not.toContain("stop");
    expect(actions).not.toContain("migrate");
    expect(actions).not.toContain("register");
    expect(actions.lastIndexOf("observe")).toBeLessThan(actions.indexOf("restart-policy"));
  });

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${signal} before acceptance preserves pending and cannot automatically restart the target`, async () => {
      const box = sandbox();
      writeFileSync(join(box.sim, "hold-observe"), "");
      // Signal only after the actual target reaches observation, not a guessed timer.
      let reachedBoundary!: () => void;
      const boundary = new Promise<void>((resolve) => {
        reachedBoundary = resolve;
      });
      const watcher = watch(box.sim, () => {
        if (existsSync(join(box.sim, "observe-held"))) reachedBoundary();
      });
      const process = Bun.spawn(["bash", deployScript], {
        env: {
          ...box.environment,
          SSH_ORIGINAL_COMMAND: `deploy ${box.target.version} ${box.target.commit} ${box.target.digest} 1234`,
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
