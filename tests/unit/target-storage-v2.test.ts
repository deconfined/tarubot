/** Real invented RSA/JWKS and native-shaped GitHub/S3 evidence; no network, secrets or host. */
import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import { privateDigest } from "../../scripts/infra-control.js";
import type { AppliedTargetEnvelope } from "../../scripts/target-descriptor.js";
import {
  assertAuthenticatedTargetContentV2,
  createTargetContentV2Consumer,
  createTargetContentV2Producer,
  withinAuthenticatedTargetContentV2,
  type TargetContentV2StorageConfiguration,
} from "../../scripts/target-storage-v2.js";
import {
  targetIssuanceAudience,
  targetIssuancePins as pins,
  type ContentReceiptV2,
  type TargetIssuanceStatementV2,
} from "../../scripts/target-issuance.js";
import type { GitHubReader } from "../../scripts/trust-run.js";
const instant = 1_800_000_000_000,
  api = "https://api.github.com/repos/deconfined/tarubot",
  jwks = "https://token.actions.githubusercontent.com/.well-known/jwks";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  key = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "invented-v2-current-key",
    use: "sig",
    alg: "RS256",
  };
function config(target: "staging" | "production" = "staging"): TargetContentV2StorageConfiguration {
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
    descriptor_v2_passphrase: "invented-dedicated-v2-passphrase".repeat(2),
  };
}
function fixture(
  mode: "apply" | "no-changes" = "apply",
  target: "staging" | "production" = "staging",
) {
  const release = {
    version: "2.36.23",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "23456",
    schema_head: "010_invented.sql",
  };
  const producer = {
    repository: "deconfined/tarubot" as const,
    workflow_ref: pins.publication,
    ref: "refs/heads/main" as const,
    event: "push" as const,
    attempt: 1 as const,
    commit: release.commit,
    run: release.publication_run,
  };
  const generation = "11111111-1111-4111-8111-111111111111",
    state = { lineage: "22222222-2222-4222-8222-222222222222", serial: 5, digest: "c".repeat(64) },
    baseline_digest = "d".repeat(64);
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
      dns_zone_id: "f".repeat(32),
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
          ? { commit: release.commit, run: release.publication_run }
          : { commit: "9".repeat(40), run: "987" },
      binding: "0".repeat(64),
      baseline_digest,
      completion_digest: privateDigest({ generation, baseline: baseline_digest }),
    },
  };
  return { release, envelope, clock: { now: instant } };
}
function missing() {
  return Object.assign(new Error("invented-private-diagnostic"), { code: "NoSuchKey" });
}
function native() {
  const records = new Map<string, Uint8Array>(),
    calls: Array<{ method: string; key: string; options?: Bun.S3Options }> = [],
    options: Bun.S3Options[] = [];
  let routeHook: ((url: URL, key: string) => void) | undefined,
    readHook: ((key: string) => void) | undefined,
    writeHook: ((key: string) => Promise<void>) | undefined,
    streamHook: ((key: string) => ReadableStream<Uint8Array> | undefined) | undefined,
    writeGetter = 0;
  const createClient = (supplied: Bun.S3Options) => {
    const c = structuredClone(supplied);
    options.push(c);
    return {
      presign(k: string) {
        const url = new URL(`${c.endpoint}/${k}`);
        url.searchParams.set("X-Amz-Date", "20261001T000000Z");
        url.searchParams.set(
          "X-Amz-Credential",
          `${c.accessKeyId}/20261001/${c.region}/s3/aws4_request`,
        );
        if (c.sessionToken) url.searchParams.set("X-Amz-Security-Token", c.sessionToken);
        routeHook?.(url, k);
        return url.toString();
      },
      file(k: string, o: Bun.S3Options) {
        calls.push({ method: "read", key: k, options: structuredClone(o) });
        readHook?.(k);
        return {
          stream() {
            return (
              streamHook?.(k) ??
              new ReadableStream<Uint8Array>({
                start(controller) {
                  const b = records.get(k);
                  if (!b) controller.error(missing());
                  else {
                    controller.enqueue(Uint8Array.from(b));
                    controller.close();
                  }
                },
              })
            );
          },
        };
      },
      get write() {
        writeGetter++;
        return async (k: string, b: Uint8Array, o: Bun.S3Options) => {
          calls.push({ method: "write", key: k, options: structuredClone(o) });
          records.set(k, Uint8Array.from(b));
          await writeHook?.(k);
          return b.length;
        };
      },
    } as unknown as Bun.S3Client;
  };
  return {
    records,
    calls,
    options,
    createClient,
    route(h: typeof routeHook) {
      routeHook = h;
    },
    read(h: typeof readHook) {
      readHook = h;
    },
    write(h: typeof writeHook) {
      writeHook = h;
    },
    stream(h: typeof streamHook) {
      streamHook = h;
    },
    writeGetter: () => writeGetter,
  };
}
function issuance(receipt: ContentReceiptV2) {
  const owner = { id: 123456, login: "deconfined" },
    repository = { id: 234567, full_name: "deconfined/tarubot", fork: false, owner },
    release = receipt.release,
    mode = receipt.mode;
  const configuration = {
    owner_id: owner.id,
    repository_id: repository.id,
    environment_id: 345678,
    subject: "repo:deconfined/tarubot:environment:target-seal",
    token: "invented_target_issuance_read_token_12345",
  };
  const statement: TargetIssuanceStatementV2 = {
    schema: 2,
    purpose: "tarubot-applied-target-issuance-v2",
    content_receipt: receipt,
    source: {
      plan: {
        job_id: 101,
        check_run_id: 1101,
        critical_step: { name: "Plan and require automatic policy", number: 1 },
        projection_step: { name: pins.projection, number: 2 },
      },
      apply:
        mode === "apply"
          ? {
              job_id: 102,
              check_run_id: 1102,
              critical_step: { name: "Recheck policy and apply exact saved plan", number: 1 },
              projection_step: { name: pins.projection, number: 2 },
            }
          : null,
    },
    issuer: {
      repository_owner_id: owner.id,
      repository_id: repository.id,
      job_path: pins.issuer,
      job_id: 103,
      check_run_id: 1103,
      critical_step: { name: pins.sealing, number: 1 },
    },
    issued_at: Math.max(instant + 1000, receipt.issued_at),
    valid_until: Math.min(receipt.expires_at, instant + 86_400_000 - 1000),
  };
  const runUrl = `${api}/actions/runs/23456`,
    iso = (n: number) => new Date(n).toISOString();
  const step = (
    name: string,
    number: number,
    start: number,
    end: number,
    conclusion = "success",
  ) => ({
    name,
    number,
    status: "completed",
    conclusion,
    started_at: conclusion === "success" ? iso(start) : null,
    completed_at: conclusion === "success" ? iso(end) : null,
  });
  const job = (
    id: number,
    check: number,
    name: string,
    start: number,
    end: number,
    steps: ReturnType<typeof step>[],
  ) => ({
    id,
    name,
    run_id: 23456,
    run_attempt: 1,
    head_sha: release.commit,
    head_branch: "main",
    run_url: runUrl,
    url: `${api}/actions/jobs/${id}`,
    check_run_url: `${api}/check-runs/${check}`,
    status: "completed",
    conclusion: "success",
    started_at: iso(start),
    completed_at: iso(end),
    steps,
  });
  const plan = job(101, 1101, pins.plan, instant - 120_000, instant - 60_000, [
    step("Plan and require automatic policy", 1, instant - 110_000, instant - 100_000),
    step(
      pins.projection,
      2,
      instant - 90_000,
      instant - 70_000,
      mode === "apply" ? "skipped" : "success",
    ),
  ]);
  const apply = job(102, 1102, pins.apply, instant - 50_000, instant - 10_000, [
    step("Recheck policy and apply exact saved plan", 1, instant - 45_000, instant - 35_000),
    step(pins.projection, 2, instant - 30_000, instant - 15_000),
  ]);
  if (mode === "no-changes") {
    apply.conclusion = "skipped";
    apply.steps = [];
  }
  const seal = job(103, 1103, pins.issuer, instant - 5000, instant + 20_000, [
    step(pins.sealing, 1, instant - 2000, instant + 15_000),
  ]);
  const run = {
    id: 23456,
    head_sha: release.commit,
    head_branch: "main",
    event: "push",
    run_attempt: 1,
    url: runUrl,
    status: "in_progress",
    conclusion: null as string | null,
    path: ".github/workflows/publish.yml",
    repository,
    head_repository: structuredClone(repository),
    referenced_workflows: ["release", "release-infra"].map((name) => ({
      path: `deconfined/tarubot/.github/workflows/${name}.yml@refs/heads/main`,
      ref: "refs/heads/main",
      sha: release.config_commit,
    })),
  };
  const gate = {
      id: configuration.environment_id,
      name: "target-seal",
      url: `${api}/environments/target-seal`,
      protection_rules: [],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    main = { name: "main", protected: true, commit: { sha: release.commit } };
  const data: Record<string, unknown> = {
    [api]: repository,
    [runUrl]: run,
    [`${runUrl}/attempts/1/jobs?per_page=100&page=1`]: {
      total_count: 3,
      jobs: [plan, apply, seal],
    },
    [gate.url]: gate,
    [`${gate.url}/deployment-branch-policies?per_page=100&page=1`]: {
      total_count: 1,
      branch_policies: [{ id: 3030, name: "main", type: "branch" }],
    },
    [`${api}/branches/main`]: main,
    [plan.url]: plan,
    [apply.url]: apply,
    [seal.url]: seal,
    [jwks]: { keys: [key] },
  };
  const calls: string[] = [];
  let getHook: ((url: string) => void) | undefined;
  const get: GitHubReader = async (request) => {
    calls.push(request.url);
    getHook?.(request.url);
    if (!Object.hasOwn(data, request.url)) throw new Error("invented-private-diagnostic");
    return {
      status: 200,
      url: request.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(data[request.url])),
    };
  };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: targetIssuanceAudience(statement),
    sub: configuration.subject,
    repository: "deconfined/tarubot",
    repository_owner: "deconfined",
    repository_id: String(repository.id),
    repository_owner_id: String(owner.id),
    ref: "refs/heads/main",
    ref_type: "branch",
    ref_protected: "true",
    event_name: "push",
    sha: release.commit,
    run_id: "23456",
    run_attempt: "1",
    workflow_ref: pins.publication,
    workflow_sha: release.commit,
    job_workflow_ref: pins.infrastructure,
    job_workflow_sha: release.config_commit,
    environment: "target-seal",
    check_run_id: "1103",
    head_ref: "",
    base_ref: "",
    jti: "invented-private-jti",
    iat: (instant + 2000) / 1000,
    nbf: (instant - 3000) / 1000,
    exp: (instant + 302_000) / 1000,
  };
  const body = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`,
    jwt = `${body}.${sign("RSA-SHA256", Buffer.from(body), { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64url")}`;
  return {
    statement,
    jwt,
    configuration,
    get,
    calls,
    data,
    main,
    seal,
    run,
    hook(h: typeof getHook) {
      getHook = h;
    },
  };
}
async function sealed(
  mode: "apply" | "no-changes" = "apply",
  target: "staging" | "production" = "staging",
) {
  const f = fixture(mode, target),
    s = native(),
    c = config(target),
    producer = createTargetContentV2Producer(c, {
      createClient: s.createClient,
      now: () => f.clock.now,
    });
  const publication = await producer.sealContent({
      envelope: f.envelope,
      expires_at: instant + 86_400_000,
    }),
    i = issuance(publication.receipt);
  f.clock.now = instant + 3000;
  await producer.sealBootstrap({
    publication: publication.publication,
    statement: i.statement,
    jwt: i.jwt,
  });
  f.clock.now = instant + 600_000;
  const consumer = createTargetContentV2Consumer(c, i.configuration, {
      createClient: s.createClient,
      get: i.get,
      now: () => f.clock.now,
    }),
    context = { target, backend: consumer.binding, release: f.release };
  return { ...f, s, c, producer, publication, i, consumer, context };
}
const failure = "invalid-target-storage-v2";
describe("dedicated native v2 content/bootstrap persistence", () => {
  test("actual historical verifier consumes both targets and modes with original opaque result", async () => {
    for (const target of ["staging", "production"] as const)
      for (const mode of ["apply", "no-changes"] as const) {
        const f = await sealed(mode, target),
          writes = f.s.calls.filter((c) => c.method === "write");
        expect(writes).toHaveLength(2);
        expect(f.consumer.namespace).toBe(`tarubot/applied-target/v2/${target}/`);
        for (const [path, bytes] of f.s.records) {
          expect(path.startsWith(f.consumer.namespace)).toBe(true);
          expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe("TAT2");
          expect(Buffer.from(bytes).includes(Buffer.from("example.org"))).toBe(false);
        }
        const getters = f.s.writeGetter(),
          result = await f.consumer.consume(f.release);
        expect(f.s.writeGetter()).toBe(getters);
        expect(result.envelope).toEqual(f.envelope);
        expect(result.statement).toEqual(f.i.statement);
        expect(Object.isFrozen(result.envelope.descriptor.addresses)).toBe(true);
        expect(() => assertAuthenticatedTargetContentV2(result, f.context)).not.toThrow();
        expect(
          await withinAuthenticatedTargetContentV2(
            result,
            f.context,
            async () => "invented-materialization",
          ),
        ).toBe("invented-materialization");
        for (const copy of [
          structuredClone(result),
          { ...result },
          JSON.parse(JSON.stringify(result)),
        ])
          expect(() => assertAuthenticatedTargetContentV2(copy, f.context)).toThrow(failure);
        expect(f.i.calls.filter((u) => u === jwks)).toHaveLength(1);
        expect(f.s.calls.filter((c) => c.method === "write")).toHaveLength(2);
        for (const o of f.s.options) {
          expect(o.retry).toBe(0);
          expect(o.accessKeyId).toBe("invented_access");
          expect(o.sessionToken).toBe("");
        }
      }
  });
  test("bootstrap lookup starts solely from independent target/release and rejects absence", async () => {
    const f = await sealed();
    const readBefore = f.s.calls.filter((c) => c.method === "read").length;
    await expect(f.consumer.consume({ ...f.release, publication_run: "999" })).rejects.toThrow(
      failure,
    );
    expect(f.i.calls).toHaveLength(0);
    expect(f.s.calls.filter((c) => c.method === "read").slice(readBefore)[0]?.key).toEndWith(
      `/applied-target-bootstrap-v2/staging/999/${f.release.commit}`,
    );
    await expect(f.consumer.consume({ ...f.release, commit: "9".repeat(40) })).rejects.toThrow(
      failure,
    );
  });
  test("exact native route, credentials, session token and separate passphrase bind bytes", async () => {
    for (const mutate of [
      (u: URL) => {
        u.hostname = "foreign.example.org";
      },
      (u: URL) => {
        u.pathname = u.pathname.replace("/v2/", "/v1/");
      },
      (u: URL) => {
        u.searchParams.set("X-Amz-Credential", "ambient/20261001/us-east-1/s3/aws4_request");
      },
      (u: URL) => {
        u.searchParams.set("X-Amz-Security-Token", "ambient-token");
      },
      (u: URL) => {
        u.searchParams.append("X-Amz-Credential", u.searchParams.get("X-Amz-Credential") ?? "");
      },
    ]) {
      const f = await sealed();
      f.s.route(mutate);
      const offers = f.s.calls.length;
      await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
      expect(f.s.calls.length).toBe(offers);
    }
    const f = await sealed();
    for (const patch of [
      { descriptor_v2_passphrase: "invented-wrong-v2-passphrase".repeat(3) },
      { region: "us-west-1" },
      { bucket: "invented-other-bucket" },
    ]) {
      const consumer = createTargetContentV2Consumer({ ...f.c, ...patch }, f.i.configuration, {
        createClient: f.s.createClient,
        get: f.i.get,
        now: () => f.clock.now,
      });
      await expect(consumer.consume(f.release)).rejects.toThrow(failure);
    }
    const session = config();
    session.credentials.sessionToken = "invented-scoped-session";
    const s = native(),
      producer = createTargetContentV2Producer(session, {
        createClient: s.createClient,
        now: () => instant,
      });
    await expect(
      producer.sealContent({ envelope: fixture().envelope, expires_at: instant + 86_400_000 }),
    ).resolves.toBeDefined();
    expect(s.options[0]?.sessionToken).toBe("invented-scoped-session");
  });
  test("purpose/nonce/tag mutations and swapped content/bootstrap ciphertext refuse before authority", async () => {
    for (const mutate of [
      (bytes: Uint8Array) => {
        bytes[0] = 0;
      },
      (bytes: Uint8Array) => {
        bytes[4] = (bytes[4] ?? 0) ^ 1;
      },
      (bytes: Uint8Array) => {
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      },
    ]) {
      const f = await sealed(),
        path = [...f.s.records.keys()].find((p) => p.includes("bootstrap-v2"));
      if (!path) throw new Error("fixture-path");
      const b = f.s.records.get(path);
      if (!b) throw new Error("fixture-bytes");
      mutate(b);
      await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
      expect(f.i.calls).toHaveLength(0);
    }
    const f = await sealed(),
      paths = [...f.s.records.keys()],
      content = paths.find((p) => p.includes("content-v2")),
      bootstrap = paths.find((p) => p.includes("bootstrap-v2"));
    if (!content || !bootstrap) throw new Error("fixture-path");
    f.s.records.set(bootstrap, f.s.records.get(content) ?? new Uint8Array());
    await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
  });
  test("successful public jobs cannot replace exact current head, issuer outcome or JWT audience", async () => {
    for (const alter of [
      (f: Awaited<ReturnType<typeof sealed>>) => {
        f.i.main.commit.sha = "9".repeat(40);
      },
      (f: Awaited<ReturnType<typeof sealed>>) => {
        f.i.seal.conclusion = "failure";
      },
      (f: Awaited<ReturnType<typeof sealed>>) => {
        f.i.run.run_attempt = 2;
      },
    ]) {
      const f = await sealed();
      alter(f);
      await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
    }
    const f = fixture(),
      s = native(),
      producer = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      }),
      publication = await producer.sealContent({
        envelope: f.envelope,
        expires_at: instant + 86_400_000,
      }),
      i = issuance(publication.receipt);
    f.clock.now = instant + 3000;
    await producer.sealBootstrap({
      publication: publication.publication,
      statement: i.statement,
      jwt: `${i.jwt.slice(0, -1)}${i.jwt.endsWith("A") ? "B" : "A"}`,
    });
    f.clock.now = instant + 600_000;
    const consumer = createTargetContentV2Consumer(config(), i.configuration, {
      createClient: s.createClient,
      get: i.get,
      now: () => f.clock.now,
    });
    await expect(consumer.consume(f.release)).rejects.toThrow(failure);
  });
  test("uncertain accepted writes and an idle mint gap permanently fence producer", async () => {
    const f = fixture(),
      s = native(),
      producer = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      });
    s.write(async () => {
      f.clock.now += 60_000;
    });
    await expect(
      producer.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
    expect(s.records.size).toBe(1);
    const offers = s.calls.length;
    await expect(
      producer.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
    expect(s.calls.length).toBe(offers);
    const g = fixture(),
      t = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: t.createClient,
        now: () => g.clock.now,
      }),
      publication = await p.sealContent({ envelope: g.envelope, expires_at: instant + 86_400_000 }),
      i = issuance(publication.receipt);
    g.clock.now = instant + 60_000;
    await expect(
      p.sealBootstrap({ publication: publication.publication, statement: i.statement, jwt: i.jwt }),
    ).rejects.toThrow(failure);
    expect(t.records.size).toBe(1);
    await expect(
      p.sealContent({ envelope: g.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
  });
  test("opaque publication cannot be copied, reused or rebound to a different receipt", async () => {
    for (const kind of ["copy", "receipt", "reuse"]) {
      const f = fixture(),
        s = native(),
        p = createTargetContentV2Producer(config(), {
          createClient: s.createClient,
          now: () => f.clock.now,
        }),
        publication = await p.sealContent({
          envelope: f.envelope,
          expires_at: instant + 86_400_000,
        }),
        i = issuance(publication.receipt);
      f.clock.now = instant + 3000;
      if (kind === "reuse") {
        await p.sealBootstrap({
          publication: publication.publication,
          statement: i.statement,
          jwt: i.jwt,
        });
        await expect(
          p.sealBootstrap({
            publication: publication.publication,
            statement: i.statement,
            jwt: i.jwt,
          }),
        ).rejects.toThrow(failure);
      } else {
        const statement = structuredClone(i.statement);
        if (kind === "receipt") statement.content_receipt.ciphertext_digest = "9".repeat(64);
        await expect(
          p.sealBootstrap({
            publication:
              kind === "copy" ? structuredClone(publication.publication) : publication.publication,
            statement,
            jwt: i.jwt,
          }),
        ).rejects.toThrow(failure);
        expect(s.records.size).toBe(1);
      }
    }
  });
  test("original operation/proof expires through presign, authority read, late EOF and byte reopens", async () => {
    const f = await sealed();
    let once = true;
    f.s.route(() => {
      if (once) {
        once = false;
        f.clock.now += 60_000;
      }
    });
    const offers = f.s.calls.length;
    await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
    expect(f.s.calls.length).toBe(offers);
    const g = await sealed();
    g.i.hook(() => {
      g.clock.now += 30_000;
    });
    await expect(g.consumer.consume(g.release)).rejects.toThrow(failure);
    expect(g.i.calls).toHaveLength(1);
    const h = await sealed();
    h.s.stream((k) => {
      if (!k.includes("content-v2")) return undefined;
      const b = h.s.records.get(k);
      return new ReadableStream<Uint8Array>({
        start(c) {
          if (!b) throw new Error("fixture");
          c.enqueue(b);
        },
        pull(c) {
          h.clock.now += 30_000;
          c.close();
        },
      });
    });
    await expect(h.consumer.consume(h.release)).rejects.toThrow(failure);
    for (const kind of ["bootstrap-v2", "content-v2"]) {
      const j = await sealed();
      let reads = 0;
      j.s.read((k) => {
        if (k.includes(kind) && ++reads === 2) {
          const b = j.s.records.get(k);
          if (b) b[b.length - 1] = (b[b.length - 1] ?? 0) ^ 1;
        }
      });
      await expect(j.consumer.consume(j.release)).rejects.toThrow(failure);
      expect(j.i.calls.filter((u) => u === jwks)).toHaveLength(1);
    }
  });
  test("materialization cannot renew or survive a swallowed nested assertion denial", async () => {
    const f = await sealed(),
      result = await f.consumer.consume(f.release);
    f.clock.now += 30_000;
    expect(() => assertAuthenticatedTargetContentV2(result, f.context)).toThrow(failure);
    f.clock.now--;
    expect(() => assertAuthenticatedTargetContentV2(result, f.context)).toThrow(failure);
    const g = await sealed(),
      r = await g.consumer.consume(g.release);
    let attempted = false;
    const expected = new Proxy(g.context, {
      ownKeys(target) {
        if (!attempted) {
          attempted = true;
          try {
            assertAuthenticatedTargetContentV2(r, { ...g.context, target: "production" });
          } catch {
            /* Deliberately swallowed: original result must stay fenced. */
          }
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => assertAuthenticatedTargetContentV2(r, expected)).toThrow(failure);
    expect(() => assertAuthenticatedTargetContentV2(r, g.context)).toThrow(failure);
  });
  test("producer phase reservation precedes hostile caller hooks and forbids an SDK offer", async () => {
    const f = fixture(),
      s = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      }),
      publication = await p.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
      i = issuance(publication.receipt);
    f.clock.now = instant + 3000;
    let nested: Promise<void> | undefined;
    const request = { publication: publication.publication, statement: i.statement, jwt: i.jwt };
    const hostile = new Proxy(request, {
      ownKeys(target) {
        nested = p.sealBootstrap(request).catch(() => {});
        return Reflect.ownKeys(target);
      },
    });
    await expect(p.sealBootstrap(hostile)).rejects.toThrow(failure);
    await nested;
    expect(s.records.size).toBe(1);
  });
  test("complete stream bounds, partial absence and config accessors retain private errors", async () => {
    const f = await sealed();
    f.s.stream(
      () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(65_569));
            c.close();
          },
        }),
    );
    await expect(f.consumer.consume(f.release)).rejects.toThrow(failure);
    const g = await sealed();
    g.s.stream(
      () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(32));
          },
          pull(c) {
            c.error(missing());
          },
        }),
    );
    await expect(g.consumer.consume(g.release)).rejects.toThrow(failure);
    let accesses = 0;
    const c = config();
    Object.defineProperty(c, "descriptor_v2_passphrase", {
      enumerable: true,
      get() {
        accesses++;
        throw new Error("invented-private-diagnostic");
      },
    });
    expect(() => createTargetContentV2Producer(c)).toThrow(failure);
    expect(accesses).toBe(0);
    expect(() =>
      createTargetContentV2Producer({
        ...config(),
        descriptor_passphrase: "v1-private-key",
      } as TargetContentV2StorageConfiguration),
    ).toThrow(failure);
  });
  test("a frozen wall clock cannot renew a short expiry after slow first-clock or input preparation", async () => {
    const f = fixture(),
      s = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => instant,
      });
    await expect(p.sealContent({ envelope: f.envelope, expires_at: instant + 1 })).rejects.toThrow(
      failure,
    );
    expect(s.calls).toHaveLength(0);
    let reads = 0;
    const slow = new Proxy(f.envelope, {
      ownKeys(target) {
        reads++;
        const end = performance.now() + 20;
        while (performance.now() < end) {
          /* Include untrusted preparation in the original physical budget. */
        }
        return Reflect.ownKeys(target);
      },
    });
    const q = createTargetContentV2Producer(config(), {
      createClient: s.createClient,
      now: () => instant,
    });
    await expect(q.sealContent({ envelope: slow, expires_at: instant + 1 })).rejects.toThrow(
      failure,
    );
    expect(reads).toBeGreaterThan(0);
    expect(s.calls).toHaveLength(0);
    for (const phase of ["clock", "input"]) {
      let first = true;
      const delay = () => {
        const end = performance.now() + 150;
        while (performance.now() < end) {
          /* Real physical time; the wall clock intentionally remains frozen. */
        }
      };
      const envelope =
        phase === "input"
          ? new Proxy(f.envelope, {
              ownKeys(target) {
                if (first) {
                  first = false;
                  delay();
                }
                return Reflect.ownKeys(target);
              },
            })
          : f.envelope;
      const p = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => {
          if (phase === "clock" && first) {
            first = false;
            delay();
          }
          return instant;
        },
      });
      await expect(p.sealContent({ envelope, expires_at: instant + 100 })).rejects.toThrow(failure);
      expect(s.calls).toHaveLength(0);
      expect(s.records.size).toBe(0);
    }
  });
  test("complete NoSuchKey is absence only before bytes; existing deterministic bootstrap is write-once", async () => {
    const f = await sealed(),
      before = f.s.calls.filter((c) => c.method === "write").length;
    const q = createTargetContentV2Producer(f.c, {
      createClient: f.s.createClient,
      now: () => f.clock.now,
    });
    const publication = await q.sealContent({
      envelope: f.envelope,
      expires_at: instant + 86_400_000,
    });
    const i = issuance(publication.receipt);
    i.statement.issued_at = f.clock.now;
    i.statement.valid_until = instant + 86_400_000 - 1000;
    await expect(
      q.sealBootstrap({ publication: publication.publication, statement: i.statement, jwt: i.jwt }),
    ).rejects.toThrow(failure);
    expect(f.s.calls.filter((c) => c.method === "write")).toHaveLength(before + 1);
    await expect(
      q.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
  });
  test("SDK-bound routing time is checked after presign and before either content write or late file offer", async () => {
    const f = fixture(),
      s = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      });
    let presigns = 0;
    s.route(() => {
      if (++presigns === 3) f.clock.now += 60_000;
    });
    await expect(
      p.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
    expect(s.calls.filter((c) => c.method === "write")).toHaveLength(0);
    expect(s.records.size).toBe(0);
  });
  test("fresh nonce changes ciphertext for identical canonical content and no verifier override is accepted", async () => {
    const f = fixture(),
      a = native(),
      b = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: a.createClient,
        now: () => f.clock.now,
      }),
      q = createTargetContentV2Producer(config(), {
        createClient: b.createClient,
        now: () => f.clock.now,
      });
    const x = await p.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
      y = await q.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 });
    expect(x.receipt.payload_digest).toBe(y.receipt.payload_digest);
    expect(x.receipt.ciphertext_digest).not.toBe(y.receipt.ciphertext_digest);
    const i = issuance(x.receipt);
    expect(() =>
      createTargetContentV2Consumer(config(), i.configuration, {
        createClient: a.createClient,
        get: i.get,
        verify: async () => ({}),
      } as Parameters<typeof createTargetContentV2Consumer>[2]),
    ).toThrow(failure);
    let accessed = 0;
    const dependencies = { createClient: a.createClient };
    Object.defineProperty(dependencies, "now", {
      enumerable: true,
      get() {
        accessed++;
        throw new Error("invented-private-diagnostic");
      },
    });
    expect(() => createTargetContentV2Producer(config(), dependencies)).toThrow(failure);
    expect(accessed).toBe(0);
    // Close both prepared publications so their denial timers do not outlive this test.
    f.clock.now = instant + 3000;
    await p.sealBootstrap({ publication: x.publication, statement: i.statement, jwt: i.jwt });
    const j = issuance(y.receipt);
    await q.sealBootstrap({ publication: y.publication, statement: j.statement, jwt: j.jwt });
  });
  test("actual Bun SigV4 presigning matches the explicit v2 route without native HTTP", async () => {
    const f = fixture(),
      s = native();
    const producer = createTargetContentV2Producer(config(), {
      now: () => instant,
      createClient(options) {
        const native = new Bun.S3Client(options),
          synthetic = s.createClient(options);
        return {
          file: synthetic.file.bind(synthetic),
          write: synthetic.write?.bind(synthetic),
          presign: native.presign.bind(native),
        } as Bun.S3Client;
      },
    });
    const result = await producer.sealContent({
      envelope: f.envelope,
      expires_at: instant + 86_400_000,
    });
    expect(result.receipt.backend).toBe(producer.binding);
    expect(s.records.size).toBe(1);
  });
  test("a shorter statement expiry remains physical while the mint-gap wall clock is frozen", async () => {
    const f = fixture(),
      s = native(),
      p = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      }),
      publication = await p.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
      i = issuance(publication.receipt);
    f.clock.now = instant + 3000;
    i.statement.valid_until = f.clock.now + 50;
    s.write(async () => {
      await Bun.sleep(80);
    });
    await expect(
      p.sealBootstrap({ publication: publication.publication, statement: i.statement, jwt: i.jwt }),
    ).rejects.toThrow(failure);
    expect(s.records.size).toBe(2);
    const offers = s.calls.length;
    await expect(
      p.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
    ).rejects.toThrow(failure);
    expect(s.calls.length).toBe(offers);
  });
  test("late returned stream/getReader getters cannot offer their captured methods", async () => {
    for (const stage of ["stream", "reader"]) {
      for (const nestedDenial of [false, true]) {
        const f = fixture(),
          s = native(),
          request = { envelope: f.envelope, expires_at: instant + 86_400_000 };
        let producer: ReturnType<typeof createTargetContentV2Producer> | undefined,
          nested: Promise<unknown> | undefined,
          streamOffers = 0,
          readerOffers = 0;
        const delay = () => {
          f.clock.now += 60_000;
          if (nestedDenial) nested = producer?.sealContent(request).catch(() => {});
        };
        producer = createTargetContentV2Producer(config(), {
          now: () => f.clock.now,
          createClient(options) {
            const base = s.createClient(options);
            return {
              presign: base.presign.bind(base),
              write: base.write?.bind(base),
              file(key: string, options: Bun.S3Options) {
                const file = base.file(key, options);
                if (stage === "stream")
                  return {
                    get stream() {
                      delay();
                      return () => {
                        streamOffers++;
                        return file.stream();
                      };
                    },
                  };
                return {
                  stream() {
                    streamOffers++;
                    const stream = file.stream();
                    return {
                      get getReader() {
                        delay();
                        return () => {
                          readerOffers++;
                          return stream.getReader();
                        };
                      },
                    } as ReadableStream<Uint8Array>;
                  },
                };
              },
            } as unknown as Bun.S3Client;
          },
        });
        await expect(producer.sealContent(request)).rejects.toThrow(failure);
        await nested;
        expect(streamOffers).toBe(stage === "stream" ? 0 : 1);
        expect(readerOffers).toBe(0);
        expect(s.records.size).toBe(0);
        const offers = s.calls.length;
        await expect(producer.sealContent(request)).rejects.toThrow(failure);
        expect(s.calls.length).toBe(offers);
      }
    }
  });
  test("swallowed busy denial in first-clock and request hooks fences the original producer before I/O", async () => {
    for (const phase of ["clock", "input"]) {
      const f = fixture(),
        s = native(),
        request = { envelope: f.envelope, expires_at: instant + 86_400_000 };
      let producer: ReturnType<typeof createTargetContentV2Producer> | undefined,
        nested: Promise<unknown> | undefined,
        first = true;
      const deny = () => {
        if (first) {
          first = false;
          nested = producer?.sealContent(request).catch(() => {});
        }
      };
      producer = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => {
          if (phase === "clock") deny();
          return instant;
        },
      });
      const input =
        phase === "input"
          ? new Proxy(request, {
              ownKeys(target) {
                deny();
                return Reflect.ownKeys(target);
              },
            })
          : request;
      await expect(producer.sealContent(input)).rejects.toThrow(failure);
      await nested;
      expect(first).toBe(false);
      expect(s.calls).toHaveLength(0);
      expect(s.records.size).toBe(0);
      await expect(producer.sealContent(request)).rejects.toThrow(failure);
      expect(s.calls).toHaveLength(0);
    }
  });
});

