/** Replacement pipeline contracts and hostile evidence; all commands/storage are invented stand-ins. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { z } from "zod";
import {
  InfrastructureRecords,
  RecordCodec,
  stateEvidence,
  type ControlStore,
} from "../../scripts/infra-control.js";
import { handoffBinding } from "../../scripts/infra-policy.js";
import {
  automaticInfrastructure,
  requireAutomaticCaller,
  requireAutomaticPlan,
} from "../../scripts/release-infra.js";
import { requireMainEnvironment } from "../../scripts/release-admission.js";
import {
  platformImages,
  releaseIdentity,
  requireStagingAcceptance,
  verifyReleaseProvenance,
} from "../../scripts/release-policy.js";
import { boundIndex, scanCommands, scanner } from "../../scripts/release-scan.js";
import { releaseInputs, releasePlan } from "../fixtures/infra/release.js";
import { hostRecordCodec } from "../../scripts/infra-control-cli.js";
import { HostEnrollmentRecords } from "../../scripts/host-enrollment.js";

const root = (path: string) => new URL(`../../${path}`, import.meta.url);
const text = (path: string) => readFileSync(root(path), "utf8");
const workflow = (name: string) =>
  z
    .object({ jobs: z.record(z.string(), z.unknown()), concurrency: z.unknown().optional() })
    .parse(YAML.parse(text(`.github/workflows/${name}.yml`)));
/** Validate inspected fields rather than casting arbitrary YAML into a workflow type. */
const jobSchema = z
  .object({
    name: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    environment: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
    steps: z
      .array(z.object({ id: z.string().optional(), run: z.string().optional() }).passthrough())
      .default([]),
  })
  .passthrough();
const job = (name: string, key: string) => jobSchema.parse(workflow(name).jobs[key]);
const release = releaseIdentity({
  version: "2.36.6",
  commit: "1".repeat(40),
  digest: `sha256:${"a".repeat(64)}`,
  config_commit: "1".repeat(40),
  publication_run: "1234",
  schema_head: "010_example.sql",
});
const platform = (architecture: string, digest: string) => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  size: 1000,
  digest: `sha256:${digest.repeat(64)}`,
  platform: { os: "linux", architecture },
});
const index = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [platform("amd64", "b"), platform("arm64", "c")],
};
const checks = {
  backup: true,
  commands: true,
  database: true,
  discord: true,
  image: true,
  schema: true,
  stability: true,
  timer: true,
  writer_lease: true,
};
const acceptance = { schema: 1, target: "staging", outcome: "accepted", release, checks };
// Fresh platform-temporary evidence works in both local checks and clean Docker build stages.
const scratch = mkdtempSync(join(tmpdir(), "release-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("platform scan evidence", () => {
  test("the manifest bytes must match the build-returned index digest", () => {
    const bytes = Buffer.from(JSON.stringify(index));
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    expect(boundIndex(bytes, digest)).toEqual(index);
    expect(() => boundIndex(Buffer.concat([bytes, Buffer.from("\n")]), digest)).toThrow(
      "invalid-release-index",
    );
    expect(() => boundIndex(bytes, release.digest)).toThrow("invalid-release-index");
  });
  test("both distinct runtime digests are scanned, including an index with BuildKit attestations", () => {
    const expected = [
      { platform: "linux/amd64" as const, digest: `sha256:${"b".repeat(64)}` },
      { platform: "linux/arm64" as const, digest: `sha256:${"c".repeat(64)}` },
    ];
    expect(platformImages(index)).toEqual(expected);
    const attestation = {
      ...platform("unknown", "d"),
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": index.manifests[0]?.digest,
      },
    };
    expect(platformImages({ ...index, manifests: [...index.manifests, attestation] })).toEqual(
      expected,
    );
    const commands = scanCommands(index);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain("HIGH,CRITICAL");
      expect(command).toContain("--ignore-unfixed");
      expect(command).toContain("--exit-code");
      expect(command[command.indexOf("--exit-code") + 1]).toBe("0");
      expect(command[command.indexOf("--format") + 1]).toBe("json");
      expect(command[command.indexOf("--image-src") + 1]).toBe("remote");
      expect(command).toContain("--list-all-pkgs=false");
      expect(command).not.toContain("false");
      expect(command).toContain("--config");
      expect(command).toContain("--ignorefile");
      expect(command.at(-1)).toMatch(/^ghcr\.io\/deconfined\/tarubot@sha256:[a-f0-9]{64}$/u);
      expect(command).not.toContain("latest");
    }
    expect(text(".github/workflows/scan.yml")).toContain(scanner.sha256);
    expect(text(".github/workflows/scan.yml")).toContain(`v${scanner.version}`);
  });
  test("missing/duplicate/unrecognized platform, digest, type and attestation cannot bypass scanning", () => {
    for (const manifests of [
      [],
      [platform("amd64", "b")],
      [platform("amd64", "b"), platform("amd64", "c")],
      [platform("amd64", "b"), platform("arm64", "b")],
      [platform("amd64", "b"), platform("arm", "c")],
      [platform("amd64", "b"), { ...platform("arm64", "c"), digest: "image:latest" }],
      [
        ...index.manifests,
        { ...platform("unknown", "d"), platform: { os: "unknown", architecture: "unknown" } },
      ],
    ])
      expect(() => platformImages({ ...index, manifests })).toThrow("invalid-release-evidence");
    expect(() => platformImages({ ...index, mediaType: "unrecognized" })).toThrow();
  });
});

