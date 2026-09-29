/**
 * Runner-only SSH bootstrap: a reviewed OpenTofu creation may establish one public host pin in the
 * private state bucket. Later deployments must authenticate against that retained pin, including
 * after an address changes. Every network-facing command is a stand-in; no host or bucket is used.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("ops/pipeline/host.sh");
const hasJq = Bun.spawnSync(["sh", "-c", "command -v jq"], { stdin: "ignore" }).exitCode === 0;
const scratch = mkdtempSync(join(tmpdir(), "pipeline-host-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const ADDRESS = "192.0.2.10";
const INSTANCE = "123456";
const HOST_KEY = `ssh-ed25519 ${"AAAAC3NzaC1lZDI1NTE5AAAAIExample".padEnd(68, "E")}`;
const CHANGED_KEY = `ssh-ed25519 ${"AAAAC3NzaC1lZDI1NTE5AAAAIChanged".padEnd(68, "F")}`;
const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nthrowaway-test-marker\n-----END OPENSSH PRIVATE KEY-----";
/** Keep shell backslashes literal while unescaping template-literal parameter expansions. */
const shell = (parts: TemplateStringsArray) => String.raw(parts).replaceAll("\\${", "${");

/** Simulated SigV4 storage captures stdin separately, so tests can prove credentials avoid argv. */
const curl = shell`#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" >> "$CASE_DIR/curl-args"
cat > "$CASE_DIR/curl-config"
output= upload=
while (($#)); do
  case $1 in --output) output=$2; shift ;; --upload-file) upload=$2; shift ;; esac
  shift
done
if [[ -n $upload ]]; then
  cp "$upload" "$CASE_DIR/uploaded.json"
  printf '%s' "\${FAKE_PUT_STATUS:-200}"
else
  if [[ \${FAKE_GET_FAIL:-0} == 1 ]]; then echo "$FAKE_ADDRESS storage failure" >&2; exit 7; fi
  if [[ \${FAKE_GET_STATUS:-404} == 200 ]]; then cp "$CASE_DIR/stored.json" "$output"; else : > "$output"; fi
  printf '%s' "\${FAKE_GET_STATUS:-404}"
fi
`;
/** Keyscan may offer a new key only on the authorized creation path. */
const keyscan = shell`#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" >> "$CASE_DIR/keyscan-args"
echo "# $FAKE_ADDRESS SSH banner" >&2
[[ \${FAKE_SCAN_FAIL:-0} == 0 ]] || exit 1
printf '%s %s\n' "$FAKE_ADDRESS" "$FAKE_OFFERED_KEY"
`;
/** SSH itself decides whether the presented key matches the known_hosts pin, as in a real run. */
const ssh = shell`#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" >> "$CASE_DIR/ssh-args"
known= command=
for arg in "$@"; do
  case $arg in UserKnownHostsFile=*) known=\${arg#UserKnownHostsFile=} ;; esac
  command=$arg
done
if ! grep -Fxq "target $FAKE_OFFERED_KEY" "$known"; then
  echo "$FAKE_ADDRESS changed host key $FAKE_OFFERED_KEY" >&2
  exit 255
fi
if [[ $command == 'cloud-init status --wait' ]]; then exit "\${FAKE_CLOUD_STATUS:-0}"; fi
count=0
if [[ -f $CASE_DIR/ssh-count ]]; then count=$(cat "$CASE_DIR/ssh-count"); fi
count=$((count + 1))
echo "$count" > "$CASE_DIR/ssh-count"
((count > \${FAKE_SSH_FAILS:-0}))
`;
/** Public test keys only; no installed or environment SSH key is read. */
const keygen = shell`#!/usr/bin/env bash
set -eu
if [[ $1 == -E ]]; then
  cat > /dev/null
  echo '256 SHA256:test-fingerprint (ED25519)'
else
  [[ \${FAKE_PRIVATE_INVALID:-0} == 0 ]] || exit 1
fi
`;