describe("sticky original v2 storage deadlines", () => {
  test("route and file hooks cannot renew an observed or simultaneous short cap", async () => {
    for (const simultaneous of [true, false]) {
      const f = fixture(),
        s = native();
      let reads = 0;
      const block = () => {
        const end = performance.now() + 60;
        while (performance.now() < end) {
          /* Hold the wall frozen and starve timers. */
        }
      };
      s.route(() => {
        if (f.clock.now === instant) {
          f.clock.now += 59_980;
          if (simultaneous) block();
        }
      });
      s.read(() => {
        reads++;
        if (!simultaneous) block();
      });
      const producer = createTargetContentV2Producer(config(), {
        createClient: s.createClient,
        now: () => f.clock.now,
      });
      await expect(
        producer.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
      ).rejects.toThrow("invalid-target-storage-v2");
      expect(reads).toBe(simultaneous ? 0 : 1);
      expect(s.records.size).toBe(0);
      const offers = s.calls.length;
      await expect(
        producer.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
      ).rejects.toThrow("invalid-target-storage-v2");
      expect(s.calls.length).toBe(offers);
    }
  });
  test("a response observation shortens a held stream read's original timer", async () => {
    const f = fixture(),
      s = native();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    s.stream(
      () =>
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
    );
    const producer = createTargetContentV2Producer(config(), {
      createClient: s.createClient,
      now: () => f.clock.now,
    });
    const physical = performance.now();
    const pending = producer.sealContent({
      envelope: f.envelope,
      expires_at: instant + 86_400_000,
    });
    await Bun.sleep(2);
    f.clock.now += 59_980;
    controller.enqueue(new Uint8Array(32));
    await expect(pending).rejects.toThrow("invalid-target-storage-v2");
    expect(performance.now() - physical).toBeLessThan(300);
    expect(s.calls).toHaveLength(1);
    expect(s.records.size).toBe(0);
  });
  test("the idle publication and held bootstrap write share the original shortened end", async () => {
    const f = fixture(),
      s = native();
    let writes = 0;
    const producer = createTargetContentV2Producer(config(), {
      createClient: s.createClient,
      now: () => f.clock.now,
    });
    const publication = await producer.sealContent({
      envelope: f.envelope,
      expires_at: instant + 86_400_000,
    });
    const i = issuance(publication.receipt);
    f.clock.now = instant + 3000;
    s.write(async () => {
      writes++;
      f.clock.now = instant + 59_980;
      await new Promise<void>(() => {});
    });
    const physical = performance.now();
    await expect(
      producer.sealBootstrap({
        publication: publication.publication,
        statement: i.statement,
        jwt: i.jwt,
      }),
    ).rejects.toThrow("invalid-target-storage-v2");
    expect(performance.now() - physical).toBeLessThan(300);
    expect(writes).toBe(1);
    const offered = s.calls.length;
    await expect(
      producer.sealBootstrap({
        publication: publication.publication,
        statement: i.statement,
        jwt: i.jwt,
      }),
    ).rejects.toThrow("invalid-target-storage-v2");
    expect(s.calls.length).toBe(offered);
  });
});

