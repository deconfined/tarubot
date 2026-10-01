/** Pending projections require native tickets or original final writer proof, never caller JSON. */
import { describe, expect, test } from "bun:test";
import { stateEvidence } from "../../scripts/infra-control.js";
import { nativeTargetFixture } from "../fixtures/infra/applied-target.js";

describe("native current-ticket target projection", () => {
  test("unfinished current Apply yields opaque pending data while ordinary inspect still refuses", async () => {
    const f = await nativeTargetFixture(),
      ticket = await f.begin();
    const candidates = await f.journal.finishTargetCandidates(
      ticket,
      f.prepare(),
      f.evidence("apply"),
    );
    expect(candidates).toHaveLength(1);
    expect(Object.keys(candidates[0] ?? {})).toEqual([]);
    expect(Object.isFrozen(candidates)).toBe(true);
    await expect(f.journal.inspect(stateEvidence(f.after.raw))).rejects.toThrow();
    f.status.current = true;
    expect((await f.journal.inspect(stateEvidence(f.after.raw))).inputs).toEqual(f.after.settings);
  });
  test("copied and serialized tickets cannot enter, and fence the attempt's preparation", async () => {
    for (const clone of [structuredClone, (v: unknown) => JSON.parse(JSON.stringify(v))]) {
      const f = await nativeTargetFixture(),
        ticket = await f.begin(),
        preparation = f.prepare();
      await expect(
        f.journal.finishTargetCandidates(clone(ticket), preparation, f.evidence("apply")),
      ).rejects.toThrow();
      await expect(
        f.journal.finishTargetCandidates(ticket, preparation, f.evidence("apply")),
      ).rejects.toThrow();
      // The failed preparation did not fabricate a journal-wide CAS or fence another attempt.
      await expect(
        f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
      ).rejects.toThrow();
    }
  });
  test("a different journal cannot consume the exact original begin object", async () => {
    const f = await nativeTargetFixture(),
      other = await nativeTargetFixture(),
      ticket = await f.begin();
    const preparation = other.prepare();
    await expect(
      other.journal.finishTargetCandidates(ticket, preparation, f.evidence("apply")),
    ).rejects.toThrow();
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).resolves.toHaveLength(1);
  });
  test("mutated native tickets and repeated finish attempts remain denied after restoration", async () => {
    const f = await nativeTargetFixture(),
      ticket = await f.begin(),
      binding = ticket.binding;
    ticket.binding = "d".repeat(64);
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).rejects.toThrow();
    ticket.binding = binding;
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).rejects.toThrow();
    const valid = await nativeTargetFixture(),
      original = await valid.begin();
    await valid.journal.finishTargetCandidates(original, valid.prepare(), valid.evidence("apply"));
    await expect(
      valid.journal.finishTargetCandidates(original, valid.prepare(), valid.evidence("apply")),
    ).rejects.toThrow();
  });
  test("legacy serialized finish stays compatible but never produces the new native projection", async () => {
    const f = await nativeTargetFixture(),
      ticket = await f.begin();
    await f.journal.finish(structuredClone(ticket), stateEvidence(f.after.raw));
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).rejects.toThrow();
    f.status.current = true;
    expect((await f.journal.inspect(stateEvidence(f.after.raw))).generation).toBe(
      ticket.generation,
    );
  });
  test("parallel calls and a caught legacy finish during projection fence all later offers", async () => {
    for (const legacy of [false, true]) {
      const f = await nativeTargetFixture(),
        ticket = await f.begin();
      const existing = new Map(f.objects);
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let once = true;
      f.hooks.read = async (_path, bytes) => {
        if (once) {
          once = false;
          reached();
          await gate;
        }
        return bytes;
      };
      const preparation = f.prepare();
      const first = f.journal.finishTargetCandidates(ticket, preparation, f.evidence("apply"));
      await entered;
      if (legacy)
        await expect(f.journal.finish(ticket, stateEvidence(f.after.raw))).rejects.toThrow();
      else
        await expect(
          f.journal.finishTargetCandidates(ticket, preparation, f.evidence("apply")),
        ).rejects.toThrow();
      release();
      await expect(first).rejects.toThrow();
      expect(f.objects).toEqual(existing);
    }
  });
  test("changed authenticated predecessor bytes deny even when the reopened plaintext is equal", async () => {
    const f = await nativeTargetFixture(),
      ticket = await f.begin();
    const path = `completed/${f.snapshot.generation}`,
      bytes = f.objects.get(path);
    if (!bytes) throw new Error("missing-invented-predecessor");
    f.objects.set(path, f.codec.seal(path, f.codec.open(path, bytes)));
    const existing = new Map(f.objects);
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).rejects.toThrow();
    expect(f.objects).toEqual(existing);
  });
  test("lost final acknowledgement or changed final readback grants no pending result or retry", async () => {
    for (const lost of [true, false]) {
      const f = await nativeTargetFixture(),
        ticket = await f.begin();
      if (lost)
        f.hooks.written = async (path, bytes) => {
          if (
            path === "current" &&
            (f.codec.open(path, bytes) as { pending: string | null }).pending === null
          )
            throw new Error("invented-private-lost-ack");
        };
      else
        f.hooks.read = async (path, bytes) => {
          if (path === `completed/${ticket.generation}` && bytes)
            return f.codec.seal(path, f.codec.open(path, bytes));
          return bytes;
        };
      await expect(
        f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
      ).rejects.toThrow();
      await expect(
        f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
      ).rejects.toThrow();
      await expect(f.journal.inspect(stateEvidence(f.after.raw))).rejects.toThrow();
    }
  });
  test("all requested target roles must derive; no partial capability escapes", async () => {
    const f = await nativeTargetFixture(),
      ticket = await f.begin();
    await expect(
      f.journal.finishTargetCandidates(
        ticket,
        f.prepare(undefined, ["staging", "production"]),
        f.evidence("apply"),
      ),
    ).rejects.toThrow();
    await expect(
      f.journal.finishTargetCandidates(ticket, f.prepare(), f.evidence("apply")),
    ).rejects.toThrow();
  });
  test("bounded raw pulls, applied show and advertised outputs must agree exactly", async () => {
    for (const kind of ["pull", "raw", "show", "output"] as const) {
      const f = await nativeTargetFixture(),
        ticket = await f.begin(),
        evidence = structuredClone(f.evidence("apply"));
      if (kind === "pull") evidence.state_reopened.serial++;
      if (kind === "raw") {
        const group = evidence.state_readback.resources[0];
        if (!group) throw new Error("missing-invented-host");
        const instance = (group.instances as { attributes: Record<string, unknown> }[])[0];
        if (!instance) throw new Error("missing-invented-instance");
        instance.attributes.metadata = [{ user_data: "invented-different-secret" }];
        evidence.state_reopened = structuredClone(evidence.state_readback);
      }
      if (kind === "show") {
        const host = evidence.applied_show.values.root_module.resources[0];
        if (!host) throw new Error("missing-invented-show-host");
        host.values.label = "invented-other-label";
      }
      if (kind === "output") {
        const output = evidence.plan.planned_values.outputs.hosts;
        if (!output) throw new Error("missing-invented-host-output");
        output.sensitive = true;
      }
      await expect(f.journal.finishTargetCandidates(ticket, f.prepare(), evidence)).rejects.toThrow(
        "invalid-target-candidate",
      );
    }
  });
});

