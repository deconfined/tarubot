/**
 * ops/tofu/ci/host.sh (2.37.0; REQUIREMENTS.md "Approved unified-pipeline amendments
 * (2026-09-29)", decision 5): host keys pinned on first use by the job the owner approved, kept in
 * one pin store keyed by the Linode instance, and strict connections over IPv6 first.
 *
 * The script runs here as the workflow runs it, against stand-ins on PATH for everything that
 * reaches the network (tests/fixtures/host-pin: curl as the pin store, ssh-keyscan, ssh and ip), a
 * sleep that returns at once, a sandbox RUNNER_TEMP, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY, and the
 * real jq and ssh-keygen with keys made for each run. Nothing reaches a host, a bucket or GitHub.
 *
 * - pin: one scan and one stored pin on first use, before any login; a rerun on the same instance
 *   neither scans nor writes; other addresses update the pin with its old key and no scan; a new
 *   instance is scanned and replaces the pin; the same instance's key is never replaced; hosts
 *   outside PINS are never read or written; an instance other than the plan expects is refused
 *   before the store is touched.
 * - IPv6 first: IPv6 when routed, IPv4 at once when it isn't, IPv4 after a routed IPv6 that doesn't
 *   answer, and nothing stored when the two families offer different keys.
 * - Failures: two keys, no key, a malformed key, an unreadable, refused or malformed pin, a failed
 *   store and a read-only key all fail with no write.
 * - status: pins_needed for created, replaced, missing, other-instance and other-address hosts, and
 *   a warning (never a listing) for another target's host.
 * - connect: the key, known_hosts and inventory; a host-key mismatch stops with no fallback and no
 *   fingerprint in the log; exit 3 for no pin or no store; key-rejected, unreachable, pin-store and
 *   configure-key.
 * - Public logs: every masked value appears only on ::add-mask:: lines, and before any other line;
 *   no credential in any process's arguments or environment.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SCRIPT = root("ops/tofu/ci/host.sh");
const STUBS = root("tests/fixtures/host-pin");

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);
/** The script needs jq and OpenSSH's ssh-keygen, as a runner has them; the image build has neither. */
const canRun = Bun.which("jq") !== null && Bun.which("ssh-keygen") !== null;

