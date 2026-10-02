/** First-host TOFU enrollment for an owner-approved Apply. Records are data, not SSH authority. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ControlStore, RecordCodec, RunIdentity, StateEvidence } from "./infra-control.js";
import { readOvhInstance, type OvhCredentials } from "./ovh-client.js";

type ObjectValue = Record<string, unknown>;
export interface AppliedHost {
  hostKey: string;
  target: "staging" | "production";
  instanceId: string;
  ovhProjectId: string;
  imageId: string;
  flavorId: string;
  networkId: string;
  fqdn: string;
  ipv4: string;
  ipv6: string;
  zoneId: string;
  generation: string;
  state: StateEvidence;
  run: RunIdentity;
  binding: string;
}
export interface ObservedHostKey {
  key: string;
  sshfp: string;
}
export interface HostEnrollmentRecord {
  schema: 1;
  status: "pending" | "complete";
  host: AppliedHost;
  observed: ObservedHostKey | null;
}
export interface EnrollmentCredentials {
  ovh: OvhCredentials;
  cloudflareToken: string;
}
export interface EnrollmentHelpers {
  verifyInstance(host: AppliedHost, credentials: OvhCredentials): Promise<void>;
  scanKey(host: AppliedHost): Promise<ObservedHostKey>;
  publishSshfp(host: AppliedHost, sshfp: string, token: string): Promise<void>;
  validateDns(host: AppliedHost, sshfp: string): Promise<void>;
}
function requireEnrollment(condition: unknown): asserts condition {
  if (!condition) throw new Error("host-enrollment-failed");
}
function object(value: unknown): ObjectValue {
  requireEnrollment(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function ipv6(value: string): string {
  requireEnrollment(isIP(value) === 6);
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}
function validateHost(host: AppliedHost): void {
  requireEnrollment(/^(staging|production)(-[0-9]{1,2})?$/u.test(host.hostKey));
  requireEnrollment(host.target === "staging" || host.target === "production");
  requireEnrollment(host.hostKey.split("-")[0] === host.target);
  requireEnrollment(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(host.instanceId));
  requireEnrollment(/^[a-f0-9]{32}$/u.test(host.ovhProjectId));
  requireEnrollment(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(host.imageId));
  requireEnrollment(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(host.networkId));
  requireEnrollment(/^[a-zA-Z0-9_-]{1,64}$/u.test(host.flavorId));
  requireEnrollment(
    host.fqdn.length <= 253 &&
      host.fqdn.includes(".") &&
      host.fqdn.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)),
  );
  requireEnrollment(isIP(host.ipv4) === 4 && ipv6(host.ipv6) === host.ipv6);
  requireEnrollment(/^[a-f0-9]{32}$/u.test(host.zoneId));
  requireEnrollment(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(host.generation));
  requireEnrollment(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(host.state.lineage));
  requireEnrollment(
    Number.isSafeInteger(host.state.serial) &&
      host.state.serial >= 0 &&
      /^[a-f0-9]{64}$/u.test(host.state.digest),
  );
  requireEnrollment(/^[a-f0-9]{40}$/u.test(host.run.commit) && /^[1-9][0-9]*$/u.test(host.run.run));
  requireEnrollment(/^[a-f0-9]{64}$/u.test(host.binding));
}
/** SSHFP hashes the SSH wire-format public key, not its textual Base64 representation. */
function observedKey(key: string): ObservedHostKey {
  requireEnrollment(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(key));
  const bytes = Buffer.from(key.slice(12), "base64");
  requireEnrollment(
    bytes.length === 51 &&
      bytes.readUInt32BE(0) === 11 &&
      bytes.subarray(4, 15).toString() === "ssh-ed25519" &&
      bytes.readUInt32BE(15) === 32 &&
      bytes.toString("base64") === key.slice(12),
  );
  return { key, sshfp: createHash("sha256").update(bytes).digest("hex") };
}