describe("completed no-change target projection", () => {
  test("requires the actual original final writer and same private reopened bytes", async () => {
    const f = await nativeTargetFixture();
    f.status.historical = false;
    await expect(
      f.journal.inspectTargetCandidates(f.prepare(), {
        expected_snapshot: f.snapshot,
        ...f.evidence("no-changes"),
      }),
    ).rejects.toThrow();
    f.status.historical = true;
    const forged = { ...f.snapshot, generation: "33333333-3333-4333-8333-333333333333" };
    await expect(
      f.journal.inspectTargetCandidates(f.prepare(), {
        expected_snapshot: forged,
        ...f.evidence("no-changes"),
      }),
    ).rejects.toThrow();
    expect(
      await f.journal.inspectTargetCandidates(f.prepare(), {
        expected_snapshot: f.snapshot,
        ...f.evidence("no-changes"),
      }),
    ).toHaveLength(1);
  });
  test("slow evidence capture and frozen/backward clocks cannot renew the original window", async () => {
    const f = await nativeTargetFixture(),
      preparation = f.prepare(f.clock.now + 1000);
    const evidence = new Proxy(
      { ...f.evidence("no-changes"), expected_snapshot: f.snapshot },
      {
        ownKeys(target) {
          f.clock.now += 1000;
          return Reflect.ownKeys(target);
        },
      },
    );
    const existing = new Map(f.objects);
    await expect(f.journal.inspectTargetCandidates(preparation, evidence)).rejects.toThrow();
    expect(f.objects).toEqual(existing);
    f.clock.now--;
    await expect(
      f.journal.inspectTargetCandidates(preparation, {
        expected_snapshot: f.snapshot,
        ...f.evidence("no-changes"),
      }),
    ).rejects.toThrow();
  });
});