let count = 0;
/** A private runner and fake bucket, with a selected host and a caller-confirmed saved plan. */
function runner(
  options: {
    stored?: unknown;
    actions?: string[];
    address?: string;
    instance?: string;
    target?: string;
    env?: Record<string, string>;
  } = {},
) {
  const dir = join(scratch, `run-${++count}`);
  const target = options.target ?? "staging";
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp);
  for (const [name, source] of Object.entries({
    curl,
    "ssh-keyscan": keyscan,
    ssh,
    "ssh-keygen": keygen,
    sleep: "#!/bin/sh\nexit 0\n",
    timeout: '#!/bin/sh\nprintf "%s\\n" "$1" > "$CASE_DIR/timeout"\nshift\nexec "$@"\n',
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(dir, "outputs.json");
  const plan = join(dir, "plan.json");
  writeFileSync(
    output,
    JSON.stringify({
      host_connection: {
        sensitive: true,
        value: {
          [target]: {
            instance_id: options.instance ?? INSTANCE,
            address: options.address ?? ADDRESS,
          },
        },
      },
    }),
  );
  writeFileSync(
    plan,
    JSON.stringify({
      resource_changes: [
        {
          address: `linode_instance.host["${target}"]`,
          mode: "managed",
          type: "linode_instance",
          name: "host",
          change: { actions: options.actions ?? ["create"] },
        },
      ],
    }),
  );
  if (options.stored !== undefined)
    writeFileSync(join(dir, "stored.json"), JSON.stringify(options.stored));
  const result = Bun.spawnSync(["bash", script, target, output, plan], {
    stdin: "ignore",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CASE_DIR: dir,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: join(dir, "github-output"),
      ANSIBLE_SSH_KEY: PRIVATE_KEY,
      STATE_BUCKET: "example-state",
      STATE_ENDPOINT: "https://storage.example.org",
      AWS_ACCESS_KEY_ID: "test-storage-access",
      AWS_SECRET_ACCESS_KEY: "test-storage-secret",
      FAKE_GET_STATUS: options.stored === undefined ? "404" : "200",
      FAKE_ADDRESS: options.address ?? ADDRESS,
      FAKE_OFFERED_KEY: HOST_KEY,
      ...options.env,
    },
  });
  return {
    dir,
    temp,
    result,
    log: result.stdout.toString() + result.stderr.toString(),
    read: (name: string) => readFileSync(join(dir, name), "utf8"),
  };
}

describe.skipIf(!hasJq)("the pipeline's private SSH handoff", () => {
  test("selects production's provisioned host and retains its pin separately", () => {
    const r = runner({ target: "production" });
    expect(r.result.exitCode).toBe(0);
    expect(r.read("curl-config")).toContain("/tarubot/hosts/production.json");
    expect(r.read("curl-config")).not.toContain("/staging.json");
    expect(runner({ target: "unknown" }).result.exitCode).toBe(1);
  });

  test("pins a newly created host after authentication, then supplies one private inventory when cloud-init succeeds", () => {
    const r = runner();
    expect(r.result.exitCode).toBe(0);
    expect(JSON.parse(r.read("uploaded.json"))).toEqual({
      instance_id: INSTANCE,
      host_key: HOST_KEY,
    });
    const d = join(r.temp, "pipeline-host");
    const inventory = JSON.parse(readFileSync(join(d, "inventory.json"), "utf8"));
    expect(inventory.all.hosts.target).toMatchObject({
      ansible_host: ADDRESS,
      ansible_user: "root",
      ansible_ssh_private_key_file: join(d, "key"),
    });
    expect(inventory.all.hosts.target.ansible_ssh_common_args).toContain(
      "StrictHostKeyChecking=yes",
    );
    expect(inventory.all.hosts.target.ansible_ssh_common_args).toContain("HostKeyAlias=target");
    expect(inventory.all.hosts.target.ansible_ssh_common_args).toContain("LogLevel=FATAL");
    expect(r.read("github-output")).toBe(`inventory=${d}/inventory.json\n`);
    expect(readFileSync(join(d, "key"), "utf8")).toBe(`${PRIVATE_KEY}\n`);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const name of ["key", "known_hosts", "inventory.json", "pin.json"])
      expect(statSync(join(d, name)).mode & 0o777).toBe(0o600);
    expect(r.read("timeout").trim()).toBe("600");
  });

  test("retains an authenticated pin after cloud-init failure so a no-op plan can retry without rescanning", () => {
    for (const status of ["1", "124"]) {
      const failed = runner({ env: { FAKE_CLOUD_STATUS: status } });
      expect(failed.result.exitCode).toBe(1);
      expect(failed.log).toContain("cloud-init did not finish successfully");
      expect(existsSync(join(failed.temp, "pipeline-host/key"))).toBe(false);
      expect(existsSync(join(failed.temp, "pipeline-host/inventory.json"))).toBe(false);
      // This is the bucket value from the failed attempt, not a fresh create authorization.
      const retained = JSON.parse(failed.read("uploaded.json"));
      expect(retained).toEqual({ instance_id: INSTANCE, host_key: HOST_KEY });
      const retry = runner({ stored: retained, actions: ["no-op"] });
      expect(retry.result.exitCode).toBe(0);
      expect(existsSync(join(retry.dir, "keyscan-args"))).toBe(false);
      expect(existsSync(join(retry.dir, "uploaded.json"))).toBe(false);
      expect(existsSync(join(retry.temp, "pipeline-host/inventory.json"))).toBe(true);
    }
  });

  test("reuses the pin on the same instance without scanning or writing, including after an address change", () => {
    const r = runner({
      stored: { instance_id: INSTANCE, host_key: HOST_KEY },
      actions: ["update"],
      address: "192.0.2.20",
    });
    expect(r.result.exitCode).toBe(0);
    expect(existsSync(join(r.dir, "keyscan-args"))).toBe(false);
    expect(existsSync(join(r.dir, "uploaded.json"))).toBe(false);
    expect(r.read("ssh-args")).toContain("root@192.0.2.20");
  });

  test("never repins a changed key for the same instance, even when the saved plan claims creation", () => {
    const r = runner({
      stored: { instance_id: INSTANCE, host_key: HOST_KEY },
      env: { FAKE_OFFERED_KEY: CHANGED_KEY },
    });
    expect(r.result.exitCode).toBe(1);
    expect(r.log).toContain("SSH did not become ready");
    expect(existsSync(join(r.dir, "keyscan-args"))).toBe(false);
    expect(existsSync(join(r.dir, "uploaded.json"))).toBe(false);
    expect(existsSync(join(r.temp, "pipeline-host/key"))).toBe(false);
  });

  test("replacement authorizes a new pin only when the selected instance was created", () => {
    const stored = { instance_id: "111111", host_key: CHANGED_KEY };
    expect(runner({ stored, actions: ["delete", "create"] }).result.exitCode).toBe(0);
    expect(runner({ stored, actions: ["create", "delete"] }).result.exitCode).toBe(0);
    for (const actions of [["no-op"], ["update"], ["delete"]]) {
      const r = runner({ stored, actions });
      expect(r.result.exitCode).toBe(1);
      expect(existsSync(join(r.dir, "keyscan-args"))).toBe(false);
      expect(existsSync(join(r.dir, "uploaded.json"))).toBe(false);
    }
    expect(runner({ actions: ["no-op"] }).result.exitCode).toBe(1);
  });

  test("storage, malformed pins, keyscan, authentication, cloud-init and pin-upload failures stop deployment", () => {
    for (const options of [
      { env: { FAKE_GET_STATUS: "403" } },
      { env: { FAKE_GET_FAIL: "1" } },
      { stored: { instance_id: INSTANCE, host_key: "invalid" } },
      { env: { FAKE_SCAN_FAIL: "1" } },
      { env: { FAKE_PRIVATE_INVALID: "1" } },
      { env: { FAKE_SSH_FAILS: "30" } },
      { env: { FAKE_CLOUD_STATUS: "124" } },
      { env: { FAKE_CLOUD_STATUS: "1" } },
      { env: { FAKE_PUT_STATUS: "403" } },
    ]) {
      const r = runner(options);
      expect(r.result.exitCode).toBe(1);
      expect(existsSync(join(r.temp, "pipeline-host/inventory.json"))).toBe(false);
      expect(existsSync(join(r.temp, "pipeline-host/key"))).toBe(false);
    }
    // Recoverable cloud-init errors retain its completed status, as site.yml does.
    expect(runner({ env: { FAKE_CLOUD_STATUS: "2", FAKE_SSH_FAILS: "2" } }).result.exitCode).toBe(
      0,
    );
  });

  test("keeps every identifying value out of logs and passes storage credentials on stdin", () => {
    const r = runner();
    const publicLog = r.log
      .split("\n")
      .filter((line) => !line.startsWith("::add-mask::"))
      .join("\n");
    for (const value of [
      ADDRESS,
      INSTANCE,
      HOST_KEY,
      PRIVATE_KEY,
      "test-storage-access",
      "test-storage-secret",
      "example-state",
      "storage.example.org",
    ])
      expect(publicLog).not.toContain(value);
    expect(r.log).toContain(`::add-mask::${ADDRESS}`);
    expect(r.log).toContain(`::add-mask::${HOST_KEY.split(" ")[1]}`);
    expect(r.read("curl-config")).toContain('user = "test-storage-access:test-storage-secret"');
    for (const value of [
      "test-storage-access",
      "test-storage-secret",
      "example-state",
      "storage.example.org",
    ])
      expect(r.read("curl-args")).not.toContain(value);
    expect(r.read("curl-args")).toContain("--aws-sigv4\naws:amz:us-east-1:s3");
  });

  test("rejects malformed OpenTofu connection data before scanning or contacting storage", () => {
    for (const options of [
      { address: "192.0.2.999" },
      { address: "-oProxyCommand=example" },
      { instance: "not-an-id" },
    ]) {
      const r = runner(options);
      expect(r.result.exitCode).toBe(1);
      expect(existsSync(join(r.dir, "curl-args"))).toBe(false);
      expect(existsSync(join(r.dir, "keyscan-args"))).toBe(false);
    }
  });
});