/** Pre-Apply check: duplicate target roles and imports must not create an enrollment candidate. */
export function plannedNewHostTargets(plan: unknown, inputs: unknown): AppliedHost["target"][] {
  try {
    const p = object(plan),
      hosts = object(object(inputs).hosts);
    requireEnrollment(Array.isArray(p.resource_changes));
    const targets: AppliedHost["target"][] = [],
      addresses = new Set<string>();
    for (const entry of p.resource_changes) {
      const resource = object(entry);
      requireEnrollment(typeof resource.address === "string" && !addresses.has(resource.address));
      addresses.add(resource.address);
      if (resource.type !== "openstack_compute_instance_v2" || resource.name !== "host") continue;
      const change = object(resource.change);
      requireEnrollment(
        !(
          Array.isArray(change.actions) &&
          change.actions.includes("create") &&
          change.actions.includes("delete")
        ),
      );
      if (!isDeepStrictEqual(change.actions, ["create"])) continue;
      requireEnrollment(
        resource.mode === "managed" && change.before === null && change.importing === undefined,
      );
      const key = resource.index;
      requireEnrollment(
        typeof key === "string" &&
          /^(staging|production)(-[0-9]{1,2})?$/u.test(key) &&
          resource.address === `openstack_compute_instance_v2.host[${JSON.stringify(key)}]`,
      );
      const role = object(hosts[key]).role;
      requireEnrollment(role === "staging" || role === "production");
      requireEnrollment(
        Object.values(hosts).filter((value) => object(value).role === role).length === 1 &&
          !targets.includes(role),
      );
      targets.push(role);
    }
    return targets;
  } catch {
    throw new Error("host-enrollment-failed");
  }
}

/**
 * The caller has verified saved-plan Apply and matching raw state under the original pending
 * Infrastructure ticket. That intent remains pending until this enrollment finishes.
 * Select actual newly-created hosts only; declarations/outputs alone never establish identity.
 */
export function projectNewAppliedHosts(
  plan: unknown,
  appliedState: unknown,
  inputs: unknown,
  completion: { generation: string; state: StateEvidence; run: RunIdentity; binding: string },
): AppliedHost[] {
  try {
    const p = object(plan),
      settings = object(inputs),
      hosts = object(settings.hosts);
    plannedNewHostTargets(p, settings);
    const root = object(object(object(appliedState).values).root_module);
    requireEnrollment(
      Array.isArray(p.resource_changes) &&
        Array.isArray(root.resources) &&
        root.child_modules === undefined,
    );
    const resources = new Map<string, ObjectValue>();
    for (const entry of root.resources) {
      const resource = object(entry);
      requireEnrollment(typeof resource.address === "string" && !resources.has(resource.address));
      resources.set(resource.address, resource);
    }
    const result: AppliedHost[] = [],
      addresses = new Set<string>();
    for (const entry of p.resource_changes) {
      const resource = object(entry);
      requireEnrollment(typeof resource.address === "string" && !addresses.has(resource.address));
      addresses.add(resource.address);
      if (resource.type !== "openstack_compute_instance_v2" || resource.name !== "host") continue;
      const change = object(resource.change);
      if (!isDeepStrictEqual(change.actions, ["create"])) continue;
      requireEnrollment(
        resource.mode === "managed" && change.before === null && change.importing === undefined,
      );
      const hostKey = resource.index;
      requireEnrollment(
        typeof hostKey === "string" &&
          resource.address === `openstack_compute_instance_v2.host[${JSON.stringify(hostKey)}]`,
      );
      const configured = object(hosts[hostKey]),
        applied = resources.get(resource.address);
      requireEnrollment(
        applied?.mode === "managed" &&
          applied.type === "openstack_compute_instance_v2" &&
          applied.name === "host" &&
          applied.index === hostKey,
      );
      const instance = object(applied.values);
      requireEnrollment(
        typeof instance.access_ip_v4 === "string" && typeof instance.access_ip_v6 === "string",
      );
      requireEnrollment(
        typeof instance.id === "string" &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(instance.id),
      );
      const host: AppliedHost = {
        hostKey,
        target: configured.role as AppliedHost["target"],
        instanceId: instance.id,
        ovhProjectId: settings.ovh_project_id as string,
        imageId: configured.image_id as string,
        flavorId: configured.flavor_id as string,
        networkId: configured.network_id as string,
        fqdn: configured.fqdn as string,
        ipv4: instance.access_ip_v4,
        ipv6: ipv6(instance.access_ip_v6),
        zoneId: settings.cloudflare_zone_id as string,
        ...structuredClone(completion),
      };
      validateHost(host);
      requireEnrollment(
        instance.region === "US-EAST-VA-1" &&
          instance.name === configured.label &&
          instance.image_id === configured.image_id &&
          instance.flavor_id === configured.flavor_id &&
          Array.isArray(instance.network) &&
          instance.network.length === 1 &&
          object(instance.network[0]).uuid === configured.network_id &&
          object(instance.network[0]).access_network === true,
      );
      requireEnrollment(
        Object.values(hosts).filter((value) => object(value).role === host.target).length === 1 &&
          !result.some((value) => value.target === host.target),
      );
      for (const [name, type, address] of [
        ["a", "A", host.ipv4],
        ["aaaa", "AAAA", host.ipv6],
      ] as const) {
        const record = resources.get(`cloudflare_dns_record.${name}[${JSON.stringify(hostKey)}]`);
        requireEnrollment(record?.type === "cloudflare_dns_record" && record.index === hostKey);
        const value = object(record.values);
        requireEnrollment(
          value.zone_id === host.zoneId &&
            value.name === host.fqdn &&
            value.type === type &&
            value.proxied === false &&
            (type === "AAAA" ? ipv6(String(value.content)) === address : value.content === address),
        );
      }
      result.push(host);
    }
    return result;
  } catch {
    throw new Error("host-enrollment-failed");
  }
}