const scratch = mkdtempSync(join(tmpdir(), "host-pin-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Documentation addresses and invented IDs, bucket and credentials only.
const V4 = "192.0.2.10";
const V6 = "2001:db8:10::1";
const V4_OLD = "192.0.2.20";
const V6_OLD = "2001:db8:20::1";
const STAGING_ID = "40000001";
const PROD_ID = "40000002";
const NEW_ID = "40000003";
const OLD_ID = "39999999";
const BUCKET = "example-state";
const ENDPOINT = "storage.example.org";
/** The read/write key's secret holds a quote and a backslash, which the config must escape. */
const RW = { id: "test-rw-access", secret: 'test-rw-sec"ret\\x' };
const RO = { id: "test-ro-access", secret: "test-ro-secret" };
/** A credential as the script's curl config quotes it. */
const quoted = (c: { id: string; secret: string }) =>
  `${c.id}:${c.secret}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

interface Key {
  pub: string;
  b64: string;
  fingerprint: string;
  private: string;
}
/** An ed25519 key pair made by the real ssh-keygen, with its public line and SHA-256 fingerprint. */
function keypair(name: string, passphrase = ""): Key {
  const path = join(scratch, "keys", name);
  mkdirSync(join(scratch, "keys"), { recursive: true });
  const made = Bun.spawnSync(
    ["ssh-keygen", "-q", "-t", "ed25519", "-N", passphrase, "-C", "", "-f", path],
    { stdin: "ignore" },
  );
  if (made.exitCode !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
  const pub = readFileSync(`${path}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const fp = Bun.spawnSync(["ssh-keygen", "-E", "sha256", "-lf", `${path}.pub`], {
    stdin: "ignore",
  });
  const fingerprint =
    fp.stdout
      .toString()
      .split(" ")[1]
      ?.replace(/^SHA256:/, "") ?? "";
  return { pub, b64: pub.split(" ")[1] ?? "", fingerprint, private: readFileSync(path, "utf8") };
}

let A: Key;
let B: Key;
let CLIENT: Key;
let LOCKED: Key;
beforeAll(() => {
  if (!canRun) return;
  A = keypair("host-a");
  B = keypair("host-b");
  CLIENT = keypair("configure");
  LOCKED = keypair("configure-locked", "a passphrase");
});

interface Host {
  id: string;
  v4: string;
  v6: string;
}
/** A host in the saved plan: the instance the state holds (none for a new host) and the actions. */
interface Planned {
  prior?: Host;
  actions?: string[];
}
interface Setup {
  /** plan.json and values.tfvars.json's hosts. */
  plan?: Record<string, Planned>;
  /** OpenTofu's host_connection value, or any raw outputs.json. */
  outputs?: Record<string, unknown>;
  rawOutputs?: unknown;
  /** Stored pins by host key: an object, or raw text. */
  pins?: Record<string, unknown>;
}
/** A stored pin, as host.sh writes it. */
const pinOf = (key: Key, h: Host) =>
  JSON.stringify({ host_key: key.pub, instance_id: h.id, ipv4: h.v4, ipv6: h.v6 });
const host = (id: string, v4 = V4, v6 = V6): Host => ({ id, v4, v6 });

/** plan.json as `tofu show -json` writes it, for linode_instance.host only. */
function planJson(plan: Record<string, Planned>) {
  const resources: unknown[] = [];
  const changes: unknown[] = [];
  for (const [k, p] of Object.entries(plan)) {
    const address = `linode_instance.host["${k}"]`;
    const base = { address, mode: "managed", type: "linode_instance", name: "host", index: k };
    const before = p.prior
      ? { id: p.prior.id, label: `tarubot-${k}`, ipv4: [p.prior.v4], ipv6: `${p.prior.v6}/128` }
      : null;
    if (before) resources.push({ ...base, values: before });
    changes.push({
      ...base,
      change: { actions: p.actions ?? (p.prior ? ["no-op"] : ["create"]), before },
    });
  }
  return {
    format_version: "1.2",
    prior_state: { values: { root_module: { resources } } },
    resource_changes: changes,
  };
}

interface Run {
  code: number;
  stdout: string;
  log: string;
  /** Every line of output that isn't a mask. */
  public: string;
  masks: string[];
  outputs: Record<string, string>;
}

/** A sandbox runner: stand-ins on PATH, RUNNER_TEMP, the stand-in bucket and OpenTofu's files. */
function sandbox(setup: Setup = {}) {
  const dir = mkdtempSync(join(scratch, "case-"));
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  mkdirSync(bin);
  mkdirSync(join(temp, "tofu"), { recursive: true });
  for (const name of ["curl", "ssh-keyscan", "ssh", "ip"]) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  // No waiting in tests: each sleep is only recorded, so a retry loop ends on its attempt count.
  writeFileSync(join(bin, "sleep"), '#!/bin/sh\necho "sleep $1" >> "$STUB/events"\n');
  chmodSync(join(bin, "sleep"), 0o755);
  const plan = setup.plan ?? {};
  writeFileSync(join(temp, "tofu", "plan.json"), JSON.stringify(planJson(plan)));
  const hosts = Object.fromEntries(
    Object.keys(plan).map((k) => [
      k,
      { label: `tarubot-${k}`, fqdn: `${k}.example.org`, region: "us-east", type: "g6", role: k },
    ]),
  );
  writeFileSync(join(temp, "tofu", "values.tfvars.json"), JSON.stringify({ hosts }));
  writeFileSync(
    join(temp, "tofu", "outputs.json"),
    JSON.stringify(
      setup.rawOutputs ?? {
        host_connection: { sensitive: true, type: "object", value: setup.outputs ?? {} },
        hosts: { sensitive: false, value: {} },
      },
    ),
  );
  for (const [k, pin] of Object.entries(setup.pins ?? {})) store(dir, k, pin);
  return {
    dir,
    temp,
    run: (args: string[], env: Record<string, string> = {}) => run(dir, args, env),
  };
}

/** Puts a pin into the stand-in bucket. */
function store(dir: string, key: string, pin: unknown) {
  mkdirSync(join(dir, "store", "tarubot", "pins"), { recursive: true });
  writeFileSync(
    join(dir, "store", "tarubot", "pins", `${key}.json`),
    typeof pin === "string" ? pin : JSON.stringify(pin),
  );
}

/** Runs host.sh in a sandbox with the workflow's settings, overridden by env. */
function run(dir: string, args: string[], env: Record<string, string>): Run {
  for (const f of ["github-output", "summary.md"]) rmSync(join(dir, f), { force: true });
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
    stdin: "ignore",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      STUB: dir,
      RUNNER_TEMP: join(dir, "temp"),
      GITHUB_OUTPUT: join(dir, "github-output"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      STATE_BUCKET: BUCKET,
      STATE_ENDPOINT: `https://${ENDPOINT}`,
      AWS_ACCESS_KEY_ID: RW.id,
      AWS_SECRET_ACCESS_KEY: RW.secret,
      ANSIBLE_SSH_KEY: CLIENT.private,
      STUB_HOST: `${BUCKET}.${ENDPOINT}`,
      STUB_RW_USER: quoted(RW),
      STUB_RO_USER: quoted(RO),
      FAKE_HOSTKEY: A.pub,
      FAKE_KEYSCAN_6: A.pub,
      FAKE_KEYSCAN_4: A.pub,
      ...env,
    },
  });
  const stdout = result.stdout.toString();
  const log = stdout + result.stderr.toString();
  const lines = log.split("\n");
  const outputs: Record<string, string> = {};
  if (existsSync(join(dir, "github-output")))
    for (const line of readFileSync(join(dir, "github-output"), "utf8").split("\n"))
      if (line.includes("="))
        outputs[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  return {
    code: result.exitCode,
    stdout,
    log,
    public: lines.filter((l) => !l.startsWith("::add-mask::")).join("\n"),
    masks: lines.filter((l) => l.startsWith("::add-mask::")).map((l) => l.slice(12)),
    outputs,
  };
}

/** What the stand-ins recorded, in order: `curl GET|PUT <path>`, `ssh-keyscan 6|4`, `ssh 6|4`, … */
const events = (dir: string) =>
  existsSync(join(dir, "events"))
    ? readFileSync(join(dir, "events"), "utf8").trim().split("\n").filter(Boolean)
    : [];
/** The events of a kind: curl, ssh-keyscan, ssh, ip or sleep. */
const of = (dir: string, kind: string) => events(dir).filter((e) => e.split(" ")[0] === kind);
const puts = (dir: string) => events(dir).filter((e) => e.startsWith("curl PUT"));
const stored = (dir: string, key: string) =>
  readFileSync(join(dir, "store", "tarubot", "pins", `${key}.json`), "utf8");
const summary = (dir: string) =>
  existsSync(join(dir, "summary.md")) ? readFileSync(join(dir, "summary.md"), "utf8") : "";