test("native stream result getters cannot offer another read after simultaneous short expiry", async () => {
  const f = fixture(),
    s = native();
  let reads = 0,
    values = 0;
  const producer = createTargetContentV2Producer(config(), {
    now: () => f.clock.now,
    createClient: (options) => {
      const client = s.createClient(options);
      return {
        presign: client.presign.bind(client),
        write: client.write.bind(client),
        file: () => ({
          stream: () => ({
            getReader: () => ({
              read: async () => {
                reads++;
                return {
                  get done() {
                    f.clock.now += 59_980;
                    const end = performance.now() + 60;
                    while (performance.now() < end) {
                      /* Original scope already shortened. */
                    }
                    return false;
                  },
                  get value() {
                    values++;
                    return new Uint8Array(32);
                  },
                };
              },
              cancel: async () => {},
              releaseLock: () => {},
            }),
          }),
        }),
      } as unknown as Bun.S3Client;
    },
  });
  await expect(
    producer.sealContent({ envelope: f.envelope, expires_at: instant + 86_400_000 }),
  ).rejects.toThrow("invalid-target-storage-v2");
  expect(reads).toBe(1);
  expect(values).toBe(0);
  expect(s.records.size).toBe(0);
});

test("native materialization assertion and within capture expected context under original proof", async () => {
  for (const method of ["assert", "within"] as const) {
    const f = await sealed(),
      value = await f.consumer.consume(f.release);
    let trapped = false,
      offers = 0;
    const expected = new Proxy(f.context, {
      ownKeys(context) {
        if (!trapped) {
          trapped = true;
          f.clock.now += 29_980;
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* Original historical proof cannot renew after caller capture. */
          }
        }
        return Reflect.ownKeys(context);
      },
    });
    if (method === "assert")
      expect(() => assertAuthenticatedTargetContentV2(value, expected)).toThrow(
        "invalid-target-storage-v2",
      );
    else
      await expect(
        withinAuthenticatedTargetContentV2(value, expected, async () => {
          offers++;
        }),
      ).rejects.toThrow("invalid-target-storage-v2");
    expect(trapped).toBe(true);
    expect(offers).toBe(0);
    expect(() => assertAuthenticatedTargetContentV2(value, f.context)).toThrow(
      "invalid-target-storage-v2",
    );
  }
});
