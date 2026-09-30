/** Private infrastructure phase adapter. Never expose S3 exceptions, records, paths or hashes. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffBinding, classifyPlan } from "./infra-policy.js";
import {
  guardDatabaseClusters,
  requireDatabaseAdoption,
  verifyDatabaseAdoption,
} from "./database-adoption.js";
import {
  InfrastructureJournal,
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

/** Native Bun S3 keeps Actions dependency-free. There are no conditional writes or lock objects. */
export class S3ControlStore implements ControlStore {
  constructor(private readonly client: Pick<Bun.S3Client, "file" | "write">) {}
  async read(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await this.client.file(`${prefix}${key}`).arrayBuffer());
    } catch (error) {
      // Only an explicit missing key is absence; 403, timeout, missing bucket, etc. stop work.
      if (error instanceof Error && "code" in error && error.code === "NoSuchKey") return null;
      throw new Error("control-storage-read-failed");
    }
  }
  async write(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.write(`${prefix}${key}`, bytes, {
        type: "application/octet-stream",
        retry: 0,
      });
    } catch {
      throw new Error("control-storage-write-failed");
    }
  }
}

/** Shared transport/key factory; reviewed and automatic adapters have distinct authority gates. */
export function infrastructureJournal(
  directory: string,
  environment: NodeJS.ProcessEnv,
): InfrastructureJournal {
  const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
  const bucket = /^bucket\s*= "([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])"$/mu.exec(backend)?.[1];
  const endpoint = /^endpoints\s*= \{ s3 = "(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)" \}$/mu.exec(
    backend,
  )?.[1];
  const passphrase = environment.TF_VAR_state_passphrase ?? "";
  if (
    !bucket ||
    !endpoint ||
    !environment.AWS_ACCESS_KEY_ID ||
    !environment.AWS_SECRET_ACCESS_KEY ||
    passphrase.length < 32
  )
    fail();
  const identity = privateDigest({ backend, key: backendKey });
  const client = new Bun.S3Client({
    bucket,
    endpoint,
    region: "us-east-1",
    virtualHostedStyle: true,
    retry: 0,
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
  });
  return new InfrastructureJournal(
    new S3ControlStore(client),
    new RecordCodec(passphrase, identity),
  );
}

/** All evidence lives under RUNNER_TEMP/tofu with umask 077, never in an Actions output/artifact. */
export async function controlPhase(
  command: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
  suppliedJournal?: InfrastructureJournal,
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
  const journal = suppliedJournal ?? infrastructureJournal(directory, environment);
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