describe.skipIf(!canRun)("host.sh pin: first use, and never a second key for one instance", () => {
  test("first use scans, stores the pin exactly once, and logs in only afterwards (connect)", () => {
    const s = sandbox({
      plan: { staging: { actions: ["create"] } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
    });
    const pinned = s.run(["pin"], { PINS: "staging" });
    expect(pinned.code).toBe(0);
    // The exact object, with no trailing newline: the pin store's one format.
    expect(stored(s.dir, "staging")).toBe(
      `{"host_key":"${A.pub}","instance_id":"${STAGING_ID}","ipv4":"${V4}","ipv6":"${V6}"}`,
    );
    expect(pinned.outputs).toEqual({ pinned: "staging" });
    expect(summary(s.dir)).toContain("- staging: host key pinned on first use");
    // Read, scan, store: no login in the pin step at all.
    expect(events(s.dir).filter((e) => !e.startsWith("ip "))).toEqual([
      "curl GET tarubot/pins/staging.json",
      "ssh-keyscan 4",
      "curl PUT tarubot/pins/staging.json",
    ]);

    const connected = s.run(["connect", "staging"]);
    expect(connected.code).toBe(0);
    const all = events(s.dir);
    expect(all.indexOf("curl PUT tarubot/pins/staging.json")).toBeLessThan(all.indexOf("ssh 4"));
    expect(puts(s.dir)).toHaveLength(1);
  });

  test("a rerun on the same instance (the retry after a failed first Configure) neither scans nor writes", () => {
    const s = sandbox({
      plan: { staging: { prior: host(STAGING_ID) } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
      pins: { staging: pinOf(A, host(STAGING_ID)) },
    });
    const r = s.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: B.pub });
    expect(r.code).toBe(0);
    expect(of(s.dir, "ssh-keyscan")).toEqual([]);
    expect(puts(s.dir)).toEqual([]);
    expect(stored(s.dir, "staging")).toBe(pinOf(A, host(STAGING_ID)));
    expect(r.outputs).toEqual({ pinned: "" });
    expect(summary(s.dir)).toContain("- staging: pinned already");
  });

  test("the same instance at other addresses keeps its key and gets the new addresses, with no scan", () => {
    const s = sandbox({
      plan: { staging: { prior: host(STAGING_ID) } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
      pins: { staging: pinOf(A, host(STAGING_ID, V4_OLD, V6_OLD)) },
    });
    const r = s.run(["pin"], {
      PINS: "staging",
      FAKE_ROUTE_6: "1",
      FAKE_KEYSCAN_6: B.pub,
      FAKE_KEYSCAN_4: B.pub,
    });
    expect(r.code).toBe(0);
    expect(of(s.dir, "ssh-keyscan")).toEqual([]);
    expect(puts(s.dir)).toHaveLength(1);
    expect(stored(s.dir, "staging")).toBe(pinOf(A, host(STAGING_ID)));
    expect(r.outputs).toEqual({ pinned: "staging" });
  });

  test("a new instance is scanned again and replaces the pin", () => {
    // A rebuild: the plan replaced the old instance, and OpenTofu now reports the new one.
    const rebuilt = sandbox({
      plan: { staging: { prior: host(OLD_ID, V4_OLD, V6_OLD), actions: ["delete", "create"] } },
      outputs: { staging: { instance_id: NEW_ID, ipv4: V4, ipv6: V6 } },
      pins: { staging: pinOf(A, host(OLD_ID, V4_OLD, V6_OLD)) },
    });
    const r = rebuilt.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: B.pub });
    expect(r.code).toBe(0);
    expect(of(rebuilt.dir, "ssh-keyscan")).toEqual(["ssh-keyscan 4"]);
    expect(stored(rebuilt.dir, "staging")).toBe(pinOf(B, host(NEW_ID)));

    // A kept instance whose pin names another one (a rebuild outside a run): scanned too.
    const kept = sandbox({
      plan: { staging: { prior: host(NEW_ID) } },
      outputs: { staging: { instance_id: NEW_ID, ipv4: V4, ipv6: V6 } },
      pins: { staging: pinOf(A, host(OLD_ID)) },
    });
    expect(kept.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: B.pub }).code).toBe(0);
    expect(stored(kept.dir, "staging")).toBe(pinOf(B, host(NEW_ID)));
  });

  test("the same instance's key is never replaced, even when a scan would offer another", () => {
    for (const planned of [
      { prior: host(STAGING_ID) },
      // Even a plan that claims to create the host can't repin an instance that already has one.
      { actions: ["create"] },
    ] as Planned[]) {
      const s = sandbox({
        plan: { staging: planned },
        outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
        pins: { staging: pinOf(A, host(STAGING_ID)) },
      });
      const r = s.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: B.pub, FAKE_HOSTKEY: B.pub });
      expect(r.code).toBe(0);
      expect(of(s.dir, "ssh-keyscan")).toEqual([]);
      expect(puts(s.dir)).toEqual([]);
      expect(stored(s.dir, "staging")).toBe(pinOf(A, host(STAGING_ID)));
    }
  });

  test("hosts outside PINS are never read or written, even without a pin", () => {
    const s = sandbox({
      plan: { staging: { actions: ["create"] }, prod: { actions: ["create"] } },
      outputs: {
        staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 },
        prod: { instance_id: PROD_ID, ipv4: V4_OLD, ipv6: V6_OLD },
      },
    });
    const r = s.run(["pin"], { PINS: "staging" });
    expect(r.code).toBe(0);
    expect(events(s.dir).filter((e) => e.includes("prod"))).toEqual([]);
    expect(existsSync(join(s.dir, "store", "tarubot", "pins", "prod.json"))).toBe(false);
    // Its values aren't even read, so they are neither masked nor printed.
    expect(r.log).not.toContain(PROD_ID);
    expect(r.outputs).toEqual({ pinned: "staging" });

    // Both, once PINS names both; a repeated key counts once.
    const both = s.run(["pin"], { PINS: "prod staging prod" });
    expect(both.code).toBe(0);
    expect(both.outputs).toEqual({ pinned: "prod" });
    expect(stored(s.dir, "prod")).toBe(pinOf(A, host(PROD_ID, V4_OLD, V6_OLD)));
  });

  test("an instance other than the plan expects is refused before any read, scan or write", () => {
    const cases: [Planned, string][] = [
      // The plan kept the host, but the state now names another instance.
      [{ prior: host(STAGING_ID) }, NEW_ID],
      // The plan replaced the host, but the instance is still the old one (an apply in between).
      [{ prior: host(STAGING_ID), actions: ["delete", "create"] }, STAGING_ID],
      [{ prior: host(STAGING_ID), actions: ["create", "delete"] }, STAGING_ID],
      // The plan neither keeps nor builds it.
      [{ actions: ["no-op"] }, STAGING_ID],
      [{ actions: ["delete"] }, STAGING_ID],
    ];
    for (const [planned, now] of cases) {
      const s = sandbox({
        plan: { staging: planned },
        outputs: { staging: { instance_id: now, ipv4: V4, ipv6: V6 } },
      });
      const r = s.run(["pin"], { PINS: "staging" });
      expect(r.code).toBe(1);
      expect(r.public).toContain(
        "::error::staging: the host changed since the plan; dispatch again.",
      );
      expect(of(s.dir, "curl")).toEqual([]);
      expect(of(s.dir, "ssh-keyscan")).toEqual([]);
    }
  });

  test("PINS and host_connection are checked before the store is touched", () => {
    const outputs = { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } };
    const plan = { staging: { actions: ["create"] } };
    const refused: [Setup, string][] = [
      [{ plan, outputs }, "production"],
      [{ plan, outputs }, "staging;true"],
      [{ plan, outputs }, "staging-100"],
      [{ plan, outputs }, "prod"],
      [{ plan, outputs: { staging: { ...outputs.staging, ipv4: "192.0.2.256" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, ipv4: "192.0.2.010" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, ipv6: "-oProxyCommand=x" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, ipv6: "2001:db8::1/128" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, ipv6: "1:2:3:4:5:6:7" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, instance_id: 40000001 } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, instance_id: "4e7" } } }, "staging"],
      [{ plan, outputs: { staging: { ...outputs.staging, extra: "x" } } }, "staging"],
      [{ plan, rawOutputs: {} }, "staging"],
    ];
    for (const [setup, pins] of refused) {
      const s = sandbox(setup);
      const r = s.run(["pin"], { PINS: pins });
      expect(r.code).toBe(1);
      expect(of(s.dir, "curl")).toEqual([]);
      expect(of(s.dir, "ssh-keyscan")).toEqual([]);
    }
    // Nothing to pin is no work at all.
    const none = sandbox({ plan, outputs });
    const r = none.run(["pin"], { PINS: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("No host key to pin.\n");
    expect(r.outputs).toEqual({ pinned: "" });
    expect(events(none.dir)).toEqual([]);
  });
});

