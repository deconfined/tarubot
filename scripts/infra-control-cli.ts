/** Private infrastructure phase adapter. Never expose S3 exceptions, records, paths or hashes. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffBinding, classifyPlan } from "./infra-policy.js";
import {
  HostEnrollmentRecords,
  plannedNewHostTargets,
  projectNewAppliedHosts,
} from "./host-enrollment.js";
import {
  guardDatabaseClusters,
  requireDatabaseAdoption,
  verifyDatabaseAdoption,
} from "./database-adoption.js";
import {
  InfrastructureRecords,
  RecordCodec,
  privateDigest,
  stateEvidence,
  verifyAppliedPlan,
  type ControlStore,
  type Snapshot,
  type Ticket,
} from "./infra-control.js";

const prefix = "tarubot/control/v1/infra/";
const backendKey = "tarubot/infra.tfstate";
function fail(): never {
  throw new Error("invalid-control-evidence");
}
/** Small native S3 adapter; only bounded ciphertext is read and uncertain writes are never retried. */
export class S3ControlStore implements ControlStore {
  constructor(private readonly client: Pick<Bun.S3Client, "file" | "write">) {}
  async read(key: string): Promise<Uint8Array | null> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    let total = 0;
    try {
      reader = this.client.file(`${prefix}${key}`).stream().getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 2 * 1024 * 1024 + 32) throw new Error("control-storage-read-failed");
        chunks.push(Uint8Array.from(part.value));
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      complete = true;
      return result;
    } catch (error) {
      // Only an explicit missing key is absence; 403, timeout, missing bucket, etc. stop work.
      if (total === 0 && error instanceof Error && "code" in error && error.code === "NoSuchKey")
        return null;
      throw new Error("control-storage-read-failed");
    } finally {
      if (reader) {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  async write(key: string, bytes: Uint8Array): Promise<void> {
    try {
      const written = await this.client.write(`${prefix}${key}`, bytes, {
        type: "application/octet-stream",
        retry: 0,
      });
      if (written !== bytes.length) throw new Error("control-storage-write-failed");
    } catch {
      throw new Error("control-storage-write-failed");
    }
  }
}

/** The reviewed manual workflow needs only its own S3 credentials and encryption passphrase. */
export function infrastructureRecords(
  directory: string,
  environment: NodeJS.ProcessEnv,
  createClient: (options: Bun.S3Options) => Bun.S3Client = (options) => new Bun.S3Client(options),
): InfrastructureRecords {
  try {
    const { backend, bucket, endpoint, region } = backendStorage(directory);
    return new InfrastructureRecords(
      nativeStore(bucket, endpoint, region, environment, createClient),
      new RecordCodec(
        environment.TF_VAR_state_passphrase ?? "",
        privateDigest({ backend, key: backendKey }),
      ),
    );
  } catch {
    fail();
  }
}

/** The same private storage identity is sufficient for later Host reads; no tfvars are needed. */
function backendStorage(directory: string) {
  const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
  const bucket = /^bucket\s*= "([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])"$/mu.exec(backend)?.[1];
  const endpoint = /^endpoints\s*= \{ s3 = "(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)" \}$/mu.exec(
    backend,
  )?.[1];
  const region = /^region\s*= "([a-z0-9]+(?:-[a-z0-9]+)*)"$/mu.exec(backend)?.[1];
  // OpenTofu rejects duplicate assignments; record access must not silently select the first.
  if (!bucket || !endpoint || !region || [...backend.matchAll(/^region\s*=/gmu)].length !== 1)
    fail();
  return { backend, bucket, endpoint, region };
}
function nativeStore(
  bucket: string,
  endpoint: string,
  region: string,
  environment: NodeJS.ProcessEnv,
  createClient: (options: Bun.S3Options) => Bun.S3Client = (options) => new Bun.S3Client(options),
): S3ControlStore {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID;
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
    !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(endpoint) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(region)
  )
    fail();
  if (!accessKeyId || !secretAccessKey || (environment.TF_VAR_state_passphrase ?? "").length < 32)
    fail();
  const url = new URL(endpoint);
  url.hostname = `${bucket}.${url.hostname}`;
  // Hosted-style routing includes the bucket; do not adopt ambient endpoint/session settings.
  return new S3ControlStore(
    createClient({
      bucket,
      endpoint: url.origin,
      region,
      virtualHostedStyle: true,
      accessKeyId,
      secretAccessKey,
      sessionToken: "",
      retry: 0,
    }),
  );
}
export function hostRecordCodec(
  bucket: string,
  endpoint: string,
  region: string,
  passphrase: string,
): RecordCodec {
  return new RecordCodec(
    passphrase,
    privateDigest({
      schema: 2,
      purpose: "tarubot-host-enrollment-v1",
      bucket,
      endpoint: new URL(endpoint).origin,
      region,
      namespace: prefix,
      stateKey: backendKey,
    }),
  );
}
/** Enrollment ciphertext is bound to the same bucket, endpoint and signing region as Infra. */
export function hostEnrollmentRecords(
  bucket: string,
  endpoint: string,
  region: string,
  environment: NodeJS.ProcessEnv,
): HostEnrollmentRecords {
  try {
    return new HostEnrollmentRecords(
      nativeStore(bucket, endpoint, region, environment),
      hostRecordCodec(bucket, endpoint, region, environment.TF_VAR_state_passphrase ?? ""),
    );
  } catch {
    fail();
  }
}

