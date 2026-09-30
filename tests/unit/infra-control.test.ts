import { verifyInventedBaselineRun, baselineRunFixture } from "../fixtures/infra/baseline-run.js";
/** Invented encrypted storage/state only; fault injection never contacts a backend or provider. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  stateEvidence,
  verifyAppliedPlan,
  type ControlStore,
} from "../../scripts/infra-control.js";
import {
  controlPhase,
  infrastructureJournal,
  S3ControlStore,
} from "../../scripts/infra-control-cli.js";
import { handoffBinding } from "../../scripts/infra-policy.js";
import type { GitHubReadRequest } from "../../scripts/trust-run.js";

const passphrase = "invented control-record passphrase with sufficient entropy";
const codec = new RecordCodec(passphrase, "a".repeat(64));
const rawState = {
  version: 4,
  terraform_version: "1.12.6",
  lineage: "11111111-1111-4111-8111-111111111111",
  serial: 10,
  resources: [],
  outputs: {},
};
const before = stateEvidence(rawState);
const after = stateEvidence({ ...rawState, serial: 11, outputs: { invented: "changed" } });
const inputs = {
  hosts: { staging: { label: "example-staging" } },
  root_keys: ["invented-public-key"],
};
const run = { commit: "1".repeat(40), run: "1234" };
const binding = "b".repeat(64);

/** The transport deliberately has no lock/CAS API. A single writer is a caller prerequisite. */
class MemoryStore implements ControlStore {
  data = new Map<string, Uint8Array>();
  writes: string[] = [];
  failWrite = 0;
  corruptReadback = false;
  readError = false;
  async read(key: string): Promise<Uint8Array | null> {
    if (this.readError) throw new Error("invented-private-storage-diagnostic");
    const data = this.data.get(key);
    if (data && this.corruptReadback && this.writes.at(-1) === key)
      return new Uint8Array([1, 2, 3]);
    return data ? Uint8Array.from(data) : null;
  }
  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(key);
    if (this.writes.length === this.failWrite) throw new Error("invented-private-write-diagnostic");
    this.data.set(key, Uint8Array.from(bytes));
  }
  put(key: string, value: unknown): void {
    this.data.set(key, codec.seal(key, value));
  }
  get(key: string): unknown {
    const bytes = this.data.get(key);
    return bytes ? codec.open(key, bytes) : null;
  }
}
async function established() {
  const store = new MemoryStore();
  const journal = new InfrastructureJournal(store, codec, {
    verifyBaselineRun: verifyInventedBaselineRun,
  });
  const snapshot = await journal.inspect(before);
  const ticket = await journal.begin(snapshot, inputs, run, binding, "baseline");
  await journal.finish(ticket, before);
  return { store, journal, snapshot: await journal.inspect(before), ticket };
}

