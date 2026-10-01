/**
 * Source-only release scanner exceptions. The protected main/CODEOWNERS review is the review
 * boundary, not a timestamp, issue link or caller flag. Production imports only the empty policy
 * below; no ignore file, environment value, HTTP response or CLI option can supply exceptions.
 */
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

type Value = Record<string, unknown>;
export type ReleaseScanPlatform = "linux/amd64" | "linux/arm64";
export const releaseScanner = Object.freeze({
  version: "0.74.0",
  sha256: "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
});
const image = "ghcr.io/deconfined/tarubot";
const maxReport = 16 * 1024 * 1024;
const maxLifetime = 30 * 24 * 60 * 60_000;
const maxOperation = 30 * 60_000;
const findingKeys = [
  "platform",
  "result_class",
  "result_type",
  "result_target",
  "os_extended",
  "vulnerability_id",
  "package_name",
  "package_id",
  "package_path",
  "package_purl",
  "installed_version",
  "fixed_version",
  "severity",
] as const;

export interface ReleaseScanFinding {
  platform: ReleaseScanPlatform;
  result_class: "os-pkgs" | "lang-pkgs";
  result_type: string;
  result_target: string;
  /** OS family/base version live in result_target; preserve extended support separately. */
  os_extended: boolean | null;
  vulnerability_id: string;
  package_name: string;
  package_id: string | null;
  package_path: string | null;
  package_purl: string | null;
  installed_version: string;
  fixed_version: string;
  severity: "HIGH" | "CRITICAL";
}
export interface ReleaseScanException extends ReleaseScanFinding {
  reason: string;
  issue: string;
  reviewed_at: number;
  expires_at: number;
}
export interface ReleaseScanExceptionPolicy {
  schema: 1;
  scanner_version: "0.74.0";
  entries: readonly ReleaseScanException[];
}
/** Each future entry requires a reviewed main change; the default grants no exception. */
export const releaseScanExceptions: ReleaseScanExceptionPolicy = Object.freeze({
  schema: 1,
  scanner_version: "0.74.0",
  entries: Object.freeze([]),
});

