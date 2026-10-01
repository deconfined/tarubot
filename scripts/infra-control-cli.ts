/** Private infrastructure phase adapter. Never expose S3 exceptions, records, paths or hashes. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlJournal } from "./control-journals.js";
import { handoffBinding, classifyPlan } from "./infra-policy.js";
import {
  guardDatabaseClusters,
  requireDatabaseAdoption,
  verifyDatabaseAdoption,
} from "./database-adoption.js";
import {
  InfrastructureRecords,
  RecordCodec,
  type InfrastructureJournal,
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
/** Runtime configuration has one canonical safe positive decimal representation, never coercion. */
function configuredId(value: string | undefined): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value)) fail();
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value) fail();
  return id;
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
    const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
    const bucket = /^bucket\s*= "([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])"$/mu.exec(backend)?.[1];
    const endpoint = /^endpoints\s*= \{ s3 = "(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)" \}$/mu.exec(
      backend,
    )?.[1];
    const passphrase = environment.TF_VAR_state_passphrase ?? "";
    const accessKeyId = environment.AWS_ACCESS_KEY_ID;
    const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey || passphrase.length < 32) fail();
    // Bun's hosted-style endpoint includes the bucket. Explicit options avoid ambient routing,
    // session credentials and retries; the backend/key bytes also bind the encryption domain.
    const url = new URL(endpoint);
    url.hostname = `${bucket}.${url.hostname}`;
    const client = createClient({
      bucket,
      endpoint: url.origin,
      region: "us-east-1",
      virtualHostedStyle: true,
      accessKeyId,
      secretAccessKey,
      sessionToken: "",
      retry: 0,
    });
    return new InfrastructureRecords(
      new S3ControlStore(client),
      new RecordCodec(passphrase, privateDigest({ backend, key: backendKey })),
    );
  } catch {
    fail();
  }
}

/** Dormant automatic target adapter only; never selected by the manual Infrastructure CLI. */
export function legacyTargetJournal(
  directory: string,
  environment: NodeJS.ProcessEnv,
  /** Internal native/GitHub/clock test seams, never CLI/environment-selected authority overrides. */
  dependencies: NonNullable<Parameters<typeof createControlJournal>[1]> = {},
): InfrastructureJournal {
  try {
    // Independent owner configuration is mandatory for every enabled ordinary reader/writer.
    // A token for contents:read or a caller's approval flag cannot stand in for this capability.
    const owner = {
      owner_id: configuredId(environment.CONTROL_OWNER_ID),
      repository_id: configuredId(environment.CONTROL_REPOSITORY_ID),
      environment_id: configuredId(environment.CONTROL_OWNER_ENVIRONMENT_ID),
      token: environment.CONTROL_OWNER_READ_TOKEN ?? "",
    };
    const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
    const bucket = /^bucket\s*= "([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])"$/mu.exec(backend)?.[1];
    const endpoint = /^endpoints\s*= \{ s3 = "(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)" \}$/mu.exec(
      backend,
    )?.[1];
    const passphrase = environment.TF_VAR_state_passphrase ?? "";
    const accessKeyId = environment.AWS_ACCESS_KEY_ID;
    const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey || passphrase.length < 32) fail();
    // Preserve exact historical backend bytes/state-key identity; scoped routing does not rekey.
    return createControlJournal(
      {
        target: "infra",
        backend: privateDigest({ backend, key: backendKey }),
        passphrase,
        owner,
        storage: {
          scope: "infra",
          bucket,
          endpoint,
          region: "us-east-1",
          credentials: { accessKeyId, secretAccessKey, sessionToken: null },
        },
      },
      dependencies,
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
  } else if (command === "finish") {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH ?? "", "utf8"));
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
    await journal.finish(read("control-ticket.json") as Ticket, state);
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