describe("control-record encryption and evidence", () => {
  test("runtime privacy hides derived keys and preserves pre-hardening ciphertext and backend/path bindings", () => {
    const privateCodec = new RecordCodec(passphrase, "a".repeat(64));
    const path = "intents/11111111-1111-4111-8111-111111111111";
    // Produced by the pre-hardening RecordCodec with only the invented fixture passphrase.
    const legacy = Buffer.from(
      "54494331896985342b3fb359ec579ba9160f2c796b5359dd7ac97b8457ea4b055013bf2d09893204cacd0bc2a79e731c4bc244cdf9ffaf6e08423ec22fad5e12e7cef056",
      "hex",
    );
    expect(Object.keys(privateCodec)).toEqual([]);
    expect(JSON.stringify(privateCodec)).toBe("{}");
    expect(Bun.inspect(privateCodec)).not.toContain("Buffer");
    expect(Reflect.get(privateCodec, "key")).toBeUndefined();
    expect(Reflect.get(privateCodec, "backend")).toBeUndefined();
    Object.assign(privateCodec, { key: Buffer.alloc(32), backend: "b".repeat(64) });
    expect(privateCodec.open(path, legacy)).toEqual({ fixture: "invented-legacy-record" });
    expect(() => privateCodec.open("current", legacy)).toThrow("invalid-control-record");
    const bytes = privateCodec.seal(path, inputs);
    expect(new RecordCodec(passphrase, "a".repeat(64)).open(path, bytes)).toEqual(inputs);
    expect(() => new RecordCodec(passphrase, "b".repeat(64)).open(path, bytes)).toThrow(
      "invalid-control-record",
    );
  });
  test("randomized authenticated encryption exposes neither values nor private digests", () => {
    const a = codec.seal("current", inputs);
    const b = codec.seal("current", inputs);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(codec.open("current", a)).toEqual(inputs);
    expect(Buffer.from(a).toString()).not.toContain("example-staging");
    expect(Buffer.from(a).toString()).not.toContain("invented-public-key");
    expect(() => codec.open("another-key", a)).toThrow("invalid-control-record");
    expect(() => new RecordCodec(passphrase, "c".repeat(64)).open("current", a)).toThrow(
      "invalid-control-record",
    );
    expect(() =>
      new RecordCodec(`${passphrase}-different`, "a".repeat(64)).open("current", a),
    ).toThrow("invalid-control-record");
    a[20] = (a[20] ?? 0) ^ 1;
    expect(() => codec.open("current", a)).toThrow("invalid-control-record");
    expect(() => codec.open("current", Buffer.from(JSON.stringify(inputs)))).toThrow(
      "invalid-control-record",
    );
    expect(() => new RecordCodec("short", "a".repeat(64))).toThrow("invalid-control-record");
    expect(() => codec.seal("current", "x".repeat(2 * 1024 * 1024))).toThrow(
      "invalid-control-record",
    );
  });
  test("state evidence binds lineage, serial and every state field without leaking parse errors", () => {
    expect(privateDigest({ a: 1, b: 2 })).toBe(privateDigest({ b: 2, a: 1 }));
    expect(stateEvidence({ ...rawState, outputs: { secret: "invented" } }).digest).not.toBe(
      before.digest,
    );
    for (const delta of [
      { version: 3 },
      { terraform_version: "1.13.0" },
      { lineage: "host.example.org" },
      { serial: -1 },
      { serial: 1.5 },
      { resources: null },
    ])
      expect(() => stateEvidence({ ...rawState, ...delta })).toThrow("invalid-control-record");
  });
});

