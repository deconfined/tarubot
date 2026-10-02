/** Phase-test transport: invented encrypted objects on disk, injected through the internal API. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { controlPhase, hostRecordCodec } from "../../../scripts/infra-control-cli.js";
import { HostEnrollmentRecords } from "../../../scripts/host-enrollment.js";
import {
  InfrastructureRecords,
  RecordCodec,
  privateDigest,
  type ControlStore,
} from "../../../scripts/infra-control.js";

const [command, directory] = process.argv.slice(2);
const stub = process.env.STUB;
if (!command || !directory || !stub) throw new Error("missing-test-runner");
// Disabled reads intentionally need no key or storage client, just like the actual CLI.
if (command === "read" && process.env.CONTROL_RECORDS_ENABLED !== "true") {
  try {
    await controlPhase(command, directory, process.env);
  } catch {
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
const objects = join(stub, "control-objects");
const store: ControlStore = {
  async read(key) {
    const path = join(objects, key);
    return existsSync(path) ? readFileSync(path) : null;
  },
  async write(key, bytes) {
    if (existsSync(join(stub, "fail-control-write"))) throw new Error("invented-write-failure");
    const path = join(objects, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
  },
};
const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
const codec = new RecordCodec(
  process.env.TF_VAR_state_passphrase ?? "",
  privateDigest({ backend, key: "tarubot/infra.tfstate" }),
);
const bucket = /^bucket\s*= "([^"]+)"$/mu.exec(backend)?.[1] ?? "";
const endpoint = /^endpoints\s*= \{ s3 = "([^"]+)" \}$/mu.exec(backend)?.[1] ?? "";
const region = /^region\s*= "([^"]+)"$/mu.exec(backend)?.[1] ?? "";
const hostCodec = hostRecordCodec(
  bucket,
  endpoint,
  region,
  process.env.TF_VAR_state_passphrase ?? "",
);
// Invented native helper responses exercise the real encrypted enrollment engine without SSH,
// HTTP or DNS. The wire-format key has a valid Ed25519 type and an invented 32-byte public value.
const wire = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]);
const observed = {
  key: `ssh-ed25519 ${wire.toString("base64")}`,
  sshfp: createHash("sha256").update(wire).digest("hex"),
};
const stage = (name: string) => appendFileSync(join(stub, "enrollment-stages"), `${name}\n`);
const enrollment = new HostEnrollmentRecords(store, hostCodec, {
  async verifyInstance(host) {
    const bytes = await store.read("current");
    if (
      bytes === null ||
      (codec.open("current", bytes) as { pending: string }).pending !== host.generation
    )
      throw new Error("invented-infra-not-pending");
    stage("verify-instance");
  },
  async scanKey() {
    stage("scan-key");
    return observed;
  },
  async publishSshfp(host) {
    const bytes = await store.read(`hosts/${host.target}`);
    if (bytes === null) throw new Error("invented-key-not-persisted");
    const saved = hostCodec.open(`hosts/${host.target}`, bytes);
    if (JSON.stringify((saved as { observed: unknown }).observed) !== JSON.stringify(observed))
      throw new Error("invented-key-not-persisted");
    stage("publish-sshfp");
    if (existsSync(join(stub, "fail-enrollment-dns"))) throw new Error("invented-unknown-dns-ack");
  },
  async validateDns() {
    stage("validate-dnssec");
  },
});
try {
  await controlPhase(
    command,
    directory,
    process.env,
    new InfrastructureRecords(store, codec),
    enrollment,
  );
} catch {
  process.exitCode = 1;
}
