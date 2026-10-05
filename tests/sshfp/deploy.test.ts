/** Native trust-boundary acceptance, enabled only with an explicitly built lab image. */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type Target = "production" | "staging";
type Scenario =
  | "signed"
  | "unsigned"
  | "missing"
  | "bogus"
  | "mismatch"
  | "rotation"
  | "term"
  | "cancel-int"
  | "cancel-term"
  | "occupied";
type Release = {
  target: Target;
  version: string;
  commit: string;
  digest: string;
  runId: string;
  uid: number;
  request: string;
  privateDiagnosticEmitted: boolean;
};
type Run = {
  phase: string;
  target: Target;
  code: number;
  stdout: string;
  stderr: string;
  runnerUid: number;
  remoteUid: number;
  knownHostsMatchesCurrentServer: boolean;
  resolverRestored: boolean;
  resolverTopologyRestored: boolean;
  resolverOriginalSha256: string;
  resolverFinalSha256: string;
  privateDirectoryObserved: boolean;
  privateDirectoryModes: number[];
  privateWorkRemaining: string[];
  unboundProcessesRemaining: number[];
  sshProcessesRemaining: number[];
  resolverPortFree: boolean;
  termSentToPid: number | null;
  resolverActiveWhenTermSent: boolean | null;
  cancelSentToPid: number | null;
  cancelElapsedSeconds: number | null;
  resolverActiveWhenCanceled: boolean | null;
  sshSessionActiveWhenCanceled: boolean | null;
  authoritativeServerSurvived: boolean;
  occupiedResolverSurvived?: boolean;
  remoteCommandEntered: boolean;
  executionMarker: (Release & { stateSha256: string }) | null;
  releaseState: Release | null;
  releaseStateSha256: string | null;
  tamperedRRsets: number;
  privateValues: string[];
  nativeProbe: {
    status: string;
    authenticated: boolean;
    answerCount: number;
    sshfpRecordCount: number;
  } | null;
};
type Report = { scenario: Scenario; target: Target; sudoUid: number; runs: Run[] };

const image = process.env.SSHFP_FIXTURE_IMAGE;
const helper = fileURLToPath(new URL("../../ops/deploy-ssh.sh", import.meta.url));
const ownedContainers = new Set<string>();
const publicLine =
  /^(?:step (?:preflight|fetch|pull|stop|backup|migrate|register|start|observe|record)|result (?:deployed|already-live|refused|needs-owner)|::error::.*)$/;

