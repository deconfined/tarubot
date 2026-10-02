/** One deployment-level trust read for stock Ansible/OpenSSH; ordinary deploys never relearn keys. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  validateHostDns,
  type AppliedHost,
  type HostEnrollmentRecords,
  type HostEnrollmentRecord,
} from "./host-enrollment.js";
import { hostEnrollmentRecords } from "./infra-control-cli.js";

type Records = Pick<HostEnrollmentRecords, "requireNoPending" | "inspect">;
export interface HostTrustHelpers {
  validateDns(host: AppliedHost, sshfp: string): Promise<void>;
  reachable(address: string): Promise<boolean>;
  checkPrivateKey(path: string): Promise<void>;
  mask(value: string): void;
}
function requireTrust(condition: unknown): asserts condition {
  if (!condition) throw new Error("host-trust-failed");
}
/** The probe only chooses an address family. Authentication still requires the stored host key. */
export function reachableSsh(address: string): Promise<boolean> {
  requireTrust(isIP(address) !== 0);
  return new Promise((resolve) => {
    const socket = createConnection({ host: address, port: 22, family: isIP(address) });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(3_000, () => finish(false));
  });
}
async function checkPrivateKey(path: string): Promise<void> {
  const child = Bun.spawn(["/usr/bin/ssh-keygen", "-y", "-P", "", "-f", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  });
  requireTrust((await child.exited) === 0);
}
function mask(value: string): void {
  console.log(
    `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
}
function complete(record: HostEnrollmentRecord | null, target: AppliedHost["target"]) {
  requireTrust(
    record !== null &&
      record.status === "complete" &&
      record.observed !== null &&
      record.host.target === target &&
      record.host.hostKey.split("-")[0] === target,
  );
  requireTrust(isIP(record.host.ipv4) === 4 && isIP(record.host.ipv6) === 6);
  return record;
}
/** Outer quoting is consumed by Ansible's shell parser, so retain inner OpenSSH file-list quotes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The protected Host job supplies read-only storage and the deployment key. Reopen the global
 * pending marker and complete record after DNS/address checks; Actions serializes cooperating
 * writers, and this is a deployment check rather than an atomic storage lock.
 */
export async function prepareHostTrust(
  target: AppliedHost["target"],
  runnerTemp: string,
  privateKey: string,
  records: Records,
  helpers: Partial<HostTrustHelpers> = {},
): Promise<void> {
  const directory = join(runnerTemp, "ssh");
  let created = false;
  try {
    requireTrust(target === "staging" || target === "production");
    requireTrust(isAbsolute(runnerTemp) && !/[\r\n\0]/u.test(runnerTemp));
    requireTrust(privateKey.includes("PRIVATE KEY") && privateKey.length <= 65_536);
    await records.requireNoPending();
    const record = structuredClone(complete(await records.inspect(target), target));
    const observed = record.observed;
    requireTrust(observed !== null);
    await (helpers.validateDns ?? validateHostDns)(record.host, observed.sshfp);
    const reachable = helpers.reachable ?? reachableSsh;
    const useIpv6 = await reachable(record.host.ipv6);
    requireTrust(useIpv6 || (await reachable(record.host.ipv4)));
    await records.requireNoPending();
    requireTrust(isDeepStrictEqual(complete(await records.inspect(target), target), record));

    const addMask = helpers.mask ?? mask;
    for (const value of [
      record.host.fqdn,
      record.host.ipv4,
      record.host.ipv6,
      observed.key,
      observed.key.slice(12),
      Buffer.from(observed.sshfp, "hex").toString("base64").replace(/=+$/u, ""),
    ])
      addMask(value);
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await writeFile(join(directory, "key"), `${privateKey.replaceAll("\r", "").trimEnd()}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await (helpers.checkPrivateKey ?? checkPrivateKey)(join(directory, "key"));
    await writeFile(join(directory, "known_hosts"), `target ${observed.key}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const knownHosts = join(directory, "known_hosts");
    const knownHostsArgument = quote(
      `"${knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    );
    const common = [
      "-F /dev/null",
      "-o IdentitiesOnly=yes",
      "-o IdentityAgent=none",
      "-o BatchMode=yes",
      "-o StrictHostKeyChecking=yes",
      `-o UserKnownHostsFile=${knownHostsArgument}`,
      "-o GlobalKnownHostsFile=/dev/null",
      "-o HostKeyAlias=target",
      "-o HostKeyAlgorithms=ssh-ed25519",
      "-o CheckHostIP=no",
      "-o UpdateHostKeys=no",
      "-o VerifyHostKeyDNS=no",
      `-o AddressFamily=${useIpv6 ? "inet6" : "inet"}`,
      "-o ConnectTimeout=20",
      "-o ServerAliveInterval=15",
      "-o ServerAliveCountMax=4",
      "-o LogLevel=FATAL",
    ].join(" ");
    await writeFile(
      join(directory, "inventory.json"),
      JSON.stringify({
        all: {
          hosts: {
            target: {
              ansible_host: useIpv6 ? record.host.ipv6 : record.host.ipv4,
              ansible_user: "root",
              ansible_ssh_private_key_file: join(directory, "key"),
              ansible_ssh_common_args: common,
            },
          },
        },
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch {
    if (created) await rm(directory, { recursive: true, force: true });
    throw new Error("host-trust-failed");
  }
}

/** Fixed workflow entry: no provider/write credentials, state renderer, DNS key learning or SSH. */
export async function hostTrust(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const target = environment.TARGET;
    requireTrust(target === "staging"); // Production activation remains a separate owner step.
    const records = hostEnrollmentRecords(
      environment.STATE_BUCKET ?? "",
      environment.STATE_ENDPOINT ?? "",
      environment.STATE_REGION ?? "",
      {
        AWS_ACCESS_KEY_ID: environment.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: environment.AWS_SECRET_ACCESS_KEY,
        TF_VAR_state_passphrase: environment.TF_VAR_state_passphrase,
      },
    );
    await prepareHostTrust(
      target,
      environment.RUNNER_TEMP ?? "",
      environment.ANSIBLE_SSH_KEY ?? "",
      records,
    );
  } catch {
    throw new Error("host-trust-failed");
  }
}
if (import.meta.main) {
  try {
    requireTrust(Bun.argv.length === 2);
    await hostTrust();
  } catch {
    console.error("::error::Host trust could not be verified.");
    process.exitCode = 1;
  }
}
