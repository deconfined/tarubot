/** Genuine invented RSA signatures and native-shaped public evidence; no network or secrets. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign, constants } from "node:crypto";
import {
  HistoricalTargetIssuanceVerifier,
  assertHistoricalTargetIssuanceProof,
  withinHistoricalTargetIssuanceProof,
  prepareTargetIssuance,
  startTargetIssuanceMint,
  finishTargetIssuanceMint,
  targetIssuanceStatement,
  targetIssuanceAudience,
  parseTargetIssuanceJson,
  targetIssuanceResponse,
  captureTargetIssuance,
  targetIssuancePins as pins,
  type TargetIssuanceStatementV2,
  type TargetIssuanceMintWindow,
} from "../../scripts/target-issuance.js";
import type { GitHubReader, GitHubReadRequest } from "../../scripts/trust-run.js";

const instant = 1_800_000_000_000;
const issued = instant - 600_000;
const api = "https://api.github.com/repos/deconfined/tarubot";
const jwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";
function fixture(mode: "apply" | "no-changes" = "apply") {
  const owner = { id: 123456, login: "deconfined" };
  const repository = { id: 234567, full_name: "deconfined/tarubot", fork: false, owner };
  const release = {
    version: "2.36.22",
    commit: "a".repeat(40),
    config_commit: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    publication_run: "23456",
    schema_head: "010_invented.sql",
  };
  const content = {
    schema: 2 as const,
    purpose: "tarubot-applied-target-content-v2" as const,
    target: "staging" as const,
    backend: "c".repeat(64),
    release,
    producer: {
      repository: "deconfined/tarubot" as const,
      workflow_ref: pins.publication,
      ref: "refs/heads/main" as const,
      event: "push" as const,
      attempt: 1 as const,
      commit: release.commit,
      run: release.publication_run,
    },
    mode,
    path: `applied-target-content-v2/staging/23456/${release.commit}/${"d".repeat(64)}`,
    payload_digest: "d".repeat(64),
    ciphertext_digest: "e".repeat(64),
    issued_at: issued - 1000,
    expires_at: issued - 1000 + 86_400_000,
  };
  const source = {
    plan: {
      job_id: 101,
      check_run_id: 1101,
      critical_step: { name: "Plan and require automatic policy" as const, number: 1 },
      projection_step: { name: pins.projection, number: 2 },
    },
    apply:
      mode === "apply"
        ? {
            job_id: 102,
            check_run_id: 1102,
            critical_step: {
              name: "Recheck policy and apply exact saved plan" as const,
              number: 1,
            },
            projection_step: { name: pins.projection, number: 2 },
          }
        : null,
  };
  const issuer = {
    repository_owner_id: owner.id,
    repository_id: repository.id,
    job_path: pins.issuer,
    job_id: 103,
    check_run_id: 1103,
    critical_step: { name: pins.sealing, number: 1 },
  };
  const statement: TargetIssuanceStatementV2 = {
    schema: 2,
    purpose: "tarubot-applied-target-issuance-v2",
    content_receipt: content,
    source,
    issuer,
    issued_at: issued,
    valid_until: issued + 86_400_000 - 1000,
  };
  const context = { target: content.target, backend: content.backend, release };
  const configuration = {
    owner_id: owner.id,
    repository_id: repository.id,
    environment_id: 345678,
    subject: "repo:deconfined/tarubot:environment:target-seal",
    token: "invented_target_issuance_read_token_12345",
  };
  const runUrl = `${api}/actions/runs/23456`;
  const iso = (at: number) => new Date(at).toISOString();
  const step = (
    name: string,
    number: number,
    start: number,
    end: number,
    conclusion: "success" | "skipped" = "success",
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
  const plan = job(101, 1101, pins.plan, issued - 120_000, issued - 60_000, [
    step(source.plan.critical_step.name, 1, issued - 110_000, issued - 100_000),
    step(
      pins.projection,
      2,
      issued - 90_000,
      issued - 70_000,
      mode === "apply" ? "skipped" : "success",
    ),
  ]);
  const apply = job(102, 1102, pins.apply, issued - 50_000, issued - 10_000, [
    step("Recheck policy and apply exact saved plan", 1, issued - 45_000, issued - 35_000),
    step(pins.projection, 2, issued - 30_000, issued - 15_000),
  ]);
  if (mode === "no-changes") {
    apply.conclusion = "skipped";
    apply.steps = [];
  }
  const seal = job(103, 1103, pins.issuer, issued - 5000, issued + 20_000, [
    step(pins.sealing, 1, issued - 2000, issued + 15_000),
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
    protection_rules: [] as unknown[],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const policies = {
    total_count: 1,
    branch_policies: [{ id: 3030, name: "main", type: "branch" }],
  };
  const jobs = { total_count: 3, jobs: [plan, apply, seal] };
  const main = { name: "main", protected: true, commit: { sha: release.commit } };
  const data: Record<string, unknown> = {
    [api]: repository,
    [runUrl]: run,
    [`${runUrl}/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [gate.url]: gate,
    [`${gate.url}/deployment-branch-policies?per_page=100&page=1`]: policies,
    [`${api}/branches/main`]: main,
    [plan.url]: plan,
    [apply.url]: apply,
    [seal.url]: seal,
  };
  const calls: GitHubReadRequest[] = [],
    clock = { now: instant };
  const get: GitHubReader = async (input) => {
    calls.push(structuredClone(input));
    if (!Object.hasOwn(data, input.url)) throw new Error("invented unexpected URL");
    return {
      status: 200,
      url: input.url,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(data[input.url])),
    };
  };
  return {
    statement,
    context,
    configuration,
    owner,
    repository,
    run,
    gate,
    policies,
    main,
    jobs,
    plan,
    apply,
    seal,
    data,
    get,
    calls,
    clock,
  };
}

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "invented-current-key",
  use: "sig",
  alg: "RS256",
  x5t: "aW52ZW50ZWQ",
  x5c: ["aW52ZW50ZWQgY2VydGlmaWNhdGU="],
};
function claims(f: ReturnType<typeof fixture>, iat = issued + 2000): Record<string, unknown> {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: targetIssuanceAudience(f.statement),
    sub: f.configuration.subject,
    repository: "deconfined/tarubot",
    repository_owner: "deconfined",
    repository_id: String(f.configuration.repository_id),
    repository_owner_id: String(f.configuration.owner_id),
    ref: "refs/heads/main",
    ref_type: "branch",
    ref_protected: "true",
    event_name: "push",
    sha: f.statement.content_receipt.release.commit,
    run_id: "23456",
    run_attempt: "1",
    workflow_ref: pins.publication,
    workflow_sha: f.statement.content_receipt.release.commit,
    job_workflow_ref: pins.infrastructure,
    job_workflow_sha: f.statement.content_receipt.release.config_commit,
    environment: "target-seal",
    check_run_id: String(f.statement.issuer.check_run_id),
    head_ref: "",
    base_ref: "",
    jti: "invented-private-jti",
    iat: iat / 1000,
    nbf: iat / 1000 - 5,
    exp: iat / 1000 + 300,
  };
}
function jwt(
  body: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid, typ: "JWT", x5t: key.x5t },
  privateKey = pair.privateKey,
): string {
  const signed =
    Buffer.from(JSON.stringify(header)).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(body)).toString("base64url");
  return (
    signed +
    "." +
    sign("RSA-SHA256", Buffer.from(signed), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64url")
  );
}
function cryptoFixture(mode: "apply" | "no-changes" = "apply") {
  const f = fixture(mode);
  f.data[jwksUrl] = { keys: [key] };
  const verifier = new HistoricalTargetIssuanceVerifier(f.configuration, {
    get: f.get,
    now: () => f.clock.now,
  });
  const input = { statement: f.statement, context: f.context, jwt: jwt(claims(f)) };
  return { ...f, verifier, input };
}
const failure = "invalid-target-issuance";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-fixture");
  return value;
}
function scope(value: {
  statement: TargetIssuanceStatementV2;
  context: ReturnType<typeof fixture>["context"];
}) {
  return { statement: value.statement, context: value.context };
}
describe("new v2 receipt/statement declarations", () => {
  test("plain snapshot traps cannot expose private diagnostics", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("invented-private-snapshot-error");
        },
      },
    );
    let message = "";
    try {
      captureTargetIssuance(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(failure);
  });
  test("intrinsic byte bounds reject hidden oversize and ignore small hostile hooks before copying", () => {
    let calls = 0;
    const hostile = (bytes: Uint8Array) => {
      Object.defineProperties(bytes, {
        byteLength: {
          get() {
            calls++;
            return 1;
          },
        },
        length: {
          get() {
            calls++;
            return 1;
          },
        },
        subarray: {
          value() {
            calls++;
            throw new Error("invented hook");
          },
        },
        [Symbol.iterator]: {
          value() {
            calls++;
            throw new Error("invented iterator");
          },
        },
      });
      return bytes;
    };
    const small = hostile(Buffer.from('{"safe":true}'));
    expect(parseTargetIssuanceJson(small)).toEqual({ safe: true });
    expect(
      targetIssuanceResponse(
        {
          status: 200,
          url: jwksUrl,
          headers: { "content-type": "application/json", "content-length": "13" },
          body: small,
        },
        jwksUrl,
      ),
    ).toEqual({ safe: true });
    expect(calls).toBe(0);
    const large = hostile(new Uint8Array(1_048_577));
    expect(() => parseTargetIssuanceJson(large)).toThrow(failure);
    expect(() =>
      targetIssuanceResponse(
        { status: 200, url: jwksUrl, headers: { "content-type": "application/json" }, body: large },
        jwksUrl,
      ),
    ).toThrow(failure);
    expect(calls).toBe(0);
    expect(() => parseTargetIssuanceJson(Buffer.from('{"invented-private":"token",BAD'))).toThrow(
      failure,
    );
  });
  test("v2 has an exact new purpose/path and canonical audience bound to every private field", () => {
    const f = fixture(),
      s = targetIssuanceStatement(f.statement);
    expect(Object.isFrozen(s.source.plan.projection_step)).toBe(true);
    expect(s.content_receipt.path).toStartWith("applied-target-content-v2/staging/");
    const audience = targetIssuanceAudience(s);
    expect(audience).toMatch(/^urn:tarubot:applied-target-issuance:v2:[a-f0-9]{64}$/u);
    for (const change of [
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.backend = "f".repeat(64);
      },
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.ciphertext_digest = "f".repeat(64);
      },
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.payload_digest = "f".repeat(64);
        s.content_receipt.path = s.content_receipt.path.slice(0, -64) + "f".repeat(64);
      },
      (s: TargetIssuanceStatementV2) => {
        s.source.plan.check_run_id += 100;
      },
      (s: TargetIssuanceStatementV2) => {
        s.issuer.check_run_id++;
      },
      (s: TargetIssuanceStatementV2) => {
        s.valid_until--;
      },
    ]) {
      const changed = structuredClone(s);
      change(changed);
      expect(targetIssuanceAudience(changed)).not.toBe(audience);
    }
    const reordered = Object.fromEntries(Object.entries(f.statement).reverse());
    expect(targetIssuanceAudience(reordered as unknown as TargetIssuanceStatementV2)).toBe(
      audience,
    );
  });
  test("v1/unknown content, mismatched identity, broad path, missing projection and >24h declarations refuse", () => {
    for (const change of [
      (s: TargetIssuanceStatementV2) => {
        Object.assign(s.content_receipt, {
          schema: 1,
          purpose: "tarubot-applied-target-handoff-v1",
        });
      },
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.path = s.content_receipt.path.replace(
          "applied-target-content-v2",
          "applied-target",
        );
      },
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.producer.run = "23457";
      },
      (s: TargetIssuanceStatementV2) => {
        s.source.plan.projection_step.name = "Any projection" as typeof pins.projection;
      },
      (s: TargetIssuanceStatementV2) => {
        s.content_receipt.expires_at = s.content_receipt.issued_at + 86_400_001;
      },
      (s: TargetIssuanceStatementV2) => {
        s.valid_until = s.content_receipt.expires_at + 1;
      },
      (s: TargetIssuanceStatementV2) => {
        Object.assign(s, { completed_at: instant });
      },
      (s: TargetIssuanceStatementV2) => {
        s.source.apply = null;
      },
      (s: TargetIssuanceStatementV2) => {
        s.issuer.job_id = s.source.plan.job_id;
      },
    ]) {
      const f = fixture();
      change(f.statement);
      expect(() => targetIssuanceStatement(f.statement)).toThrow();
    }
    let getters = 0;
    const f = fixture(),
      hostile = Object.defineProperty({ ...f.statement }, "content_receipt", {
        enumerable: true,
        get() {
          getters++;
          return f.statement.content_receipt;
        },
      });
    expect(() => targetIssuanceStatement(hostile)).toThrow(failure);
    expect(getters).toBe(0);
  });
});
describe("local one-attempt mint denial window", () => {
  const input = () => {
    const f = fixture();
    return {
      content_receipt: f.statement.content_receipt,
      source: f.statement.source,
      issuer: f.statement.issuer,
    };
  };
  test("pre-mint audience tolerates 2s and 29s delays without rewriting/renewing the statement", () => {
    for (const delay of [2000, 29_000]) {
      let now = issued;
      const p = prepareTargetIssuance(input(), { now: () => now });
      expect(p.statement.issued_at).toBe(issued);
      expect(p.statement.valid_until).toBe(issued + 86_400_000 - 1000);
      startTargetIssuanceMint(p.window);
      now += delay;
      finishTargetIssuanceMint(p.window);
      expect(targetIssuanceAudience(p.statement)).toBe(p.audience);
      expect(JSON.stringify(p.window)).toBe("{}");
      expect(() => finishTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
      expect(() => startTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
    }
  });
  test("expiry, rollback, duplicate/reentrant start and forged windows never restore one attempt", () => {
    for (const mode of ["deadline", "rollback", "duplicate"]) {
      let now = issued;
      const p = prepareTargetIssuance(input(), { now: () => now });
      startTargetIssuanceMint(p.window);
      if (mode === "deadline") now += 30_000;
      if (mode === "rollback") now--;
      if (mode === "duplicate")
        expect(() => startTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
      expect(() => finishTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
      now = issued;
      expect(() => startTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
    }
    expect(() => startTargetIssuanceMint({} as TargetIssuanceMintWindow)).toThrow(
      "invalid-target-issuance-window",
    );
    let p: ReturnType<typeof prepareTargetIssuance> | undefined,
      reenter = false;
    p = prepareTargetIssuance(input(), {
      now: () => {
        if (reenter && p) startTargetIssuanceMint(p.window);
        return issued;
      },
    });
    reenter = true;
    expect(() => startTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
    reenter = false;
    expect(() => startTargetIssuanceMint(p.window)).toThrow("invalid-target-issuance-window");
    for (const duringFinish of [false, true]) {
      let reserved: ReturnType<typeof prepareTargetIssuance> | undefined,
        swallowedReentry = false,
        nestedRefusals = 0;
      reserved = prepareTargetIssuance(input(), {
        now: () => {
          if (swallowedReentry && reserved) {
            try {
              startTargetIssuanceMint(reserved.window);
            } catch {
              nestedRefusals++;
            }
          }
          return issued;
        },
      });
      if (duringFinish) startTargetIssuanceMint(reserved.window);
      swallowedReentry = true;
      expect(() =>
        duringFinish
          ? finishTargetIssuanceMint(reserved.window)
          : startTargetIssuanceMint(reserved.window),
      ).toThrow("invalid-target-issuance-window");
      swallowedReentry = false;
      expect(nestedRefusals).toBe(1);
      expect(() => finishTargetIssuanceMint(reserved.window)).toThrow(
        "invalid-target-issuance-window",
      );
      expect(() => startTargetIssuanceMint(reserved.window)).toThrow(
        "invalid-target-issuance-window",
      );
    }
  });
});
describe("historical current-JWKS attribution", () => {
  test("real RS256 signature authenticates expired-at-use original JWT only under the separate v2 purpose", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const f = cryptoFixture(mode);
      expect(Number(claims(f).exp) * 1000).toBeLessThan(f.clock.now);
      const proof = await f.verifier.verify(f.input);
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).not.toThrow();
      expect(Object.keys(proof)).toEqual([]);
      expect(JSON.stringify(proof)).toBe("{}");
      expect(f.calls.find((call) => call.url === jwksUrl)?.headers.Authorization).toBeUndefined();
      expect(f.calls.every((call) => call.method === "GET" && call.redirect === "error")).toBe(
        true,
      );
    }
  });
  test("ordinary expired v1/OAuth, wrong audience/subject/environment/repository/job/check-run claims all refuse", async () => {
    for (const [field, value] of Object.entries({
      aud: `urn:tarubot:applied-target-sealing:v1:${"f".repeat(64)}`,
      sub: "repo:deconfined/tarubot:environment:infra-auto",
      environment: "infra-auto",
      repository_id: "999",
      repository_owner_id: "999",
      check_run_id: "103",
      run_attempt: "2",
      event_name: "workflow_dispatch",
      ref_protected: "false",
      head_ref: "foreign",
      job_workflow_sha: "f".repeat(40),
    })) {
      const f = cryptoFixture(),
        body = claims(f);
      body[field] = value;
      f.input.jwt = jwt(body);
      await expect(f.verifier.verify(f.input)).rejects.toThrow(failure);
    }
  });
  test("original internal validity and immutable dual 24h caps are enforced, not exp-now authorization", async () => {
    for (const change of [
      (c: Record<string, unknown>) => {
        c.exp = Number(c.iat) + 901;
      },
      (c: Record<string, unknown>) => {
        c.nbf = Number(c.iat) + 1;
      },
      (c: Record<string, unknown>) => {
        c.nbf = Number(c.iat) - 61;
      },
      (c: Record<string, unknown>) => {
        c.exp = c.iat;
      },
      (c: Record<string, unknown>) => {
        c.iat = Number(c.iat) + 0.5;
      },
    ]) {
      const f = cryptoFixture(),
        body = claims(f);
      change(body);
      f.input.jwt = jwt(body);
      await expect(f.verifier.verify(f.input)).rejects.toThrow(failure);
    }
    const f = cryptoFixture();
    f.statement.issued_at = issued + 1;
    f.statement.content_receipt.issued_at = issued;
    f.statement.content_receipt.expires_at = issued + 86_400_000;
    f.statement.valid_until = issued + 86_400_000;
    f.input.jwt = jwt(claims(f, issued - 1000));
    await expect(f.verifier.verify(f.input)).rejects.toThrow(failure);
  });
  test("signed issuance fits bounded pre-mint delay and actual successful sealing interval", async () => {
    for (const offset of [-1000, 2000, 29_000]) {
      const f = cryptoFixture();
      f.seal.completed_at = new Date(issued + 29_000).toISOString();
      present(f.seal.steps[0]).completed_at = new Date(issued + 29_000).toISOString();
      f.input.jwt = jwt(claims(f, issued + offset));
      const proof = await f.verifier.verify(f.input);
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).not.toThrow();
    }
    for (const offset of [-2000, 30_000, 16_001]) {
      const f = cryptoFixture();
      f.input.jwt = jwt(claims(f, issued + offset));
      await expect(f.verifier.verify(f.input)).rejects.toThrow(failure);
    }
  });
  test("tampered signatures, key absence/alternate sources/private RSA data and ambiguous current JWKS refuse", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const mode of [
      "signature",
      "kid",
      "private",
      "url",
      "duplicate",
      "header-url",
      "mime",
      "partial",
      "duplicate-json",
    ]) {
      const f = cryptoFixture();
      if (mode === "signature") f.input.jwt = jwt(claims(f), undefined, other.privateKey);
      if (mode === "kid") f.data[jwksUrl] = { keys: [{ ...key, kid: "rotated-away" }] };
      if (mode === "private") f.data[jwksUrl] = { keys: [{ ...key, d: "private-packet-field" }] };
      if (mode === "url") f.data[jwksUrl] = { keys: [{ ...key, x5u: "https://example.org/key" }] };
      if (mode === "duplicate") f.data[jwksUrl] = { keys: [key, key] };
      if (mode === "header-url")
        f.input.jwt = jwt(claims(f), {
          alg: "RS256",
          kid: key.kid,
          typ: "JWT",
          jku: "https://example.org/key",
        });
      const verifier = new HistoricalTargetIssuanceVerifier(f.configuration, {
        now: () => f.clock.now,
        get: async (input) => {
          const result = await f.get(input);
          if (input.url === jwksUrl) {
            if (mode === "mime")
              result.headers["content-type"] = "application/json,application/json";
            if (mode === "partial")
              result.headers["content-length"] = String(result.body.length + 1);
            if (mode === "duplicate-json") result.body = Buffer.from('{"keys":[],"\\u006beys":[]}');
          }
          return result;
        },
      });
      await expect(verifier.verify(f.input)).rejects.toThrow(failure);
    }
  });
  test("mutable inputs/instance shadows/configuration cannot replace captured authority and proofs cannot be echoed", async () => {
    const f = cryptoFixture(),
      input = structuredClone(f.input),
      configuration = structuredClone(f.configuration);
    const verifier = new HistoricalTargetIssuanceVerifier(configuration, {
      now: () => f.clock.now,
      get: async (request) => {
        input.statement.content_receipt.ciphertext_digest = "f".repeat(64);
        input.context.backend = "f".repeat(64);
        configuration.repository_id++;
        return f.get(request);
      },
    });
    const original = structuredClone(input);
    const proof = await verifier.verify(input);
    expect(() => assertHistoricalTargetIssuanceProof(proof, scope(original))).not.toThrow();
    expect(() => assertHistoricalTargetIssuanceProof(proof, scope(input))).toThrow(failure);
    expect(JSON.stringify(verifier)).toBe("{}");
    expect(() => Object.assign(verifier, { configuration: { token: "exposed" } })).toThrow();
    for (const echo of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), true])
      expect(() => assertHistoricalTargetIssuanceProof(echo, scope(original))).toThrow(failure);
    let getters = 0;
    const hostile = Object.defineProperty({ ...f.input }, "jwt", {
      enumerable: true,
      get() {
        getters++;
        return f.input.jwt;
      },
    });
    await expect(f.verifier.verify(hostile)).rejects.toThrow(failure);
    expect(getters).toBe(0);
  });
  test("original expiry persists across awaits, late result and future/rollback clocks refuse", async () => {
    const f = cryptoFixture();
    const proof = await f.verifier.verify(f.input);
    const work = withinHistoricalTargetIssuanceProof(proof, scope(f.input), async () => {
      f.clock.now += 30_000;
      return "late";
    });
    await expect(work).rejects.toThrow(failure);
    expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
    for (const mode of ["expired", "future", "rollback", "held"]) {
      const g = cryptoFixture();
      if (mode === "expired") g.clock.now = g.statement.valid_until;
      if (mode === "future") g.clock.now = g.statement.issued_at - 1;
      let calls = 0;
      const verifier = new HistoricalTargetIssuanceVerifier(g.configuration, {
        now: () => g.clock.now,
        get: async (request) => {
          if (mode === "held" && ++calls === 1) {
            const reply = await g.get(request);
            g.clock.now += 29_990;
            return reply;
          }
          if (mode === "held") return new Promise(() => {});
          if (mode === "rollback") g.clock.now--;
          return g.get(request);
        },
      });
      await expect(verifier.verify(g.input)).rejects.toThrow(failure);
    }
  });
  test("downstream work diagnostics stay fixed and permanently fence the original proof", async () => {
    for (const synchronous of [false, true]) {
      const f = cryptoFixture(),
        proof = await f.verifier.verify(f.input);
      const work = () => {
        const error = new Error("invented-private-work-error");
        if (synchronous) throw error;
        return Promise.reject(error);
      };
      const message = await withinHistoricalTargetIssuanceProof(proof, scope(f.input), work).then(
        () => "unexpected-success",
        (error: Error) => error.message,
      );
      expect(message).toBe(failure);
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
      let offers = 0;
      await expect(
        withinHistoricalTargetIssuanceProof(proof, scope(f.input), async () => {
          offers++;
          return "late";
        }),
      ).rejects.toThrow(failure);
      expect(offers).toBe(0);
    }
  });
  test("frozen wall cannot hide physical mint/GET elapsed time in isolated subprocesses", () => {
    const f = cryptoFixture();
    const source = `
      import {performance} from "node:perf_hooks";
      let elapsed=0;
      Object.defineProperty(performance,"now",{value:()=>elapsed});
      const m=await import(${JSON.stringify(new URL("../../scripts/target-issuance.ts", import.meta.url).href)});
      const input=${JSON.stringify(f.input)},config=${JSON.stringify(f.configuration)},data=${JSON.stringify(f.data)};
      const prepared=m.prepareTargetIssuance({content_receipt:input.statement.content_receipt,source:input.statement.source,issuer:input.statement.issuer},{now:()=>${issued}});
      m.startTargetIssuanceMint(prepared.window);elapsed=30000;
      try{m.finishTargetIssuanceMint(prepared.window);process.exit(1);}catch(e){if(e.message!=="invalid-target-issuance-window")process.exit(2);}
      elapsed=0;
      const verifier=new m.HistoricalTargetIssuanceVerifier(config,{now:()=>${instant},get:async request=>{elapsed+=2000;return {status:200,url:request.url,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify(data[request.url]))};}});
      try{await verifier.verify(input);process.exit(3);}catch(e){if(e.message!==${JSON.stringify(failure)})process.exit(4);}
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      env: { TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.byteLength).toBe(0);
  });
  test("outer original timeout permanently fences late nested GETs even after a fresh verification", async () => {
    const f = cryptoFixture();
    let held = false,
      announced!: () => void,
      release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const offers: string[] = [];
    const verifier = new HistoricalTargetIssuanceVerifier(f.configuration, {
      now: () => f.clock.now,
      get: async (request) => {
        offers.push(request.url);
        if (request.url === jwksUrl && !held) {
          const response = await f.get(request);
          f.clock.now = instant + 28_750;
          return response;
        }
        if (request.url === api && !held) {
          held = true;
          announced();
          await waiting;
        }
        return f.get(request);
      },
    });
    const old = verifier.verify(f.input).then(
      () => "unexpected-proof",
      (error) => (error as Error).message,
    );
    await entered;
    expect(await old).toBe(failure);
    const fresh = await verifier.verify(f.input);
    expect(() => assertHistoricalTargetIssuanceProof(fresh, scope(f.input))).not.toThrow();
    const count = offers.length;
    release();
    await Bun.sleep(0);
    expect(offers).toHaveLength(count);
  });
  test("frozen-wall original physical timeout stops all late reader offers without rebind", () => {
    const f = cryptoFixture();
    const source = `
      import {performance} from "node:perf_hooks";let elapsed=0;
      Object.defineProperty(performance,"now",{value:()=>elapsed});
      const m=await import(${JSON.stringify(new URL("../../scripts/target-issuance.ts", import.meta.url).href)});
      const input=${JSON.stringify(f.input)},config=${JSON.stringify(f.configuration)},data=${JSON.stringify(f.data)};
      let held=false,release,announce;const entered=new Promise(r=>announce=r),waiting=new Promise(r=>release=r),offers=[];
      const verifier=new m.HistoricalTargetIssuanceVerifier(config,{now:()=>${instant},get:async request=>{
        offers.push(request.url);
        if(request.url===${JSON.stringify(jwksUrl)}&&!held)elapsed=29990;
        if(request.url===${JSON.stringify(api)}&&!held){held=true;announce();await waiting;}
        return{status:200,url:request.url,headers:{"content-type":"application/json"},body:Buffer.from(JSON.stringify(data[request.url]))};
      }});
      const old=verifier.verify(input).then(()=>"unexpected",error=>error.message);await entered;
      if(await old!==${JSON.stringify(failure)})process.exit(1);
      elapsed=40000;await verifier.verify(input);const count=offers.length;release();await Bun.sleep(0);
      if(offers.length!==count)process.exit(2);
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      env: { TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.byteLength).toBe(0);
  });
  test("observed expiry/rollback and accessor expectations permanently deny the same proof", async () => {
    for (const mode of ["expiry", "rollback", "getter"]) {
      const f = cryptoFixture(),
        proof = await f.verifier.verify(f.input);
      let called = 0;
      const expected = scope(f.input);
      if (mode === "expiry") f.clock.now += 30000;
      if (mode === "rollback") f.clock.now--;
      if (mode === "getter")
        Object.defineProperty(expected, "context", {
          enumerable: true,
          get() {
            called++;
            return f.context;
          },
        });
      expect(() => assertHistoricalTargetIssuanceProof(proof, expected)).toThrow(failure);
      f.clock.now = instant;
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
      expect(called).toBe(0);
    }
  });
  test("caller snapshot reentry cannot pass the outer barrier or clear its reservation", async () => {
    for (const matching of [false, true]) {
      const f = cryptoFixture(),
        proof = await f.verifier.verify(f.input);
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).not.toThrow();
      let enter = true,
        refusals = 0;
      const expected = new Proxy(scope(f.input), {
        ownKeys(target) {
          if (enter) {
            enter = false;
            const nested = scope(f.input);
            if (!matching) nested.context = { ...nested.context, backend: "f".repeat(64) };
            try {
              assertHistoricalTargetIssuanceProof(proof, nested);
            } catch {
              refusals++;
            }
          }
          return Reflect.ownKeys(target);
        },
      });
      expect(() => assertHistoricalTargetIssuanceProof(proof, expected)).toThrow(failure);
      expect(refusals).toBe(1);
      expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
    }
  });
  test("swallowed clock reentry fences both the outer and dependent-native proof barriers", async () => {
    for (const matching of [false, true]) {
      for (const clockSample of [1, 2]) {
        const f = cryptoFixture();
        let proof: unknown,
          enabled = false,
          samples = 0,
          refusals = 0;
        const verifier = new HistoricalTargetIssuanceVerifier(f.configuration, {
          get: f.get,
          now: () => {
            if (enabled && ++samples === clockSample) {
              const nested = scope(f.input);
              if (!matching) nested.context = { ...nested.context, backend: "f".repeat(64) };
              try {
                assertHistoricalTargetIssuanceProof(proof, nested);
              } catch {
                refusals++;
              }
            }
            return f.clock.now;
          },
        });
        proof = await verifier.verify(f.input);
        enabled = true;
        // Sample two runs inside the dependent native proof, after the outer clock passed.
        expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
        expect(refusals).toBe(1);
        enabled = false;
        expect(() => assertHistoricalTargetIssuanceProof(proof, scope(f.input))).toThrow(failure);
      }
    }
  });
  test("default transports keep fixed public origins and capture the real native reader", () => {
    // Transport effects use the trusted invented GET seam above. This static boundary check
    // never invokes defaults or patches builtins and does not claim a live network rehearsal.
    const source = readFileSync(
      new URL("../../scripts/target-issuance.ts", import.meta.url),
      "utf8",
    );
    const reader = readFileSync(
      new URL("../../scripts/target-issuance-run.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('hostname: "token.actions.githubusercontent.com"');
    expect(source).toContain("input.url !== jwksUrl");
    expect(source).toContain("createTargetIssuanceRunReader(");
    expect(reader).toContain('hostname: "api.github.com"');
    expect(reader).toContain("url.origin !== api");
    expect(reader).toContain("url.pathname !== prefix");
    expect(reader).toContain("url.pathname.startsWith");
    for (const text of [source, reader]) {
      expect(text).toContain("rejectUnauthorized: true");
      expect(text).not.toContain("process.env");
      expect(text).not.toContain("fetch(");
    }
  });
});
