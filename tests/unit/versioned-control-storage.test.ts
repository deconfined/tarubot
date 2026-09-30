/** Historical transport uses invented credentials/versions only; no network or backend is read. */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlStorageConfig } from "../../scripts/control-storage.js";
import {
  createVersionedControlStorage,
  type VersionExecution,
  type VersionExecutionResult,
  type VersionExecutor,
} from "../../scripts/versioned-control-storage.js";

const generation = "00000000-0000-4000-8000-000000000001";
const version = "invented/version+._~-";
const pin = "a".repeat(64);
function configuration(scope: ControlStorageConfig["scope"] = "infra"): ControlStorageConfig {
  return {
    scope,
    bucket: "invented-bucket",
    endpoint: "https://region.example.org",
    region: "us-east-1",
    credentials: {
      accessKeyId: "invented_access",
      secretAccessKey: 'invented"secret\\with:punctuation',
      sessionToken: null,
    },
  };
}
interface Reply {
  status?: number;
  headers?: string[];
  body?: Uint8Array;
  code?: number | null;
  signal?: string | null;
  stderr?: string;
  metadata?: string;
  headerBlock?: string;
}
function fixture(reply: Reply = {}) {
  const calls: VersionExecution[] = [];
  const run: VersionExecutor = async (request) => {
    calls.push(request);
    const body = reply.body ?? Uint8Array.from([84, 73, 67, 49, 1, 2, 3]);
    writeFileSync(join(request.directory, "body"), body, { mode: 0o600 });
    const input = new TextDecoder().decode(request.input);
    const url = /^url = "([^"]+)"$/mu.exec(input)?.[1];
    const status = reply.status ?? 200;
    const headers = reply.headers ?? [`x-amz-version-id: ${version}`];
    return {
      code: reply.code === undefined ? 0 : reply.code,
      signal: reply.signal ?? null,
      stdout: Buffer.from(
        (reply.headerBlock ??
          `HTTP/1.1 ${status} Invented\r\nContent-Length: ${body.length}${headers.length ? `\r\n${headers.join("\r\n")}` : ""}\r\n\r\n`) +
          `\nTARUBOT_VERSION_TRANSFER ${reply.metadata ?? `${status} 0 ${url}`}\n`,
      ),
      stderr: Buffer.from(reply.stderr ?? ""),
    };
  };
  return { run, calls };
}