describe.skipIf(!canRun)("host.sh: IPv6 first, for scans and logins alike", () => {
  const created = () =>
    sandbox({
      plan: { staging: { actions: ["create"] } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
    });
  const inventory = (temp: string) =>
    JSON.parse(readFileSync(join(temp, "ssh", "inventory.json"), "utf8")).all.hosts.target;

  test("a routed IPv6 is asked first, IPv4 must agree, and the login uses IPv6", () => {
    const s = created();
    expect(s.run(["pin"], { PINS: "staging", FAKE_ROUTE_6: "1" }).code).toBe(0);
    expect(of(s.dir, "ssh-keyscan")).toEqual(["ssh-keyscan 6", "ssh-keyscan 4"]);
    const r = s.run(["connect", "staging"], { FAKE_ROUTE_6: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Connected to staging over IPv6.");
    expect(of(s.dir, "ssh")).toEqual(["ssh 6"]);
    const target = inventory(s.temp);
    expect(target.ansible_host).toBe(V6);
    expect(target.ansible_ssh_common_args).toContain("'AddressFamily=inet6'");
    expect(of(s.dir, "sleep")).toEqual([]);
  });

  test("without an IPv6 route, IPv4 at once, with no delay", () => {
    const s = created();
    expect(s.run(["pin"], { PINS: "staging" }).code).toBe(0);
    expect(of(s.dir, "ssh-keyscan")).toEqual(["ssh-keyscan 4"]);
    const r = s.run(["connect", "staging"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Connected to staging over IPv4.");
    expect(of(s.dir, "ssh")).toEqual(["ssh 4"]);
    const target = inventory(s.temp);
    expect(target.ansible_host).toBe(V4);
    expect(target.ansible_ssh_common_args).toContain("'AddressFamily=inet'");
    expect(of(s.dir, "sleep")).toEqual([]);
  });

  test("a routed IPv6 that doesn't answer falls back to IPv4 in the same round", () => {
    const s = created();
    const pinned = s.run(["pin"], { PINS: "staging", FAKE_ROUTE_6: "1", FAKE_KEYSCAN_6: "" });
    expect(pinned.code).toBe(0);
    expect(stored(s.dir, "staging")).toBe(pinOf(A, host(STAGING_ID)));
    // Silent (no route, a refusal or a connect timeout at LogLevel=FATAL), or ended by `timeout`.
    for (const behaviour of ["silent", "hung"]) {
      rmSync(join(s.dir, "events"), { force: true });
      const r = s.run(["connect", "staging"], { FAKE_ROUTE_6: "1", FAKE_SSH_6: behaviour });
      expect(r.code).toBe(0);
      expect(of(s.dir, "ssh")).toEqual(["ssh 6", "ssh 4"]);
      expect(inventory(s.temp).ansible_host).toBe(V4);
      expect(of(s.dir, "sleep")).toEqual([]);
    }
  });

  test("IPv6 and IPv4 offering different keys stores nothing", () => {
    const s = created();
    const r = s.run(["pin"], { PINS: "staging", FAKE_ROUTE_6: "1", FAKE_KEYSCAN_4: B.pub });
    expect(r.code).toBe(1);
    expect(r.public).toContain(
      "the host's IPv6 and IPv4 addresses offered different host keys; nothing was stored. The next approved run pins it (the plan will list it as needing a pin).",
    );
    expect(puts(s.dir)).toEqual([]);
  });
});

describe.skipIf(!canRun)("host.sh pin: every failure writes nothing", () => {
  const created = (pins: Record<string, unknown> = {}) =>
    sandbox({
      plan: { staging: { actions: ["create"] } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
      pins,
    });
  const RETRY = "The next approved run pins it (the plan will list it as needing a pin).";

  test("two keys on one family, no key in 5 minutes, or a malformed key", () => {
    for (const offered of [`${A.pub}\n${B.pub}`, "", "ssh-ed25519 notbase64", `${A.pub} extra`]) {
      const s = created();
      const r = s.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: offered });
      expect(r.code).toBe(1);
      expect(r.public).toContain(RETRY);
      expect(puts(s.dir)).toEqual([]);
    }
    // No key at all: 30 rounds, 10 seconds apart.
    const s = created();
    s.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_4: "" });
    expect(of(s.dir, "ssh-keyscan")).toHaveLength(30);
    expect(of(s.dir, "sleep")).toEqual(Array(29).fill("sleep 10"));
    // A host whose key appears late is pinned in a later round.
    const late = created();
    expect(late.run(["pin"], { PINS: "staging", FAKE_KEYSCAN_FROM: "3" }).code).toBe(0);
    expect(of(late.dir, "sleep")).toEqual(["sleep 10", "sleep 10"]);
  });

  test("an unreadable pin store (403, 500, no answer) fails with no scan and no write", () => {
    for (const env of [
      { FAKE_GET_STATUS: "403" },
      { FAKE_GET_STATUS: "500" },
      { FAKE_CURL_EXIT: "7" },
      { AWS_SECRET_ACCESS_KEY: "someone-else" },
    ]) {
      const s = created();
      const r = s.run(["pin"], { PINS: "staging", ...env });
      expect(r.code).toBe(1);
      expect(r.public).toContain("The pin store couldn't be read for staging");
      expect(of(s.dir, "ssh-keyscan")).toEqual([]);
      expect(puts(s.dir)).toEqual([]);
    }
  });

  test("a malformed pin fails with no scan and no write", () => {
    const good = JSON.parse(pinOf(A, host(OLD_ID)));
    for (const pin of [
      "not json",
      "",
      `${pinOf(A, host(OLD_ID))}\n${pinOf(A, host(OLD_ID))}`,
      { ...good, host_key: "ssh-ed25519 short" },
      { ...good, host_key: `ssh-rsa ${A.b64}` },
      // The right shape, but no key ssh-keygen can read.
      { ...good, host_key: `ssh-ed25519 ${"A".repeat(68)}` },
      { ...good, instance_id: 39999999 },
      { ...good, ipv4: "192.0.2.1/32" },
      { ...good, ipv6: "2001:db8::1/128" },
      { ...good, comment: "x" },
      (({ ipv6: _, ...rest }) => rest)(good),
    ]) {
      const s = created({ staging: pin });
      const r = s.run(["pin"], { PINS: "staging" });
      expect(r.code).toBe(1);
      expect(r.public).toContain("staging's stored pin is malformed; nothing was written.");
      expect(of(s.dir, "ssh-keyscan")).toEqual([]);
      expect(puts(s.dir)).toEqual([]);
    }
  });

  test("a store that refuses the write fails clearly, and a read-only key gets 403", () => {
    const readOnly = created();
    const r = readOnly.run(["pin"], {
      PINS: "staging",
      AWS_ACCESS_KEY_ID: RO.id,
      AWS_SECRET_ACCESS_KEY: RO.secret,
    });
    expect(r.code).toBe(1);
    expect(r.public).toContain(
      "::error::The pin store refused to store staging's pin (HTTP 403): only prod's read/write state key (TOFU_STATE_WRITE_*) can write pins.",
    );
    expect(r.public).toContain(RETRY);
    expect(existsSync(join(readOnly.dir, "store", "tarubot", "pins", "staging.json"))).toBe(false);
    expect(r.outputs).toEqual({});

    const broken = created();
    const failed = broken.run(["pin"], { PINS: "staging", FAKE_PUT_STATUS: "500" });
    expect(failed.code).toBe(1);
    expect(failed.public).toContain("staging's pin couldn't be stored (HTTP 500).");
  });

  test("the store's settings: empty fails, and so does a dotted bucket, a path or a line break", () => {
    for (const env of [
      { STATE_BUCKET: "" },
      { STATE_ENDPOINT: "" },
      { AWS_ACCESS_KEY_ID: "" },
      { AWS_SECRET_ACCESS_KEY: "" },
      { STATE_BUCKET: "example.state" },
      { STATE_ENDPOINT: `https://${ENDPOINT}/path` },
      { STATE_ENDPOINT: `http://${ENDPOINT}` },
      { AWS_SECRET_ACCESS_KEY: "line\nbreak" },
      { AWS_ACCESS_KEY_ID: "carriage\rreturn" },
    ]) {
      const s = created();
      expect(s.run(["pin"], { PINS: "staging", ...env }).code).toBe(1);
      expect(of(s.dir, "curl")).toEqual([]);
    }
  });
});

describe.skipIf(!canRun)("host.sh status: which hosts the approving job pins", () => {
  // Every case at once: staging pinned; staging-2 with no pin; staging-3 pinned for another
  // instance; staging-4 at other addresses; prod created; prod-2 replaced; prod-3 with no pin.
  const matrix = () =>
    sandbox({
      plan: {
        prod: { actions: ["create"] },
        "prod-2": { prior: host(OLD_ID, V4_OLD, V6_OLD), actions: ["delete", "create"] },
        "prod-3": { prior: host("40000013", "192.0.2.13", "2001:db8:13::1") },
        staging: { prior: host(STAGING_ID) },
        "staging-2": { prior: host("40000012", "192.0.2.12", "2001:db8:12::1") },
        "staging-3": { prior: host("40000014", "192.0.2.14", "2001:db8:14::1") },
        "staging-4": { prior: host("40000015", "192.0.2.15", "2001:db8:15::1") },
      },
      pins: {
        "prod-2": pinOf(A, host(OLD_ID, V4_OLD, V6_OLD)),
        staging: pinOf(A, host(STAGING_ID)),
        "staging-3": pinOf(A, host(OLD_ID, "192.0.2.14", "2001:db8:14::1")),
        "staging-4": pinOf(B, host("40000015", "192.0.2.16", "2001:db8:15::1")),
      },
    });
  const NEW = "new host — approving trusts its host key on first use";
  const MISSING = "no pin for its current instance — approving trusts its host key on first use";
  const MOVED = "addresses changed — approving updates its pin, not its key";
  const ro = { AWS_ACCESS_KEY_ID: RO.id, AWS_SECRET_ACCESS_KEY: RO.secret };

  test("PIN_SCOPE=staging lists staging's hosts and every new one, and warns about prod-3", () => {
    const s = matrix();
    const r = s.run(["status"], { PIN_SCOPE: "staging", ...ro });
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ pins_needed: "prod prod-2 staging-2 staging-3 staging-4" });
    expect(r.public.trim().split("\n")).toEqual([
      `prod: ${NEW}`,
      `prod-2: ${NEW}`,
      "staging: pinned",
      `staging-2: ${MISSING}`,
      `staging-3: ${MISSING}`,
      `staging-4: ${MOVED}`,
      "::warning::prod-3 has no pin for its current instance, and this run leaves it alone: dispatch action=infra to pin it",
    ]);
    expect(summary(s.dir)).toBe(
      [
        "### Host keys",
        "",
        `- prod: ${NEW}`,
        `- prod-2: ${NEW}`,
        "- staging: pinned",
        `- staging-2: ${MISSING}`,
        `- staging-3: ${MISSING}`,
        `- staging-4: ${MOVED}`,
        "- **Warning:** prod-3 has no pin for its current instance, and this run leaves it alone: dispatch action=infra to pin it",
        "",
      ].join("\n"),
    );
    // Reads only: no scan, no write, from infra-plan's read-only key.
    expect(puts(s.dir)).toEqual([]);
    expect(readFileSync(join(s.dir, "curl-config.1"), "utf8")).toBe(
      `user = "${quoted(RO)}"\nurl = "https://${BUCKET}.${ENDPOINT}/tarubot/pins/prod-3.json"\n`,
    );
    expect(of(s.dir, "ssh-keyscan")).toEqual([]);
    expect(of(s.dir, "ssh")).toEqual([]);
  });

  test("PIN_SCOPE=prod warns about staging's hosts instead, and all lists everything", () => {
    const s = matrix();
    const prod = s.run(["status"], { PIN_SCOPE: "prod", ...ro });
    expect(prod.code).toBe(0);
    expect(prod.outputs).toEqual({ pins_needed: "prod prod-2 prod-3" });
    expect(prod.public).toContain(`prod-3: ${MISSING}`);
    for (const w of [
      "::warning::staging-2 has no pin for its current instance, and this run leaves it alone: dispatch action=infra to pin it",
      "::warning::staging-3 has no pin for its current instance, and this run leaves it alone: dispatch action=infra to pin it",
      "::warning::staging-4 has other addresses than its pin, and this run leaves it alone: dispatch action=infra to pin it",
    ])
      expect(prod.public).toContain(w);
    const all = s.run(["status"], { PIN_SCOPE: "all", ...ro });
    expect(all.outputs).toEqual({
      pins_needed: "prod prod-2 prod-3 staging-2 staging-3 staging-4",
    });
    expect(all.public).not.toContain("::warning::");
  });

  test("status prints no ID, address or key, and masks each before printing anything", () => {
    const s = matrix();
    const r = s.run(["status"], { PIN_SCOPE: "all", ...ro });
    for (const value of [
      STAGING_ID,
      OLD_ID,
      "40000012",
      V4,
      V6,
      V4_OLD,
      "192.0.2.16",
      A.b64,
      B.b64,
      A.fingerprint,
      B.fingerprint,
    ])
      expect(r.public).not.toContain(value);
    for (const value of [STAGING_ID, "40000013", V4, V6, "192.0.2.16", A.b64, A.fingerprint])
      expect(r.masks).toContain(value);
    const lines = r.stdout.trim().split("\n");
    const firstOther = lines.findIndex((l) => !l.startsWith("::add-mask::"));
    expect(lines.slice(firstOther).some((l) => l.startsWith("::add-mask::"))).toBe(false);
  });

  test("status fails on a bad scope, an unset or unreadable store, or a malformed pin", () => {
    for (const env of [
      { PIN_SCOPE: "production" },
      { PIN_SCOPE: "" },
      { PIN_SCOPE: "all", STATE_BUCKET: "" },
      { PIN_SCOPE: "all", FAKE_GET_STATUS: "403" },
      { PIN_SCOPE: "all", FAKE_GET_STATUS: "500" },
    ]) {
      const r = matrix().run(["status"], { ...ro, ...env });
      expect(r.code).toBe(1);
      expect(r.outputs).toEqual({});
    }
    const malformed = sandbox({
      plan: { staging: { prior: host(STAGING_ID) } },
      pins: { staging: "{}" },
    });
    const r = malformed.run(["status"], { PIN_SCOPE: "staging", ...ro });
    expect(r.code).toBe(1);
    expect(r.public).toContain("staging's stored pin is malformed");

    const empty = sandbox({ plan: {} });
    const none = empty.run(["status"], { PIN_SCOPE: "all", ...ro });
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("No hosts in TOFU_VARS.\n");
    expect(none.outputs).toEqual({ pins_needed: "" });
  });
});

