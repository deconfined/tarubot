/**
 * Exact historical-version reads for owner-selected recovery manifests. Curl signs the actual
 * versionId query; this never appends a query to Bun's object key or falls back to latest bytes.
 * No listing, version discovery, deletion, owner approval or journal repair is performed here.
 * Primary contracts: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
 * https://curl.se/docs/manpage.html#--aws-sigv4 and #--config.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionedControlStore } from "./control-recovery.js";
import {
  createControlStorage,
  type ControlStorageConfig,
  type ScopedControlStore,
} from "./control-storage.js";

const maximumBytes = 64 * 1024 * 1024;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const marker = "\nTARUBOT_VERSION_TRANSFER ";
function requireVersion(value: unknown): asserts value {
  if (!value) throw new Error("invalid-control-version");
}

export interface VersionExecution {
  executable: "/usr/bin/curl";
  executable_sha256: string;
  args: ["--disable", "--config", "-"];
  directory: string;
  /** Credentials and private object/version URLs stay in the input pipe, never argv or files. */
  input: Uint8Array;
  timeout_ms: 20_000;
  output_limit: 32_768;
}
export interface VersionExecutionResult {
  code: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export type VersionExecutor = (request: VersionExecution) => Promise<VersionExecutionResult>;

function privateEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    LANG: "C",
    LC_ALL: "C",
    OPENSSL_CONF: "/dev/null",
  };
}

function verifyExecutable(request: VersionExecution): void {
  const file = lstatSync(request.executable);
  requireVersion(file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0 && file.nlink === 1);
  requireVersion(
    createHash("sha256").update(readFileSync(request.executable)).digest("hex") ===
      request.executable_sha256,
  );
  try {
    lstatSync("/etc/ld.so.preload");
  } catch (error) {
    requireVersion(error instanceof Error && "code" in error && error.code === "ENOENT");
    // Streaming max-filesize enforcement requires curl >=8.4, even without Content-Length.
    // A reviewed hash alone must not accidentally authorize an older unbounded transfer.
    const probe = spawnSync(request.executable, ["--disable", "--version"], {
      cwd: request.directory,
      env: privateEnvironment(request.directory),
      timeout: 3000,
      maxBuffer: 16384,
    });
    requireVersion(probe.status === 0 && probe.signal === null && probe.stderr.length === 0);
    const version = /^curl ([0-9]+)\.([0-9]+)\.([0-9]+) /u.exec(probe.stdout.toString());
    requireVersion(
      version !== null &&
        (Number(version[1]) > 8 || (Number(version[1]) === 8 && Number(version[2]) >= 4)),
    );
    return;
  }
  // Clearing LD_* cannot disable the system-wide preload file.
  throw new Error("invalid-control-version");
}