describe("release and acceptance binding", () => {
  test("rejects injected identities, changing configuration, hostile paths and unknown fields", () => {
    for (const edit of [
      { version: "2.36.6\naccepted=true" },
      { commit: "x" },
      { config_commit: "2".repeat(40) },
      { digest: "image:latest" },
      { publication_run: "-1" },
      { schema_head: "../private.sql" },
      { extra: "private.example.org" },
    ])
      expect(() => releaseIdentity({ ...release, ...edit })).toThrow("invalid-release-evidence");
  });
  test("verified provenance must bind the exact image subject and publication attempt", () => {
    const provenance = [
      {
        verificationResult: {
          statement: {
            subject: [
              { name: "ghcr.io/deconfined/tarubot", digest: { sha256: release.digest.slice(7) } },
            ],
            predicate: {
              runDetails: {
                metadata: {
                  invocationId:
                    "https://github.com/deconfined/tarubot/actions/runs/1234/attempts/1",
                },
              },
            },
          },
        },
      },
    ];
    expect(() => verifyReleaseProvenance(provenance, release, "deconfined/tarubot")).not.toThrow();
    expect(() =>
      verifyReleaseProvenance(
        provenance,
        { ...release, publication_run: "9999" },
        "deconfined/tarubot",
      ),
    ).toThrow();
    expect(() =>
      verifyReleaseProvenance(
        provenance,
        { ...release, digest: `sha256:${"f".repeat(64)}` },
        "deconfined/tarubot",
      ),
    ).toThrow();
    expect(() => verifyReleaseProvenance([{}], release, "deconfined/tarubot")).toThrow();
  });
  test("all actual target checks and this release are mandatory; green non-deploy outcomes never count", () => {
    expect(() => requireStagingAcceptance(acceptance, release)).not.toThrow();
    for (const outcome of [
      "configured",
      "superseded",
      "preflight-ok",
      "no-host",
      "deployed",
      "skipped",
    ])
      expect(() => requireStagingAcceptance({ ...acceptance, outcome }, release)).toThrow();
    for (const key of Object.keys(checks))
      expect(() =>
        requireStagingAcceptance({ ...acceptance, checks: { ...checks, [key]: false } }, release),
      ).toThrow();
    expect(() =>
      requireStagingAcceptance(
        { ...acceptance, release: { ...release, publication_run: "9999" } },
        release,
      ),
    ).toThrow();
    expect(() =>
      requireStagingAcceptance({ ...acceptance, target: "production" }, release),
    ).toThrow();
  });
  test("main-only environments must already exist before jobs reference them; infra-auto cannot repurpose approval", () => {
    const env = {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      protection_rules: [],
    };
    const policies = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
    expect(() => requireMainEnvironment(env, policies, true)).not.toThrow();
    expect(() => requireMainEnvironment({}, policies)).toThrow();
    expect(() =>
      requireMainEnvironment(env, { branch_policies: [{ name: "*", type: "branch" }] }),
    ).toThrow();
    expect(() => requireMainEnvironment(env, { ...policies, total_count: 31 })).toThrow();
    expect(() =>
      requireMainEnvironment(
        { ...env, protection_rules: [{ type: "required_reviewers" }] },
        policies,
        true,
      ),
    ).toThrow();
    // Staging's reviewer is still the owner's pause gate; this code cannot remove/bypass it.
    expect(() =>
      requireMainEnvironment(
        { ...env, protection_rules: [{ type: "required_reviewers" }] },
        policies,
      ),
    ).not.toThrow();
  });
});

