/** Credential-free platform scan of the build's exact index. Scanner logs stay private. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  lstatSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { platformImages } from "./release-policy.js";

const image = "ghcr.io/deconfined/tarubot";
export const scanner = {
  version: "0.74.0",
  sha256: "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
};

/** Raw Buildx output has no added newline, so bind the parsed index to its exact OCI digest. */
export function boundIndex(bytes: Uint8Array, digest: string): unknown {
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
    throw new Error("invalid-release-index");
  return JSON.parse(Buffer.from(bytes).toString());
}

/** Fixed command construction: no shell, arbitrary tool arguments, tags or credential inheritance. */
export function scanCommands(index: unknown): string[][] {
  return platformImages(index).map(({ platform, digest }) => [
    "trivy",
    "image",
    "--quiet",
    "--no-progress",
    "--config",
    "/dev/null",
    "--ignorefile",
    "/dev/null",
    "--scanners",
    "vuln",
    "--severity",
    "HIGH,CRITICAL",
    "--ignore-unfixed",
    "--exit-code",
    "1",
    "--timeout",
    "10m",
    "--platform",
    platform,
    `${image}@${digest}`,
  ]);
}
if (import.meta.main) {
  let directory: string | undefined;
  try {
    const digest = process.env.DIGEST ?? "";
    const temp = process.env.RUNNER_TEMP;
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || !temp) throw new Error("invalid-scan-input");
    const privateDirectory = join(temp, "release-scan");
    // Refuse stale output or symlinks rather than reuse an earlier runner directory.
    mkdirSync(privateDirectory, { mode: 0o700 });
    directory = privateDirectory;
    const dockerConfig = join(privateDirectory, ".docker");
    const sourceConfig =
      process.env.DOCKER_CONFIG ||
      (process.env.HOME ? join(process.env.HOME, ".docker") : undefined);
    const pluginSource = sourceConfig
      ? join(sourceConfig, "cli-plugins", "docker-buildx")
      : undefined;
    const plugin = pluginSource ? lstatSync(pluginSource, { throwIfNoEntry: false }) : undefined;
    if (plugin && pluginSource) {
      if (!plugin.isFile()) throw new Error("invalid-buildx-plugin");
      const plugins = join(dockerConfig, "cli-plugins");
      mkdirSync(plugins, { recursive: true, mode: 0o700 });
      // The action's user plugin needs to remain discoverable after HOME isolation. Copy only
      // executable bytes, never registry auth, Docker contexts or certificate configuration.
      copyFileSync(pluginSource, join(plugins, "docker-buildx"));
      chmodSync(join(plugins, "docker-buildx"), 0o700);
    }
    const run = (command: string[], name: string) => {
      const result = Bun.spawnSync(command, {
        cwd: privateDirectory,
        stdin: "ignore",
        env: {
          PATH: process.env.PATH,
          HOME: privateDirectory,
          DOCKER_CONFIG: dockerConfig,
          TRIVY_CACHE_DIR: join(privateDirectory, "cache"),
        },
        // Bound registry/scanner failures as well as Trivy's own vulnerability timeout.
        timeout: command[0] === "trivy" ? 11 * 60_000 : 60_000,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
      });
      writeFileSync(join(privateDirectory, `${name}.stdout`), result.stdout, { mode: 0o600 });
      writeFileSync(join(privateDirectory, `${name}.stderr`), result.stderr, { mode: 0o600 });
      if (!result.success || result.exitedDueToTimeout || result.exitedDueToMaxBuffer)
        throw new Error("scan-failed");
    };
    run(["docker", "buildx", "imagetools", "inspect", "--raw", `${image}@${digest}`], "index");
    const index = boundIndex(readFileSync(join(privateDirectory, "index.stdout")), digest);
    for (const [i, command] of scanCommands(index).entries()) run(command, `platform-${i}`);
    console.log(
      "Both runtime platform digests passed the pinned high/critical fixable-vulnerability gate.",
    );
  } catch {
    console.log(
      "::error::Release platform evidence, scanner execution or vulnerability gate failed; signing/promotion is blocked.",
    );
    process.exitCode = 1;
  } finally {
    // Workflow cleanup is a fallback; private diagnostics never outlive a normal script exit.
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      console.log("::error::Private scanner output cleanup failed; signing/promotion is blocked.");
      process.exitCode = 1;
    }
  }
}