/** All evidence lives under RUNNER_TEMP/tofu with umask 077, never in an Actions output/artifact. */
export async function controlPhase(
  command: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
  suppliedJournal?: Pick<InfrastructureRecords, "inspect" | "begin" | "finish">,
  suppliedEnrollment?: Pick<HostEnrollmentRecords, "requireNoPending" | "inspect" | "enroll">,
): Promise<void> {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(directory, name), "utf8"));
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  if (command === "read" && environment.CONTROL_RECORDS_ENABLED !== "true") {
    if (environment.CONTROL_RECORDS_ENABLED && environment.CONTROL_RECORDS_ENABLED !== "false")
      fail();
    write("control-context.json", { enabled: false });
    write("baseline-inputs.json", null);
    return;
  }
  if (command === "enrollment_check") {
    const { bucket, endpoint, region } = backendStorage(directory);
    const enrollment =
      suppliedEnrollment ?? hostEnrollmentRecords(bucket, endpoint, region, environment);
    // The fixed index blocks a pending target even if later inputs omit or rename it.
    await enrollment.requireNoPending();
    const event = readFileSync(environment.GITHUB_EVENT_PATH ?? "", "utf8");
    if (!["apply", "adopt"].includes(JSON.parse(event).inputs?.operation)) fail();
    const targets = plannedNewHostTargets(read("plan.json"), read("values.tfvars.json"));
    const context = read("control-context.json") as { enabled?: unknown };
    if (targets.length > 0 && context.enabled !== true) fail();
    for (const target of targets) if ((await enrollment.inspect(target)) !== null) fail();
    return;
  }
  // Dependency injection is internal-only for invented tests, never a CLI/environment override.
  const journal = suppliedJournal ?? infrastructureRecords(directory, environment);
  const state = stateEvidence(read("state.json"));
  if (command === "read") {
    const snapshot = await journal.inspect(state);
    write("control-context.json", { enabled: true, snapshot });
    write("baseline-inputs.json", snapshot.inputs);
    return;
  }
  const context = read("control-context.json") as { enabled?: unknown; snapshot?: Snapshot };
  if (context.enabled !== true || !context.snapshot) fail();
  const binding = handoffBinding(directory, environment);
  if (readFileSync(join(directory, "verified.binding"), "utf8") !== binding) fail();
  if (command === "begin" || command === "baseline") {
    if (privateDigest(state) !== privateDigest(context.snapshot.state)) fail();
    const inputs = read("values.tfvars.json") as Record<string, unknown>;
    const run = { commit: environment.GITHUB_SHA ?? "", run: environment.GITHUB_RUN_ID ?? "" };
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH ?? "", "utf8"));
    const adopting = command === "begin" && event.inputs?.operation === "adopt";
    if (!adopting && event.inputs?.operation !== (command === "baseline" ? "baseline" : "apply"))
      fail();
    if (adopting) requireDatabaseAdoption(read("plan.json"), inputs, context.snapshot.inputs);
    else guardDatabaseClusters(read("plan.json"), inputs);
    if (command === "baseline") {
      // Initial establishment is an explicit reviewed dispatch, with a complete no-change plan.
      if (classifyPlan(read("plan.json"), inputs, inputs).decision !== "no-changes") fail();
    }
    const ticket = await journal.begin(
      context.snapshot,
      inputs,
      run,
      binding,
      command === "baseline" ? "baseline" : "apply",
    );
    write("control-ticket.json", ticket);
    if (command === "baseline") await journal.finish(ticket, state);
  } else if (command === "finish" || command === "enroll") {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH ?? "", "utf8"));
    if (command === "enroll" && event.inputs?.operation !== "apply") fail();
    if (event.inputs?.operation === "adopt")
      verifyDatabaseAdoption(
        read("plan.json"),
        read("adoption-no-change.json"),
        read("applied-state.json"),
        read("values.tfvars.json"),
        context.snapshot.inputs,
      );
    else if (event.inputs?.operation !== "apply") fail();
    verifyAppliedPlan(read("plan.json"), read("applied-state.json"));
    const ticket = read("control-ticket.json") as Ticket;
    if (command === "finish") await journal.finish(ticket, state);
    else {
      const inputs = read("values.tfvars.json");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          ticket.generation,
        ) ||
        Object.keys(ticket).sort().join(",") !== "binding,generation" ||
        ticket.binding !== binding ||
        state.lineage !== context.snapshot.state.lineage ||
        state.serial <= context.snapshot.state.serial
      )
        fail();
      const { bucket, endpoint, region } = backendStorage(directory);
      const enrollment =
        suppliedEnrollment ?? hostEnrollmentRecords(bucket, endpoint, region, environment);
      await enrollment.enroll(
        projectNewAppliedHosts(read("plan.json"), read("applied-state.json"), inputs, {
          generation: ticket.generation,
          state,
          run: { commit: environment.GITHUB_SHA ?? "", run: environment.GITHUB_RUN_ID ?? "" },
          binding,
        }),
        {
          linodeToken: environment.LINODE_TOKEN ?? "",
          cloudflareToken: environment.CLOUDFLARE_API_TOKEN ?? "",
        },
        // Both pending records stay live through enrollment and exact Infra completion readback.
        // This is the reviewed Apply sequence, not a caller-supplied approval mechanism.
        () => journal.finish(ticket, state),
      );
    }
  } else fail();
}

if (import.meta.main) {
  try {
    const [command, directory] = process.argv.slice(2);
    if (process.argv.length !== 4 || !command || !directory) fail();
    await controlPhase(command as string, directory as string, process.env);
  } catch {
    console.log(
      "::error::Infrastructure control evidence or persistence failed; stop and reconcile any pending operation before another write.",
    );
    process.exitCode = 1;
  }
}