describe("single-writer journal transitions", () => {
  test("diagnostics and instance shadows cannot expose or replace the journal's history capabilities", async () => {
    const f = await established();
    const shadow = new MemoryStore();
    expect(Object.keys(f.journal)).toEqual([]);
    expect(JSON.stringify(f.journal)).toBe("{}");
    expect(Bun.inspect(f.journal)).not.toContain("example-staging");
    for (const name of ["store", "codec", "read", "persist", "head", "baseline", "validateIntent"])
      expect(Reflect.get(f.journal, name)).toBeUndefined();
    Object.assign(f.journal, {
      store: shadow,
      codec: new RecordCodec(`${passphrase}-shadow`, "c".repeat(64)),
      read: async () => null,
      persist: async () => {},
      head: async () => ({ baseline: null, pending: null }),
      baseline: async () => ({ intent: {}, state: before }),
      validateIntent: () => {},
    });
    const ticket = await f.journal.begin(f.snapshot, inputs, run, binding, "apply");
    await expect(f.journal.inspect(before)).rejects.toThrow("invalid-control-record");
    await f.journal.finish(ticket, after);
    expect((await f.journal.inspect(after)).generation).toBe(ticket.generation);
    expect(f.store.get("current")).toEqual({ baseline: ticket.generation, pending: null });
    expect(shadow.writes).toEqual([]);
    f.store.data.delete(`completed/${ticket.generation}`);
    await expect(f.journal.inspect(after)).rejects.toThrow("invalid-control-record");
  });
  test("baseline establishment is explicit; ordinary Apply cannot learn a missing baseline", async () => {
    const store = new MemoryStore();
    const journal = new InfrastructureJournal(store, codec, {
      verifyBaselineRun: verifyInventedBaselineRun,
    });
    const snapshot = await journal.inspect(before);
    expect(snapshot).toEqual({ generation: null, state: before, inputs: null });
    await expect(journal.begin(snapshot, inputs, run, binding, "apply")).rejects.toThrow();
    expect(store.writes).toEqual([]);
    const ticket = await journal.begin(snapshot, inputs, run, binding, "baseline");
    await expect(journal.inspect(before)).rejects.toThrow();
    expect(store.get("current")).toEqual({ baseline: null, pending: ticket.generation });
    await journal.finish(ticket, before);
    expect((await journal.inspect(before)).inputs).toEqual(inputs);
    expect(store.writes.map((key) => key.split("/")[0])).toEqual([
      "intents",
      "current",
      "baselines",
      "current",
      "completed",
      "current",
    ]);
    await expect(
      journal.begin(await journal.inspect(before), inputs, run, binding, "baseline"),
    ).rejects.toThrow();
  });
  test("Apply retains intent/history and completes only with same-lineage advanced state", async () => {
    const { store, journal, snapshot } = await established();
    const ticket = await journal.begin(
      snapshot,
      { ...inputs, label: "changed" },
      run,
      binding,
      "apply",
    );
    await expect(journal.finish(ticket, before)).rejects.toThrow();
    await expect(
      journal.finish(ticket, { ...after, lineage: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow();
    await expect(journal.finish({ ...ticket, binding: "f".repeat(64) }, after)).rejects.toThrow();
    await journal.finish(ticket, after);
    const current = await journal.inspect(after);
    expect(current.generation).toBe(ticket.generation);
    expect(current.inputs).toEqual({ ...inputs, label: "changed" });
    expect(store.data.has(`baselines/${snapshot.generation}`)).toBe(true);
    await expect(journal.finish(ticket, after)).rejects.toThrow();
    await expect(journal.inspect(before)).rejects.toThrow();
  });
  test("stale snapshots, altered baseline inputs, state restore and out-of-band state updates stop", async () => {
    const { journal, snapshot } = await established();
    await expect(
      journal.begin({ ...snapshot, inputs: {} }, inputs, run, binding, "apply"),
    ).rejects.toThrow();
    await expect(
      journal.begin(
        { ...snapshot, generation: "22222222-2222-4222-8222-222222222222" },
        inputs,
        run,
        binding,
        "apply",
      ),
    ).rejects.toThrow();
    for (const state of [after, { ...before, serial: 9 }, { ...before, digest: "f".repeat(64) }])
      await expect(journal.inspect(state)).rejects.toThrow();
    const ticket = await journal.begin(snapshot, inputs, run, binding, "apply");
    await journal.finish(ticket, after);
    await expect(journal.begin(snapshot, inputs, run, binding, "apply")).rejects.toThrow();
  });
  test("missing referenced records and independently restored completion generations stop", async () => {
    for (const prefix of ["baselines", "intents", "completed"]) {
      const { store, journal, snapshot } = await established();
      store.data.delete(`${prefix}/${snapshot.generation}`);
      await expect(journal.inspect(before)).rejects.toThrow();
    }
    const { store, journal, snapshot } = await established();
    store.put(`completed/${snapshot.generation}`, {
      generation: snapshot.generation,
      baseline: "f".repeat(64),
    });
    await expect(journal.inspect(before)).rejects.toThrow();
  });
  test("failed/mismatching intent or pending-reference persistence never permits provider writes", async () => {
    for (const at of [1, 2]) {
      const { store, journal, snapshot } = await established();
      store.failWrite = store.writes.length + at;
      await expect(journal.begin(snapshot, inputs, run, binding, "apply")).rejects.toThrow();
      // No Apply occurs until begin returns a successfully persisted ticket.
      expect((await journal.inspect(before)).generation).toBe(snapshot.generation);
    }
    const { store, journal, snapshot } = await established();
    store.corruptReadback = true;
    await expect(journal.begin(snapshot, inputs, run, binding, "apply")).rejects.toThrow();
  });
  test("each interruption after intent publication fences later writes, including completion crashes", async () => {
    for (const at of [1, 2, 3, 4]) {
      const { store, journal, snapshot } = await established();
      const ticket = await journal.begin(snapshot, inputs, run, binding, "apply");
      store.failWrite = store.writes.length + at;
      await expect(journal.finish(ticket, after)).rejects.toThrow();
      store.failWrite = 0;
      await expect(journal.inspect(after)).rejects.toThrow();
      await expect(journal.begin(snapshot, inputs, run, binding, "apply")).rejects.toThrow();
      // Normal discovery refuses this operation; there is no automatic recovery/Apply retry.
      expect((store.get("current") as { pending: string }).pending).toBe(ticket.generation);
    }
  });
  test("storage/record failures never become missing-baseline authority", async () => {
    const { store, journal } = await established();
    store.readError = true;
    await expect(journal.inspect(before)).rejects.toThrow();
    store.readError = false;
    for (const value of [
      { baseline: null, pending: null },
      { baseline: "example.org", pending: null },
      { baseline: null, pending: null, unexpected: "private" },
    ]) {
      store.put("current", value);
      await expect(journal.inspect(before)).rejects.toThrow();
    }
  });
});

/** Show data is independently read after Apply; computed unknowns are not wildcard whole resources. */
const resource = {
  address: 'linode_instance.host["staging"]',
  mode: "managed",
  type: "linode_instance",
  name: "host",
  index: "staging",
  provider_name: "registry.opentofu.org/linode/linode",
  values: { id: "100", label: "example-staging", ipv4: null },
};
const plan = {
  format_version: "1.2",
  terraform_version: "1.12.6",
  errored: false,
  planned_values: {
    root_module: { resources: [resource] },
    outputs: { host: { sensitive: true, value: null } },
  },
  resource_changes: [{ address: resource.address, change: { after_unknown: { ipv4: true } } }],
  output_changes: { host: { after_unknown: true } },
};
const shown = {
  format_version: "1.0",
  terraform_version: "1.12.6",
  values: {
    root_module: {
      resources: [{ ...resource, values: { ...resource.values, ipv4: ["198.51.100.10"] } }],
    },
    outputs: { host: { sensitive: true, value: "198.51.100.10" } },
  },
};
describe("post-Apply verification", () => {
  test("known fields match; explicitly unknown computed fields may resolve", () => {
    expect(() => verifyAppliedPlan(plan, shown)).not.toThrow();
  });
  test("missing/extra resources, altered known fields, wrong formats and incomplete evidence stop", () => {
    for (const edit of [
      (s: typeof shown) => {
        s.format_version = "2.0";
      },
      (s: typeof shown) => {
        s.values.root_module.resources = [];
      },
      (s: typeof shown) => {
        const first = s.values.root_module.resources[0];
        if (first)
          s.values.root_module.resources.push({
            ...first,
            address: 'linode_instance.host["production"]',
          });
      },
      (s: typeof shown) => {
        const first = s.values.root_module.resources[0];
        if (first) first.values.label = "unexpected-private-label";
      },
      (s: typeof shown) => {
        s.values.outputs.host.sensitive = false;
      },
    ]) {
      const candidate = structuredClone(shown);
      edit(candidate);
      expect(() => verifyAppliedPlan(plan, candidate)).toThrow("invalid-control-record");
    }
    expect(() => verifyAppliedPlan({ ...plan, resource_changes: [] }, shown)).toThrow();
    expect(() => verifyAppliedPlan({ ...plan, output_changes: {} }, shown)).toThrow();
    expect(() =>
      verifyAppliedPlan(
        {
          ...plan,
          resource_changes: [{ address: resource.address, change: { after_unknown: {} } }],
        },
        shown,
      ),
    ).toThrow();
  });
});

describe("private phase adapter", () => {
  // The Docker build has no agent-specific scratch directory; use the platform temp root.
  const scratch = mkdtempSync(join(tmpdir(), "infra-control-test-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const values = {
    hosts: {},
    root_keys: ["invented-public-key"],
    configure_keys: {},
    root_password_hash: "",
    cloudflare_zone_id: "0".repeat(32),
    database_ids: {},
    db_allow_extra: [],
  };
  const noChanges = {
    format_version: "1.2",
    terraform_version: "1.12.6",
    errored: false,
    variables: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
    resource_changes: [],
    planned_values: {
      root_module: { resources: [] },
      outputs: { addresses: { value: {} }, hosts: { value: {} } },
    },
    output_changes: Object.fromEntries(
      ["addresses", "hosts"].map((key) => [
        key,
        { actions: ["no-op"], before: {}, after: {}, after_unknown: false },
      ]),
    ),
  };
  function runner() {
    const directory = mkdtempSync(join(scratch, "runner-"));
    const store = new MemoryStore();
    const journal = new InfrastructureJournal(store, codec, {
      verifyBaselineRun: verifyInventedBaselineRun,
    });
    const write = (name: string, value: unknown) =>
      writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
    writeFileSync(
      join(directory, "backend.hcl"),
      'bucket         = "state-bucket-example"\nendpoints      = { s3 = "https://us-east-1.example.org" }\nuse_path_style = false\n',
    );
    writeFileSync(join(directory, "plan.bin"), "invented encrypted plan bytes");
    write("values.tfvars.json", values);
    write("state.json", rawState);
    write("plan.json", noChanges);
    write("event.json", { inputs: { operation: "baseline" } });
    const env = {
      CONTROL_RECORDS_ENABLED: "true",
      AWS_ACCESS_KEY_ID: "invented-access",
      AWS_SECRET_ACCESS_KEY: "invented-secret",
      TF_VAR_state_passphrase: passphrase,
      GITHUB_SHA: run.commit,
      GITHUB_RUN_ID: run.run,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: join(directory, "event.json"),
    };
    const phase = (command: string) => controlPhase(command, directory, env, journal);
    const verify = () =>
      writeFileSync(join(directory, "verified.binding"), handoffBinding(directory, env));
    const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
    return { store, journal, env, directory, write, phase, verify, read };
  }
  test("reviewed baseline dispatch establishes unchanged state without an Apply", async () => {
    const r = runner();
    await r.phase("read");
    expect(r.read("baseline-inputs.json")).toBeNull();
    r.verify();
    await r.phase("baseline");
    expect((await r.journal.inspect(before)).inputs).toEqual(values);
    expect(r.store.writes).toHaveLength(6);
    await r.phase("read");
    expect(r.read("baseline-inputs.json")).toEqual(values);
  });
  test("disabled/invalid configuration cannot establish a baseline or retain old inputs", async () => {
    const r = runner();
    r.write("baseline-inputs.json", values);
    r.env.CONTROL_RECORDS_ENABLED = "false";
    await r.phase("read");
    expect(r.read("baseline-inputs.json")).toBeNull();
    expect(r.read("control-context.json")).toEqual({ enabled: false });
    r.verify();
    await expect(r.phase("baseline")).rejects.toThrow();
    expect(r.store.writes).toEqual([]);
    r.env.CONTROL_RECORDS_ENABLED = "typo";
    await expect(r.phase("read")).rejects.toThrow();
  });
  test("first baseline refuses changed/incomplete plans, wrong dispatch and altered state", async () => {
    for (const change of ["plan", "dispatch", "state", "binding"] as const) {
      const r = runner();
      await r.phase("read");
      if (change === "plan") r.write("plan.json", { ...noChanges, errored: true });
      if (change === "dispatch") r.write("event.json", { inputs: { operation: "apply" } });
      if (change === "state") r.write("state.json", { ...rawState, serial: 11 });
      r.verify();
      if (change === "binding") r.env.GITHUB_RUN_ID = "9999";
      await expect(r.phase("baseline")).rejects.toThrow();
      expect(r.store.writes).toEqual([]);
    }
  });
  test("Apply begins only on the bound baseline and completes only after known-value verification", async () => {
    const r = runner();
    await r.phase("read");
    r.verify();
    await r.phase("baseline");
    await r.phase("read");
    r.write("event.json", { inputs: { operation: "apply" } });
    r.write("plan.json", plan);
    r.verify();
    await r.phase("begin");
    r.write("state.json", { ...rawState, serial: 11, outputs: { invented: "changed" } });
    r.write("applied-state.json", {
      ...shown,
      values: { ...shown.values, root_module: { resources: [] } },
    });
    await expect(r.phase("finish")).rejects.toThrow();
    await expect(r.journal.inspect(after)).rejects.toThrow();
    r.write("applied-state.json", shown);
    await r.phase("finish");
    expect((await r.journal.inspect(after)).inputs).toEqual(values);
  });
  test("baseline generation/activation changes after Plan alter the private handoff binding", async () => {
    const r = runner();
    await r.phase("read");
    const original = handoffBinding(r.directory, r.env);
    r.write("control-context.json", { enabled: false });
    expect(handoffBinding(r.directory, r.env)).not.toBe(original);
  });
  test("CLI diagnostics contain no hostile JSON, backend, passphrase or stack trace", () => {
    const r = runner();
    r.write("backend.hcl", "hostile-private-marker");
    const output = Bun.spawnSync(
      [process.execPath, "scripts/infra-control-cli.ts", "read", r.directory],
      { env: r.env },
    );
    expect(output.exitCode).toBe(1);
    expect(output.stderr.toString()).toBe("");
    expect(output.stdout.toString()).toBe(
      "::error::Infrastructure control evidence or persistence failed; stop and reconcile any pending operation before another write.\n",
    );
  });
});

describe("scoped infrastructure journal factory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "infra-journal-factory-test-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const backend =
    'bucket         = "state-bucket-example"\nendpoints      = { s3 = "https://us-east-1.example.org" }\nuse_path_style = false\n';
  const environment = () => ({
    AWS_ACCESS_KEY_ID: "invented-access",
    AWS_SECRET_ACCESS_KEY: "invented-secret",
    // Neither supplied ambient session field authorizes a temporary credential in this factory.
    AWS_SESSION_TOKEN: "invented-unapproved-session",
    S3_SESSION_TOKEN: "invented-other-unapproved-session",
    TF_VAR_state_passphrase: passphrase,
    CONTROL_OWNER_ID: "123456",
    CONTROL_REPOSITORY_ID: "234567",
    CONTROL_OWNER_ENVIRONMENT_ID: "1010",
    CONTROL_OWNER_READ_TOKEN: "invented_owner_read_token_1234567890",
  });
  test("reopens historical raw-backend ciphertext and writes the same namespace through the scoped store", async () => {
    const directory = mkdtempSync(join(scratch, "compatible-"));
    writeFileSync(join(directory, "backend.hcl"), backend, { mode: 0o600 });
    const physicalPrefix = "tarubot/control/v1/infra/";
    const previous = "33333333-3333-4333-8333-333333333333";
    const originalCodec = new RecordCodec(
      passphrase,
      privateDigest({ backend, key: "tarubot/infra.tfstate" }),
    );
    const intent = {
      generation: previous,
      previous: null,
      kind: "baseline",
      run,
      binding,
      inputs,
      before,
    };
    const baseline = { intent, state: before };
    const objects = new Map<string, Uint8Array>();
    for (const [path, value] of [
      ["current", { baseline: previous, pending: null }],
      [`intents/${previous}`, intent],
      [`baselines/${previous}`, baseline],
      [`completed/${previous}`, { generation: previous, baseline: privateDigest(baseline) }],
    ] as const)
      objects.set(physicalPrefix + path, originalCodec.seal(path, value));
    const options: Bun.S3Options[] = [];
    const calls: string[] = [];
    const requests: GitHubReadRequest[] = [];
    const api = "https://api.github.com/repos/deconfined/tarubot";
    const ownerRecord: Record<string, unknown> = {
      schema: 1,
      target: "infra",
      backend: privateDigest({ backend, key: "tarubot/infra.tfstate" }),
      namespace: physicalPrefix,
      revision: "44444444-4444-4444-8444-444444444444",
      repair: { mode: "never-repaired" },
    };
    const observed = 1_800_000_000_000;
    const nextRun = { commit: run.commit, run: "5678" };
    const executionData = {
      ...baselineRunFixture({ kind: "baseline", run }).data,
      ...baselineRunFixture({ kind: "apply", run: nextRun }).data,
    };
    const journal = infrastructureJournal(directory, environment(), {
      now: () => observed,
      async get(request) {
        requests.push(structuredClone(request));
        const data: Record<string, unknown> = {
          ...executionData,
          [api]: {
            id: 234567,
            full_name: "deconfined/tarubot",
            fork: false,
            owner: { id: 123456, login: "deconfined" },
          },
          [`${api}/environments/control-infra`]: {
            id: 1010,
            name: "control-infra",
            url: `${api}/environments/control-infra`,
          },
          [`${api}/environments/control-infra/variables/CONTROL_OWNER_ANCHOR`]: {
            name: "CONTROL_OWNER_ANCHOR",
            value: JSON.stringify(ownerRecord),
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        };
        if (!Object.hasOwn(data, request.url)) throw new Error("unexpected-invented-owner-api");
        return {
          status: 200,
          url: request.url,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(data[request.url])),
        };
      },
      // Native-shaped streams/presigns exercise the actual scoped factory and owner guard.
      createClient(native) {
        options.push(structuredClone(native));
        return {
          presign(key: string) {
            const url = new URL(`${native.endpoint}/${key}`);
            url.searchParams.set("X-Amz-Date", "20260930T000000Z");
            url.searchParams.set(
              "X-Amz-Credential",
              `${native.accessKeyId}/20260930/${native.region}/s3/aws4_request`,
            );
            return url.toString();
          },
          file(key: string) {
            calls.push(key);
            return {
              stream: () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    const bytes = objects.get(key);
                    if (bytes) {
                      controller.enqueue(Uint8Array.from(bytes));
                      controller.close();
                    } else
                      controller.error(
                        Object.assign(new Error("invented-absence"), { code: "NoSuchKey" }),
                      );
                  },
                }),
            };
          },
          async write(key: string, bytes: Uint8Array) {
            calls.push(key);
            objects.set(key, Uint8Array.from(bytes));
            return bytes.length;
          },
        } as unknown as Bun.S3Client;
      },
    });
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.keys(journal)).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(options[0]).toMatchObject({
      endpoint: "https://state-bucket-example.us-east-1.example.org",
      virtualHostedStyle: true,
      sessionToken: "",
      retry: 0,
    });
    const snapshot = await journal.inspect(before);
    expect(snapshot).toEqual({ generation: previous, inputs, state: before });
    const ticket = await journal.begin(snapshot, inputs, nextRun, binding, "apply");
    await journal.finish(ticket, after);
    expect(await journal.inspect(after)).toEqual({
      generation: ticket.generation,
      inputs,
      state: after,
    });
    const latest = objects.get(`${physicalPrefix}current`);
    expect(latest).toBeDefined();
    if (!latest) throw new Error("missing-invented-current-record");
    expect(originalCodec.open("current", latest)).toEqual({
      baseline: ticket.generation,
      pending: null,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((path) => path.startsWith(physicalPrefix))).toBe(true);
    expect(objects.has("tarubot/infra.tfstate")).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (request) =>
          request.headers.Authorization === `Bearer ${environment().CONTROL_OWNER_READ_TOKEN}`,
      ),
    ).toBe(true);
    expect(
      requests.some((request) => request.url.endsWith("/variables/CONTROL_OWNER_ANCHOR")),
    ).toBe(true);
    // A completed ordinary pointer does not bypass an independently fenced owner scope.
    ownerRecord.revision = "66666666-6666-4666-8666-666666666666";
    ownerRecord.repair = { mode: "repairing", generation: "55555555-5555-4555-8555-555555555555" };
    const count = calls.length;
    await expect(journal.inspect(after)).rejects.toThrow("control-consumer-read-failed");
    expect(calls).toHaveLength(count);
  });
  test("missing credentials, owner configuration or noncanonical unsafe IDs stop before native/GitHub effects", () => {
    const directory = mkdtempSync(join(scratch, "invalid-"));
    writeFileSync(join(directory, "backend.hcl"), backend, { mode: 0o600 });
    let created = false;
    let fetched = false;
    const changes: NodeJS.ProcessEnv[] = [
      { AWS_ACCESS_KEY_ID: "" },
      { AWS_SECRET_ACCESS_KEY: "" },
      { TF_VAR_state_passphrase: "short" },
      { CONTROL_OWNER_READ_TOKEN: "" },
      { CONTROL_OWNER_READ_TOKEN: undefined },
      { CONTROL_OWNER_READ_TOKEN: "short" },
      { CONTROL_OWNER_READ_TOKEN: "invented\nprivate-token" },
    ];
    for (const name of [
      "CONTROL_OWNER_ID",
      "CONTROL_REPOSITORY_ID",
      "CONTROL_OWNER_ENVIRONMENT_ID",
    ])
      for (const value of [
        undefined,
        "",
        "0",
        "01",
        "+1",
        "-1",
        "1.0",
        " 1",
        "1 ",
        "1e3",
        "0x10",
        "9007199254740992",
        "999999999999999999999",
      ])
        changes.push({ [name]: value });
    for (const changed of changes)
      expect(() =>
        infrastructureJournal(
          directory,
          { ...environment(), ...changed },
          {
            createClient() {
              created = true;
              throw new Error("unexpected-invented-storage-construction");
            },
            async get() {
              fetched = true;
              throw new Error("unexpected-invented-owner-api");
            },
          },
        ),
      ).toThrow("invalid-control-evidence");
    expect(created).toBe(false);
    expect(fetched).toBe(false);
  });
  test("default disabled-control read needs neither owner configuration, backend nor native transport", async () => {
    const directory = mkdtempSync(join(scratch, "disabled-"));
    await controlPhase("read", directory, { CONTROL_RECORDS_ENABLED: "false" });
    expect(JSON.parse(readFileSync(join(directory, "control-context.json"), "utf8"))).toEqual({
      enabled: false,
    });
    expect(JSON.parse(readFileSync(join(directory, "baseline-inputs.json"), "utf8"))).toBeNull();
    await expect(
      controlPhase("read", directory, { CONTROL_RECORDS_ENABLED: "true" }),
    ).rejects.toThrow("invalid-control-evidence");
  });
});