async function docker(arguments_: string[], timeout = 90_000) {
  const child = Bun.spawn(["docker", ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let expired = false;
  // This bounds a real Docker daemon/CLI, not application timer behavior.
  // Await its exit event normally; fake time cannot terminate a hung daemon.
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (expired) throw new Error(`Owned SSHFP fixture Docker command timed out: ${arguments_[0]}`);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedContainer(name: string) {
  const result = await docker(["rm", "--force", name], 20_000);
  if (result.code !== 0 && !result.stderr.includes(`No such container: ${name}`))
    throw new Error(`Could not remove owned SSHFP fixture ${name}: ${result.stderr}`);
  ownedContainers.delete(name);
}

afterAll(async () => {
  // A second cleanup boundary also covers an interrupted/failed test callback.
  for (const name of ownedContainers) await removeOwnedContainer(name);
});

async function lab(scenario: Scenario, target: Target): Promise<Report> {
  if (!image) throw new Error("SSHFP_FIXTURE_IMAGE must identify an already built fixture image");
  const name = `tarubot-sshfp-${randomUUID()}`;
  ownedContainers.add(name);
  try {
    const result = await docker([
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network=none",
      "--cap-add=NET_ADMIN",
      "--mount",
      `type=bind,source=${helper},target=/transport/deploy-ssh.sh,readonly`,
      image,
      scenario,
      target,
    ]);
    if (result.code !== 0)
      throw new Error(
        `Native SSHFP fixture failed (${result.code}): ${result.stderr}\n${result.stdout}`,
      );
    const report = JSON.parse(result.stdout) as Report;
    expect(report.scenario).toBe(scenario);
    expect(report.target).toBe(target);
    expect(report.sudoUid).toBe(0);
    return report;
  } finally {
    // Killing the CLI alone is insufficient: remove the exact container even
    // on timeout, invalid JSON, native setup failure or an assertion failure.
    await removeOwnedContainer(name);
  }
}

function assertLifecycleAndPrivacy(run: Run, occupied = false) {
  expect(run.runnerUid).toBeGreaterThan(0);
  expect(run.remoteUid).toBeGreaterThan(0);
  expect(run.knownHostsMatchesCurrentServer).toBe(true);
  expect(run.resolverRestored).toBe(true);
  expect(run.resolverTopologyRestored).toBe(true);
  expect(run.resolverFinalSha256).toBe(run.resolverOriginalSha256);
  expect(run.privateDirectoryObserved).toBe(true);
  expect(run.privateDirectoryModes).toEqual([0o700]);
  expect(run.privateWorkRemaining).toEqual([]);
  expect(run.unboundProcessesRemaining).toEqual([]);
  expect(run.sshProcessesRemaining).toEqual([]);
  expect(run.resolverPortFree).toBe(!occupied);
  expect(run.authoritativeServerSurvived).toBe(true);
  expect(run.stderr).toBe("");
  const output = run.stdout + run.stderr;
  for (const privateValue of run.privateValues) expect(output).not.toContain(privateValue);
  for (const line of run.stdout.split("\n").filter(Boolean)) expect(line).toMatch(publicLine);
}

function assertDeployed(run: Run) {
  assertLifecycleAndPrivacy(run);
  expect(run.code).toBe(0);
  expect(run.stdout.split("\n")).toContain("result deployed");
  expect(run.nativeProbe).toMatchObject({ status: "NOERROR", authenticated: true });
  expect(run.nativeProbe?.sshfpRecordCount).toBeGreaterThanOrEqual(2);
  expect(run.executionMarker).not.toBeNull();
  expect(run.remoteCommandEntered).toBe(true);
  expect(run.executionMarker?.uid).toBe(run.remoteUid);
  expect(run.releaseState?.target).toBe(run.target);
  expect(run.releaseState?.privateDiagnosticEmitted).toBe(true);
}

function assertRejected(run: Run, scenario: Scenario) {
  assertLifecycleAndPrivacy(run, scenario === "occupied");
  expect(run.code).not.toBe(0);
  expect(run.remoteCommandEntered).toBe(false);
  expect(run.executionMarker).toBeNull();
  expect(run.releaseState).toBeNull();
  expect(run.releaseStateSha256).toBeNull();
  expect(run.stdout).not.toContain("result deployed");
  expect(run.stdout).not.toContain("result already-live");
  // Native OpenSSH may finish rejection before the observer's extra query.
  // When captured, this is the actual job-local Unbound response, not a fake
  // DNS server, a canned AD flag or a test-specific validator configuration.
  if (run.nativeProbe) {
    if (scenario === "unsigned")
      expect(run.nativeProbe).toMatchObject({
        status: "NOERROR",
        authenticated: false,
        sshfpRecordCount: 2,
      });
    else if (scenario === "bogus")
      expect(run.nativeProbe).toMatchObject({
        status: "SERVFAIL",
        authenticated: false,
        sshfpRecordCount: 0,
      });
    else if (scenario === "missing")
      expect(run.nativeProbe).toMatchObject({
        status: "NOERROR",
        authenticated: true,
        sshfpRecordCount: 0,
      });
    else
      expect(run.nativeProbe).toMatchObject({
        status: "NOERROR",
        authenticated: true,
        sshfpRecordCount: run.phase.startsWith("overlap-") ? 4 : 2,
      });
  }
  if (scenario === "bogus") expect(run.tamperedRRsets).toBe(2);
}

describe.skipIf(!image)("DNSSEC-authenticated native deployment SSHFP", () => {
  for (const target of ["staging", "production"] as const) {
    test(`${target}: signed matching SSHFP executes a real remote command without any client key`, async () => {
      const report = await lab("signed", target);
      expect(report.runs).toHaveLength(1);
      const run = report.runs[0];
      if (!run) throw new Error("Missing native fixture run");
      assertDeployed(run);
    }, 120_000);

    for (const scenario of ["unsigned", "missing", "bogus", "mismatch"] as const) {
      test(`${target}: ${scenario} SSHFP cannot fall back to a matching ordinary host pin`, async () => {
        const report = await lab(scenario, target);
        expect(report.runs).toHaveLength(1);
        const run = report.runs[0];
        if (!run) throw new Error("Missing native fixture run");
        assertRejected(run, scenario);
      }, 120_000);
    }
  }

  test("an occupied resolver port refuses deployment without stopping the pre-existing native DNS server", async () => {
    const report = await lab("occupied", "production");
    expect(report.runs).toHaveLength(1);
    const run = report.runs[0];
    if (!run) throw new Error("Missing native fixture run");
    assertRejected(run, "occupied");
    expect(run.occupiedResolverSurvived).toBe(true);
  }, 120_000);

  test("early TERM during real resolver startup removes private state and restores the resolver", async () => {
    const report = await lab("term", "production");
    expect(report.runs).toHaveLength(1);
    const run = report.runs[0];
    if (!run) throw new Error("Missing native fixture run");
    assertRejected(run, "term");
    expect(run.termSentToPid).toBeGreaterThan(0);
  }, 120_000);

  for (const scenario of ["cancel-int", "cancel-term"] as const) {
    test(`${scenario}: entry-PID cancellation cleans a held native SSH session before remote publication`, async () => {
      const report = await lab(scenario, "production");
      const run = report.runs[0];
      if (!run) throw new Error("Missing native cancellation run");
      assertLifecycleAndPrivacy(run);
      expect(run.code).toBe(scenario === "cancel-int" ? 130 : 143);
      expect(run.cancelSentToPid).toBeGreaterThan(0);
      expect(run.resolverActiveWhenCanceled).toBe(true);
      expect(run.sshSessionActiveWhenCanceled).toBe(true);
      expect(run.remoteCommandEntered).toBe(true);
      expect(run.nativeProbe).toMatchObject({ status: "NOERROR", authenticated: true });
      expect(run.executionMarker).toBeNull();
      expect(run.releaseState).toBeNull();
      expect(run.stdout).not.toContain("result deployed");
      // The real runner escalates to SIGKILL 2.5 seconds after SIGTERM.
      // Bound process cleanup, not application timer/wording behavior.
      expect(run.cancelElapsedSeconds).not.toBeNull();
      expect(run.cancelElapsedSeconds).toBeLessThan(2);
    }, 120_000);
  }

  test("mixed same-algorithm SSHFP refuses both host keys; a matching signed cutover restores delivery", async () => {
    const report = await lab("rotation", "production");
    expect(report.runs.map((run) => run.phase)).toEqual([
      "overlap-old-host",
      "overlap-new-host",
      "stale-dns-new-host",
      "rotated-dns-new-host",
    ]);
    for (const run of report.runs) {
      if (run.phase !== "rotated-dns-new-host") assertRejected(run, "rotation");
      else assertDeployed(run);
    }
  }, 120_000);
});