describe.skipIf(!canRun)("host.sh connect: strict, and quiet about the host", () => {
  const pinned = (pin?: unknown) =>
    sandbox({
      pins: pin === undefined ? { staging: pinOf(A, host(STAGING_ID)) } : { staging: pin },
    });

  test("writes the Configure key, the pin as known_hosts and the inventory, all private", () => {
    const s = pinned();
    // A key pasted on another system: its carriage returns go.
    const r = s.run(["connect", "staging"], {
      ANSIBLE_SSH_KEY: CLIENT.private.replaceAll("\n", "\r\n"),
    });
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({});
    const d = join(s.temp, "ssh");
    expect(readFileSync(join(d, "key"), "utf8")).toBe(`${CLIENT.private}\n`);
    expect(readFileSync(join(d, "known_hosts"), "utf8")).toBe(`target ${A.pub}\n`);
    const inventory = JSON.parse(readFileSync(join(d, "inventory.json"), "utf8"));
    const opts = [
      "-F",
      "/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${d}/known_hosts`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "HostKeyAlias=target",
      "-o",
      "HostKeyAlgorithms=ssh-ed25519",
      "-o",
      "CheckHostIP=no",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "LogLevel=FATAL",
    ];
    expect(inventory).toEqual({
      all: {
        hosts: {
          target: {
            ansible_host: V4,
            ansible_user: "root",
            ansible_ssh_private_key_file: `${d}/key`,
            ansible_ssh_common_args: [
              ...opts,
              "-o",
              "AddressFamily=inet",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=4",
            ]
              .map((o) => `'${o}'`)
              .join(" "),
          },
        },
      },
    });
    // The probe: those options, the family, the key, root and `true`.
    const argv = readFileSync(join(s.dir, "argv"), "utf8");
    expect(argv).toContain(
      ["== ssh", ...opts, "-o", "AddressFamily=inet", "-i", `${d}/key`, `root@${V4}`, "true"].join(
        "\n",
      ),
    );
    expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const f of ["key", "known_hosts", "inventory.json"])
      expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
  });

  test("a host-key mismatch stops at once: no other family, no retry, no fingerprint in the log", () => {
    for (const env of [
      { FAKE_ROUTE_6: "1", FAKE_HOSTKEY_6: B.pub },
      { FAKE_HOSTKEY: B.pub },
    ] as Record<string, string>[]) {
      const s = pinned();
      const r = s.run(["connect", "staging"], env);
      expect(r.code).toBe(1);
      expect(r.outputs).toEqual({ reason: "host-key" });
      expect(r.public).toContain("staging offered a host key other than its pin");
      expect(of(s.dir, "ssh")).toHaveLength(1);
      expect(of(s.dir, "sleep")).toEqual([]);
      // The stand-in ssh printed the offered key and the address; none of it reaches the log.
      for (const value of [B.b64, B.fingerprint, A.b64, A.fingerprint, V4, V6])
        expect(r.public).not.toContain(value);
      expect(existsSync(join(s.temp, "ssh", "key"))).toBe(false);
    }
  });

  test("exit 3 with no pin or no store, and nothing written", () => {
    const noPin = sandbox();
    const r = noPin.run(["connect", "staging"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe(
      "No pin for staging yet: its host key is pinned by the first approved run that builds it.\n",
    );
    expect(r.outputs).toEqual({});
    expect(existsSync(join(noPin.temp, "ssh", "key"))).toBe(false);
    for (const env of [
      { STATE_BUCKET: "" },
      { STATE_ENDPOINT: "" },
      { AWS_ACCESS_KEY_ID: "" },
      { AWS_SECRET_ACCESS_KEY: "" },
    ]) {
      const s = pinned();
      const unset = s.run(["connect", "staging"], env);
      expect(unset.code).toBe(3);
      expect(unset.outputs).toEqual({});
      expect(events(s.dir)).toEqual([]);
    }
    // Set but malformed is a failure, not "no store".
    const dotted = pinned().run(["connect", "staging"], { STATE_BUCKET: "example.state" });
    expect(dotted.code).toBe(1);
    expect(dotted.outputs).toEqual({ reason: "pin-store" });
  });

  test("key-rejected, unreachable, pin-store and configure-key", () => {
    const denied = pinned();
    const r = denied.run(["connect", "staging"], { FAKE_SSH_4: "denied" });
    expect(r.code).toBe(1);
    expect(r.outputs).toEqual({ reason: "key-rejected" });
    expect(of(denied.dir, "ssh")).toEqual(["ssh 4"]);
    expect(existsSync(join(denied.temp, "ssh", "key"))).toBe(false);

    const down = pinned();
    const gone = down.run(["connect", "staging"], {
      FAKE_ROUTE_6: "1",
      FAKE_SSH_6: "silent",
      FAKE_SSH_4: "silent",
    });
    expect(gone.code).toBe(1);
    expect(gone.outputs).toEqual({ reason: "unreachable" });
    expect(of(down.dir, "ssh")).toHaveLength(60);
    expect(of(down.dir, "sleep")).toHaveLength(29);

    // A host still booting answers in a later round.
    const booting = pinned();
    expect(booting.run(["connect", "staging"], { FAKE_SSH_FAILS_4: "2" }).code).toBe(0);
    expect(of(booting.dir, "sleep")).toEqual(["sleep 10", "sleep 10"]);

    for (const env of [{ FAKE_GET_STATUS: "403" }, { FAKE_GET_STATUS: "500" }]) {
      const s = pinned();
      const unreadable = s.run(["connect", "staging"], env);
      expect(unreadable.code).toBe(1);
      expect(unreadable.outputs).toEqual({ reason: "pin-store" });
      expect(of(s.dir, "ssh")).toEqual([]);
    }
    const malformed = pinned('{"host_key":"x"}').run(["connect", "staging"]);
    expect(malformed.code).toBe(1);
    expect(malformed.outputs).toEqual({ reason: "pin-store" });

    for (const key of ["", "not a key", LOCKED.private]) {
      const s = pinned();
      const bad = s.run(["connect", "staging"], { ANSIBLE_SSH_KEY: key });
      expect(bad.code).toBe(1);
      expect(bad.outputs).toEqual({ reason: "configure-key" });
      expect(of(s.dir, "ssh")).toEqual([]);
      expect(existsSync(join(s.temp, "ssh", "key"))).toBe(false);
    }
  });

  test("only staging and prod connect", () => {
    for (const args of [["connect", "production"], ["connect", "staging-2"], ["connect"], ["x"]]) {
      const s = pinned();
      expect(s.run(args).code).toBe(1);
      expect(events(s.dir)).toEqual([]);
    }
  });
});

describe.skipIf(!canRun)("host.sh: the public log and the credentials", () => {
  test("a first build end to end: masked values only on mask lines, masks first, no credential in any argv or child environment", () => {
    const s = sandbox({
      plan: { staging: { actions: ["create"] } },
      outputs: { staging: { instance_id: STAGING_ID, ipv4: V4, ipv6: V6 } },
    });
    // The plan's status (read-only key), the approving job's pin and its connect.
    const ro = { AWS_ACCESS_KEY_ID: RO.id, AWS_SECRET_ACCESS_KEY: RO.secret, FAKE_ROUTE_6: "1" };
    const runs = [
      s.run(["status"], { PIN_SCOPE: "staging", ...ro }),
      s.run(["pin"], { PINS: "staging", FAKE_ROUTE_6: "1" }),
      s.run(["connect", "staging"], { FAKE_ROUTE_6: "1" }),
    ];
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
    const masked = [STAGING_ID, V4, V6, A.b64, A.fingerprint];
    const secret = [
      RW.id,
      RW.secret,
      RO.id,
      RO.secret,
      BUCKET,
      ENDPOINT,
      CLIENT.private.split("\n")[1] ?? "",
    ];
    for (const r of runs) {
      for (const value of [...masked, ...secret]) expect(r.public).not.toContain(value);
      // Every mask comes before the first line that isn't one.
      const lines = r.log.trim().split("\n");
      const firstOther = lines.findIndex((l) => !l.startsWith("::add-mask::"));
      expect(firstOther).toBeGreaterThanOrEqual(0);
      expect(lines.slice(firstOther).some((l) => l.startsWith("::add-mask::"))).toBe(false);
    }
    for (const value of masked) expect(runs[1]?.masks).toContain(value);
    for (const value of [V4, V6, A.b64, A.fingerprint]) expect(runs[2]?.masks).toContain(value);
    // No output carries a value: only the keys and the lists of host keys.
    for (const r of runs)
      for (const v of Object.values(r.outputs)) expect(v).toMatch(/^[a-z0-9 -]*$/);

    // curl got the URL and the credentials only in its config on stdin, quoted.
    const argv = readFileSync(join(s.dir, "argv"), "utf8");
    for (const value of secret) expect(argv).not.toContain(value);
    expect(argv).not.toContain("tarubot/pins");
    expect(argv).toContain("--aws-sigv4\naws:amz:us-east-1:s3");
    expect(argv).toContain("--config\n-\n");
    // status reads nothing for a new host; pin reads and writes, and connect reads.
    expect(existsSync(join(s.dir, "curl-config.4"))).toBe(false);
    for (const f of ["curl-config.1", "curl-config.2", "curl-config.3"])
      expect(readFileSync(join(s.dir, f), "utf8")).toBe(
        `user = "${quoted(RW)}"\nurl = "https://${BUCKET}.${ENDPOINT}/tarubot/pins/staging.json"\n`,
      );
    // No stand-in inherited a credential or the Configure key.
    expect(existsSync(join(s.dir, "leaked-env"))).toBe(false);
    // ssh's and ssh-keyscan's own output stayed in private files.
    for (const f of ["scan6", "scan4", "ssh.log", "curl.stderr"])
      if (existsSync(join(s.temp, "pin", f)))
        expect(statSync(join(s.temp, "pin", f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.temp, "pin")).mode & 0o777).toBe(0o700);
  });

  test("the script never traces, and its usage names the three subcommands", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toMatch(/^set -Eeuo pipefail$/m);
    expect(text).toMatch(/^umask 077$/m);
    expect(text).not.toMatch(/^\s*set -[a-zA-Z]*x/m);
    const s = sandbox();
    const r = s.run([]);
    expect(r.code).toBe(1);
    expect(r.public).toContain("usage: host.sh status | pin | connect staging|prod");
  });
});