describe("Bun S3 transport boundary", () => {
  test("only definite NoSuchKey is absence; every other failure remains an error", async () => {
    for (const code of ["NoSuchKey", "AccessDenied", "NoSuchBucket", "Timeout", "404"]) {
      const client = {
        file: () => ({
          arrayBuffer: async () => {
            throw Object.assign(new Error("invented-secret-diagnostic"), { code });
          },
        }),
      };
      const store = new S3ControlStore(client as unknown as Bun.S3Client);
      if (code === "NoSuchKey") expect(await store.read("current")).toBeNull();
      else await expect(store.read("current")).rejects.toThrow("control-storage-read-failed");
    }
  });
  test("objects use a private separate prefix, binary content and no automatic upload retries", async () => {
    const calls: unknown[] = [];
    const client = {
      file: (key: string) => {
        calls.push(key);
        return { arrayBuffer: async () => Uint8Array.from([1, 2]).buffer };
      },
      write: async (...args: unknown[]) => {
        calls.push(args);
      },
    };
    const store = new S3ControlStore(client as unknown as Bun.S3Client);
    expect(await store.read("current")).toEqual(new Uint8Array([1, 2]));
    await store.write("current", new Uint8Array([3]));
    expect(calls).toEqual([
      "tarubot/control/v1/infra/current",
      [
        "tarubot/control/v1/infra/current",
        new Uint8Array([3]),
        { type: "application/octet-stream", retry: 0 },
      ],
    ]);
  });
});
