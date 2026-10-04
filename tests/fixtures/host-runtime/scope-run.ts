export {};
// Execute the host entry's actual inline Bun check with container-equivalent settings.
// Unlike observation's simulated DB/health boundary, identity checks use the real guard.
const [settingsFile, runtime, code, ...args] = process.argv.slice(2);
if (!settingsFile || !runtime || code === undefined)
  throw new Error("Missing scope fixture arguments");
const settings = (await Bun.file(settingsFile).json()) as Record<string, string>;
const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code, ...args], {
  cwd: runtime,
  env: settings,
  stdin: "ignore",
});
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode);