/** Single Actions writer, exact ciphertext readbacks; this is not a distributed lock or CAS. */
export class HostEnrollmentRecords {
  constructor(
    private readonly store: ControlStore,
    private readonly codec: RecordCodec,
    private readonly helpers: EnrollmentHelpers = nativeHelpers,
  ) {}
  async #read(path: string): Promise<unknown | null> {
    const bytes = await this.store.read(path);
    return bytes === null ? null : this.codec.open(path, bytes);
  }
  async #persist(path: string, value: unknown): Promise<void> {
    const bytes = this.codec.seal(path, value);
    await this.store.write(path, bytes);
    const actual = await this.store.read(path);
    requireEnrollment(actual !== null && Buffer.from(bytes).equals(actual));
  }
  async requireNoPending(): Promise<void> {
    try {
      const pending = await this.#read("hosts/pending");
      if (pending === null) return;
      requireEnrollment(
        object(pending).schema === 1 &&
          Array.isArray(object(pending).targets) &&
          (object(pending).targets as unknown[]).length === 0,
      );
    } catch {
      throw new Error("host-enrollment-pending");
    }
  }
  async inspect(target: AppliedHost["target"]): Promise<HostEnrollmentRecord | null> {
    try {
      requireEnrollment(target === "staging" || target === "production");
      const value = await this.#read(`hosts/${target}`);
      if (value === null) return null;
      const record = object(value) as unknown as HostEnrollmentRecord;
      requireEnrollment(
        record.schema === 1 && (record.status === "pending" || record.status === "complete"),
      );
      validateHost(record.host);
      requireEnrollment(
        record.host.target === target && (record.status !== "complete" || record.observed !== null),
      );
      if (record.observed !== null)
        requireEnrollment(isDeepStrictEqual(observedKey(record.observed.key), record.observed));
      return structuredClone(record);
    } catch {
      throw new Error("host-enrollment-failed");
    }
  }
  async enroll(
    hosts: AppliedHost[],
    credentials: EnrollmentCredentials,
    finishApply: () => Promise<void>,
  ): Promise<void> {
    try {
      hosts = structuredClone(hosts);
      await this.requireNoPending();
      requireEnrollment(new Set(hosts.map((host) => host.target)).size === hosts.length);
      for (const host of hosts) {
        validateHost(host);
        requireEnrollment((await this.inspect(host.target)) === null);
      }
      if (hosts.length === 0) {
        await finishApply();
        return;
      }
      // The fixed index also blocks retries when a failed target disappears from later inputs.
      await this.#persist("hosts/pending", {
        schema: 1,
        targets: hosts.map((host) => host.target),
      });
      for (const host of hosts)
        await this.#persist(`hosts/${host.target}`, {
          schema: 1,
          status: "pending",
          host,
          observed: null,
        });
      for (const host of hosts) {
        await this.helpers.verifyInstance(host, credentials.ovh);
        const observed = await this.helpers.scanKey(host);
        requireEnrollment(isDeepStrictEqual(observedKey(observed.key), observed));
        const record: HostEnrollmentRecord = { schema: 1, status: "pending", host, observed };
        // TOFU is irrevocable for this first-enrollment path. No SSH authentication occurs here.
        await this.#persist(`hosts/${host.target}`, record);
        await this.helpers.publishSshfp(host, observed.sshfp, credentials.cloudflareToken);
        await this.helpers.validateDns(host, observed.sshfp);
        requireEnrollment(isDeepStrictEqual(await this.inspect(host.target), record));
        await this.#persist(`hosts/${host.target}`, { ...record, status: "complete" });
      }
      // Protected-job orchestration keeps BOTH indexes pending until Infra completion succeeds.
      await finishApply();
      await this.#persist("hosts/pending", { schema: 1, targets: [] });
    } catch {
      throw new Error("host-enrollment-failed");
    }
  }
}