function requireScan(value: unknown): asserts value {
  if (!value) throw new Error("invalid-release-scan-gate");
}
function object(value: unknown): Value {
  requireScan(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Value;
}
function exact(value: unknown, keys: readonly string[]): Value {
  const data = object(value);
  requireScan(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function text(value: unknown, limit = 1024): asserts value is string {
  requireScan(
    typeof value === "string" &&
      value.length > 0 &&
      value.trim() === value &&
      Buffer.byteLength(value) <= limit &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
}
function time(value: unknown): asserts value is number {
  requireScan(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Supplied test policies/bindings are bounded plain snapshots; accessors never execute. */
function snapshot(input: unknown): unknown {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    requireScan(++nodes <= 4096 && depth <= 8);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      requireScan(Number.isFinite(value));
      return value;
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      requireScan(bytes <= 32_768);
      return value;
    }
    requireScan(value !== null && typeof value === "object" && !ancestors.has(value));
    requireScan(Object.getOwnPropertySymbols(value).length === 0);
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let result: unknown;
    if (Array.isArray(value)) {
      requireScan(value.length <= 32 && Object.keys(descriptors).length === value.length + 1);
      result = Array.from({ length: value.length }, (_, index) => {
        const item = descriptors[String(index)];
        requireScan(item?.enumerable === true && Object.hasOwn(item, "value"));
        return copy(item.value, depth + 1);
      });
    } else {
      requireScan(
        Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      );
      const output: Value = {};
      for (const [key, item] of Object.entries(descriptors)) {
        requireScan(item.enumerable === true && Object.hasOwn(item, "value"));
        bytes += Buffer.byteLength(key);
        requireScan(bytes <= 32_768);
        Object.defineProperty(output, key, {
          value: copy(item.value, depth + 1),
          enumerable: true,
        });
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  };
  const result = copy(input, 0);
  requireScan(Buffer.byteLength(JSON.stringify(result)) <= 32_768);
  return result;
}

/** Complete UTF-8 JSON only, with bounded nesting/nodes and duplicate decoded keys refused. */
export function releaseScanJson(input: Uint8Array): unknown {
  try {
    requireScan(input instanceof Uint8Array && input.length > 0 && input.length <= maxReport);
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(input),
    );
    let at = 0,
      nodes = 0;
    const whitespace = () => {
      while (/^[ \t\r\n]$/u.test(source[at] ?? "")) at++;
    };
    const string = () => {
      requireScan(source[at] === '"');
      const start = at++;
      while (at < source.length) {
        if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
        if (source[at - 1] === "\\") at++;
      }
      throw new Error("invalid-release-scan-gate");
    };
    const value = (depth: number): void => {
      requireScan(++nodes <= 131_072 && depth <= 32);
      whitespace();
      const first = source[at];
      if (first === '"') {
        string();
        return;
      }
      if (first === "{" || first === "[") {
        at++;
        whitespace();
        const end = first === "{" ? "}" : "]",
          keys = new Set<string>();
        if (source[at] === end) {
          at++;
          return;
        }
        for (;;) {
          whitespace();
          if (first === "{") {
            const key = string();
            requireScan(!keys.has(key));
            keys.add(key);
            whitespace();
            requireScan(source[at++] === ":");
          }
          value(depth + 1);
          whitespace();
          const next = source[at++];
          if (next === end) return;
          requireScan(next === ",");
        }
      }
      const start = at;
      while (at < source.length && !/^[,}\] \t\r\n]$/u.test(source[at] ?? "")) at++;
      requireScan(at > start);
      const primitive = JSON.parse(source.slice(start, at)) as unknown;
      requireScan(typeof primitive !== "number" || Number.isFinite(primitive));
    };
    value(0);
    whitespace();
    requireScan(at === source.length);
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("invalid-release-scan-gate");
  }
}
function key(finding: ReleaseScanFinding): string {
  // Literal equality only: versions, package names, IDs and paths are never patterns/ranges.
  return JSON.stringify(findingKeys.map((name) => finding[name]));
}
function osFamily(value: unknown): asserts value is string {
  requireScan(typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value));
}
function osVersion(value: unknown): asserts value is string {
  requireScan(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value));
}
function finding(input: unknown): ReleaseScanFinding {
  const f = object(input);
  requireScan(f.platform === "linux/amd64" || f.platform === "linux/arm64");
  requireScan(f.result_class === "os-pkgs" || f.result_class === "lang-pkgs");
  requireScan(f.severity === "HIGH" || f.severity === "CRITICAL");
  for (const name of [
    "result_type",
    "result_target",
    "vulnerability_id",
    "package_name",
    "installed_version",
    "fixed_version",
  ])
    text(f[name]);
  for (const name of ["package_id", "package_path", "package_purl"])
    if (f[name] !== null) text(f[name]);
  if (f.package_purl !== null) requireScan((f.package_purl as string).startsWith("pkg:"));
  if (f.result_class === "os-pkgs") {
    osFamily(f.result_type);
    const prefix = `${f.result_type} `;
    const target = f.result_target as string;
    requireScan(target.startsWith(prefix) && typeof f.os_extended === "boolean");
    osVersion(target.slice(prefix.length));
  } else requireScan(f.os_extended === null);
  return f as unknown as ReleaseScanFinding;
}
/**
 * OS Target includes the image reference in pinned ospkg/scan.go. Construct and compare the
 * WHOLE raw target after immutable child verification; never search/strip a suffix or wildcard.
 * Store only the exact family/base-version tuple and separate extended flag, so source policy
 * changes do not require their own resulting image digest. Language paths remain literal.
 */
function resultIdentity(
  result: Value,
  metadata: Value,
  reference: string,
): { target: string; extended: boolean | null } {
  if (result.Class !== "os-pkgs") return { target: result.Target as string, extended: null };
  const os = object(metadata.OS);
  const fields = new Set(["Family", "Name", "EOSL", "Supplier", "extended"]);
  requireScan(Object.keys(os).every((name) => fields.has(name)));
  osFamily(os.Family);
  osVersion(os.Name);
  requireScan(result.Type === os.Family);
  requireScan(os.EOSL === undefined || typeof os.EOSL === "boolean");
  if (os.Supplier !== undefined) text(os.Supplier);
  const extended = os.extended === undefined ? false : os.extended;
  requireScan(typeof extended === "boolean");
  const version = `${os.Name}${extended ? "-ESM" : ""}`;
  requireScan(result.Target === `${reference} (${os.Family} ${version})`);
  return { target: `${os.Family} ${os.Name}`, extended };
}
function policy(input: unknown): ReleaseScanExceptionPolicy {
  const p = exact(snapshot(input), ["schema", "scanner_version", "entries"]);
  requireScan(
    p.schema === 1 &&
      p.scanner_version === releaseScanner.version &&
      Array.isArray(p.entries) &&
      p.entries.length <= 32,
  );
  const seen = new Set<string>();
  for (const entry of p.entries) {
    const e = exact(entry, [...findingKeys, "reason", "issue", "reviewed_at", "expires_at"]);
    const f = finding(e);
    requireScan(f.package_id !== null || f.package_purl !== null);
    text(e.reason, 1024);
    requireScan((e.reason as string).length >= 20);
    requireScan(
      typeof e.issue === "string" &&
        /^https:\/\/github\.com\/deconfined\/tarubot\/issues\/[1-9][0-9]{0,9}$/u.test(e.issue),
    );
    time(e.reviewed_at);
    time(e.expires_at);
    requireScan(e.expires_at > e.reviewed_at && e.expires_at - e.reviewed_at <= maxLifetime);
    const id = key(f);
    requireScan(!seen.has(id));
    seen.add(id);
  }
  return frozen(p) as unknown as ReleaseScanExceptionPolicy;
}

/**
 * One invocation's gate, not a reusable authority cache. Bind each report only after boundIndex
 * and platformImages verified the build index. Constructor/report/finish all check expiry against
 * wall AND monotonic elapsed time, so frozen/backward wall clocks cannot extend an exception.
 */
export class ReleaseScanGate {
  readonly #policy: ReleaseScanExceptionPolicy;
  readonly #now: () => number;
  readonly #monotonic: () => number;
  readonly #started: number;
  readonly #physicalStarted: number;
  #last: number;
  #physicalLast: number;
  readonly #reports = new Map<ReleaseScanPlatform, string>();
  #failed = false;
  #finished = false;
  constructor(
    input: unknown = releaseScanExceptions,
    dependencies: { now?: () => number; monotonic?: () => number } = {},
  ) {
    try {
      const now = dependencies.now ?? Date.now,
        monotonic = dependencies.monotonic ?? (() => performance.now());
      requireScan(typeof now === "function" && typeof monotonic === "function");
      this.#now = now;
      this.#monotonic = monotonic;
      this.#started = now();
      time(this.#started);
      this.#last = this.#started;
      this.#physicalStarted = monotonic();
      requireScan(Number.isFinite(this.#physicalStarted) && this.#physicalStarted >= 0);
      this.#physicalLast = this.#physicalStarted;
      this.#policy = policy(input);
      this.#time();
    } catch {
      throw new Error("invalid-release-scan-gate");
    }
  }
  #time(): number {
    requireScan(!this.#failed && !this.#finished);
    const at = this.#now(),
      physical = this.#monotonic();
    time(at);
    requireScan(at >= this.#last && Number.isFinite(physical) && physical >= this.#physicalLast);
    const elapsed = physical - this.#physicalStarted;
    requireScan(at - this.#started < maxOperation && elapsed < maxOperation);
    this.#last = at;
    this.#physicalLast = physical;
    const effective = Math.max(at, this.#started + elapsed);
    for (const e of this.#policy.entries)
      requireScan(e.reviewed_at <= at && effective < e.expires_at);
    return effective;
  }
  checkReport(
    bytes: Uint8Array,
    input: { platform: ReleaseScanPlatform; digest: string },
  ): { findings: number; exceptions: number } {
    try {
      this.#time();
      const binding = exact(snapshot(input), ["platform", "digest"]);
      requireScan(binding.platform === "linux/amd64" || binding.platform === "linux/arm64");
      requireScan(
        typeof binding.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(binding.digest),
      );
      const platform = binding.platform,
        reference = `${image}@${binding.digest}`;
      requireScan(
        !this.#reports.has(platform) && ![...this.#reports.values()].includes(binding.digest),
      );
      const report = object(releaseScanJson(bytes));
      requireScan(
        report.SchemaVersion === 2 &&
          report.ArtifactType === "container_image" &&
          report.ArtifactName === reference,
      );
      requireScan(exact(report.Trivy, ["Version"]).Version === releaseScanner.version);
      const metadata = object(report.Metadata),
        config = object(metadata.ImageConfig);
      requireScan(
        metadata.Reference === reference && isDeepStrictEqual(metadata.RepoDigests, [reference]),
      );
      requireScan(config.os === "linux" && config.architecture === platform.slice(6));
      const results = report.Results === undefined ? [] : report.Results;
      requireScan(Array.isArray(results) && results.length <= 1024);
      const allowed = new Set(this.#policy.entries.map(key)),
        seen = new Set<string>(),
        resultIds = new Set<string>();
      let count = 0;
      for (const inputResult of results) {
        const result = object(inputResult);
        text(result.Target);
        text(result.Type);
        requireScan(result.Class === "os-pkgs" || result.Class === "lang-pkgs");
        const identity = resultIdentity(result, metadata, reference);
        for (const name of [
          "Misconfigurations",
          "Secrets",
          "Licenses",
          "CustomResources",
          "ExperimentalModifiedFindings",
        ])
          requireScan(!Object.hasOwn(result, name));
        requireScan(
          result.Packages === undefined ||
            (Array.isArray(result.Packages) && result.Packages.length === 0),
        );
        const resultId = JSON.stringify([result.Class, result.Type, result.Target]);
        requireScan(!resultIds.has(resultId));
        resultIds.add(resultId);
        const vulnerabilities = result.Vulnerabilities === undefined ? [] : result.Vulnerabilities;
        requireScan(Array.isArray(vulnerabilities) && vulnerabilities.length <= 65_536);
        for (const inputVulnerability of vulnerabilities) {
          requireScan(++count <= 65_536);
          const v = object(inputVulnerability);
          requireScan(v.Status === "fixed");
          const identifier = v.PkgIdentifier === undefined ? undefined : object(v.PkgIdentifier);
          // Only absent omitempty fields become null. Explicit null/empty identities are errors.
          for (const name of ["PkgID", "PkgPath"]) if (v[name] !== undefined) text(v[name]);
          if (identifier?.PURL !== undefined) text(identifier.PURL);
          const f = finding({
            platform,
            result_class: result.Class,
            result_type: result.Type,
            result_target: identity.target,
            os_extended: identity.extended,
            vulnerability_id: v.VulnerabilityID,
            package_name: v.PkgName,
            package_id: v.PkgID ?? null,
            package_path: v.PkgPath ?? null,
            package_purl: identifier?.PURL ?? null,
            installed_version: v.InstalledVersion,
            fixed_version: v.FixedVersion,
            severity: v.Severity,
          });
          const id = key(f);
          requireScan(!seen.has(id) && allowed.has(id));
          seen.add(id);
        }
      }
      this.#time();
      this.#reports.set(platform, binding.digest);
      return Object.freeze({ findings: count, exceptions: count });
    } catch {
      this.#failed = true;
      throw new Error("invalid-release-scan-gate");
    }
  }
  /** Call after both exact child scans and private cleanup; a failure permanently refuses reuse. */
  finish(): void {
    try {
      this.#time();
      requireScan(
        this.#reports.size === 2 &&
          this.#reports.has("linux/amd64") &&
          this.#reports.has("linux/arm64"),
      );
      this.#finished = true;
    } catch {
      this.#failed = true;
      throw new Error("invalid-release-scan-gate");
    }
  }
  /** Fixed conservative window for caller jobs hard-bounded to ten minutes; never a remote lock. */
  checkWriteWindow(): void {
    try {
      const at = this.#time();
      for (const entry of this.#policy.entries) requireScan(entry.expires_at > at + 10 * 60_000);
      const final = this.#time();
      for (const entry of this.#policy.entries) requireScan(entry.expires_at > final + 10 * 60_000);
    } catch {
      this.#failed = true;
      throw new Error("invalid-release-scan-gate");
    }
  }
}

/**
 * Independent pre-write checkpoint for signing/promotion after job/environment waits. It checks
 * only this checkout's fixed source policy, never a runtime policy argument. A successful check
 * does not establish scan evidence: the caller must still require the completed two-child gate.
 */
export function assertReleaseScanExceptionFreshness(mode: "sign" | "promote"): void {
  requireScan(mode === "sign" || mode === "promote");
  // Validate review time against actual now before adding the fixed remaining-life margin.
  new ReleaseScanGate().checkWriteWindow();
}
if (import.meta.main) {
  try {
    requireScan(process.argv.length === 3);
    const mode = process.argv[2];
    requireScan(mode === "sign" || mode === "promote");
    assertReleaseScanExceptionFreshness(mode);
    console.log("Reviewed scanner exception policy permits the bounded signing/promotion window.");
  } catch {
    console.log(
      "::error::Scanner exception policy is invalid or expired; signing/promotion is blocked.",
    );
    process.exitCode = 1;
  }
}

/** Pinned upstream contracts, checked without scanning or fetching any vulnerability data:
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/types/report.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/types/vulnerability.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/fanal/image/remote.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/flag/vulnerability_flags.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/flag/options.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/scan/ospkg/scan.go
 * https://github.com/aquasecurity/trivy/blob/v0.74.0/pkg/fanal/types/artifact.go
 * https://github.com/spf13/pflag/blob/v1.0.10/flag.go
 */
