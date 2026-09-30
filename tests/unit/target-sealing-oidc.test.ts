/** Invented RSA keys, JWTs and GET responses only; no real OIDC token, API or credentials. */
import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import {
  appliedTargetOidcAudience,
  AppliedTargetOidcAuthenticator,
  type AppliedTargetOidcConfiguration,
  type AppliedTargetOidcAudienceRequest,
  type AppliedTargetOidcRequest,
} from "../../scripts/target-sealing-oidc.js";
import type { GitHubReader, GitHubReadRequest } from "../../scripts/trust-run.js";

const instant = 1_800_000_000_000;
const issuer = "https://token.actions.githubusercontent.com";
const jwksUrl = `${issuer}/.well-known/jwks`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreignKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
type Value = Record<string, unknown>;
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}
function jwt(
  claims: Value,
  header: Value = { alg: "RS256", typ: "JWT", kid: "invented-key" },
  text?: string,
): string {
  const parts = [
    Buffer.from(JSON.stringify(header)).toString("base64url"),
    Buffer.from(text ?? JSON.stringify(claims)).toString("base64url"),
  ];
  const signature = sign("RSA-SHA256", Buffer.from(parts.join(".")), {
    key: keys.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url");
  return `${parts.join(".")}.${signature}`;
}
function fixture(mode: "apply" | "no-changes" = "no-changes") {
  const configuration: AppliedTargetOidcConfiguration = {
    owner_id: 123456,
    repository_id: 234567,
    subjects: {
      apply: "repo:deconfined@123456/tarubot@234567:environment:infra-auto",
      "no-changes": "repo:deconfined@123456/tarubot@234567:environment:infra-plan",
    },
  };
  const release = {
    version: "2.36.14",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "12345",
    schema_head: "001_schema.sql",
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
  const request: AppliedTargetOidcRequest = {
    request: {
      receipt: {
        schema: 1,
        purpose: "tarubot-applied-target-handoff-v1",
        target: "staging",
        backend: "c".repeat(64),
        release,
        producer,
        mode,
        path: `applied-target/staging/12345/${release.commit}/${"d".repeat(64)}`,
        payload_digest: "d".repeat(64),
        ciphertext_digest: "e".repeat(64),
        issued_at: instant - 1000,
        expires_at: instant + 3_599_000,
      },
      job: {
        workflow_ref: "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
        workflow_commit: release.config_commit,
        job_name: mode === "apply" ? "Apply infrastructure" : "Plan infrastructure",
        critical_step: "Seal applied target descriptor",
      },
      requested_at: instant,
    },
    writer: {
      repository: "deconfined/tarubot",
      repository_owner_id: configuration.owner_id,
      repository_id: configuration.repository_id,
      publication_workflow_ref: producer.workflow_ref,
      ref: producer.ref,
      event: producer.event,
      run: producer.run,
      attempt: 1,
      head_commit: release.commit,
      reusable_workflow_ref:
        "deconfined/tarubot/.github/workflows/release-infra.yml@refs/heads/main",
      reusable_workflow_commit: release.config_commit,
      job_path: `Replacement release orchestration / infrastructure / ${mode === "apply" ? "Apply infrastructure" : "Plan infrastructure"}`,
      job_id: 102,
      check_run_id: 987654,
      critical_step: {
        name: "Seal applied target descriptor",
        number: 3,
        status: "completed",
        conclusion: "success",
      },
    },
  };
  const claims: Value = {
    iss: issuer,
    aud: appliedTargetOidcAudience(request),
    sub: configuration.subjects[mode],
    repository: "deconfined/tarubot",
    repository_owner: "deconfined",
    repository_id: "234567",
    repository_owner_id: "123456",
    ref: "refs/heads/main",
    ref_type: "branch",
    ref_protected: "true",
    event_name: "push",
    sha: release.commit,
    run_id: "12345",
    run_attempt: "1",
    workflow_ref: producer.workflow_ref,
    workflow_sha: release.commit,
    job_workflow_ref: request.writer.reusable_workflow_ref,
    job_workflow_sha: release.config_commit,
    environment: mode === "apply" ? "infra-auto" : "infra-plan",
    check_run_id: "987654",
    head_ref: "",
    base_ref: "",
    iat: instant / 1000 - 1,
    nbf: instant / 1000 - 1,
    exp: instant / 1000 + 300,
    jti: "invented-token-id",
  };
  const jwk: Value = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "invented-key",
    use: "sig",
    alg: "RS256",
  };
  let token = jwt(claims);
  let now = instant;
  const seen: GitHubReadRequest[] = [];
  const tokenRequests: AppliedTargetOidcRequest[] = [];
  const get: GitHubReader = async (input) => {
    seen.push(structuredClone(input));
    return {
      status: 200,
      url: input.url,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: Buffer.from(JSON.stringify({ keys: [jwk] })),
    };
  };
  const readToken = async (input: AppliedTargetOidcRequest) => {
    tokenRequests.push(structuredClone(input));
    expect(Object.isFrozen(input.writer.critical_step)).toBe(true);
    return token;
  };
  const invoke = (
    dependencies: Partial<ConstructorParameters<typeof AppliedTargetOidcAuthenticator>[1]> = {},
    input = request,
  ) =>
    new AppliedTargetOidcAuthenticator(configuration, {
      readToken,
      get,
      now: () => now,
      ...dependencies,
    }).verify(input);
  return {
    configuration,
    request,
    claims,
    jwk,
    seen,
    tokenRequests,
    readToken,
    get,
    invoke,
    setToken: (input: string) => {
      token = input;
    },
    setNow: (input: number) => {
      now = input;
    },
  };
}
async function refusal(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toThrow("invalid-target-sealing-oidc");
}

describe("private exact GitHub OIDC sealing authentication", () => {
  test("both modes verify invented signatures, distinct exact check-run IDs and bounded private proof", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const f = fixture(mode);
      const proof = await f.invoke();
      expect(proof).toEqual({
        schema: 1,
        purpose: "tarubot-authenticated-applied-target-sealing-v1",
        ...f.request,
        authenticated_at: instant,
        expires_at: instant + 30_000,
      });
      expect(Object.isFrozen(proof.request.receipt.release)).toBe(true);
      expect(Object.isFrozen(proof.writer.critical_step)).toBe(true);
      expect(f.tokenRequests).toEqual([f.request]);
      expect(f.seen).toHaveLength(1);
      expect(present(f.seen[0])).toEqual({
        url: jwksUrl,
        method: "GET",
        redirect: "error",
        timeout_ms: expect.any(Number),
        body_limit: 1_048_576,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "TaruBot-private-sealing-oidc",
        },
      });
      expect(present(f.seen[0]).timeout_ms).toBeGreaterThan(0);
      expect(present(f.seen[0]).timeout_ms).toBeLessThanOrEqual(10_000);
      expect(f.request.writer.job_id).not.toBe(f.request.writer.check_run_id);
    }
  });

  test("audience excludes future consumer time while every private receipt field and stable identity binds", async () => {
    const f = fixture();
    const changedTime = structuredClone(f.request);
    changedTime.request.requested_at += 1000;
    expect(appliedTargetOidcAudience(changedTime)).toBe(appliedTargetOidcAudience(f.request));
    const minting: AppliedTargetOidcAudienceRequest = structuredClone(f.request);
    minting.writer.critical_step.status = "in_progress";
    minting.writer.critical_step.conclusion = null;
    expect(appliedTargetOidcAudience(minting)).toBe(appliedTargetOidcAudience(f.request));
    // The minting helper normalizes statuses; authentication still needs final REST evidence.
    await refusal(f.invoke({}, minting as AppliedTargetOidcRequest));
    const changes: ((input: AppliedTargetOidcRequest) => void)[] = [
      (r) => {
        r.request.receipt.backend = "f".repeat(64);
      },
      (r) => {
        r.request.receipt.ciphertext_digest = "f".repeat(64);
      },
      (r) => {
        r.request.receipt.issued_at++;
      },
      (r) => {
        r.request.receipt.expires_at--;
      },
      (r) => {
        r.writer.job_id++;
      },
      (r) => {
        r.writer.check_run_id++;
      },
      (r) => {
        r.writer.critical_step.number++;
      },
    ];
    for (const change of changes) {
      const altered = structuredClone(f.request);
      change(altered);
      expect(appliedTargetOidcAudience(altered)).not.toBe(appliedTargetOidcAudience(f.request));
      await refusal(f.invoke({}, altered));
    }
    f.setNow(instant + 1000);
    expect((await f.invoke({}, changedTime)).authenticated_at).toBe(instant + 1000);
  });

  test("each signed source/job/owner/environment/main/first-attempt claim is independently required", async () => {
    const mismatches: Value = {
      iss: "https://example.org",
      aud: "urn:invented-other-audience",
      sub: "repo:foreign/project:environment:infra-plan",
      repository: "foreign/project",
      repository_owner: "foreign",
      repository_id: "123",
      repository_owner_id: "456",
      ref: "refs/heads/other",
      ref_type: "tag",
      ref_protected: "false",
      event_name: "pull_request",
      sha: "f".repeat(40),
      run_id: "12346",
      run_attempt: "2",
      workflow_ref: "deconfined/tarubot/.github/workflows/other.yml@refs/heads/main",
      workflow_sha: "f".repeat(40),
      job_workflow_ref: "deconfined/tarubot/.github/workflows/other.yml@refs/heads/main",
      job_workflow_sha: "f".repeat(40),
      environment: "infra",
      check_run_id: "102",
      head_ref: "other",
      base_ref: "main",
      jti: "",
    };
    for (const [claim, value] of Object.entries(mismatches)) {
      const f = fixture();
      f.setToken(jwt({ ...f.claims, [claim]: value }));
      await refusal(f.invoke());
      const missing = { ...f.claims };
      delete missing[claim];
      f.setToken(jwt(missing));
      await refusal(f.invoke());
    }
    const f = fixture();
    for (const [claim, value] of [
      ["aud", [f.claims.aud]],
      ["run_attempt", 1],
      ["ref_protected", true],
    ] as const) {
      f.setToken(jwt({ ...f.claims, [claim]: value }));
      await refusal(f.invoke());
    }
    const automaticApply = fixture("apply");
    automaticApply.setToken(jwt({ ...automaticApply.claims, environment: "infra" }));
    await refusal(automaticApply.invoke());
  });

  test("current signed expiry caps proof and cannot be renewed by delayed verification", async () => {
    const f = fixture();
    f.setToken(jwt({ ...f.claims, exp: instant / 1000 + 5 }));
    const proof = await f.invoke();
    expect(proof.expires_at).toBeLessThanOrEqual(instant + 5000);
    expect(proof.expires_at).toBeGreaterThan(instant);
    f.setNow(instant + 5000);
    await refusal(f.invoke());
    const delayed = fixture();
    delayed.setToken(jwt({ ...delayed.claims, exp: instant / 1000 + 5 }));
    await refusal(
      delayed.invoke({
        get: async (input) => {
          const result = await delayed.get(input);
          delayed.setNow(instant + 5000);
          return result;
        },
      }),
    );
    for (const changes of [
      { exp: instant / 1000 },
      { iat: instant / 1000 + 1 },
      { nbf: instant / 1000 + 1 },
      { iat: instant / 1000 - 900, exp: instant / 1000 + 1 },
      { exp: "1800000300" },
    ]) {
      const other = fixture();
      other.setToken(jwt({ ...other.claims, ...changes }));
      await refusal(other.invoke());
    }
  });

  test("unsigned, foreign-signed and algorithm-confused tokens cannot authenticate a caller echo", async () => {
    const f = fixture();
    const valid = jwt(f.claims);
    const parts = valid.split(".");
    const foreign = sign(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      foreignKeys.privateKey,
    ).toString("base64url");
    for (const token of [
      `${parts[0]}.${parts[1]}.${foreign}`,
      `${parts[0]}.${parts[1]}.AA`,
      jwt(f.claims, { alg: "none", typ: "JWT", kid: "invented-key" }),
      jwt(f.claims, { alg: "HS256", typ: "JWT", kid: "invented-key" }),
      jwt(f.claims, { alg: "RS256", typ: "JWT", kid: "invented-key", jku: "https://example.org" }),
      jwt(f.claims, { alg: "RS256", typ: "JWT", kid: "invented-key", crit: ["b64"] }),
      jwt(f.claims, { alg: "RS256", typ: "JWT", kid: "unknown-key" }),
      `${present(parts[0])}=.${parts[1]}.${parts[2]}`,
      "invented-request-echo",
    ]) {
      f.setToken(token);
      await refusal(f.invoke());
    }
  });

  test("duplicate signed decoded JSON keys and duplicate/weak/private JWKs refuse", async () => {
    const f = fixture();
    f.setToken(
      jwt(
        f.claims,
        undefined,
        JSON.stringify(f.claims).replace(
          '"run_attempt":"1"',
          '"run_attempt":"2","run_\\u0061ttempt":"1"',
        ),
      ),
    );
    await refusal(f.invoke());
    f.setToken(jwt(f.claims));
    const bodies = [
      JSON.stringify({ keys: [f.jwk, f.jwk] }),
      JSON.stringify({ keys: [{ ...f.jwk, kty: "oct" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, d: "invented-private-key" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, use: "enc" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, alg: "HS256" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, e: "Aw" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, n: "AQAB" }] }),
      JSON.stringify({ keys: [{ ...f.jwk, key_ops: ["sign", "verify"] }] }),
      JSON.stringify({ keys: [f.jwk] }).replace(
        '"kid":"invented-key"',
        '"kid":"other","k\\u0069d":"invented-key"',
      ),
    ];
    for (const body of bodies)
      await refusal(
        f.invoke({
          get: async (input) => ({
            status: 200,
            url: input.url,
            headers: { "content-type": "application/json" },
            body: Buffer.from(body),
          }),
        }),
      );
  });

  test("optional issuer x5t metadata matches selected fixed-origin key and grants no alternate source", async () => {
    const f = fixture();
    const thumbprint = Buffer.alloc(20, 3).toString("base64url");
    f.jwk.x5t = thumbprint;
    f.setToken(jwt(f.claims, { alg: "RS256", typ: "JWT", kid: "invented-key", x5t: thumbprint }));
    expect((await f.invoke()).writer.check_run_id).toBe(987654);
    f.jwk.x5t = Buffer.alloc(20, 4).toString("base64url");
    await refusal(f.invoke());
  });

  test("JWKS transport rejects redirects, compression, duplicate MIME/keys, overflow and malformed UTF-8", async () => {
    const f = fixture();
    const response = await f.get({
      url: jwksUrl,
      method: "GET",
      headers: {},
      timeout_ms: 1000,
      body_limit: 1_048_576,
      redirect: "error",
    });
    const responses = [
      { ...response, status: 302 },
      { ...response, url: "https://example.org/.well-known/jwks" },
      ...[
        { "content-type": "application/json; charset=utf-8,application/json" },
        { "content-type": "application/json; charset=latin1" },
        { "content-type": "application/json; unknown=yes" },
        { "content-type": "application/json", "Content-Type": "application/json" },
        { "content-type": "application/json", "content-encoding": "gzip" },
        { "content-type": "application/json", location: "https://example.org" },
        { "content-type": "application/json", link: "<https://example.org>; rel=next" },
        { "content-type": "application/json", "content-range": "bytes 0-1/3" },
        { "content-type": "application/json", "content-length": "1" },
      ].map((headers) => ({ ...response, headers })),
      { ...response, body: Buffer.alloc(1_048_577) },
      { ...response, body: Buffer.from([0xc0, 0xaf]) },
      { ...response, body: Buffer.from('{"keys":[],"k\\u0065ys":[]}') },
    ];
    for (const value of responses) await refusal(f.invoke({ get: async () => value }));
    expect(f.seen).toHaveLength(1);
  });

  test("missing new writer IDs and unreviewed subject/scope never call private token reader", async () => {
    const f = fixture();
    const writer = f.request.writer as unknown as Value;
    for (const key of ["repository_id", "check_run_id"] as const) {
      const altered = structuredClone(f.request);
      delete (altered.writer as unknown as Value)[key];
      await refusal(f.invoke({}, altered));
    }
    writer.repository_owner_id = 654321;
    await refusal(f.invoke());
    expect(f.tokenRequests).toHaveLength(0);
    expect(
      () =>
        new AppliedTargetOidcAuthenticator(
          { ...f.configuration, subjects: { apply: "same", "no-changes": "same" } },
          { readToken: f.readToken, get: f.get },
        ),
    ).toThrow("invalid-target-sealing-oidc");
    const valid = fixture();
    valid.claims.sub = "repo:deconfined/tarubot:environment:infra-plan";
    valid.setToken(jwt(valid.claims));
    await refusal(valid.invoke());
    valid.configuration.subjects["no-changes"] = String(valid.claims.sub);
    expect((await valid.invoke()).writer.repository_id).toBe(234567);
  });

  test("caller/config/dependency mutation across awaits cannot change authenticated bytes or captured verifier", async () => {
    const f = fixture();
    let resume: ((value: string) => void) | undefined;
    const dependencies = {
      readToken: async (_input: AppliedTargetOidcRequest) =>
        new Promise<string>((resolve) => {
          resume = resolve;
        }),
      get: f.get,
      now: () => instant,
    };
    const authenticator = new AppliedTargetOidcAuthenticator(f.configuration, dependencies);
    const original = structuredClone(f.request);
    const result = authenticator.verify(f.request);
    await Promise.resolve();
    await Promise.resolve();
    f.request.request.receipt.ciphertext_digest = "f".repeat(64);
    f.request.writer.check_run_id++;
    f.configuration.owner_id++;
    dependencies.get = async () => {
      throw new Error("invented-secret-diagnostic");
    };
    present(resume)(jwt(f.claims));
    expect((await result).request.receipt).toEqual(original.request.receipt);
    expect(f.seen).toHaveLength(1);
    expect(JSON.stringify(authenticator)).toBe("{}");
    expect(Bun.inspect(authenticator)).not.toContain("invented-token");
    expect(Object.isFrozen(authenticator)).toBe(true);
  });

  test("accessors, shared authority, oversized token, clock reversal and late private read fail with fixed code", async () => {
    const f = fixture();
    let calls = 0;
    Object.defineProperty(f.request.request.receipt, "ciphertext_digest", {
      enumerable: true,
      get: () => {
        calls++;
        return "e".repeat(64);
      },
    });
    await refusal(f.invoke());
    expect(calls).toBe(0);
    for (const token of ["x".repeat(32_769), "a.b.c.d", "a.b."]) {
      const altered = fixture();
      altered.setToken(token);
      await refusal(altered.invoke());
    }
    const late = fixture();
    await refusal(
      late.invoke({
        readToken: async () => {
          late.setNow(instant + 60_000);
          return jwt(late.claims);
        },
      }),
    );
    const reverse = fixture();
    await refusal(
      reverse.invoke({
        get: async (input) => {
          reverse.setNow(instant - 1);
          return reverse.get(input);
        },
      }),
    );
    const diagnostics = fixture();
    await expect(
      diagnostics.invoke({
        readToken: async () => {
          throw new Error("invented-private-diagnostic-token");
        },
      }),
    ).rejects.toThrow(/^invalid-target-sealing-oidc$/u);
  });

  test("real deadlines reject unresolved token/JWKS capabilities under a frozen wall clock", async () => {
    for (const phase of ["token", "jwks"] as const) {
      const f = fixture();
      f.request.request.receipt.expires_at = instant + 100;
      f.claims.aud = appliedTargetOidcAudience(f.request);
      f.setToken(jwt(f.claims));
      await refusal(
        f.invoke(
          phase === "token"
            ? { readToken: async () => new Promise<never>(() => {}) }
            : { get: async () => new Promise<never>(() => {}) },
        ),
      );
    }
  });

  test("physical time starts before the private read and remaining signed lifetime cannot renew", () => {
    for (const phase of ["private-expired", "jwks-expired", "remaining"] as const) {
      const f = fixture();
      const modulePath = new URL("../../scripts/target-sealing-oidc.ts", import.meta.url).pathname;
      const token = jwt({ ...f.claims, exp: instant / 1000 + 1 });
      // Subprocess isolation keeps the invented monotonic clock replacement out of all peers.
      const program = `
        import { performance } from "node:perf_hooks";
        const input = ${JSON.stringify({ request: f.request, configuration: f.configuration, jwk: f.jwk, token, phase })};
        let elapsed = 0, gets = 0, code = "unexpected-success", expiry = null;
        Object.defineProperty(performance, "now", { value: () => elapsed });
        const { AppliedTargetOidcAuthenticator } = await import(${JSON.stringify(modulePath)});
        const verifier = new AppliedTargetOidcAuthenticator(input.configuration, {
          now: () => ${instant},
          readToken: async () => { elapsed = input.phase === "private-expired" ? 2000 : 0; return input.token; },
          get: async request => {
            gets++;
            elapsed = input.phase === "jwks-expired" ? 1000 : 500;
            return { status: 200, url: request.url, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({keys:[input.jwk]})) };
          },
        });
        try { const proof = await verifier.verify(input.request); code = "verified"; expiry = proof.expires_at; }
        catch (error) { code = error.message; }
        console.log(JSON.stringify({ gets, code, expiry }));
      `;
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(Buffer.from(child.stderr).toString()).toBe("");
      expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual({
        gets: phase === "private-expired" ? 0 : 1,
        code: phase === "remaining" ? "verified" : "invalid-target-sealing-oidc",
        expiry: phase === "remaining" ? instant + 500 : null,
      });
    }
  });
});
