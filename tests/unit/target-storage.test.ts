/** Invented native streams/credentials and local presigning only: no S3 HTTP or owner action. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { privateDigest } from "../../scripts/infra-control.js";
import type { AppliedTargetEnvelope } from "../../scripts/target-descriptor.js";
import type {
  AppliedTargetContext,
  AppliedTargetJobProof,
  AppliedTargetJobRequest,
} from "../../scripts/target-handoff.js";
import {
  createTargetDescriptorConsumer,
  createTargetDescriptorProducer,
  type TargetDescriptorStorageConfig,
} from "../../scripts/target-storage.js";

const instant = 1_800_000_000_000;
const generation = "11111111-1111-4111-8111-111111111111";
function configuration(
  target: "staging" | "production" = "staging",
): TargetDescriptorStorageConfig {
  return {
    target,
    bucket: "invented-bucket",
    endpoint: "https://region.example.org",
    region: "us-east-1",
    credentials: {
      accessKeyId: "invented_access",
      secretAccessKey: "invented-private-secret",
      sessionToken: null,
    },
    descriptor_passphrase: "invented-dedicated-descriptor-passphrase".repeat(2),
  };
}
function fixture(
  target: "staging" | "production" = "staging",
  mode: "apply" | "no-changes" = "apply",
) {
  const release = {
    version: "2.36.13",
    commit: "1".repeat(40),
    config_commit: "1".repeat(40),
    digest: `sha256:${"2".repeat(64)}`,
    publication_run: "1234",
    schema_head: "001_initial.sql",
  };
  const producer = {
    repository: "deconfined/tarubot" as const,
    workflow_ref: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main" as const,
    ref: "refs/heads/main" as const,
    event: "push" as const,
    attempt: 1 as const,
    commit: release.commit,
    run: release.publication_run,
  };
  const context: AppliedTargetContext = { target, release, producer };
  const state = {
    lineage: "22222222-2222-4222-8222-222222222222",
    serial: 5,
    digest: "3".repeat(64),
  };
  const baselineDigest = "4".repeat(64);
  const envelope: AppliedTargetEnvelope = {
    schema: 1,
    purpose: "tarubot-applied-target-v1",
    descriptor: {
      schema: 1,
      target,
      provider: "linode",
      instance_id: "123",
      fqdn: `${target}.example.org`,
      addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
      dns_zone_id: "5".repeat(32),
      applied_generation: generation,
      state,
    },
    release,
    verification: { mode, producer },
    baseline: {
      generation,
      state,
      run:
        mode === "apply"
          ? { commit: producer.commit, run: producer.run }
          : { commit: "e".repeat(40), run: "987" },
      binding: "6".repeat(64),
      baseline_digest: baselineDigest,
      completion_digest: privateDigest({ generation, baseline: baselineDigest }),
    },
  };
  return { context, envelope, expires_at: instant + 3_600_000 };
}
function proof(request: AppliedTargetJobRequest, now = instant): AppliedTargetJobProof {
  return {
    schema: 1,
    purpose: "tarubot-applied-target-job-proof-v1",
    receipt: structuredClone(request.receipt),
    producer: structuredClone(request.receipt.producer),
    head_commit: request.receipt.release.commit,
    workflow_ref: request.job.workflow_ref,
    workflow_commit: request.job.workflow_commit,
    job_name: request.job.job_name,
    job_id: 321,
    status: "completed",
    conclusion: "success",
    critical_step: {
      name: request.job.critical_step,
      number: 7,
      status: "completed",
      conclusion: "success",
    },
    observed_at: now,
    expires_at: now + 30_000,
  };
}
function missing(code = "NoSuchKey"): Error {
  return Object.assign(new Error("invented-private-native-diagnostic"), { code });
}
function fake() {
  const records = new Map<string, Uint8Array>();
  const calls: Array<{ method: string; key: string; options?: Bun.S3Options }> = [];
  const clients: Array<{
    file: (key: string, options: Bun.S3Options) => unknown;
    presign: (key: string) => string;
    write: (key: string, bytes: Uint8Array, options: Bun.S3Options) => Promise<number>;
  }> = [];
  const options: Bun.S3Options[] = [];
  let streamOverride: ((key: string) => ReadableStream<Uint8Array>) | undefined;
  let beforeWrite: (() => Promise<void>) | undefined;
  let afterWrite: (() => Promise<void>) | undefined;
  let changeUrl: ((url: URL) => void) | undefined;
  let cancelled = 0;
  const createClient = (supplied: Bun.S3Options) => {
    const config = structuredClone(supplied);
    options.push(config);
    const client = {
      presign(key: string) {
        calls.push({ method: "presign", key });
        const url = new URL(`${config.endpoint}/${key}`);
        url.searchParams.set("X-Amz-Date", "20260930T000000Z");
        url.searchParams.set(
          "X-Amz-Credential",
          `${config.accessKeyId}/20260930/${config.region}/s3/aws4_request`,
        );
        if (config.sessionToken) url.searchParams.set("X-Amz-Security-Token", config.sessionToken);
        changeUrl?.(url);
        return url.toString();
      },
      file(key: string, suppliedOptions: Bun.S3Options) {
        calls.push({ method: "read", key, options: structuredClone(suppliedOptions) });
        return {
          stream() {
            if (streamOverride) return streamOverride(key);
            return new ReadableStream<Uint8Array>({
              start(controller) {
                const bytes = records.get(key);
                if (!bytes) controller.error(missing());
                else {
                  controller.enqueue(Uint8Array.from(bytes));
                  controller.close();
                }
              },
              cancel() {
                cancelled++;
              },
            });
          },
        };
      },
      async write(key: string, bytes: Uint8Array, suppliedOptions: Bun.S3Options) {
        calls.push({ method: "write", key, options: structuredClone(suppliedOptions) });
        await beforeWrite?.();
        records.set(key, Uint8Array.from(bytes));
        await afterWrite?.();
        return bytes.length;
      },
    };
    clients.push(client);
    return client as unknown as Bun.S3Client;
  };
  return {
    records,
    calls,
    options,
    clients,
    createClient,
    stream(value: typeof streamOverride) {
      streamOverride = value;
    },
    beforeWrite(value: typeof beforeWrite) {
      beforeWrite = value;
    },
    afterWrite(value: typeof afterWrite) {
      afterWrite = value;
    },
    changeUrl(value: typeof changeUrl) {
      changeUrl = value;
    },
    cancelled: () => cancelled,
  };
}
async function refused(action: Promise<unknown>, message = "target-storage-seal-failed") {
  try {
    await action;
    throw new Error("expected-invented-refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  }
}
function io(f: ReturnType<typeof fake>) {
  return f.calls.filter((call) => call.method !== "presign");
}

describe("descriptor-only native handoff capabilities", () => {
  test("both roles/modes persist encrypted exact bytes in distinct namespaces and consume with private job authentication", async () => {
    const namespaces = new Set<string>();
    for (const target of ["staging", "production"] as const)
      for (const mode of ["apply", "no-changes"] as const) {
        const f = fake();
        const config = configuration(target);
        const request = fixture(target, mode);
        const producer = createTargetDescriptorProducer(config, {
          createClient: f.createClient,
          now: () => instant,
        });
        const receipt = await producer.seal(request);
        const seen: AppliedTargetJobRequest[] = [];
        const consumer = createTargetDescriptorConsumer(config, {
          createClient: f.createClient,
          now: () => instant,
          verifyProducerJob: async (r) => {
            seen.push(structuredClone(r));
            return proof(r);
          },
        });
        const result = await consumer.consume({ context: request.context, receipt });
        namespaces.add(producer.namespace);
        expect(producer.namespace).toBe(`tarubot/applied-target/v1/${target}/`);
        expect(receipt.backend).toBe(producer.binding);
        expect(consumer.binding).toBe(producer.binding);
        expect(result.envelope).toEqual(request.envelope);
        expect(seen[0]?.receipt).toEqual(receipt);
        expect(result.envelope.baseline.binding).not.toBe(producer.binding);
        expect(f.records.size).toBe(1);
        const bytes = f.records.get(producer.namespace + receipt.path);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(
          Buffer.from(bytes ?? [])
            .subarray(0, 4)
            .toString(),
        ).toBe("TIC1");
        expect(Buffer.from(bytes ?? []).toString()).not.toContain(`${target}.example.org`);
        expect(io(f).map((call) => call.method)).toEqual(["read", "write", "read", "read", "read"]);
        expect(
          io(f).every(
            (call) => call.key === producer.namespace + receipt.path && call.options?.retry === 0,
          ),
        ).toBe(true);
        expect(f.options[0]).toMatchObject({
          endpoint: "https://invented-bucket.region.example.org",
          virtualHostedStyle: true,
          retry: 0,
          sessionToken: "",
        });
        expect(Reflect.get(consumer, "seal")).toBeUndefined();
        expect(Reflect.get(consumer, "write")).toBeUndefined();
        expect(Reflect.get(producer, "consume")).toBeUndefined();
        expect(Reflect.get(producer, "read")).toBeUndefined();
      }
    expect(namespaces.size).toBe(2);
  });
  test("public metadata hides credentials/passphrase/client/functions and entry snapshots survive external mutation", async () => {
    const f = fake();
    const config = configuration();
    config.credentials.sessionToken = "invented-private-session";
    const deps = { createClient: f.createClient, now: () => instant };
    const producer = createTargetDescriptorProducer(config, deps);
    expect(Object.keys(producer).sort()).toEqual(["binding", "namespace", "target"]);
    for (const diagnostic of [JSON.stringify(producer), Bun.inspect(producer)])
      for (const secret of [...Object.values(config.credentials), config.descriptor_passphrase])
        if (secret !== null) expect(diagnostic).not.toContain(secret);
    for (const field of [
      "captured",
      "config",
      "store",
      "client",
      "handoff",
      "now",
      "key",
      "allowed",
      "fenced",
      "busy",
    ])
      expect(Reflect.get(producer, field)).toBeUndefined();
    for (const [field, value] of [
      ["config", configuration("production")],
      ["store", { write: () => {} }],
      ["binding", "f".repeat(64)],
      ["seal", () => {}],
      ["target", "production"],
    ] as const)
      expect(Reflect.set(producer, field, value)).toBe(false);
    config.target = "production";
    config.endpoint = "https://other.example.org";
    config.descriptor_passphrase = "different-private-descriptor-passphrase";
    config.credentials.secretAccessKey = "changed-secret";
    deps.createClient = () => {
      throw new Error("replacement-never-called");
    };
    deps.now = () => instant + 60_001;
    const client = f.clients[0];
    if (!client) throw new Error("missing-invented-client");
    client.file = () => {
      throw new Error("replaced-never-called");
    };
    client.write = async () => {
      throw new Error("replaced-never-called");
    };
    const receipt = await producer.seal(fixture());
    expect(receipt.target).toBe("staging");
    expect(io(f).every((call) => call.key.startsWith("tarubot/applied-target/v1/staging/"))).toBe(
      true,
    );
  });
  test("malformed/accessor/incomplete route and missing private verifier reject before native client creation", () => {
    for (const edit of [
      { target: "infra" },
      { bucket: "dotted.bucket" },
      { bucket: "ab" },
      { endpoint: "http://region.example.org" },
      { endpoint: "https://192.0.2.10" },
      { endpoint: "https://region.example.org/" },
      { endpoint: "https://region.example.org?other" },
      { endpoint: "https://invented-bucket.region.example.org" },
      { region: "Upper" },
      { descriptor_passphrase: "short" },
      { state_passphrase: "invented-forbidden-state-key" },
    ]) {
      const f = fake();
      expect(() =>
        createTargetDescriptorProducer(
          { ...configuration(), ...edit } as TargetDescriptorStorageConfig,
          { createClient: f.createClient },
        ),
      ).toThrow("invalid-target-storage");
      expect(f.options).toHaveLength(0);
    }
    const f = fake();
    const config = configuration();
    let invoked = false;
    Object.defineProperty(config, "credentials", {
      enumerable: true,
      get() {
        invoked = true;
        return {};
      },
    });
    expect(() => createTargetDescriptorProducer(config, { createClient: f.createClient })).toThrow(
      "invalid-target-storage",
    );
    expect(invoked).toBe(false);
    expect(() =>
      createTargetDescriptorConsumer(configuration(), {
        createClient: f.createClient,
        verifyProducerJob: undefined as unknown as (
          r: AppliedTargetJobRequest,
        ) => Promise<AppliedTargetJobProof>,
      }),
    ).toThrow("invalid-target-storage");
    expect(f.options).toHaveLength(0);
  });
  test("immutable existing record and uncertain acknowledged PUT stop without overwrite/retry", async () => {
    const f = fake();
    const producer = createTargetDescriptorProducer(configuration(), {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(fixture());
    const key = producer.namespace + receipt.path;
    const exactBytes = Uint8Array.from(f.records.get(key) ?? []);
    await refused(producer.seal(fixture()));
    expect(io(f).filter((call) => call.method === "write")).toHaveLength(1);
    expect(f.records.get(key)).toEqual(exactBytes);
    const uncertain = fake();
    uncertain.afterWrite(async () => {
      throw new Error("private-ack-failure");
    });
    const writer = createTargetDescriptorProducer(configuration(), {
      createClient: uncertain.createClient,
      now: () => instant,
    });
    await refused(writer.seal(fixture()));
    expect(uncertain.records.size).toBe(1);
    const calls = uncertain.calls.length;
    await refused(writer.seal(fixture()));
    expect(uncertain.calls).toHaveLength(calls);
    expect(io(uncertain).map((call) => call.method)).toEqual(["read", "write"]);
  });
  test("route/target/dedicated key bind decryption and receipt validation before private job verification", async () => {
    const f = fake();
    const config = configuration();
    const request = fixture();
    const producer = createTargetDescriptorProducer(config, {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(request);
    for (const edit of [
      { target: "production" },
      { bucket: "other-bucket" },
      { endpoint: "https://other.example.org" },
      { region: "other-region" },
      { descriptor_passphrase: "different-dedicated-descriptor-key".repeat(2) },
    ]) {
      let verified = false;
      const consumer = createTargetDescriptorConsumer(
        { ...configuration(), ...edit } as TargetDescriptorStorageConfig,
        {
          createClient: f.createClient,
          now: () => instant,
          verifyProducerJob: async (r) => {
            verified = true;
            return proof(r);
          },
        },
      );
      await refused(
        consumer.consume({ context: request.context, receipt }),
        "target-storage-consume-failed",
      );
      expect(verified).toBe(false);
    }
    const renewed = configuration();
    renewed.credentials.secretAccessKey = "rotated-invented-secret";
    const consumer = createTargetDescriptorConsumer(renewed, {
      createClient: f.createClient,
      now: () => instant,
      verifyProducerJob: async (r) => proof(r),
    });
    expect(consumer.binding).toBe(producer.binding);
    expect((await consumer.consume({ context: request.context, receipt })).envelope).toEqual(
      request.envelope,
    );
  });
  test("NoSuchKey is absence only before bytes; wrong bucket/403/bare404/partial/truncated/oversized streams refuse", async () => {
    const failures: Array<() => ReadableStream<Uint8Array>> = [
      () =>
        new ReadableStream({
          start(controller) {
            controller.error(missing("NoSuchBucket"));
          },
        }),
      () =>
        new ReadableStream({
          start(controller) {
            controller.error(missing("AccessDenied"));
          },
        }),
      () =>
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("private"), { status: 404 }));
          },
        }),
      () => {
        let index = 0;
        return new ReadableStream({
          pull(controller) {
            if (index++ === 0) controller.enqueue(Uint8Array.from([1]));
            else controller.error(missing());
          },
        });
      },
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(31));
            controller.close();
          },
        }),
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65_569));
            controller.close();
          },
        }),
      () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
    ];
    for (const stream of failures) {
      const f = fake();
      f.stream(stream);
      const producer = createTargetDescriptorProducer(configuration(), {
        createClient: f.createClient,
        now: () => instant,
      });
      await refused(producer.seal(fixture()));
      expect(io(f).filter((call) => call.method === "write")).toHaveLength(0);
    }
  });
  test("client presigning rejects ambient/foreign token, credential scope, route and path before native I/O", async () => {
    for (const edit of [
      (url: URL) => url.searchParams.set("X-Amz-Security-Token", "invented-ambient-token"),
      (url: URL) =>
        url.searchParams.set("X-Amz-Credential", "foreign/20260930/us-east-1/s3/aws4_request"),
      (url: URL) => {
        url.hostname = "other.example.org";
      },
      (url: URL) => {
        url.pathname = "/tarubot/infra.tfstate";
      },
      (url: URL) => url.searchParams.append("X-Amz-Credential", "duplicate"),
    ]) {
      const f = fake();
      f.changeUrl(edit);
      expect(() =>
        createTargetDescriptorProducer(configuration(), { createClient: f.createClient }),
      ).toThrow("invalid-target-storage");
      expect(io(f)).toHaveLength(0);
    }
    const f = fake();
    const producer = createTargetDescriptorProducer(configuration(), {
      createClient: f.createClient,
      now: () => instant,
    });
    f.changeUrl((url) => url.searchParams.set("X-Amz-Security-Token", "invented-late-token"));
    await refused(producer.seal(fixture()));
    expect(io(f)).toHaveLength(0);
  });
  test("foreign/malformed private paths and unknown producer identities never enter native I/O", async () => {
    const f = fake();
    const config = configuration();
    const request = fixture();
    const producer = createTargetDescriptorProducer(config, {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(request);
    const consumer = createTargetDescriptorConsumer(config, {
      createClient: f.createClient,
      now: () => instant,
      verifyProducerJob: async (r) => proof(r),
    });
    const count = io(f).length;
    for (const path of [
      "current",
      "trust/staging/current",
      "tarubot/infra.tfstate",
      `../${receipt.path}`,
      `${receipt.path}?versionId=foreign`,
      receipt.path.replace("staging", "production"),
      receipt.path.replace("1234", "9007199254740992"),
    ])
      await refused(
        consumer.consume({ context: request.context, receipt: { ...receipt, path } }),
        "target-storage-consume-failed",
      );
    expect(io(f)).toHaveLength(count);
    await refused(
      consumer.consume({
        context: { ...request.context, producer: { ...request.context.producer, attempt: 2 as 1 } },
        receipt,
      }),
      "target-storage-consume-failed",
    );
    expect(io(f)).toHaveLength(count);
  });
});

describe("native target transport deadline and private authentication", () => {
  test("outer clock rollback/expiry after writes refuses readback and permanently fences uncertain writer", async () => {
    const f = fake();
    let clock = instant;
    f.afterWrite(async () => {
      clock = instant - 1;
    });
    const producer = createTargetDescriptorProducer(configuration(), {
      createClient: f.createClient,
      now: () => clock,
    });
    await refused(producer.seal(fixture()));
    expect(f.records.size).toBe(1);
    expect(io(f).map((call) => call.method)).toEqual(["read", "write"]);
    clock = instant;
    const calls = io(f).length;
    await refused(producer.seal(fixture()));
    expect(io(f)).toHaveLength(calls);
  });
  test("late PUT acknowledgement persists uncertain bytes but cannot trigger final readback or retry", async () => {
    const f = fake();
    const request = fixture();
    // KDF work is inside the physical budget; leave enough for it before the slow PUT begins.
    request.expires_at = instant + 1200;
    let completePut: (() => void) | undefined;
    const putCompleted = new Promise<void>((resolve) => {
      completePut = resolve;
    });
    f.afterWrite(async () => {
      await Bun.sleep(1250);
      completePut?.();
    });
    const producer = createTargetDescriptorProducer(configuration(), {
      createClient: f.createClient,
      now: () => instant,
    });
    await refused(producer.seal(request));
    expect(f.records.size).toBe(1);
    const count = io(f).length;
    // Wait for the deliberately late acknowledgement, rather than assuming a fixed post-timeout
    // pause outlasts scrypt/PUT scheduling on a loaded runner. It still cannot cause readback.
    await putCompleted;
    await Bun.sleep(1);
    expect(io(f).map((call) => call.method)).toEqual(["read", "write"]);
    await refused(producer.seal(request));
    expect(io(f)).toHaveLength(count);
  });
  test("unfinished stream cancels without waiting for cancellation acknowledgement at receipt expiry", async () => {
    const f = fake();
    let cancelled = false;
    f.stream(
      () =>
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
    );
    const request = fixture();
    request.expires_at = instant + 1200;
    const producer = createTargetDescriptorProducer(configuration(), {
      createClient: f.createClient,
      now: () => instant,
    });
    await refused(producer.seal(request));
    await Bun.sleep(1);
    expect(cancelled).toBe(true);
    expect(io(f).filter((call) => call.method === "write")).toHaveLength(0);
  });
  test("consumer requires independent exact fresh private job proof and no native PUT exists even with broader client", async () => {
    const f = fake();
    const request = fixture();
    const config = configuration();
    const producer = createTargetDescriptorProducer(config, {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(request);
    const writeCount = io(f).filter((call) => call.method === "write").length;
    for (const invalidProof of [
      true,
      { conclusion: "success" },
      {
        ...proof({
          receipt,
          job: {
            workflow_ref: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
            workflow_commit: request.context.release.commit,
            job_name: "Apply infrastructure",
            critical_step: "Seal applied target descriptor",
          },
          requested_at: instant,
        }),
        receipt: { ...receipt, ciphertext_digest: "f".repeat(64) },
      },
    ]) {
      const consumer = createTargetDescriptorConsumer(config, {
        createClient: f.createClient,
        now: () => instant,
        verifyProducerJob: async () => invalidProof as AppliedTargetJobProof,
      });
      await refused(
        consumer.consume({ context: request.context, receipt }),
        "target-storage-consume-failed",
      );
    }
    const consumer = createTargetDescriptorConsumer(config, {
      createClient: f.createClient,
      now: () => instant,
      verifyProducerJob: async (r) => proof(r),
    });
    expect(Reflect.get(consumer, "seal")).toBeUndefined();
    expect(Reflect.get(consumer, "write")).toBeUndefined();
    expect(io(f).filter((call) => call.method === "write")).toHaveLength(writeCount);
  });
  test("consumer never even reads a backing write capability and captures its verifier once", async () => {
    const f = fake();
    const config = configuration();
    const request = fixture();
    const producer = createTargetDescriptorProducer(config, {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(request);
    let accessed = false;
    const deps = {
      createClient: (options: Bun.S3Options) => {
        const client = f.createClient(options);
        Object.defineProperty(client, "write", {
          get() {
            accessed = true;
            throw new Error("consumer-must-not-acquire-put-capability");
          },
        });
        return client;
      },
      verifyProducerJob: async (r: AppliedTargetJobRequest) => proof(r),
      now: () => instant,
    };
    const consumer = createTargetDescriptorConsumer(config, deps);
    deps.verifyProducerJob = async () => {
      throw new Error("replacement-not-called");
    };
    expect((await consumer.consume({ context: request.context, receipt })).envelope).toEqual(
      request.envelope,
    );
    expect(accessed).toBe(false);
    expect(Object.keys(consumer).sort()).toEqual(["binding", "namespace", "target"]);
    expect(JSON.stringify(consumer)).not.toContain(config.descriptor_passphrase);
  });
  test("late private job verification cannot continue to final ciphertext readback after consumer expiry", async () => {
    const f = fake();
    const config = configuration();
    const request = fixture();
    request.expires_at = instant + 1200;
    const producer = createTargetDescriptorProducer(config, {
      createClient: f.createClient,
      now: () => instant,
    });
    const receipt = await producer.seal(request);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const consumer = createTargetDescriptorConsumer(config, {
      createClient: f.createClient,
      now: () => instant,
      verifyProducerJob: async (r) => {
        entered = true;
        await gate;
        return proof(r);
      },
    });
    const previousReads = io(f).filter((call) => call.method === "read").length;
    await refused(
      consumer.consume({ context: request.context, receipt }),
      "target-storage-consume-failed",
    );
    expect(entered).toBe(true);
    release?.();
    await Bun.sleep(1);
    expect(io(f).filter((call) => call.method === "read")).toHaveLength(previousReads + 1);
    expect(io(f).filter((call) => call.method === "write")).toHaveLength(1);
  });
  test("native PUT20s bound refuses success independently of the enclosing60s budget and frozen wall clock", () => {
    const modulePath = new URL("../../scripts/target-storage.ts", import.meta.url).pathname;
    // Isolate the test-only monotonic-clock replacement; every stream/signature uses invented data.
    const program = `
      import { performance } from "node:perf_hooks";
      let elapsed = 0, reads = 0, writes = 0;
      Object.defineProperty(performance, "now", { value: () => elapsed });
      const { createTargetDescriptorProducer } = await import(${JSON.stringify(modulePath)});
      const config = ${JSON.stringify(configuration())};
      const producer = createTargetDescriptorProducer(config, { now: () => ${instant},
        createClient: options => ({
          presign(key) {
            const url = new URL(options.endpoint + "/" + key);
            url.searchParams.set("X-Amz-Date", "20260930T000000Z");
            url.searchParams.set("X-Amz-Credential", options.accessKeyId + "/20260930/" + options.region + "/s3/aws4_request");
            return url.toString();
          },
          file() { reads++; return { stream() { return new ReadableStream({ start(controller) {
            controller.error(Object.assign(new Error("invented"), { code: "NoSuchKey" }));
          } }); } }; },
          async write() { writes++; elapsed = 20001; return 100; },
        }),
      });
      let status = "unexpected-success";
      try { await producer.seal(${JSON.stringify(fixture())}); }
      catch (error) { status = error.message; }
      console.log(JSON.stringify({ status, reads, writes }));
    `;
    const child = spawnSync(process.execPath, ["--no-env-file", "-e", program], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 16384,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({
      status: "target-storage-seal-failed",
      reads: 1,
      writes: 1,
    });
  });
  test("default Bun factory uses credential-free local presigning and refuses ambient session fallback", () => {
    const modulePath = new URL("../../scripts/target-storage.ts", import.meta.url).pathname;
    const config = configuration();
    for (const ambient of [false, true]) {
      const program = `
        const { createTargetDescriptorProducer } = await import(${JSON.stringify(modulePath)});
        let result;
        try { const value = createTargetDescriptorProducer(${JSON.stringify(config)});
          result = { status: "ready", namespace: value.namespace, keys: Object.keys(value).sort() };
        } catch (error) { result = { status: error.message }; }
        console.log(JSON.stringify(result));
      `;
      const child = spawnSync(process.execPath, ["--no-env-file", "-e", program], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 16384,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          ...(ambient ? { AWS_SESSION_TOKEN: "invented-ambient-session" } : {}),
        },
      });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual(
        ambient
          ? { status: "invalid-target-storage" }
          : {
              status: "ready",
              namespace: "tarubot/applied-target/v1/staging/",
              keys: ["binding", "namespace", "target"],
            },
      );
    }
  });
});