const passphrase = "invented-release-passphrase-with-more-than-32-characters";
const codec = new RecordCodec(passphrase, "a".repeat(64));
const rawState = {
  version: 4,
  terraform_version: "1.12.6",
  lineage: "11111111-1111-4111-8111-111111111111",
  serial: 10,
  resources: [],
  outputs: {},
};
describe("automatic infrastructure adapter", () => {
  async function runner(label = "example-renamed") {
    const directory = mkdtempSync(join(scratch, "infra-"));
    const objects = new Map<string, Uint8Array>();
    let failFinish = false;
    const store: ControlStore = {
      async read(key) {
        return objects.get(key) ?? null;
      },
      async write(key, value) {
        if (failFinish && key.startsWith("baselines/"))
          throw new Error("invented-private-storage-error");
        objects.set(key, Uint8Array.from(value));
      },
    };
    const records = new InfrastructureRecords(store, codec);
    const first = await records.inspect(stateEvidence(rawState));
    await records.finish(
      await records.begin(
        first,
        releaseInputs,
        { commit: release.commit, run: "1000" },
        "b".repeat(64),
        "baseline",
      ),
      first.state,
    );
    const snapshot = await records.inspect(first.state);
    const hostCodec = hostRecordCodec("example-bucket", "https://storage.example.org", passphrase);
    const enrollment = new HostEnrollmentRecords(store, hostCodec);
    const candidate = releasePlan(label);
    const values = {
      ...releaseInputs,
      hosts: { staging: { ...releaseInputs.hosts.staging, label } },
    };
    const env = {
      GITHUB_REPOSITORY: "deconfined/tarubot",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: release.commit,
      GITHUB_RUN_ID: release.publication_run,
      GITHUB_WORKFLOW_REF: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
      CONTROL_RECORDS_ENABLED: "true",
      TF_VAR_state_passphrase: passphrase,
      GITHUB_OUTPUT: join(directory, "output"),
      LINODE_TOKEN: "invented-write-token",
      CLOUDFLARE_API_TOKEN: "invented-write-token",
    };
    writeFileSync(env.GITHUB_OUTPUT, "");
    const write = (name: string, value: unknown) =>
      writeFileSync(join(directory, name), JSON.stringify(value));
    let state = rawState;
    let failApply = false;
    let current = release.commit;
    let plan: unknown = candidate;
    let mismatchedShow = false;
    let changedRead = "";
    const calls: string[][] = [];
    const execute = (argv: string[], name: string): Uint8Array => {
      calls.push([...argv]);
      let output: unknown = {};
      if (argv[0] === "gh") output = { object: { sha: current } };
      else if (argv[0] === "bash") {
        if (argv.at(-1) === "prepare") {
          writeFileSync(join(directory, "backend.hcl"), 'bucket = "example-bucket"\n');
          writeFileSync(join(directory, "replace"), "");
          write("values.tfvars.json", values);
        }
        if (argv.at(-1) === "control_read") {
          write("control-context.json", { enabled: true, snapshot });
          write("baseline-inputs.json", snapshot.inputs);
        }
        if (argv.at(-1) === "plan") {
          writeFileSync(join(directory, "plan.bin"), "invented-encrypted-plan");
          write("plan.json", plan);
        }
      } else if (argv[0] === "tofu") {
        if (argv[2] === "state")
          output = name === changedRead ? { ...state, serial: state.serial + 1 } : state;
        if (argv[2] === "show")
          output =
            argv.length > 4
              ? plan
              : {
                  format_version: "1.0",
                  terraform_version: "1.12.6",
                  values: mismatchedShow
                    ? { ...candidate.planned_values, root_module: { resources: [] } }
                    : candidate.planned_values,
                };
        if (argv[2] === "apply") {
          // Actual encrypted intent and pending readbacks must precede the invented provider effect.
          const head = objects.get("current");
          expect(head && (codec.open("current", head) as { pending: string }).pending).toBeTruthy();
          if (failApply) throw new Error("invented-private-provider-error");
          state = { ...rawState, serial: 11 };
        }
      }
      return Buffer.from(JSON.stringify(output));
    };
    const binding = () => ({
      ...env,
      DIGEST: new Bun.CryptoHasher("sha256")
        .update(readFileSync(join(directory, "plan.bin")))
        .digest("hex"),
      BINDING: handoffBinding(directory, env),
    });
    return {
      directory,
      env,
      records,
      objects,
      calls,
      binding,
      deps: { execute, records, enrollment },
      fail: () => {
        failApply = true;
      },
      stale: () => {
        current = "9".repeat(40);
      },
      invalid: () => {
        plan = { ...candidate, errored: true };
      },
      reviewRequired: () => {
        plan = {
          ...candidate,
          resource_changes: candidate.resource_changes.map((resource, index) =>
            index === 0
              ? { ...resource, change: { ...resource.change, actions: ["delete", "create"] } }
              : resource,
          ),
        };
      },
      mismatch: () => {
        mismatchedShow = true;
      },
      changeRead: (name: string) => {
        changedRead = name;
      },
      failCompletion: () => {
        failFinish = true;
      },
      pendingHost: () =>
        objects.set(
          "hosts/pending",
          hostCodec.seal("hosts/pending", { schema: 1, targets: ["staging"] }),
        ),
    };
  }
  test("no-change continuation reopens the same completed baseline without provider Apply or candidate artifacts", async () => {
    const r = await runner(releaseInputs.hosts.staging.label);
    await automaticInfrastructure("plan", release, r.directory, r.env, r.deps);
    expect(readFileSync(r.env.GITHUB_OUTPUT, "utf8")).toBe("decision=no-changes\nverified=true\n");
    expect(
      r.calls
        .filter((call) => call[0] === "gh")
        .every((call) => call.at(-1)?.endsWith("git/ref/heads/main")),
    ).toBe(true);
    expect(new Bun.Glob("target-candidates/**").scanSync({ cwd: r.directory }).next().done).toBe(
      true,
    );
  });
  test("a non-applyable no-change plan can continue, but a changed one cannot apply", () => {
    const context = {
      enabled: true,
      snapshot: { generation: "invented-test-generation", inputs: releaseInputs },
    };
    expect(
      requireAutomaticPlan({ ...releasePlan(), applyable: false }, releaseInputs, context),
    ).toBe("no-changes");
    const label = "example-renamed",
      inputs = { ...releaseInputs, hosts: { staging: { ...releaseInputs.hosts.staging, label } } };
    expect(() =>
      requireAutomaticPlan({ ...releasePlan(label), applyable: false }, inputs, context),
    ).toThrow();
  });
  test("safe Apply uses the exact encrypted plan and completes the ordinary records after state verification", async () => {
    const r = await runner();
    await automaticInfrastructure("plan", release, r.directory, r.env, r.deps);
    await automaticInfrastructure("apply", release, r.directory, r.binding(), r.deps);
    expect(
      (await r.records.inspect(stateEvidence({ ...rawState, serial: 11 }))).inputs?.hosts,
    ).toEqual({ staging: { ...releaseInputs.hosts.staging, label: "example-renamed" } });
    expect(readFileSync(r.env.GITHUB_OUTPUT, "utf8")).toBe(
      "decision=safe\nverified=false\nverified=true\n",
    );
  });
  test("unstable state, wrong applied show and corrupted completed baseline never produce verified continuation", async () => {
    for (const failure of ["changed-state", "wrong-show", "corrupt-baseline"] as const) {
      const r = await runner(releaseInputs.hosts.staging.label);
      if (failure === "changed-state") r.changeRead("state-verified");
      if (failure === "wrong-show") r.mismatch();
      if (failure === "corrupt-baseline") r.objects.set("current", new Uint8Array([1]));
      await expect(
        automaticInfrastructure("plan", release, r.directory, r.env, r.deps),
      ).rejects.toThrow();
      expect(readFileSync(r.env.GITHUB_OUTPUT, "utf8")).toBe("");
      expect(r.calls.some((call) => call[2] === "apply")).toBe(false);
    }
  });
  test("pending host enrollment blocks no-change continuation and safe provider Apply", async () => {
    for (const mode of ["plan", "apply"] as const) {
      const r = await runner(mode === "plan" ? releaseInputs.hosts.staging.label : undefined);
      if (mode === "apply")
        await automaticInfrastructure("plan", release, r.directory, r.env, r.deps);
      r.pendingHost();
      await expect(
        automaticInfrastructure(
          mode,
          release,
          r.directory,
          mode === "plan" ? r.env : r.binding(),
          r.deps,
        ),
      ).rejects.toThrow();
      expect(r.calls.some((call) => call[2] === "apply")).toBe(false);
      expect(readFileSync(r.env.GITHUB_OUTPUT, "utf8")).not.toContain("verified=true");
    }
  });
  test("wrong handoff and plan tampering stop before effects; provider failure retains pending intent", async () => {
    const r = await runner();
    await automaticInfrastructure("plan", release, r.directory, r.env, r.deps);
    const expected = r.binding();
    await expect(
      automaticInfrastructure(
        "apply",
        release,
        r.directory,
        { ...expected, BINDING: "f".repeat(64) },
        r.deps,
      ),
    ).rejects.toThrow();
    writeFileSync(join(r.directory, "plan.bin"), "changed-after-plan");
    await expect(
      automaticInfrastructure("apply", release, r.directory, expected, r.deps),
    ).rejects.toThrow();
    expect(r.calls.some((call) => call[2] === "apply")).toBe(false);
    writeFileSync(join(r.directory, "plan.bin"), "invented-encrypted-plan");
    r.fail();
    await expect(
      automaticInfrastructure("apply", release, r.directory, expected, r.deps),
    ).rejects.toThrow();
    await expect(r.records.inspect(stateEvidence(rawState))).rejects.toThrow();
  });
  test("post-Apply verification or completion failure leaves durable pending and no verified result", async () => {
    for (const failure of ["changed-state", "wrong-show", "finish-failed"] as const) {
      const r = await runner();
      await automaticInfrastructure("plan", release, r.directory, r.env, r.deps);
      if (failure === "changed-state") r.changeRead("state-verified");
      if (failure === "wrong-show") r.mismatch();
      if (failure === "finish-failed") r.failCompletion();
      await expect(
        automaticInfrastructure("apply", release, r.directory, r.binding(), r.deps),
      ).rejects.toThrow();
      expect(readFileSync(r.env.GITHUB_OUTPUT, "utf8")).not.toContain("verified=true");
      await expect(r.records.inspect(stateEvidence({ ...rawState, serial: 11 }))).rejects.toThrow();
    }
  });
  test("invalid or review-required plans, disabled records and stale main stop without provider writes", async () => {
    for (const mode of ["invalid", "review-required", "stale", "disabled"] as const) {
      const r = await runner();
      if (mode === "invalid") r.invalid();
      if (mode === "review-required") r.reviewRequired();
      if (mode === "stale") r.stale();
      if (mode === "disabled") r.env.CONTROL_RECORDS_ENABLED = "false";
      await expect(
        automaticInfrastructure("plan", release, r.directory, r.env, r.deps),
      ).rejects.toThrow();
      expect(r.calls.some((call) => call[2] === "apply")).toBe(false);
    }
  });
  test("dispatch, rerun and another workflow cannot use the automatic adapter", () => {
    const env = {
      GITHUB_REPOSITORY: "deconfined/tarubot",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: release.commit,
      GITHUB_RUN_ID: release.publication_run,
      GITHUB_WORKFLOW_REF: "deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",
      CONTROL_RECORDS_ENABLED: "true",
    };
    expect(() => requireAutomaticCaller(release, env)).not.toThrow();
    for (const edit of [
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_WORKFLOW_REF: "deconfined/tarubot/.github/workflows/other.yml@refs/heads/main" },
      { GITHUB_RUN_ID: "9999" },
    ])
      expect(() => requireAutomaticCaller(release, { ...env, ...edit })).toThrow();
    expect(() =>
      requireAutomaticPlan(releasePlan(), releaseInputs, {
        enabled: true,
        snapshot: { generation: null, inputs: releaseInputs },
      }),
    ).toThrow();
  });
});

