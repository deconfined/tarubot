/** Real native projection caps, dedicated AEAD, private files and irreversible denial boundaries. */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { targetIssuancePins } from "../../scripts/target-issuance.js";
import { stateEvidence, type PendingTargetCandidate } from "../../scripts/infra-control.js";
import {
  openEncryptedTargetCandidate,
  prepareTargetCandidates,
  remainingTargetCandidatePreparation,
  sealPendingTargetCandidate,
  targetCandidateDeclaration,
  targetCandidateFileName,
  targetCandidatePreparation,
  type TargetCandidateContext,
} from "../../scripts/target-candidate.js";
import {
  candidateProducer,
  candidateRelease,
  nativeTargetFixture,
} from "../fixtures/infra/applied-target.js";

const scratch = mkdtempSync(join(tmpdir(), "private-candidate-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const passphrase = "invented-dedicated-candidate-passphrase-123456789";
function directory() {
  return mkdtempSync(join(scratch, "receipt-"));
}
async function pending(mode: "apply" | "no-changes" = "apply", expires?: number) {
  const f = await nativeTargetFixture();
  const ticket = mode === "apply" ? await f.begin() : null;
  const preparation = f.prepare(expires === undefined ? undefined : f.clock.now + expires);
  const caps = ticket
    ? await f.journal.finishTargetCandidates(ticket, preparation, f.evidence(mode))
    : await f.journal.inspectTargetCandidates(preparation, {
        expected_snapshot: f.snapshot,
        ...f.evidence(mode),
      });
  const candidate = caps[0];
  if (!candidate) throw new Error("missing-invented-candidate");
  const expected: TargetCandidateContext = {
    target: "staging",
    release: candidateRelease,
    producer: candidateProducer,
    mode,
  };
  const configuration = { directory: directory(), candidate_passphrase: passphrase };
  return {
    f,
    ticket,
    preparation,
    candidate,
    expected,
    configuration,
    file: join(configuration.directory, targetCandidateFileName("staging")),
  };
}
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("native pending candidate transport", () => {
  test("all selected roles can seal once under one shared original preparation", async () => {
    const f = await nativeTargetFixture(true),
      ticket = await f.begin(),
      preparation = f.prepare(undefined, ["staging", "production"]);
    const caps = await f.journal.finishTargetCandidates(ticket, preparation, f.evidence("apply"));
    const roles = targetCandidatePreparation(preparation).targets,
      path = directory();
    expect(caps).toHaveLength(2);
    for (const [index, cap] of caps.entries()) {
      const target = roles[index];
      if (!target) throw new Error("missing-invented-role");
      const candidate_passphrase = `${passphrase}-${target}`;
      await sealPendingTargetCandidate(cap, { directory: path, candidate_passphrase });
      const declaration = openEncryptedTargetCandidate({
        bytes: readFileSync(join(path, targetCandidateFileName(target))),
        candidate_passphrase,
        expected: { target, release: candidateRelease, producer: candidateProducer, mode: "apply" },
      });
      expect(declaration.envelope.descriptor.target).toBe(target);
    }
    expect(readdirSync(path).sort()).toEqual([
      "target-candidate-production.enc",
      "target-candidate-staging.enc",
    ]);
  });
  test("both modes persist only bounded ciphertext and preserve original release/writer/timestamps", async () => {
    for (const mode of ["apply", "no-changes"] as const) {
      const p = await pending(mode),
        original = targetCandidatePreparation(p.preparation);
      expect(await sealPendingTargetCandidate(p.candidate, p.configuration)).toBeUndefined();
      const bytes = readFileSync(p.file),
        declaration = openEncryptedTargetCandidate({
          bytes,
          candidate_passphrase: passphrase,
          expected: p.expected,
        });
      expect(declaration.mode).toBe(mode);
      expect(declaration.issued_at).toBe(original.issued_at);
      expect(declaration.expires_at).toBe(original.expires_at);
      expect(declaration.baseline_writer).toEqual({
        kind: mode === "apply" ? "apply" : "baseline",
        run: declaration.envelope.baseline.run,
      });
      expect(declaration.source_job_path).toBe(
        mode === "apply" ? targetIssuancePins.apply : targetIssuancePins.plan,
      );
      expect(statSync(p.file).mode & 0o777).toBe(0o600);
      expect(bytes.length).toBeLessThan(65_568);
      expect(bytes.toString()).not.toContain("staging.example.org");
      expect(bytes.toString()).not.toContain(declaration.envelope.baseline.state.digest);
      const json = JSON.stringify(declaration);
      for (const secret of [
        "invented-unchanged-hash",
        "invented-unchanged-data",
        "root_keys",
        "configure_keys",
        "resources",
        "variables",
        "jwt",
        "token",
      ])
        expect(json).not.toContain(secret);
      expect(Object.keys(declaration)).toEqual([
        "baseline_writer",
        "envelope",
        "expires_at",
        "issued_at",
        "mode",
        "producer",
        "purpose",
        "release",
        "schema",
        "source_job_path",
        "target",
      ]);
      expect(Object.isFrozen(declaration.envelope.descriptor)).toBe(true);
      // Decryption yields only a declaration; even exact bytes cannot recreate native authority.
      await expect(
        sealPendingTargetCandidate(declaration as unknown as PendingTargetCandidate, {
          ...p.configuration,
          directory: directory(),
        }),
      ).rejects.toThrow();
      await expect(
        sealPendingTargetCandidate(structuredClone(p.candidate), {
          ...p.configuration,
          directory: directory(),
        }),
      ).rejects.toThrow();
      await expect(sealPendingTargetCandidate(p.candidate, p.configuration)).rejects.toThrow();
    }
  });
  test("dedicated purpose/key and full target/release/producer/mode context prevent replay", async () => {
    const p = await pending();
    await sealPendingTargetCandidate(p.candidate, p.configuration);
    const bytes = readFileSync(p.file);
    for (const change of [
      {
        candidate_passphrase: "invented-unrelated-state-or-trust-key-1234567890",
        expected: p.expected,
      },
      {
        candidate_passphrase: passphrase,
        expected: { ...p.expected, target: "production" as const },
      },
      {
        candidate_passphrase: passphrase,
        expected: { ...p.expected, mode: "no-changes" as const },
      },
      {
        candidate_passphrase: passphrase,
        expected: {
          ...p.expected,
          release: { ...candidateRelease, digest: `sha256:${"a".repeat(64)}` },
        },
      },
      {
        candidate_passphrase: passphrase,
        expected: { ...p.expected, producer: { ...candidateProducer, run: "9999" } },
      },
    ])
      expect(() => openEncryptedTargetCandidate({ bytes, ...change })).toThrow(
        "invalid-target-candidate",
      );
    for (const index of [0, 4, bytes.length - 1]) {
      const changed = Uint8Array.from(bytes);
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(() =>
        openEncryptedTargetCandidate({
          bytes: changed,
          candidate_passphrase: passphrase,
          expected: p.expected,
        }),
      ).toThrow();
    }
    const original = openEncryptedTargetCandidate({
      bytes,
      candidate_passphrase: passphrase,
      expected: p.expected,
    });
    for (const changes of [
      { purpose: "tarubot-infra-control-v1" },
      { schema: 1 },
      { expires_at: original.issued_at + 86_400_001 },
      { issued_at: original.expires_at },
      { source_job_path: "invented/other-job" },
      { baseline_writer: { kind: "baseline", run: original.baseline_writer.run } },
      { extra: "invented" },
    ])
      expect(() => targetCandidateDeclaration({ ...original, ...changes }, p.expected)).toThrow();
    // Intrinsic byte copying ignores a hostile named length and iterator without executing either.
    const hostile = Uint8Array.from(bytes);
    Object.defineProperty(hostile, "length", {
      get() {
        throw new Error("named-length-called");
      },
    });
    Object.defineProperty(hostile, Symbol.iterator, {
      get() {
        throw new Error("iterator-called");
      },
    });
    expect(
      openEncryptedTargetCandidate({
        bytes: hostile,
        candidate_passphrase: passphrase,
        expected: p.expected,
      }),
    ).toEqual(original);
  });
  test("preparation cannot mint a cap and enforces exact producer, unique roles and original 24h maximum", () => {
    const at = 1_800_000_000_000,
      base = {
        targets: ["staging"] as const,
        release: candidateRelease,
        producer: candidateProducer,
      };
    const preparation = prepareTargetCandidates(base, { now: () => at });
    expect(Object.keys(preparation)).toEqual([]);
    expect(targetCandidatePreparation(preparation).expires_at).toBe(at + 86_400_000);
    for (const changes of [
      { targets: ["staging", "staging"] },
      { targets: [] },
      { expires_at: at },
      { expires_at: at + 86_400_001 },
      { producer: { ...candidateProducer, attempt: 2 } },
      { extra: true },
    ])
      expect(() =>
        prepareTargetCandidates(
          { ...base, ...changes } as Parameters<typeof prepareTargetCandidates>[0],
          { now: () => at },
        ),
      ).toThrow();
  });
  test("first clock and caller capture consume physical time even with a frozen wall clock", () => {
    const at = 1_800_000_000_000,
      base = {
        targets: ["staging"] as const,
        release: candidateRelease,
        producer: candidateProducer,
        expires_at: at + 10,
      };
    const busy = () => {
      const until = performance.now() + 25;
      while (performance.now() < until) {
        /* Original physical preparation includes this callback. */
      }
    };
    expect(() =>
      prepareTargetCandidates(base, {
        now: () => {
          busy();
          return at;
        },
      }),
    ).toThrow();
    const input = new Proxy(base, {
      ownKeys(target) {
        busy();
        return Reflect.ownKeys(target);
      },
    });
    expect(() => prepareTargetCandidates(input, { now: () => at })).toThrow();
  });
  test("remaining time shrinks under the original wall/physical window and cannot renew it", () => {
    let at = 1_800_000_000_000;
    const window = prepareTargetCandidates(
      { targets: ["staging"], release: candidateRelease, producer: candidateProducer },
      { now: () => at },
    );
    expect(remainingTargetCandidatePreparation(window)).toBeGreaterThan(0);
    expect(remainingTargetCandidatePreparation(window)).toBeLessThanOrEqual(60_000);
    at += 59_999;
    expect(remainingTargetCandidatePreparation(window)).toBeLessThanOrEqual(1);
    at++;
    expect(() => remainingTargetCandidatePreparation(window)).toThrow();
    at -= 60_000;
    expect(() => remainingTargetCandidatePreparation(window)).toThrow();
  });
  test("a frozen wall clock cannot extend a pending capability past its original physical expiry", async () => {
    const p = await pending("apply", 150);
    await pause(170);
    await expect(sealPendingTargetCandidate(p.candidate, p.configuration)).rejects.toThrow();
    expect(existsSync(p.file)).toBe(false);
  });
  test("pending candidate guards detect ticket, predecessor and final ciphertext changes before file offers", async () => {
    for (const which of ["ticket", "predecessor", "final"] as const) {
      const p = await pending();
      if (which === "ticket") {
        if (!p.ticket) throw new Error("missing-invented-ticket");
        p.ticket.binding = "d".repeat(64);
      } else {
        const path = which === "predecessor" ? `completed/${p.f.snapshot.generation}` : "current";
        const value = p.f.objects.get(path);
        if (!value) throw new Error("missing-invented-history");
        p.f.objects.set(path, p.f.codec.seal(path, p.f.codec.open(path, value)));
      }
      await expect(sealPendingTargetCandidate(p.candidate, p.configuration)).rejects.toThrow();
      expect(existsSync(p.file)).toBe(false);
    }
  });
  test("no-change encryption/local persistence retains the same original proof rather than refreshing it", async () => {
    const p = await pending("no-changes");
    await expect(
      sealPendingTargetCandidate(p.candidate, p.configuration, {
        afterPersist() {
          p.f.clock.now += 30_000;
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(p.file)).toBe(true);
    await expect(
      sealPendingTargetCandidate(p.candidate, { ...p.configuration, directory: directory() }),
    ).rejects.toThrow();
    const changed = await pending("no-changes"),
      path = `completed/${changed.f.snapshot.generation}`;
    const value = changed.f.objects.get(path);
    if (!value) throw new Error("missing-invented-history");
    changed.f.objects.set(path, changed.f.codec.seal(path, changed.f.codec.open(path, value)));
    await expect(
      sealPendingTargetCandidate(changed.candidate, changed.configuration),
    ).rejects.toThrow();
    expect(existsSync(changed.file)).toBe(false);
  });
  test("a matching legacy finish attempt permanently denies an already projected candidate", async () => {
    const p = await pending();
    if (!p.ticket) throw new Error("missing-invented-ticket");
    await expect(
      p.f.journal.finish(structuredClone(p.ticket), stateEvidence(p.f.after.raw)),
    ).rejects.toThrow();
    await expect(sealPendingTargetCandidate(p.candidate, p.configuration)).rejects.toThrow();
    expect(existsSync(p.file)).toBe(false);
  });
  test("caught nested sealing from caller capture or clock permanently denies the outer offer", async () => {
    for (const clock of [false, true]) {
      const p = await pending();
      let nested: Promise<void> | undefined;
      const reenter = () => {
        nested ??= sealPendingTargetCandidate(p.candidate, p.configuration).catch(() => {});
      };
      let configuration = p.configuration;
      if (clock)
        Object.defineProperty(p.f.clock, "now", {
          get() {
            reenter();
            return 1_800_000_000_000;
          },
        });
      else
        configuration = new Proxy(configuration, {
          ownKeys(target) {
            reenter();
            return Reflect.ownKeys(target);
          },
        });
      await expect(sealPendingTargetCandidate(p.candidate, configuration)).rejects.toThrow();
      await nested;
      expect(existsSync(p.file)).toBe(false);
    }
  });
  test("lost or unresolved final local acknowledgement leaves only ciphertext and forbids retry", async () => {
    for (const unresolved of [false, true]) {
      const p = await pending("apply", unresolved ? 500 : undefined);
      const work = unresolved
        ? () => new Promise<void>(() => {})
        : () => {
            throw new Error("invented-private-unknown-write-ack");
          };
      await expect(
        sealPendingTargetCandidate(p.candidate, p.configuration, { afterPersist: work }),
      ).rejects.toThrow("invalid-target-candidate");
      expect(existsSync(p.file)).toBe(true);
      expect(readFileSync(p.file).toString()).not.toContain("invented-private-unknown-write-ack");
      const before = readFileSync(p.file);
      await expect(sealPendingTargetCandidate(p.candidate, p.configuration)).rejects.toThrow();
      expect(readFileSync(p.file)).toEqual(before);
    }
  });
  test("existing files, public directories, symlink routes and substituted persisted bytes deny", async () => {
    for (const kind of ["exists", "permissions", "symlink", "replace"] as const) {
      const p = await pending();
      if (kind === "exists") writeFileSync(p.file, "invented-existing-evidence", { mode: 0o600 });
      if (kind === "permissions") chmodSync(p.configuration.directory, 0o755);
      if (kind === "symlink") {
        const route = join(directory(), "alias");
        symlinkSync(p.configuration.directory, route);
        p.configuration.directory = route;
      }
      await expect(
        sealPendingTargetCandidate(p.candidate, p.configuration, {
          afterPersist() {
            if (kind === "replace")
              writeFileSync(p.file, "invented-replaced-private-ciphertext", { mode: 0o600 });
          },
        }),
      ).rejects.toThrow();
      if (kind === "exists")
        expect(readFileSync(p.file, "utf8")).toBe("invented-existing-evidence");
      if (kind === "permissions" || kind === "symlink")
        expect(readdirSync(p.configuration.directory)).toEqual([]);
    }
    // A private directory must already exist; the sealing boundary creates no route itself.
    const p = await pending(),
      missing = join(directory(), "missing");
    await expect(
      sealPendingTargetCandidate(p.candidate, { ...p.configuration, directory: missing }),
    ).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