describe("exact scoped historical control transport", () => {
  test("signs the escaped version query with one isolated measured curl invocation", async () => {
    const f = fixture();
    const config = configuration();
    const store = createVersionedControlStorage(config, { curl_sha256: pin }, { run: f.run });
    expect(await store.readVersion(`baselines/${generation}`, version)).toEqual(
      Uint8Array.from([84, 73, 67, 49, 1, 2, 3]),
    );
    expect(f.calls).toHaveLength(1);
    const request = f.calls[0];
    expect(request?.executable).toBe("/usr/bin/curl");
    expect(request?.executable_sha256).toBe(pin);
    expect(request?.args).toEqual(["--disable", "--config", "-"]);
    expect(request?.timeout_ms).toBe(20_000);
    expect(request?.output_limit).toBe(32_768);
    const input = new TextDecoder().decode(request?.input);
    expect(input).toContain(
      `url = "https://invented-bucket.region.example.org/tarubot/control/v1/infra/baselines/${generation}?versionId=invented%2Fversion%2B._~-"`,
    );
    expect(input).toContain('aws-sigv4 = "aws:amz:us-east-1:s3"');
    expect(input).toContain('user = "invented_access:invented\\"secret\\\\with:punctuation"');
    expect(input).toContain('max-time = "15"');
    expect(input).toContain('retry = "0"');
    expect(input).toContain('max-filesize = "67108864"');
    expect(input).toContain('proxy = ""');
    expect(input).toContain("no-location\n");
    expect(input).not.toContain("x-amz-security-token");
    for (const secret of Object.values(config.credentials))
      if (secret !== null) expect(JSON.stringify(request?.args)).not.toContain(secret);
    expect(existsSync(request?.directory ?? "")).toBe(false);
    expect(JSON.stringify(store)).toBe("{}");
    expect(Bun.inspect(store)).not.toContain(config.credentials.secretAccessKey);
  });

  test("requires exact target namespaces and refuses state/other-scope paths before execution", async () => {
    for (const scope of ["infra", "trust-staging", "trust-production"] as const) {
      const f = fixture();
      const store = createVersionedControlStorage(
        configuration(scope),
        { curl_sha256: pin },
        { run: f.run },
      );
      const role = scope === "infra" ? "infra" : scope.slice("trust-".length);
      const good = role === "infra" ? "current" : `trust/${role}/current`;
      await store.readVersion(good, version);
      await store.readVersion(`recovery/${role}/current`, version);
      for (const path of [
        "tarubot/infra.tfstate",
        "../current",
        "current?versionId=latest",
        "current#fragment",
        "tarubot/control/v1/infra/current",
        `trust/${role === "production" ? "staging" : "production"}/current`,
      ])
        await expect(store.readVersion(path, version)).rejects.toThrow(
          "control-version-read-failed",
        );
      expect(f.calls).toHaveLength(2);
      for (const call of f.calls)
        expect(new TextDecoder().decode(call.input)).toContain(`tarubot/control/v1/${scope}/`);
    }
  });

  test("refuses implicit/null, malformed and query-injection versions without a latest fallback", async () => {
    const f = fixture();
    const store = createVersionedControlStorage(
      configuration(),
      { curl_sha256: pin },
      { run: f.run },
    );
    for (const v of [
      "",
      "null",
      "a".repeat(1025),
      "other&versionId=latest",
      "../v?x=y",
      "a\nb",
      "%2F",
      "☃",
    ])
      await expect(store.readVersion("current", v)).rejects.toThrow("control-version-read-failed");
    expect(f.calls).toHaveLength(0);
  });

  test("only definite NoSuchVersion can produce absence", async () => {
    const missing = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchVersion</Code><Message>Invented missing version.</Message><VersionId>${version}</VersionId></Error>`,
    );
    const f = fixture({ status: 404, headers: [], body: missing });
    const store = createVersionedControlStorage(
      configuration(),
      { curl_sha256: pin },
      { run: f.run },
    );
    expect(await store.readVersion("current", version)).toBeNull();
    expect(f.calls).toHaveLength(1);
    const bad = [
      "<Error><Code>NoSuchKey</Code></Error>",
      "<Error><Code>NoSuchBucket</Code></Error>",
      "<Error><Code>AccessDenied</Code></Error>",
      "<Error><Code>NoSuchVersion</Code><Code>NoSuchVersion</Code></Error>",
      "<Error><Code>NoSuchVersion</Code><VersionId>different</VersionId></Error>",
      "<Error><Code>NoSuchVersion</Code><Key>foreign-key</Key></Error>",
      "<Error><Code>NoSuchVersion</Code><BucketName>foreign-bucket</BucketName></Error>",
      "<Error><Code>NoSuchVersion</Code><Resource>/foreign-bucket/foreign-key</Resource></Error>",
      "<Error><Code>NoSuchVersion</Code><Message>unclosed</Error>",
      "<Error><Message><Code>NoSuchVersion</Code></Message></Error>",
      "<html><Code>NoSuchVersion</Code></html>",
      '<!DOCTYPE Error [<!ENTITY x "NoSuchVersion">]><Error><Code>&x;</Code></Error>',
    ];
    for (const text of bad) {
      const negative = fixture({ status: 404, headers: [], body: Buffer.from(text) });
      const rejected = createVersionedControlStorage(
        configuration(),
        { curl_sha256: pin },
        { run: negative.run },
      );
      await expect(rejected.readVersion("current", version)).rejects.toThrow(
        "control-version-read-failed",
      );
      expect(negative.calls).toHaveLength(1);
      expect(existsSync(negative.calls[0]?.directory ?? "")).toBe(false);
    }
  });

  test("refuses wrong/missing/duplicate version metadata, redirects, partial and delete-marker responses", async () => {
    for (const reply of [
      { headers: [] },
      { headers: ["x-amz-version-id: wrong"] },
      { headers: [`x-amz-version-id: ${version}`, `X-Amz-Version-Id: ${version}`] },
      { headers: [`x-amz-version-id: ${version}`, "Location: https://other.example.org"] },
      { headers: [`x-amz-version-id: ${version}`, "x-amz-delete-marker: true"] },
      { headers: [`x-amz-version-id: ${version}`, "Content-Range: bytes 0-6/9"] },
      { headers: [`x-amz-version-id: ${version}`, "Content-Encoding: gzip"] },
      { headers: [`x-amz-version-id: ${version}`, "Transfer-Encoding: chunked"] },
      { headers: [`x-amz-version-id: ${version}`, "Content-Length: 8"] },
      { status: 206 },
      { status: 301 },
      { status: 405 },
      { status: 403 },
      { status: 503 },
      { metadata: "200 1 https://invented-bucket.region.example.org/wrong" },
      { metadata: "200 0 https://invented-bucket.region.example.org/wrong" },
      {
        headerBlock: `HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 7\r\nx-amz-version-id: ${version}\r\n\r\n`,
      },
      {
        headerBlock: `HTTP/1.1 200 OK\r\nContent-Length: 7\r\n x-amz-version-id: ${version}\r\n\r\n`,
      },
    ] satisfies Reply[]) {
      const f = fixture(reply);
      const store = createVersionedControlStorage(
        configuration(),
        { curl_sha256: pin },
        { run: f.run },
      );
      await expect(store.readVersion("current", version)).rejects.toThrow(
        "control-version-read-failed",
      );
      expect(f.calls).toHaveLength(1);
      expect(existsSync(f.calls[0]?.directory ?? "")).toBe(false);
    }
  });

  test("uncertain process results and private errors stay fixed and cannot cause retry", async () => {
    for (const reply of [
      { code: 28, stderr: "invented timeout private diagnostic" },
      { code: null, signal: "SIGKILL" },
      { code: 0, stderr: "invented config warning" },
      { body: new Uint8Array() },
    ] satisfies Reply[]) {
      const f = fixture(reply);
      const store = createVersionedControlStorage(
        configuration(),
        { curl_sha256: pin },
        { run: f.run },
      );
      await expect(store.readVersion("current", version)).rejects.toThrow(
        "control-version-read-failed",
      );
      expect(f.calls).toHaveLength(1);
    }
    const f = fixture();
    const run: VersionExecutor = async (request) => {
      await f.run(request);
      throw new Error("invented credential and private object diagnostic");
    };
    const store = createVersionedControlStorage(configuration(), { curl_sha256: pin }, { run });
    await expect(store.readVersion("current", version)).rejects.toThrow(
      "control-version-read-failed",
    );
    expect(f.calls).toHaveLength(1);
    expect(existsSync(f.calls[0]?.directory ?? "")).toBe(false);
  });

  test("snapshots authority config and sends an explicit session credential only through stdin", async () => {
    const config = configuration();
    config.credentials.sessionToken = "invented_session";
    const f = fixture();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: VersionExecutor = async (request) => {
      await wait;
      return f.run(request);
    };
    const store = createVersionedControlStorage(config, { curl_sha256: pin }, { run });
    const pending = store.readVersion("current", version);
    config.bucket = "other-bucket";
    config.credentials.accessKeyId = "other_access";
    config.credentials.sessionToken = "other_session";
    expect(Reflect.set(store, "config", config)).toBe(false);
    expect(Reflect.set(store, "run", () => {})).toBe(false);
    release?.();
    await pending;
    const input = new TextDecoder().decode(f.calls[0]?.input);
    expect(input).toContain('header = "x-amz-security-token: invented_session"');
    expect(input).toContain("invented-bucket.region.example.org");
    expect(input).toContain("invented_access:");
    expect(input).not.toContain("other_session");
    expect(JSON.stringify(store)).not.toContain("invented_session");
  });

  test("rejects unpinned tools and ambiguous configuration before subprocess or network", () => {
    for (const options of [
      { curl_sha256: "" },
      { curl_sha256: "a".repeat(63) },
      { curl_sha256: pin, extra: true },
    ])
      expect(() => createVersionedControlStorage(configuration(), options)).toThrow(
        "invalid-control-version-storage",
      );
    for (const patch of [
      { endpoint: "http://region.example.org" },
      { endpoint: "https://region.example.org:443" },
      { bucket: "invented.bucket" },
      { scope: "other" },
    ])
      expect(() =>
        createVersionedControlStorage({ ...configuration(), ...patch } as ControlStorageConfig, {
          curl_sha256: pin,
        }),
      ).toThrow("invalid-control-version-storage");
  });

  test("output caps and truncated bytes fail before granting a historical object", async () => {
    const f = fixture();
    const run: VersionExecutor = async (request) => {
      const result = await f.run(request);
      return { ...result, stdout: new Uint8Array(32769) } satisfies VersionExecutionResult;
    };
    const store = createVersionedControlStorage(configuration(), { curl_sha256: pin }, { run });
    await expect(store.readVersion("current", version)).rejects.toThrow(
      "control-version-read-failed",
    );
    expect(existsSync(f.calls[0]?.directory ?? "")).toBe(false);
    const short = fixture({
      headerBlock: `HTTP/1.1 200 OK\r\nContent-Length: 8\r\nx-amz-version-id: ${version}\r\n\r\n`,
    });
    const rejected = createVersionedControlStorage(
      configuration(),
      { curl_sha256: pin },
      { run: short.run },
    );
    await expect(rejected.readVersion("current", version)).rejects.toThrow(
      "control-version-read-failed",
    );
  });
});