describe("replacement workflow graph and acceptance execution", () => {
  test("scan precedes signing; orchestration defaults off; legacy production jobs remain pinned elsewhere", () => {
    expect(job("publish", "attest").needs).toEqual(["publish", "scan"]);
    expect(job("publish", "release").uses).toBe("./.github/workflows/release.yml");
    expect(job("publish", "release").if).toContain("vars.RELEASE_PIPELINE_ENABLED == 'true'");
    expect(job("publish", "release").with.digest).toBe(`\${{ needs.publish.outputs.digest }}`);
    expect(job("publish", "latest").if).toContain("needs.release.outputs.accepted == 'true'");
    expect(job("release", "identity").environment).toBeUndefined();
    expect(job("release", "infrastructure").needs).toBe("identity");
    expect(job("release", "staging").needs).toEqual(["identity", "infrastructure"]);
    expect(job("release", "staging").with.accept_release).toBe(true);
    expect(job("release", "complete").needs).toEqual(["identity", "infrastructure", "staging"]);
    expect(text(".github/workflows/release.yml")).not.toContain("environment: production");
  });
  test("the automatic lane shares the infra writer group and never uses reviewed infra as a bypass", () => {
    const infra = workflow("release-infra");
    expect(infra.concurrency).toEqual({
      group: "infra",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(job("release-infra", "plan").environment).toBe("infra-plan");
    expect(job("release-infra", "apply").environment).toBe("infra-auto");
    // Keep the existing workflow structure clear without inventing another authority reader.
    expect(job("publish", "release").name).toBe("Replacement release orchestration");
    expect(job("release", "infrastructure").uses).toBe("./.github/workflows/release-infra.yml");
    expect(job("release-infra", "plan").name).toBe("Plan infrastructure");
    expect(job("release-infra", "apply").name).toBe("Apply infrastructure");
    expect(job("release-infra", "apply").if).toContain("needs.plan.outputs.decision == 'safe'");
    expect(job("release-infra", "apply").steps.find((s) => s.id === "apply")?.run).not.toContain(
      "plan",
    );
    expect(job("release-infra", "complete").steps[0]?.run).toContain("$APPLY_RESULT == skipped");
    expect(job("release-infra", "complete").steps[0]?.run).toContain("$APPLY_VERIFIED == true");
    // The protected jobs use ordinary state/provider roles; no historical workflow authority,
    // descriptor key or per-target candidate secret is required for infrastructure completion.
    const serialized = text(".github/workflows/release-infra.yml");
    expect(serialized).not.toMatch(/CONTROL_OWNER_|CONTROL_REPOSITORY_ID|TARGET_CANDIDATE_/u);
    expect(serialized).toContain("secrets.TOFU_STATE_READ_ACCESS_KEY");
    expect(serialized).toContain("secrets.TOFU_STATE_WRITE_ACCESS_KEY");
    expect(serialized).toContain("secrets.LINODE_READ_TOKEN");
    expect(serialized).toContain("secrets.LINODE_WRITE_TOKEN");
  });
  test("the unfinished trust/adoption prerequisites are a code fence before environment jobs", () => {
    const fence = z.string().parse(job("release", "identity").steps[0]?.run);
    expect(fence).toContain("activation is blocked before credentials load");
    expect(Bun.spawnSync(["bash", "-c", fence], { env: {} }).exitCode).not.toBe(0);
    expect(job("release", "infrastructure").needs).toBe("identity");
  });
  test("failed, skipped or configure-only staging cannot complete the release", () => {
    const script = z.string().parse(job("release", "complete").steps[0]?.run);
    const directory = mkdtempSync(join(scratch, "gate-"));
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\nprintf "%s\\n" "$COMMIT"\n');
    chmodSync(join(bin, "gh"), 0o755);
    const base = {
      // Some local shells export BASH_ENV; it must not replace this test's isolated gh stand-in.
      BASH_ENV: "/dev/null",
      PATH: `${bin}:/usr/bin:/bin`,
      GITHUB_REPOSITORY: "example/project",
      GITHUB_OUTPUT: join(directory, "output"),
      IDENTITY_RESULT: "success",
      INFRA_RESULT: "success",
      STAGING_RESULT: "success",
      INFRA_VERIFIED: "true",
      STAGING_ACCEPTED: "true",
      COMMIT: release.commit,
    };
    expect(
      Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], { env: base }).exitCode,
    ).toBe(0);
    for (const edit of [
      { STAGING_RESULT: "skipped" },
      { STAGING_RESULT: "failure" },
      { STAGING_ACCEPTED: "" },
      { STAGING_ACCEPTED: "configured" },
      { INFRA_VERIFIED: "" },
      { IDENTITY_RESULT: "skipped" },
    ])
      expect(
        Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", script], {
          env: { ...base, ...edit },
        }).exitCode,
      ).not.toBe(0);
  });
  test("acceptance is builtin-only, private, schema-read-only and checks a fresh encrypted backup", () => {
    const playbook = text("ops/ansible/accept.yml");
    const plays = z
      .array(z.object({ no_log: z.boolean().optional() }).passthrough())
      .parse(YAML.parse(playbook));
    expect(plays[0]?.no_log).toBe(true);
    expect(playbook).toContain("await d.schema()");
    expect(playbook).not.toContain("d.migrate");
    expect(playbook).toContain("s.writerLease");
    expect(playbook).toContain("s.discord");
    expect(playbook).toContain("seconds: 60");
    expect(playbook).toContain("accept_backup_before.rc != 3");
    expect(playbook).toContain("name: tarubot-backup.service");
    const modules = [...playbook.matchAll(/^\s+([a-z][a-z_.]+):\s*$/gmu)]
      .map((m) => m[1])
      .filter((name) => name?.includes("."));
    expect(modules.every((name) => name?.startsWith("ansible.builtin."))).toBe(true);
  });
  test("recovery boundary is persisted before installation/reload can run candidate migrations", () => {
    const bot = text("ops/ansible/bot.yml");
    expect(bot.indexOf("Stop the old writer before installing the candidate")).toBeLessThan(
      bot.indexOf("Install the checked unit"),
    );
    expect(bot.indexOf("Persist the boundary before a candidate migration can run")).toBeLessThan(
      bot.indexOf("Reload tarubot's user manager, which regenerates tarubot.service"),
    );
    expect(bot.indexOf("Keep it as the restore point")).toBeLessThan(
      bot.indexOf("Restart the bot"),
    );
    expect(text(".github/workflows/host.yml")).not.toContain("To roll back, run Deploy");
  });
});
