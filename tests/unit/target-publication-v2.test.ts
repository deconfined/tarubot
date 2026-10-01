/** End-to-end invented native24 ciphertext, real baseline/current REST, RSA/JWKS and v23 S3. */
import { afterAll, describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createTargetPublicationV2,
  type TargetPublicationV2Configuration,
} from "../../scripts/target-publication-v2.js";
import { createTargetContentV2Consumer } from "../../scripts/target-storage-v2.js";
import type { GitHubReader } from "../../scripts/trust-run.js";
import { targetIssuancePins as pins } from "../../scripts/target-issuance.js";
import type { TargetMintReader } from "../../scripts/target-issuance-mint.js";
import {
  candidatePassphrase,
  cleanupLiveIssuerFixtures,
  liveIssuerFixture,
} from "./target-issuer-run.test.js";
afterAll(cleanupLiveIssuerFixtures);
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  key = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "invented-live-key",
    use: "sig",
    alg: "RS256",
  };
const jwks = "https://token.actions.githubusercontent.com/.well-known/jwks";
function nativeStore() {
  const records = new Map<string, Uint8Array>(),
    calls: Array<{ method: string; key: string }> = [];
  let writeHook: ((key: string) => Promise<void>) | undefined, routeHook: (() => void) | undefined;
  const createClient = (supplied: Bun.S3Options) => {
    const config = structuredClone(supplied);
    return {
      presign(path: string) {
        routeHook?.();
        const url = new URL(`${config.endpoint}/${path}`);
        url.searchParams.set("X-Amz-Date", "20261001T000000Z");
        url.searchParams.set(
          "X-Amz-Credential",
          `${config.accessKeyId}/20261001/${config.region}/s3/aws4_request`,
        );
        return url.toString();
      },
      file(path: string) {
        calls.push({ method: "read", key: path });
        return {
          stream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                const value = records.get(path);
                if (value) {
                  controller.enqueue(Uint8Array.from(value));
                  controller.close();
                } else
                  controller.error(
                    Object.assign(new Error("invented-private-store-detail"), {
                      code: "NoSuchKey",
                    }),
                  );
              },
            }),
        };
      },
      async write(path: string, value: Uint8Array) {
        calls.push({ method: "write", key: path });
        records.set(path, Uint8Array.from(value));
        await writeHook?.(path);
        return value.length;
      },
    } as unknown as Bun.S3Client;
  };
  return {
    records,
    calls,
    createClient,
    write: (hook: typeof writeHook) => {
      writeHook = hook;
    },
    route: (hook: typeof routeHook) => {
      routeHook = hook;
    },
  };
}
export async function publicationFixture(
  mode: "apply" | "no-changes" = "no-changes",
  lifetime = 86_400_000,
) {
  const f = await liveIssuerFixture(mode, lifetime),
    store = nativeStore(),
    mintOffers: string[] = [];
  let jwt = "",
    claimsHook: ((claims: Record<string, unknown>) => void) | undefined,
    mintHook: ((url: string) => Promise<void>) | undefined;
  const configuration: TargetPublicationV2Configuration = {
    target: "staging",
    candidate_passphrase: candidatePassphrase,
    issuer: f.configuration,
    mint: {
      request_url:
        "https://oidc.example.actions.githubusercontent.com/opaque/token?api-version=2.0",
      request_token: "invented-opaque-runtime-bearer+/:=",
      subject: "repo:deconfined/tarubot:environment:target-seal",
    },
    storage: {
      target: "staging",
      bucket: "invented-v2-bucket",
      endpoint: "https://region.example.org",
      region: "us-east-1",
      credentials: {
        accessKeyId: "invented_v2_access",
        secretAccessKey: "invented-private-v2-secret",
        sessionToken: null,
      },
      descriptor_v2_passphrase: "invented-dedicated-descriptor-v2-passphrase-123456789",
    },
  };
  const get: TargetMintReader = async (request) => {
    request.beforeRead();
    mintOffers.push(request.url);
    await mintHook?.(request.url);
    request.beforeRead();
    if (request.url === jwks)
      return {
        status: 200,
        url: request.url,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ keys: [key] })),
      };
    const release = f.candidate.release,
      seconds = Math.floor(f.clock.now / 1000),
      claims: Record<string, unknown> = {
        iss: "https://token.actions.githubusercontent.com",
        aud: new URL(request.url).searchParams.get("audience"),
        sub: configuration.mint.subject,
        repository: pins.repository,
        repository_owner: "deconfined",
        repository_id: String(f.configuration.repository_id),
        repository_owner_id: String(f.configuration.owner_id),
        ref: "refs/heads/main",
        ref_type: "branch",
        ref_protected: "true",
        event_name: "push",
        sha: release.commit,
        run_id: release.publication_run,
        run_attempt: "1",
        workflow_ref: pins.publication,
        workflow_sha: release.commit,
        job_workflow_ref: pins.infrastructure,
        job_workflow_sha: release.config_commit,
        environment: pins.environment,
        check_run_id: "1103",
        head_ref: "",
        base_ref: "",
        runner_environment: "github-hosted",
        jti: "invented-single-mint",
        iat: seconds,
        nbf: seconds,
        exp: seconds + 600,
      };
    claimsHook?.(claims);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid })).toString(
        "base64url",
      ),
      payload = Buffer.from(JSON.stringify(claims)).toString("base64url"),
      unsigned = `${header}.${payload}`;
    jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64url")}`;
    expect(request.headers.Authorization).toBe(`Bearer ${configuration.mint.request_token}`);
    expect(request.redirect).toBe("error");
    expect(request.timeout_ms).toBeLessThanOrEqual(10_000);
    return {
      status: 200,
      url: request.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ value: jwt })),
    };
  };
  const dependencies = {
    now: () => f.clock.now,
    githubGet: f.get,
    oidcGet: get,
    createClient: store.createClient,
  };
  const publisher = createTargetPublicationV2(configuration, dependencies),
    request = { release: f.candidate.release, mode, candidate_file: f.file };
  return {
    f,
    store,
    configuration,
    dependencies,
    publisher,
    request,
    mintOffers,
    jwt: () => jwt,
    claims: (hook: typeof claimsHook) => {
      claimsHook = hook;
    },
    mint: (hook: typeof mintHook) => {
      mintHook = hook;
    },
  };
}
describe("native private target publication", () => {
  test("both modes publish encrypted content/bootstrap once without changing original candidate expiry", async () => {
    for (const mode of ["no-changes", "apply"] as const) {
      const p = await publicationFixture(mode);
      expect(await p.publisher.publish(p.request)).toBeUndefined();
      expect(p.mintOffers).toHaveLength(2);
      expect(p.mintOffers[1]).toBe(jwks);
      const writes = p.store.calls.filter((call) => call.method === "write");
      expect(writes).toHaveLength(2);
      expect(writes[0]?.key).toContain("applied-target-content-v2/staging/");
      expect(writes[1]?.key).toBe(
        `tarubot/applied-target/v2/staging/applied-target-bootstrap-v2/staging/${p.request.release.publication_run}/${p.request.release.commit}`,
      );
      for (const bytes of p.store.records.values()) {
        expect(Buffer.from(bytes).includes(Buffer.from(p.jwt()))).toBe(false);
        expect(Buffer.from(bytes).includes(Buffer.from("192.0.2.10"))).toBe(false);
      }
      const count = p.store.calls.length;
      await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
      expect(p.store.calls).toHaveLength(count);
    }
  });
  test("unchanged23 consumer requires final22 Seal evidence and retains original24 expiry", async () => {
    const p = await publicationFixture();
    await p.publisher.publish(p.request);
    const issuer = p.f.configuration,
      issuance = {
        owner_id: issuer.owner_id,
        repository_id: issuer.repository_id,
        environment_id: issuer.environment_id,
        token: issuer.token,
        subject: p.configuration.mint.subject,
      };
    const get: GitHubReader = async (request) =>
      request.url === jwks
        ? {
            status: 200,
            url: request.url,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ keys: [key] })),
          }
        : p.f.get({ ...request, beforeRead: () => {} });
    const consume = () =>
      createTargetContentV2Consumer(p.configuration.storage, issuance, {
        createClient: p.store.createClient,
        now: () => p.f.clock.now,
        get,
      });
    await expect(consume().consume(p.request.release)).rejects.toThrow("invalid-target-storage-v2");
    p.f.clock.now += 1000;
    const completed = new Date(p.f.clock.now).toISOString();
    p.f.seal.status = "completed";
    p.f.seal.conclusion = "success";
    p.f.seal.completed_at = completed;
    const sealing = p.f.seal.steps[0];
    if (!sealing) throw new Error("missing-invented-sealing");
    sealing.status = "completed";
    sealing.conclusion = "success";
    sealing.completed_at = completed;
    const result = await consume().consume(p.request.release);
    expect(result.envelope).toEqual(p.f.candidate.envelope);
    expect(result.statement.content_receipt.expires_at).toBe(p.f.candidate.expires_at);
    expect(result.statement.valid_until).toBeLessThanOrEqual(p.f.candidate.expires_at);
  });
  test("unowned permission, symlink and wrong candidate context cannot offer authority GET or storage", async () => {
    for (const change of ["mode", "symlink", "context"] as const) {
      const p = await publicationFixture();
      if (change === "mode") chmodSync(p.f.file, 0o644);
      if (change === "symlink") {
        const source = `${p.f.file}.original`;
        writeFileSync(source, readFileSync(p.f.file), { mode: 0o600 });
        unlinkSync(p.f.file);
        symlinkSync(source, p.f.file);
      }
      if (change === "context")
        p.request.release = { ...p.request.release, digest: `sha256:${"f".repeat(64)}` };
      await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
      expect(p.f.seen).toHaveLength(0);
      expect(p.store.calls).toHaveLength(0);
      expect(p.mintOffers).toHaveLength(0);
    }
  });
  test("failed baseline or final projection denies before any descriptor write/mint", async () => {
    for (const baseline of [true, false]) {
      const p = await publicationFixture();
      if (baseline) p.f.old.apply.conclusion = "failure";
      else {
        const projection = p.f.plan.steps[1];
        if (!projection) throw new Error("missing-invented-projection");
        projection.conclusion = "failure";
      }
      await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
      expect(p.store.calls).toHaveLength(0);
      expect(p.mintOffers).toHaveLength(0);
    }
  });
  test("same private candidate bytes are reopened before effects and after final bootstrap persistence", async () => {
    for (const finalWrite of [false, true]) {
      const p = await publicationFixture();
      let changed = false;
      const mutate = () => {
        if (changed) return;
        changed = true;
        const bytes = readFileSync(p.f.file);
        const last = bytes.length - 1;
        bytes[last] = (bytes[last] ?? 0) ^ 1;
        writeFileSync(p.f.file, bytes);
      };
      if (finalWrite)
        p.store.write(async (path) => {
          if (path.includes("bootstrap")) mutate();
        });
      else
        p.f.hook((url) => {
          if (url.endsWith("/actions/jobs/103")) mutate();
        });
      await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
      expect(p.store.calls.filter((call) => call.method === "write")).toHaveLength(
        finalWrite ? 2 : 0,
      );
    }
  });
  test("content accepted at original proof expiry leaves no later mint/bootstrap offer", async () => {
    const p = await publicationFixture();
    p.store.write(async () => {
      p.f.clock.now += 30_000;
    });
    await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
    expect(p.store.calls.filter((call) => call.method === "write")).toHaveLength(1);
    expect(p.mintOffers).toHaveLength(0);
  });
  test("live token claims/signature fail closed after exactly one mint attempt", async () => {
    for (const mutate of [
      (claims: Record<string, unknown>) => {
        claims.check_run_id = "9999";
      },
      (claims: Record<string, unknown>) => {
        claims.exp = Number(claims.iat) - 1;
      },
      (claims: Record<string, unknown>) => {
        claims.runner_environment = "self-hosted";
      },
    ]) {
      const p = await publicationFixture();
      p.claims(mutate);
      await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
      expect(p.mintOffers.filter((url) => url !== jwks)).toHaveLength(1);
      expect(p.store.calls.filter((call) => call.method === "write")).toHaveLength(1);
    }
  });
  test("swallowed nested publication refusal fences the outer attempt before a storage offer", async () => {
    const p = await publicationFixture();
    let attempted = false;
    const dependencies = {
        ...p.dependencies,
        createClient: (options: Bun.S3Options) => {
          if (!attempted) {
            attempted = true;
            void publisher.publish({ ...p.request }).catch(() => {});
          }
          return p.store.createClient(options);
        },
      },
      publisher = createTargetPublicationV2(p.configuration, dependencies);
    await expect(publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
    expect(attempted).toBe(true);
    expect(p.store.calls).toHaveLength(0);
    expect(p.mintOffers).toHaveLength(0);
  });
  test("original global candidate expiry bounds an accepted unknown bootstrap write", async () => {
    const p = await publicationFixture("no-changes", 3200);
    p.store.write(async (path) => {
      if (path.includes("bootstrap")) await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    const started = performance.now();
    await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
    expect(performance.now() - started).toBeLessThan(1300);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(p.store.calls.filter((call) => call.method === "write")).toHaveLength(2);
    expect(p.mintOffers).toHaveLength(2);
  });
  test("immutable short candidate expiry bounds a held token response with frozen wall", async () => {
    const p = await publicationFixture("no-changes", 3200);
    p.mint(async (url) => {
      if (url !== jwks) await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    const started = performance.now();
    await expect(p.publisher.publish(p.request)).rejects.toThrow("invalid-target-publication-v2");
    expect(performance.now() - started).toBeLessThan(1400);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(p.mintOffers.filter((url) => url === jwks)).toHaveLength(0);
    expect(p.store.calls.filter((call) => call.method === "write")).toHaveLength(1);
  });
});