/** One isolated transfer, no inherited proxy, CA override, crypto configuration or credential. */
const execute: VersionExecutor = (request) =>
  new Promise((accept, reject) => {
    try {
      verifyExecutable(request);
    } catch {
      reject(new Error("control-version-process-failed"));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let refused = false;
    const child = spawn(request.executable, request.args, {
      cwd: request.directory,
      env: privateEnvironment(request.directory),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => {
      refused = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, request.timeout_ms);
    const collect = (target: Buffer[], bytes: Buffer) => {
      size += bytes.length;
      if (size > request.output_limit) stop();
      else target.push(Buffer.from(bytes));
    };
    child.stdout.on("data", (bytes: Buffer) => collect(out, bytes));
    child.stderr.on("data", (bytes: Buffer) => collect(err, bytes));
    child.stdin.on("error", stop);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("control-version-process-failed"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        requireVersion(!refused);
        verifyExecutable(request);
        accept({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      } catch {
        reject(new Error("control-version-process-failed"));
      }
    });
    child.stdin.end(request.input);
  });

/** Curl config has its own quoting rules, and is passed directly to stdin without a shell. */
function quoted(value: string): string {
  requireVersion(/^[\x20-\x7e]*$/u.test(value));
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function option(name: string, value: string): string {
  return `${name} = ${quoted(value)}`;
}
function versionId(value: unknown): asserts value is string {
  requireVersion(
    typeof value === "string" && value !== "null" && /^[A-Za-z0-9._~+/-]{1,1024}$/u.test(value),
  );
}
function key(store: ScopedControlStore, path: string): string {
  requireVersion(typeof path === "string");
  const target = store.scope === "infra" ? "infra" : store.scope.slice("trust-".length);
  const ordinary =
    target === "infra"
      ? `(?:current|(?:intents|baselines|completed)/${uuid})`
      : `trust/${target}/(?:registration|authorization-current|current|(?:authorizations|attempts|consumed|intents|references|records|publication-intents|publications|completed)/${uuid})`;
  const repair = `recovery/${target}/(?:registration|current|(?:intents|completed)/${uuid})`;
  requireVersion(new RegExp(`^(?:${ordinary}|${repair})$`, "u").test(path));
  return store.namespace + path;
}

function response(
  result: VersionExecutionResult,
  url: string,
): {
  status: number;
  headers: Record<string, string>;
} {
  requireVersion(
    result &&
      result.code === 0 &&
      result.signal === null &&
      result.stdout instanceof Uint8Array &&
      result.stderr instanceof Uint8Array &&
      result.stderr.length === 0 &&
      result.stdout.length > 0 &&
      result.stdout.length <= 32768,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  const boundary = text.indexOf(marker);
  requireVersion(boundary > 0 && text.lastIndexOf(marker) === boundary);
  const metadata = text.slice(boundary + marker.length);
  const match = /^([0-9]{3}) 0 (https:\/\/[^\r\n]+)\n$/u.exec(metadata);
  requireVersion(match?.[2] === url);
  const status = Number(match?.[1]);
  const block = text.slice(0, boundary);
  requireVersion(block.length <= 16384 && block.endsWith("\r\n\r\n"));
  const lines = block.slice(0, -4).split("\r\n");
  requireVersion(
    new RegExp(`^HTTP/1\\.1 ${status} [\\x20-\\x7e]*$`, "u").test(lines.shift() ?? ""),
  );
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/u.exec(line);
    requireVersion(header?.[1] !== undefined && header[2] !== undefined);
    const name = header[1].toLowerCase();
    requireVersion(!Object.hasOwn(headers, name));
    headers[name] = header[2].trim();
  }
  requireVersion(
    headers.location === undefined &&
      headers["x-amz-website-redirect-location"] === undefined &&
      headers["content-range"] === undefined &&
      headers["transfer-encoding"] === undefined &&
      headers["x-amz-delete-marker"] === undefined &&
      (headers["content-encoding"] === undefined || headers["content-encoding"] === "identity"),
  );
  return { status, headers };
}

/** Accept only a simple complete S3 error document, never HTML, entities or parser recovery. */
function missingVersion(
  content: Uint8Array,
  expected: { version: string; key: string; bucket: string },
): void {
  requireVersion(content.length <= 16384);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content).trim();
  const xml = text.replace(/^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>\s*/u, "");
  requireVersion(xml.startsWith("<Error>") && xml.endsWith("</Error>"));
  const children = xml.slice(7, -8);
  const field = /\s*<([A-Za-z][A-Za-z0-9]*)>([^<&]*)<\/\1>/uy;
  const values: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < children.length && children.slice(offset).trim().length > 0) {
    field.lastIndex = offset;
    const match = field.exec(children);
    requireVersion(match?.[1] !== undefined && match[2] !== undefined);
    requireVersion(
      [
        "Code",
        "Message",
        "Key",
        "BucketName",
        "Resource",
        "RequestId",
        "HostId",
        "VersionId",
      ].includes(match[1]) && !Object.hasOwn(values, match[1]),
    );
    values[match[1]] = match[2];
    offset = field.lastIndex;
  }
  requireVersion(children.slice(offset).trim().length === 0);
  requireVersion(values.Code === "NoSuchVersion");
  requireVersion(values.VersionId === undefined || values.VersionId === expected.version);
  requireVersion(values.Key === undefined || values.Key === expected.key);
  requireVersion(values.BucketName === undefined || values.BucketName === expected.bucket);
  // Providers differ in Resource formatting; do not guess a representation for absence proof.
  requireVersion(values.Resource === undefined);
}

class HistoricalControlStore implements VersionedControlStore {
  readonly #config: ControlStorageConfig;
  readonly #latest: ScopedControlStore;
  readonly #pin: string;
  readonly #run: VersionExecutor;
  constructor(config: ControlStorageConfig, pin: string, run: VersionExecutor) {
    this.#config = structuredClone(config);
    // Native local presign verifies explicit routing/credentials without an HTTP request.
    this.#latest = createControlStorage(this.#config);
    requireVersion(typeof pin === "string" && /^[a-f0-9]{64}$/u.test(pin));
    this.#pin = pin;
    this.#run = run;
    Object.freeze(this);
  }
  read(path: string): Promise<Uint8Array | null> {
    return this.#latest.read(path);
  }
  write(path: string, value: Uint8Array): Promise<void> {
    return this.#latest.write(path, value);
  }
  async readVersion(path: string, version: string): Promise<Uint8Array | null> {
    let directory: string | undefined;
    let failed = false;
    let bytes: Uint8Array | null = null;
    try {
      versionId(version);
      const objectKey = key(this.#latest, path);
      const host = `${this.#config.bucket}.${this.#config.endpoint.slice("https://".length)}`;
      const url = `https://${host}/${objectKey}?versionId=${encodeURIComponent(version)}`;
      directory = mkdtempSync(join(tmpdir(), "tarubot-control-version-"));
      const body = join(directory, "body");
      writeFileSync(body, new Uint8Array(), { mode: 0o600, flag: "wx" });
      const config = `${[
        "silent",
        "show-error",
        "globoff",
        "path-as-is",
        "http1.1",
        "no-location",
        option("proxy", ""),
        option("noproxy", "*"),
        option("proto", "=https"),
        option("proto-redir", "=https"),
        "tlsv1.2",
        option("retry", "0"),
        option("max-redirs", "0"),
        option("connect-timeout", "5"),
        option("max-time", "15"),
        option("max-filesize", String(maximumBytes)),
        option("request", "GET"),
        option("aws-sigv4", `aws:amz:${this.#config.region}:s3`),
        option(
          "user",
          `${this.#config.credentials.accessKeyId}:${this.#config.credentials.secretAccessKey}`,
        ),
        option("header", "Accept-Encoding: identity"),
        ...(this.#config.credentials.sessionToken === null
          ? []
          : [option("header", `x-amz-security-token: ${this.#config.credentials.sessionToken}`)]),
        option("url", url),
        option("output", body),
        option("dump-header", "-"),
        // Literal config escape, expanded by curl; no credential reaches diagnostic argv.
        'write-out = "\\nTARUBOT_VERSION_TRANSFER %{http_code} %{num_redirects} %{url_effective}\\n"',
      ].join("\n")}\n`;
      const result = await this.#run({
        executable: "/usr/bin/curl",
        executable_sha256: this.#pin,
        args: ["--disable", "--config", "-"],
        directory,
        input: Buffer.from(config),
        timeout_ms: 20_000,
        output_limit: 32_768,
      });
      const r = response(result, url);
      const file = lstatSync(body);
      requireVersion(
        file.isFile() &&
          file.uid === process.getuid?.() &&
          file.nlink === 1 &&
          (file.mode & 0o077) === 0 &&
          file.size > 0 &&
          file.size <= maximumBytes,
      );
      requireVersion(
        /^[1-9][0-9]{0,8}$/u.test(r.headers["content-length"] ?? "") &&
          Number(r.headers["content-length"]) === file.size,
      );
      const content = readFileSync(body);
      requireVersion(content.length === file.size);
      if (r.status === 404) {
        // Only the exact service error can mean absence. Delete markers, missing bucket/key,
        // denied access and arbitrary 404 pages remain failures; never ask for latest instead.
        missingVersion(content, { version, key: objectKey, bucket: this.#config.bucket });
        requireVersion(
          r.headers["x-amz-version-id"] === undefined || r.headers["x-amz-version-id"] === version,
        );
      } else {
        requireVersion(r.status === 200 && r.headers["x-amz-version-id"] === version);
        bytes = Uint8Array.from(content);
      }
    } catch {
      failed = true;
    }
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: false });
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("control-version-read-failed");
    return bytes;
  }
}

/** The owner independently reviews/pins the runner's system curl binary; no PATH fallback. */
export function createVersionedControlStorage(
  config: ControlStorageConfig,
  options: { curl_sha256: string },
  dependencies: { run?: VersionExecutor } = {},
): VersionedControlStore {
  try {
    const input = structuredClone({ config, options });
    requireVersion(Object.keys(input.options).length === 1);
    return new HistoricalControlStore(
      input.config,
      input.options.curl_sha256,
      dependencies.run ?? execute,
    );
  } catch {
    throw new Error("invalid-control-version-storage");
  }
}