interface CommandResult {
  code: number;
  stdout: string;
}
async function cleanup(
  directory: string | undefined,
  resolver?: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  try {
    if (resolver) {
      resolver.kill();
      await resolver.exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  } catch {
    throw new Error("host-enrollment-failed");
  }
}
export interface NativeEnrollmentDependencies {
  readInstance?: typeof readOvhInstance;
  fetch?: typeof fetch;
  run?: (argv: string[]) => Promise<CommandResult>;
  sleep?: (milliseconds: number) => Promise<void>;
}
/** Normal process timeouts/output limits; stderr stays private and never enters the error text. */
async function command(argv: string[]): Promise<CommandResult> {
  const result = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}
const sleep = (milliseconds: number) => Bun.sleep(milliseconds).then(() => {});
async function api(
  url: string,
  token: string,
  method: "GET" | "POST",
  body: unknown,
  dependencies: NativeEnrollmentDependencies,
): Promise<ObjectValue> {
  requireEnrollment(/^[!-~]+$/u.test(token));
  const response = await (dependencies.fetch ?? fetch)(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  requireEnrollment(response.ok && response.body !== null);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireEnrollment(size <= 1024 * 1024);
      parts.push(part.value);
    }
    return object(JSON.parse(Buffer.concat(parts).toString()));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function verifyAppliedInstance(
  host: AppliedHost,
  credentials: OvhCredentials,
  dependencies: NativeEnrollmentDependencies = {},
): Promise<void> {
  try {
    validateHost(host);
    // Only boot readiness is retried. An identity/address mismatch is a hard refusal.
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = object(
        await (dependencies.readInstance ?? readOvhInstance)(
          host.ovhProjectId,
          host.instanceId,
          credentials,
        ),
      );
      requireEnrollment(Array.isArray(result.ipAddresses));
      const publicAddresses = result.ipAddresses
        .map(object)
        .filter((address) => address.type === "public");
      const v4 = publicAddresses.filter((address) => address.version === 4);
      const v6 = publicAddresses.filter((address) => address.version === 6);
      requireEnrollment(
        result.id === host.instanceId &&
          result.region === "US-EAST-VA-1" &&
          result.imageId === host.imageId &&
          result.flavorId === host.flavorId &&
          v4.length === 1 &&
          v4[0]?.ip === host.ipv4 &&
          v4[0]?.networkId === host.networkId &&
          v6[0]?.networkId === host.networkId &&
          v6.length === 1 &&
          ipv6(String(v6[0]?.ip)) === host.ipv6,
      );
      if (result.status === "ACTIVE") return;
      requireEnrollment(result.status === "BUILD");
      if (attempt < 29) await (dependencies.sleep ?? sleep)(5_000);
    }
    throw new Error();
  } catch {
    throw new Error("host-enrollment-failed");
  }
}
export async function scanEd25519(
  host: AppliedHost,
  dependencies: NativeEnrollmentDependencies = {},
): Promise<ObservedHostKey> {
  let directory: string | undefined;
  try {
    validateHost(host);
    const run = dependencies.run ?? command;
    let saved: ObservedHostKey | undefined;
    for (let round = 0; round < 2; round++) {
      let reachable = false;
      for (let attempt = 0; attempt < 12 && !reachable; attempt++) {
        for (const [family, address] of [
          ["-4", host.ipv4],
          ["-6", host.ipv6],
        ] as const) {
          const result = await run([
            "/usr/bin/ssh-keyscan",
            family,
            "-T",
            "5",
            "-t",
            "ed25519",
            address,
          ]);
          const lines = result.stdout
            .split(/\r?\n/u)
            .filter((line) => line !== "" && !line.startsWith("#"));
          if (lines.length === 0) continue; // IPv6 may be unreachable from a hosted runner.
          requireEnrollment(result.code === 0);
          for (const line of lines) {
            const fields = line.trim().split(/\s+/u);
            requireEnrollment(fields.length === 3 && fields[0] === address);
            const observed = observedKey(`${fields[1]} ${fields[2]}`);
            requireEnrollment(saved === undefined || isDeepStrictEqual(saved, observed));
            saved = observed;
          }
          reachable = true;
        }
        if (!reachable && attempt < 11) await (dependencies.sleep ?? sleep)(5_000);
      }
      requireEnrollment(reachable);
    }
    requireEnrollment(saved);
    directory = await mkdtemp(join(tmpdir(), "tarubot-host-key-"));
    const keyfile = join(directory, "key.pub");
    await writeFile(keyfile, `${saved.key}\n`, { mode: 0o600, flag: "wx" });
    requireEnrollment(
      (await run(["/usr/bin/ssh-keygen", "-l", "-E", "sha256", "-f", keyfile])).code === 0,
    );
    const record = await run([
      "/usr/bin/ssh-keygen",
      "-r",
      host.fqdn,
      "-f",
      keyfile,
      "-O",
      "hashalg=sha256",
    ]);
    requireEnrollment(
      record.code === 0 &&
        record.stdout.trim().toLowerCase() === `${host.fqdn} in sshfp 4 2 ${saved.sshfp}`,
    );
    return saved;
  } catch {
    throw new Error("host-enrollment-failed");
  } finally {
    await cleanup(directory);
  }
}

function dnsRecord(value: unknown, host: AppliedHost, fingerprint: string): string {
  const record = object(value),
    data = object(record.data);
  requireEnrollment(
    typeof record.id === "string" &&
      /^[a-f0-9]{32}$/u.test(record.id) &&
      record.name === host.fqdn &&
      record.type === "SSHFP" &&
      data.algorithm === 4 &&
      data.type === 2 &&
      typeof data.fingerprint === "string" &&
      data.fingerprint.toLowerCase() === fingerprint,
  );
  return record.id;
}
export async function publishSshfp(
  host: AppliedHost,
  fingerprint: string,
  token: string,
  dependencies: NativeEnrollmentDependencies = {},
): Promise<void> {
  try {
    validateHost(host);
    requireEnrollment(/^[a-f0-9]{64}$/u.test(fingerprint));
    const origin = `https://api.cloudflare.com/client/v4/zones/${host.zoneId}/dns_records`;
    const list = async (): Promise<unknown[]> => {
      const result = await api(
        `${origin}?type=SSHFP&name=${encodeURIComponent(host.fqdn)}&page=1&per_page=100`,
        token,
        "GET",
        null,
        dependencies,
      );
      requireEnrollment(
        result.success === true &&
          Array.isArray(result.errors) &&
          result.errors.length === 0 &&
          Array.isArray(result.result),
      );
      requireEnrollment(
        object(result.result_info).page === 1 &&
          object(result.result_info).total_count === result.result.length &&
          result.result.length <= 1,
      );
      return result.result;
    };
    const existing = await list();
    if (existing.length === 1) {
      dnsRecord(existing[0], host, fingerprint);
      return;
    }
    // No mutation retry: an uncertain response leaves the durable observed key pending.
    const created = await api(
      origin,
      token,
      "POST",
      { type: "SSHFP", name: host.fqdn, ttl: 300, data: { algorithm: 4, type: 2, fingerprint } },
      dependencies,
    );
    requireEnrollment(
      created.success === true && Array.isArray(created.errors) && created.errors.length === 0,
    );
    const id = dnsRecord(created.result, host, fingerprint);
    const readback = await list();
    requireEnrollment(readback.length === 1 && dnsRecord(readback[0], host, fingerprint) === id);
  } catch {
    throw new Error("host-enrollment-failed");
  }
}

/** AD is accepted only from the locally launched validating Unbound, never a remote resolver. */
export function checkValidatedDns(
  output: string,
  host: AppliedHost,
  type: "A" | "AAAA" | "SSHFP",
  fingerprint: string,
): void {
  requireEnrollment(
    /status: NOERROR[,;]/u.test(output) && /;; flags: [^;]*\bad\b[^;]*;/u.test(output),
  );
  const records = output
    .split(/\r?\n/u)
    .filter((line) => line !== "" && !line.startsWith(";"))
    .map((line) => line.trim().split(/\s+/u))
    // +dnssec includes signatures. AD is the local validator's result; select the covered RRset.
    .filter(
      (record) =>
        !(
          record[0] === `${host.fqdn}.` &&
          record[2] === "IN" &&
          record[3] === "RRSIG" &&
          record[4] === type
        ),
    );
  requireEnrollment(records.length === 1);
  const record = records[0];
  requireEnrollment(record);
  requireEnrollment(
    record[0] === `${host.fqdn}.` &&
      typeof record[1] === "string" &&
      /^\d+$/u.test(record[1]) &&
      record[2] === "IN" &&
      record[3] === type,
  );
  if (type === "SSHFP")
    requireEnrollment(
      record.length === 7 &&
        record[4] === "4" &&
        record[5] === "2" &&
        record[6]?.toLowerCase() === fingerprint,
    );
  else
    requireEnrollment(
      record.length === 5 &&
        typeof record[4] === "string" &&
        (type === "A" ? record[4] === host.ipv4 : ipv6(record[4]) === host.ipv6),
    );
}
async function resolverPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  requireEnrollment(address !== null && typeof address !== "string");
  return address.port;
}
export async function validateHostDns(
  host: AppliedHost,
  fingerprint: string,
  dependencies: NativeEnrollmentDependencies = {},
): Promise<void> {
  let directory: string | undefined, resolver: ReturnType<typeof Bun.spawn> | undefined;
  try {
    validateHost(host);
    directory = await mkdtemp(join(tmpdir(), "tarubot-host-dns-"));
    const port = await resolverPort();
    const config = join(directory, "unbound.conf");
    await writeFile(
      config,
      `server:\n  interface: 127.0.0.1\n  port: ${port}\n  do-daemonize: no\n  username: ""\n  chroot: ""\n  use-syslog: no\n  logfile: "${join(directory, "unbound.log")}"\n  pidfile: ""\n  module-config: "validator iterator"\n  trust-anchor-file: "/usr/share/dns/root.key"\n  root-hints: "/usr/share/dns/root.hints"\n  val-permissive-mode: no\n  cache-max-ttl: 5\n  cache-max-negative-ttl: 5\n`,
      { mode: 0o600, flag: "wx" },
    );
    const run = dependencies.run ?? command;
    requireEnrollment((await run(["/usr/sbin/unbound-checkconf", config])).code === 0);
    resolver = Bun.spawn(["/usr/sbin/unbound", "-d", "-c", config], {
      stdout: "ignore",
      stderr: Bun.file(join(directory, "stderr.log")),
      timeout: 150_000,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      requireEnrollment(resolver.exitCode === null);
      let valid = true;
      for (const type of ["A", "AAAA", "SSHFP"] as const) {
        const result = await run([
          "/usr/bin/dig",
          "@127.0.0.1",
          "-p",
          String(port),
          host.fqdn,
          type,
          "+dnssec",
          "+adflag",
          "+nocdflag",
          "+noall",
          "+comments",
          "+answer",
          "+split=0",
          "+time=3",
          "+tries=1",
        ]);
        try {
          requireEnrollment(result.code === 0);
          checkValidatedDns(result.stdout, host, type, fingerprint);
        } catch {
          valid = false;
          break;
        }
      }
      requireEnrollment(resolver.exitCode === null);
      if (valid) return;
      if (attempt < 19) await (dependencies.sleep ?? sleep)(5_000);
    }
    throw new Error();
  } catch {
    throw new Error("host-enrollment-failed");
  } finally {
    await cleanup(directory, resolver);
  }
}
const nativeHelpers: EnrollmentHelpers = {
  verifyInstance: verifyAppliedInstance,
  scanKey: scanEd25519,
  publishSshfp,
  validateDns: validateHostDns,
};
