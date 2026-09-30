/** Invented scanner JSON and literal source-policy fixtures only; no image or database fetch. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReleaseScanGate,
  releaseScanExceptions,
  releaseScanJson,
  releaseScanner,
  type ReleaseScanException,
  type ReleaseScanPlatform,
} from "../../scripts/release-scan-exceptions.js";
import { boundIndex, scanCommands } from "../../scripts/release-scan.js";

const instant = 1_800_000_000_000;
const lifetime = 30 * 24 * 60 * 60_000;
const image = "ghcr.io/deconfined/tarubot";
const scratch = mkdtempSync(join(tmpdir(), "release-exceptions-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
type Value = Record<string, unknown>;
const bindings = [
  { platform: "linux/amd64" as const, digest: `sha256:${"a".repeat(64)}` },
  { platform: "linux/arm64" as const, digest: `sha256:${"b".repeat(64)}` },
];
function binding(index: number) {
  const value = bindings[index];
  if (!value) throw new Error("missing-invented-binding");
  return value;
}
function record(value: unknown): Value {
  if (value === null || typeof value !== "object") throw new Error("invalid-invented-record");
  return value as Value;
}
function entry(platform: ReleaseScanPlatform = "linux/amd64", now = instant): ReleaseScanException {
  return {
    platform,
    result_class: "lang-pkgs",
    result_type: "npm",
    result_target: "app/node_modules/example-library/package.json",
    os_extended: null,
    vulnerability_id: "TEST-VULNERABILITY-0001",
    package_name: "example-library",
    package_id: "example-library@1.2.3",
    package_path: "app/node_modules/example-library/package.json",
    package_purl: "pkg:npm/example-library@1.2.3",
    installed_version: "1.2.3",
    fixed_version: "1.2.4",
    severity: "HIGH",
    reason: "Invented bounded fixture reason with a documented follow-up only.",
    issue: "https://github.com/deconfined/tarubot/issues/999999999",
    reviewed_at: now - 1000,
    expires_at: now + 60_000,
  };
}
function report(index = 0, vulnerable = false): Value {
  const b = binding(index),
    e = entry(b.platform),
    reference = `${image}@${b.digest}`;
  return {
    SchemaVersion: 2,
    Trivy: { Version: releaseScanner.version },
    ArtifactName: reference,
    ArtifactType: "container_image",
    Metadata: {
      Reference: reference,
      RepoDigests: [reference],
      ImageConfig: { os: "linux", architecture: b.platform.slice(6) },
    },
    Results: [
      {
        Target: e.result_target,
        Class: e.result_class,
        Type: e.result_type,
        ...(vulnerable
          ? {
              Vulnerabilities: [
                {
                  VulnerabilityID: e.vulnerability_id,
                  PkgName: e.package_name,
                  PkgID: e.package_id,
                  PkgPath: e.package_path,
                  PkgIdentifier: { PURL: e.package_purl },
                  InstalledVersion: e.installed_version,
                  FixedVersion: e.fixed_version,
                  Severity: e.severity,
                  Status: "fixed",
                },
              ],
            }
          : {}),
      },
    ],
  };
}
function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}
function result(value: Value): Value {
  return record((value.Results as unknown[])[0]);
}
function vulnerability(value: Value): Value {
  return record((result(value).Vulnerabilities as unknown[])[0]);
}
function policy(entries: unknown[] = [entry(), entry("linux/arm64")]): Value {
  return { schema: 1, scanner_version: releaseScanner.version, entries };
}
function osFixture(extended = false) {
  const e = entry();
  e.result_class = "os-pkgs";
  e.result_type = "debian";
  e.result_target = "debian 12.1";
  e.os_extended = extended;
  e.package_name = "example-system-library";
  e.package_id = "example-system-library@1.2.3";
  e.package_path = null;
  e.package_purl = "pkg:deb/debian/example-system-library@1.2.3?distro=debian-12";
  const r = report(0, true),
    raw = result(r),
    v = vulnerability(r);
  raw.Class = e.result_class;
  raw.Type = e.result_type;
  raw.Target = `${image}@${binding(0).digest} (debian 12.1${extended ? "-ESM" : ""})`;
  record(r.Metadata).OS = {
    Family: "debian",
    Name: "12.1",
    ...(extended ? { extended: true } : {}),
  };
  v.PkgName = e.package_name;
  v.PkgID = e.package_id;
  delete v.PkgPath;
  record(v.PkgIdentifier).PURL = e.package_purl;
  return { e, r };
}
function gate(input: unknown = policy(), clock = { wall: instant, physical: 0 }): ReleaseScanGate {
  return new ReleaseScanGate(input, { now: () => clock.wall, monotonic: () => clock.physical });
}
function both(g: ReleaseScanGate, vulnerable = true): void {
  for (let i = 0; i < 2; i++) g.checkReport(bytes(report(i, vulnerable)), binding(i));
}
function refusal(work: () => unknown): void {
  expect(work).toThrow(/^invalid-release-scan-gate$/u);
}

/**
 * The real CLI reads a copied, invented literal policy from its source checkout. The fixture
 * never adds a production runtime policy override and all tools are direct Bun stand-ins.
 */
function cli(
  options: {
    entries?: unknown[];
    reply?: { exitCode?: number; signal?: boolean; malformed?: boolean };
  } = {},
) {
  const directory = mkdtempSync(join(scratch, "case-")),
    bin = join(directory, "bin"),
    runner = join(directory, "runner");
  for (const path of [bin, runner]) mkdirSync(path, { mode: 0o700 });
  for (const name of ["release-scan.ts", "release-policy.ts", "release-scan-exceptions.ts"]) {
    let source = readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
    if (name === "release-scan-exceptions.ts" && options.entries) {
      const pattern = /entries:\s*Object\.freeze\(\[\]\)/u;
      expect(pattern.test(source)).toBe(true);
      source = source.replace(
        pattern,
        `entries: Object.freeze(${JSON.stringify(options.entries)})`,
      );
    }
    writeFileSync(join(directory, name), source, { mode: 0o600 });
  }
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: bindings.map((b) => ({
      digest: b.digest,
      size: 1000,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: { os: "linux", architecture: b.platform.slice(6) },
    })),
  };
  const indexBytes = JSON.stringify(index),
    calls = join(directory, "calls.jsonl");
  const responses = [report(0, options.entries !== undefined), report(1, false)];
  for (const tool of ["docker", "trivy"])
    writeFileSync(
      join(bin, tool),
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const calls=${JSON.stringify(calls)}, tool=${JSON.stringify(tool)}, replies=${JSON.stringify(responses)}, reply=${JSON.stringify(options.reply ?? {})};
const count=existsSync(calls)?readFileSync(calls,"utf8").trim().split("\\n").filter(line=>JSON.parse(line).tool===tool).length:0;
appendFileSync(calls,JSON.stringify({tool,args:process.argv.slice(2),env:process.env})+"\\n");
if(tool==="docker"){process.stdout.write(${JSON.stringify(indexBytes)});process.exit(0);}
if(reply.signal){process.kill(process.pid,"SIGTERM");await Bun.sleep(1000);}
process.stdout.write(reply.malformed?"invented-private-malformed-diagnostic":JSON.stringify(replies[count]));
process.stderr.write("invented-private-scanner-diagnostic\\n::error::invented-scanner-output");
process.exit(reply.exitCode??0);
`,
      { mode: 0o700 },
    );
  const digest = `sha256:${createHash("sha256").update(indexBytes).digest("hex")}`;
  const processResult = Bun.spawnSync(
    [process.execPath, "--no-env-file", join(directory, "release-scan.ts")],
    {
      cwd: directory,
      env: {
        PATH: bin,
        RUNNER_TEMP: runner,
        DIGEST: digest,
        HOME: directory,
        TRIVY_IGNORE_FILE: "/tmp/invented-ignore-trap",
        TRIVY_CONFIG: "/tmp/invented-config-trap",
        TRIVY_IMAGE_SRC: "docker",
        TRIVY_EXIT_CODE: "0",
      },
      stdin: "ignore",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const output = processResult.stdout.toString() + processResult.stderr.toString();
  expect(output).not.toContain("invented-private");
  expect(output).not.toContain("invented-scanner-output");
  expect(output).not.toContain(directory);
  expect(existsSync(join(runner, "release-scan"))).toBe(false);
  const seen = existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { tool: string; args: string[]; env: Record<string, string> },
        )
    : [];
  return { processResult, seen };
}

describe("bounded reviewed release scanner exceptions", () => {
  test("empty reviewed source policy accepts only complete clean reports from both exact children", () => {
    expect(releaseScanExceptions.entries).toEqual([]);
    expect(Object.isFrozen(releaseScanExceptions.entries)).toBe(true);
    const g = gate(releaseScanExceptions);
    both(g, false);
    g.finish();
    refusal(() => g.finish());
    const blocked = gate(releaseScanExceptions);
    refusal(() => blocked.checkReport(bytes(report(0, true)), binding(0)));
    refusal(() => blocked.checkReport(bytes(report(0)), binding(0)));
    refusal(() => blocked.finish());
  });

  test("active literal tuples allow both platforms without changing the observed finding", () => {
    const g = gate();
    for (let i = 0; i < 2; i++)
      expect(g.checkReport(bytes(report(i, true)), binding(i))).toEqual({
        findings: 1,
        exceptions: 1,
      });
    g.finish();
    // A null path/PURL means only an omitted upstream field, never an arbitrary package/path.
    const e = entry();
    e.package_path = null;
    e.package_purl = null;
    const r = report(0, true);
    delete vulnerability(r).PkgPath;
    delete vulnerability(r).PkgIdentifier;
    const absent = gate(policy([e]));
    absent.checkReport(bytes(r), binding(0));
    absent.checkReport(bytes(report(1)), binding(1));
    absent.finish();
  });

  test("every vulnerability/package/version/severity/location/platform component is exact", () => {
    const mutations: ((r: Value) => void)[] = [
      (r) => {
        vulnerability(r).VulnerabilityID = "TEST-VULNERABILITY-0002";
      },
      (r) => {
        vulnerability(r).PkgName = "different-library";
      },
      (r) => {
        vulnerability(r).PkgID = "example-library@1.2.3:other";
      },
      (r) => {
        vulnerability(r).PkgPath = "other/node_modules/example-library/package.json";
      },
      (r) => {
        record(vulnerability(r).PkgIdentifier).PURL = "pkg:npm/other-library@1.2.3";
      },
      (r) => {
        vulnerability(r).InstalledVersion = "1.2.4";
      },
      (r) => {
        vulnerability(r).FixedVersion = "1.2.5";
      },
      (r) => {
        vulnerability(r).Severity = "CRITICAL";
      },
      (r) => {
        result(r).Type = "yarn";
      },
      (r) => {
        result(r).Class = "os-pkgs";
      },
      (r) => {
        result(r).Target = "other/package.json";
      },
      (r) => {
        delete vulnerability(r).PkgID;
      },
      (r) => {
        delete vulnerability(r).PkgPath;
      },
      (r) => {
        delete vulnerability(r).PkgIdentifier;
      },
    ];
    for (const mutate of mutations) {
      const r = report(0, true);
      mutate(r);
      refusal(() => gate().checkReport(bytes(r), binding(0)));
    }
    refusal(() => gate(policy([entry()])).checkReport(bytes(report(1, true)), binding(1)));
    const pattern = entry();
    pattern.installed_version = "1.2.*";
    refusal(() => gate(policy([pattern])).checkReport(bytes(report(0, true)), binding(0)));
  });

  test("OS exceptions authenticate each raw child target before matching stable family/base-version/extended identity", () => {
    for (const extended of [false, true]) {
      const { e, r } = osFixture(extended);
      const first = gate(policy([e]));
      first.checkReport(bytes(r), binding(0));
      first.checkReport(bytes(report(1)), binding(1));
      first.finish();
      const changed = structuredClone(r),
        next = { ...binding(0), digest: `sha256:${"c".repeat(64)}` },
        reference = `${image}@${next.digest}`;
      changed.ArtifactName = reference;
      record(changed.Metadata).Reference = reference;
      record(changed.Metadata).RepoDigests = [reference];
      result(changed).Target = `${reference} (debian 12.1${extended ? "-ESM" : ""})`;
      const second = gate(policy([e]));
      second.checkReport(bytes(changed), next);
      second.checkReport(bytes(report(1)), binding(1));
      second.finish();
      // The exact raw target still belongs to the NEW child; leaving the prior digest refuses.
      result(changed).Target = result(r).Target;
      refusal(() => gate(policy([e])).checkReport(bytes(changed), next));
    }
  });

  test("OS metadata/type/version/flag conflicts or malformed targets cannot be normalized away", () => {
    const mutations: ((r: Value) => void)[] = [
      (r) => {
        result(r).Target = `${result(r).Target} extra`;
      },
      (r) => {
        result(r).Target = `${image}:latest (debian 12.1)`;
      },
      (r) => {
        result(r).Target = `foreign@${binding(0).digest} (debian 12.1)`;
      },
      (r) => {
        result(r).Target = `${image}@${binding(0).digest}(debian 12.1)`;
      },
      (r) => {
        result(r).Target = `${image}@${binding(0).digest} (debian 12.1))`;
      },
      (r) => {
        result(r).Type = "ubuntu";
      },
      (r) => {
        delete record(r.Metadata).OS;
      },
      (r) => {
        record(record(r.Metadata).OS).Family = "ubuntu";
      },
      (r) => {
        record(record(r.Metadata).OS).Name = "12.2";
      },
      (r) => {
        record(record(r.Metadata).OS).Name = "12.1) extra";
      },
      (r) => {
        record(record(r.Metadata).OS).Name = "";
      },
      (r) => {
        record(record(r.Metadata).OS).extended = "false";
      },
      (r) => {
        record(record(r.Metadata).OS).extended = null;
      },
      (r) => {
        record(record(r.Metadata).OS).Extended = false;
      },
      (r) => {
        record(record(r.Metadata).OS).extended = true;
      },
      (r) => {
        record(record(r.Metadata).OS).EOSL = "false";
      },
      (r) => {
        record(r.Metadata).Reference = `${image}@${binding(1).digest}`;
      },
    ];
    for (const mutate of mutations) {
      const { e, r } = osFixture();
      mutate(r);
      refusal(() => gate(policy([e])).checkReport(bytes(r), binding(0)));
    }
    const explicitFalse = osFixture();
    record(record(explicitFalse.r.Metadata).OS).extended = false;
    expect(gate(policy([explicitFalse.e])).checkReport(bytes(explicitFalse.r), binding(0))).toEqual(
      { findings: 1, exceptions: 1 },
    );
    const noFlag = osFixture(true);
    delete record(record(noFlag.r.Metadata).OS).extended;
    refusal(() => gate(policy([noFlag.e])).checkReport(bytes(noFlag.r), binding(0)));
    const literalSuffix = osFixture(true);
    record(record(literalSuffix.r.Metadata).OS).Name = "12.1-ESM";
    record(record(literalSuffix.r.Metadata).OS).extended = false;
    // Its raw string equals the extended display target, but base version/flag are different.
    refusal(() => gate(policy([literalSuffix.e])).checkReport(bytes(literalSuffix.r), binding(0)));
    const wrongPolicy = osFixture();
    wrongPolicy.e.os_extended = true;
    refusal(() => gate(policy([wrongPolicy.e])).checkReport(bytes(wrongPolicy.r), binding(0)));
    const selfDigest = osFixture();
    selfDigest.e.result_target = result(selfDigest.r).Target as string;
    refusal(() => gate(policy([selfDigest.e])));
    const language = report(0, true);
    result(language).Target = `${image}@${binding(0).digest} (debian 12.1)`;
    refusal(() => gate().checkReport(bytes(language), binding(0)));
  });

  test("policy bounds, duplicates, missing identities and declared review metadata fail closed", () => {
    const changes: ((p: Value) => void)[] = [
      (p) => {
        p.schema = 2;
      },
      (p) => {
        p.scanner_version = "0.75.0";
      },
      (p) => {
        p.extra = true;
      },
      (p) => {
        p.entries = Array.from({ length: 33 }, () => entry());
      },
      (p) => {
        p.entries = [
          entry(),
          { ...entry(), reason: "Another reason cannot create a second matching authority." },
        ];
      },
      (p) => {
        record((p.entries as unknown[])[0]).package_id = null;
        record((p.entries as unknown[])[0]).package_purl = null;
      },
      (p) => {
        record((p.entries as unknown[])[0]).severity = "LOW";
      },
      (p) => {
        record((p.entries as unknown[])[0]).reason = "too short";
      },
      (p) => {
        record((p.entries as unknown[])[0]).reason =
          "Invented reason\nwith an injected workflow command";
      },
      (p) => {
        record((p.entries as unknown[])[0]).issue = "https://example.org/unreviewed";
      },
      (p) => {
        record((p.entries as unknown[])[0]).reviewed_at = instant + 1;
      },
      (p) => {
        record((p.entries as unknown[])[0]).expires_at = instant;
      },
      (p) => {
        const e = record((p.entries as unknown[])[0]);
        e.expires_at = Number(e.reviewed_at) + lifetime + 1;
      },
      (p) => {
        record((p.entries as unknown[])[0]).reviewed_at = Number.NaN;
      },
      (p) => {
        record((p.entries as unknown[])[0]).extra = "self-approved";
      },
      (p) => {
        p.entries = Array.from({ length: 20 }, (_, i) => ({
          ...entry(),
          vulnerability_id: `TEST-${i}`,
          package_name: "x".repeat(1024),
          reason: "r".repeat(1024),
        }));
      },
    ];
    for (const mutate of changes) {
      const p = policy();
      mutate(p);
      refusal(() => gate(p));
    }
    const expires = entry();
    expires.expires_at = expires.reviewed_at + lifetime;
    expect(gate(policy([expires]))).toBeInstanceOf(ReleaseScanGate);
    const maximum = Array.from({ length: 32 }, (_, i) => ({
      ...entry(),
      vulnerability_id: `TEST-${i}`,
    }));
    expect(gate(policy(maximum))).toBeInstanceOf(ReleaseScanGate);
  });

  test("expired unused entries refuse initially, between scans and after both scans before success", () => {
    const e = entry();
    e.expires_at = instant;
    refusal(() => gate(policy([e])));
    for (const final of [false, true]) {
      const clock = { wall: instant, physical: 0 },
        g = gate(policy(), clock);
      g.checkReport(bytes(report(0)), binding(0));
      if (final) g.checkReport(bytes(report(1)), binding(1));
      clock.wall += 60_000;
      refusal(() => (final ? g.finish() : g.checkReport(bytes(report(1)), binding(1))));
      refusal(() => g.finish());
    }
  });

  test("physical elapsed expiry and whole-operation limits survive frozen or backward clocks", () => {
    for (const phase of ["expiry", "operation", "backward-wall", "backward-physical"] as const) {
      const clock = { wall: instant, physical: 10 },
        g = gate(phase === "operation" ? releaseScanExceptions : policy(), clock);
      both(g, false);
      if (phase === "expiry") clock.physical += 60_000;
      if (phase === "operation") clock.physical += 30 * 60_000;
      if (phase === "backward-wall") clock.wall--;
      if (phase === "backward-physical") clock.physical--;
      refusal(() => g.finish());
    }
  });

  test("a completed scan cannot carry an expired source exception through later signing/promotion waits", () => {
    const directory = mkdtempSync(join(scratch, "checkpoint-")),
      module = join(directory, "release-scan-exceptions.ts");
    const source = readFileSync(
      new URL("../../scripts/release-scan-exceptions.ts", import.meta.url),
      "utf8",
    );
    const entries = [entry(), entry("linux/arm64")];
    for (const e of entries) e.expires_at = instant + 11 * 60_000;
    writeFileSync(
      module,
      source.replace(
        /entries:\s*Object\.freeze\(\[\]\)/u,
        `entries: Object.freeze(${JSON.stringify(entries)})`,
      ),
    );
    const program = `
      let at=${instant}; Date.now=()=>at;
      const m=await import(${JSON.stringify(module)});
      const gate=new m.ReleaseScanGate();
      const reports=${JSON.stringify([report(0, true), report(1, true)])}, bindings=${JSON.stringify(bindings)};
      for(let i=0;i<2;i++)gate.checkReport(Buffer.from(JSON.stringify(reports[i])),bindings[i]);
      gate.finish(); m.assertReleaseScanExceptionFreshness("sign"); m.assertReleaseScanExceptionFreshness("promote");
      at+=11*60000;
      let result="unexpected-success";
      try{m.assertReleaseScanExceptionFreshness("sign");}catch(error){result=error.message;}
      console.log(JSON.stringify({scan:"complete",checkpoint:result}));
    `;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      timeout: 5000,
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      scan: "complete",
      checkpoint: "invalid-release-scan-gate",
    });
    for (const args of [["sign"], ["promote"], [], ["--policy", "/tmp/invented-override"]]) {
      const current = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          new URL("../../scripts/release-scan-exceptions.ts", import.meta.url).pathname,
          ...args,
        ],
        { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", timeout: 5000 },
      );
      expect(current.exitCode).toBe(args.length === 1 ? 0 : 1);
      expect(current.stderr.toString()).toBe("");
      expect(current.stdout.toString()).not.toContain("invented-override");
    }
  });

  test("pre-write checkpoints require strictly more than the fixed ten-minute budget without accepting future reviews", () => {
    for (const remaining of [600_000, 600_001]) {
      const e = entry();
      e.expires_at = instant + remaining;
      const g = gate(policy([e]));
      if (remaining === 600_000) refusal(() => g.checkWriteWindow());
      else expect(() => g.checkWriteWindow()).not.toThrow();
    }
    const future = entry();
    future.reviewed_at = instant + 1;
    future.expires_at = instant + lifetime;
    refusal(() => gate(policy([future])));
    let reviewTicks = 0;
    refusal(
      () =>
        new ReleaseScanGate(policy([future]), {
          now: () => instant,
          monotonic: () => (++reviewTicks >= 2 ? 2 : 0),
        }),
    );
    const clock = { wall: instant, physical: 0 },
      e = entry();
    e.expires_at = instant + 600_001;
    const elapsed = gate(policy([e]), clock);
    clock.physical = 2;
    refusal(() => elapsed.checkWriteWindow());
    let ticks = 0;
    const during = new ReleaseScanGate(policy([e]), {
      now: () => instant,
      monotonic: () => (++ticks >= 4 ? 2 : 0),
    });
    refusal(() => during.checkWriteWindow());
  });

  test("plain policies/bindings and trusted clock functions are captured without getters or mutable authority", () => {
    const p = policy(),
      clocks = { now: () => instant, monotonic: () => 0 },
      g = new ReleaseScanGate(p, clocks);
    expect(JSON.stringify(g)).toBe("{}");
    expect(Object.keys(g)).toEqual([]);
    record((p.entries as unknown[])[0]).expires_at = instant - 1;
    p.entries = [];
    clocks.now = () => instant + lifetime;
    clocks.monotonic = () => 30 * 60_000;
    Object.assign(g, { policy: releaseScanExceptions, reports: new Map(), failed: false });
    both(g);
    g.finish();
    let reads = 0;
    const getter = policy();
    Object.defineProperty(getter, "entries", {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    refusal(() => gate(getter));
    expect(reads).toBe(0);
    const request = { ...binding(0) };
    Object.defineProperty(request, "digest", {
      enumerable: true,
      get: () => {
        reads++;
        return binding(0).digest;
      },
    });
    refusal(() => gate().checkReport(bytes(report(0)), request));
    expect(reads).toBe(0);
  });

  test("strict bounded UTF-8 JSON refuses duplicate escaped/nested keys, truncation and excess", () => {
    for (const input of [
      Buffer.from(""),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from("\ufeff{}"),
      Buffer.from("{} garbage"),
      Buffer.from('{"a":'),
      Buffer.from('{"schema":1,"s\\u0063hema":2}'),
      Buffer.from('{"nested":{"key":1,"key":2}}'),
      Buffer.from('{"a":1e999}'),
      Buffer.from(`${"[".repeat(34)}0${"]".repeat(34)}`),
      Buffer.from(JSON.stringify(Array.from({ length: 131_072 }, () => null))),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    ])
      refusal(() => releaseScanJson(input));
    expect(releaseScanJson(Buffer.from(' {"array":[true,null,123,"text"]}\n'))).toEqual({
      array: [true, null, 123, "text"],
    });
    const duplicateIndex = Buffer.from('{"schemaVersion":1,"schemaVersion":2}');
    refusal(() =>
      boundIndex(
        duplicateIndex,
        `sha256:${createHash("sha256").update(duplicateIndex).digest("hex")}`,
      ),
    );
  });

  test("report scanner/schema/reference/digest/platform and findings cannot be omitted or malformed", () => {
    const changes: ((r: Value) => void)[] = [
      (r) => {
        r.SchemaVersion = 3;
      },
      (r) => {
        record(r.Trivy).Version = "0.75.0";
      },
      (r) => {
        record(r.Trivy).Server = {};
      },
      (r) => {
        r.ArtifactType = "filesystem";
      },
      (r) => {
        r.ArtifactName = `${image}:latest`;
      },
      (r) => {
        record(r.Metadata).Reference = `${image}@${binding(1).digest}`;
      },
      (r) => {
        record(r.Metadata).RepoDigests = [`${image}@${binding(1).digest}`];
      },
      (r) => {
        record(r.Metadata).RepoDigests = [
          `${image}@${binding(0).digest}`,
          `${image}@${binding(0).digest}`,
        ];
      },
      (r) => {
        record(record(r.Metadata).ImageConfig).os = "windows";
      },
      (r) => {
        record(record(r.Metadata).ImageConfig).architecture = "arm64";
      },
      (r) => {
        r.Results = null;
      },
      (r) => {
        result(r).Class = "unknown";
      },
      (r) => {
        result(r).Type = "";
      },
      (r) => {
        result(r).Target = "";
      },
      (r) => {
        result(r).Packages = [{}];
      },
      (r) => {
        result(r).Secrets = [];
      },
      (r) => {
        result(r).ExperimentalModifiedFindings = [];
      },
      (r) => {
        result(r).Vulnerabilities = null;
      },
      (r) => {
        vulnerability(r).Status = "affected";
      },
      (r) => {
        delete vulnerability(r).Status;
      },
      (r) => {
        vulnerability(r).FixedVersion = "";
      },
      (r) => {
        delete vulnerability(r).FixedVersion;
      },
      (r) => {
        vulnerability(r).Severity = "UNKNOWN";
      },
      (r) => {
        vulnerability(r).PkgName = "";
      },
      (r) => {
        vulnerability(r).PkgID = null;
      },
      (r) => {
        vulnerability(r).PkgPath = null;
      },
      (r) => {
        record(vulnerability(r).PkgIdentifier).PURL = null;
      },
      (r) => {
        result(r).Vulnerabilities = [vulnerability(r), vulnerability(r)];
      },
      (r) => {
        r.Results = [result(r), result(r)];
      },
    ];
    for (const mutate of changes) {
      const r = report(0, true);
      mutate(r);
      refusal(() => gate().checkReport(bytes(r), binding(0)));
    }
    const omitted = report();
    delete omitted.Results;
    const g = gate(releaseScanExceptions);
    g.checkReport(bytes(omitted), binding(0));
    g.checkReport(bytes(report(1)), binding(1));
    g.finish();
  });

  test("missing, duplicate or repeated runtime evidence can never finish a gate", () => {
    refusal(() => gate().finish());
    const one = gate();
    one.checkReport(bytes(report(0)), binding(0));
    refusal(() => one.finish());
    const duplicate = gate();
    duplicate.checkReport(bytes(report(0)), binding(0));
    refusal(() => duplicate.checkReport(bytes(report(0)), binding(0)));
    refusal(() => duplicate.finish());
    const sameDigest = gate();
    sameDigest.checkReport(bytes(report(0)), binding(0));
    refusal(() =>
      sameDigest.checkReport(bytes(report(1)), {
        platform: "linux/arm64",
        digest: binding(0).digest,
      }),
    );
  });

  test("commands preserve empty scanner config/ignore files and force remote JSON with no finding-driven exit", () => {
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: bindings.map((b) => ({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: b.digest,
        size: 1000,
        platform: { os: "linux", architecture: b.platform.slice(6) },
      })),
    };
    for (const command of scanCommands(index)) {
      for (const [flag, expected] of [
        ["--config", "/dev/null"],
        ["--ignorefile", "/dev/null"],
        ["--image-src", "remote"],
        ["--format", "json"],
        ["--exit-code", "0"],
        ["--severity", "HIGH,CRITICAL"],
      ]) {
        expect(command[command.indexOf(flag ?? "") + 1]).toBe(expected);
      }
      // Pinned pflag's boolean NoOptDefVal is true: a separate false would be an image argument.
      expect(command).toContain("--list-all-pkgs=false");
      expect(command).not.toContain("false");
      expect(command).toContain("--ignore-unfixed");
      expect(command.at(-1)).toMatch(/@sha256:[a-f0-9]{64}$/u);
    }
  });

  test("real CLI accepts the default clean reports and literal invented source exception with private cleanup", () => {
    for (const options of [{}, { entries: [entry("linux/amd64", Date.now())] }]) {
      const { processResult, seen } = cli(options);
      expect(processResult.exitCode).toBe(0);
      expect(seen.map((c) => c.tool)).toEqual(["docker", "trivy", "trivy"]);
      for (const call of seen)
        for (const name of [
          "TRIVY_IGNORE_FILE",
          "TRIVY_CONFIG",
          "TRIVY_IMAGE_SRC",
          "TRIVY_EXIT_CODE",
        ])
          expect(call.env[name]).toBeUndefined();
    }
  });

  test("matching report never excuses process failure, signal or malformed stdout; invalid policy stops before I/O", () => {
    for (const reply of [{ exitCode: 1 }, { signal: true }, { malformed: true }]) {
      const { processResult, seen } = cli({ entries: [entry("linux/amd64", Date.now())], reply });
      expect(processResult.exitCode).toBe(1);
      expect(seen.map((c) => c.tool)).toEqual(["docker", "trivy"]);
    }
    const expired = entry("linux/amd64", Date.now());
    expired.expires_at = Date.now() - 1;
    const { processResult, seen } = cli({ entries: [expired] });
    expect(processResult.exitCode).toBe(1);
    expect(seen).toEqual([]);
  });
});
