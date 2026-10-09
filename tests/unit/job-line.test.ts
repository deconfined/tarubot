/**
 * Background work as status replies show it (approved errors-and-style#28): every stored status
 * and last_error code maps to one marker; members get labels and plain words, never job IDs,
 * attempts or diagnostics; officers get the raw kind, short ID, attempt, next time and a bounded
 * quoted diagnostic; long lists end with '…and N more' and split across fields within limits.
 */
import { describe, expect, test } from "bun:test";
import type { EffectsMode, JobView, RosterEvidence } from "../../src/application/results.js";
import {
  effectsField,
  jobCode,
  jobFields,
  jobLabel,
  jobLine,
  jobLines,
  jobMarker,
  pausedSave,
  rosterEvidence,
  whenApplied,
} from "../../src/discord/presenters/jobs.js";
import { reply } from "../../src/discord/presenters/reply.js";
import { MARKER, type Marker } from "../../src/discord/presenters/style.js";
import { expectHouseStyle, stress } from "../fixtures/replies.js";
import { at, job, NOW, roster, VIEWERS } from "../fixtures/results.js";

/** Every stored job status (the jobs.status CHECK constraint). */
const STATUSES = ["queued", "running", "succeeded", "blocked", "disabled", "failed"] as const;
/** No error, the waiting codes, retryable codes and the terminal job-only codes. */
const CODES = [
  null,
  "ordered",
  "busy",
  "cooldown",
  "superseded",
  "lease_lost",
  "transient",
  "rate_limited",
  "dm_blocked",
  "invalid_job",
] as const;
// 2.17.0: Lodestone throttling waits too, instead of spending attempts.
const WAITING = new Set([
  "ordered",
  "busy",
  "cooldown",
  "superseded",
  "lease_lost",
  "rate_limited",
]);

/** The approved marker for a status and code, written out independently of jobMarker. */
function expectedMarker(status: (typeof STATUSES)[number], code: string | null): Marker {
  if (status === "succeeded") return "done";
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  if (status === "disabled") return "paused";
  if (status === "failed") return "failed";
  return code === null ? "queued" : "waiting";
}

/** A diagnostic message longer than the 150-character quote, with text only officers may see. */
const SECRET = "officer-only diagnostic detail ".repeat(8);

describe("job markers and lines", () => {
  for (const status of STATUSES)
    for (const code of CODES)
      test(`${status} with ${code ?? "no error"}`, () => {
        const row = job({
          status,
          attempts: 3,
          last_error: code === null ? null : `${code}: ${SECRET}`,
        });
        const expected = expectedMarker(status, code);
        const state = jobMarker(row);
        expect(state.marker).toBe(expected);
        if (expected === "waiting")
          expect(state.wait).toBe(code !== null && WAITING.has(code) ? "next" : "retrying");
        expect(state.dmBlocked === true).toBe(status === "failed" && code === "dm_blocked");

        const memberLine = jobLine(row, VIEWERS.member);
        // A succeeded role update reads as its approved completion phrase instead of the label.
        const words = status === "succeeded" ? "Roles and nickname updated" : "Role update";
        expect(memberLine).toStartWith(`\`${MARKER[expected]}\` ${words}`);
        // Members never see the job ID, attempts, the raw kind, the code or its diagnostic.
        expect(memberLine).not.toContain(row.id.slice(0, 8));
        expect(memberLine).not.toContain("attempt");
        expect(memberLine).not.toContain("reconcile.user");
        expect(memberLine).not.toContain("officer-only");
        if (code) expect(memberLine).not.toContain(`${code}:`);
        expect(memberLine).not.toContain("\n");
        // ✓ DONE, and completion words, belong to succeeded jobs only.
        expect(memberLine.includes(MARKER.done)).toBe(status === "succeeded");
        expect(/updated|posted|sent|secured|applied/u.test(memberLine)).toBe(
          status === "succeeded",
        );

        const officerLine = jobLine(row, VIEWERS.officer);
        expect(officerLine).toStartWith(`\`${MARKER[expected]}\` reconcile.user \`1a2b3c4d\``);
        expect(officerLine.includes(MARKER.done)).toBe(status === "succeeded");
        const [head, quoted, ...rest] = officerLine.split("\n");
        expect(rest).toEqual([]);
        if (expected === "waiting")
          expect(head).toContain(`attempt 3 · next <t:${NOW.getTime() / 1_000 + 420}:R>`);
        if (expected === "failed" || expected === "running") expect(head).toContain("attempt 3");
        if (code === null || status === "succeeded") expect(quoted).toBeUndefined();
        else {
          expect(quoted).toStartWith(`> ${code.replace("_", "\\_")}: officer-only`);
          // The quoted diagnostic is cut to 150 characters.
          expect((quoted ?? "").length - 2).toBeLessThanOrEqual(150);
          expect(quoted).toEndWith("…");
        }
      });

  test("the approved errors-and-style#28 member lines", () => {
    expect(
      jobLine(
        job({ status: "succeeded", completed_at: NOW, last_error: "cooldown: old" }),
        VIEWERS.member,
      ),
    ).toBe("`✓ DONE` Roles and nickname updated <t:1790169000:R>");
    expect(
      jobLine(
        job({
          kind: "ledger.notify",
          last_error: "transient: Discord timed out.",
          due_at: at(420),
        }),
        VIEWERS.member,
      ),
    ).toBe("`↻ WAITING` Ledger post (retrying <t:1790169420:R>)");
    expect(jobLine(job({ status: "blocked", last_error: "blocked: x" }), VIEWERS.member)).toBe(
      "`! BLOCKED` Role update: an officer needs to fix permissions",
    );
    expect(jobLine(job({ status: "disabled" }), VIEWERS.member)).toBe(
      "`‖ PAUSED` Role update: waiting for activation",
    );
    expect(
      jobLine(
        job({
          kind: "guest.dm",
          status: "failed",
          last_error: "dm_blocked: The recipient has disabled DMs.",
        }),
        VIEWERS.member,
      ),
    ).toBe("`✗ FAILED` Decision DM: your DMs are closed (the decision still stands)");
    expect(jobLine(job(), VIEWERS.member)).toBe("`… QUEUED` Role update");
  });

  test("the approved errors-and-style#28 officer lines show the raw kind", () => {
    expect(
      jobLine(
        job({
          id: "1a2b3c4d-0000-4000-8000-000000000000",
          attempts: 3,
          last_error: "cooldown: FC refresh cooldown.",
          due_at: at(420),
        }),
        VIEWERS.officer,
      ),
    ).toBe(
      "`↻ WAITING` reconcile.user `1a2b3c4d` · attempt 3 · next <t:1790169420:R>\n> cooldown: FC refresh cooldown.",
    );
    expect(
      jobLine(
        job({
          id: "5e6f7a8b-0000-4000-8000-000000000000",
          kind: "channels.access",
          status: "blocked",
          due_at: at(-1_000),
          last_error:
            "blocked: The bot needs View Channel, Manage Channels, and Manage Roles in channel 223456789012345678.",
        }),
        VIEWERS.manager,
      ),
    ).toBe(
      "`! BLOCKED` channels.access `5e6f7a8b` · <t:1790168000:R>\n> blocked: The bot needs View Channel, Manage Channels, and Manage Roles in channel <#223456789012345678>.",
    );
    // Approved #44's failed officer notice, as a marker line.
    expect(
      jobLine(
        job({
          id: "b2c3d4e5-0000-4000-8000-000000000000",
          kind: "officer.notify",
          status: "failed",
          attempts: 8,
          last_error: "transient",
        }),
        VIEWERS.officer,
      ),
    ).toBe("`✗ FAILED` officer.notify `b2c3d4e5` · attempt 8\n> transient");
  });

  test("skipped work reads – SKIPPED, with the dispatcher's reason for officers", () => {
    const skipped = job({
      kind: "roles.layout",
      status: "succeeded",
      completed_at: NOW,
      result: { skipped: "layout disabled" },
    });
    expect(jobMarker(skipped)).toEqual({ marker: "skipped", skipped: "layout disabled" });
    expect(jobLine(skipped, VIEWERS.member)).toBe("`– SKIPPED` Role layout: nothing to do");
    expect(jobLine(skipped, VIEWERS.officer)).toBe(
      "`– SKIPPED` roles.layout `1a2b3c4d` · <t:1790169000:R>\n> layout disabled",
    );
  });

  test("update posts (2.25.0) read as 'Update post' for members, raw for officers", () => {
    expect(jobLabel("changelog.post")).toBe("Update post");
    const post = (overrides: Parameters<typeof job>[0]) =>
      jobLine(job({ kind: "changelog.post", ...overrides }), VIEWERS.member);
    expect(post({ status: "succeeded", completed_at: NOW })).toBe(
      "`✓ DONE` Update posted <t:1790169000:R>",
    );
    // A range with no release notes moves the baseline without posting.
    expect(
      post({ status: "succeeded", completed_at: NOW, result: { skipped: "nothing for members" } }),
    ).toBe("`– SKIPPED` Update post: nothing to do");
    expect(post({ status: "blocked", last_error: "blocked: x" })).toBe(
      "`! BLOCKED` Update post: an officer needs to fix permissions",
    );
    expect(
      jobLine(
        job({
          kind: "changelog.post",
          status: "succeeded",
          completed_at: NOW,
          result: { skipped: "already announced" },
        }),
        VIEWERS.officer,
      ),
    ).toBe("`– SKIPPED` changelog.post `1a2b3c4d` · <t:1790169000:R>\n> already announced");
  });

  test("status posts (2.29.0) read as 'Status notice' for members, raw for officers", () => {
    expect(jobLabel("officer.status")).toBe("Status notice");
    const status = (overrides: Parameters<typeof job>[0]) =>
      jobLine(job({ kind: "officer.status", ...overrides }), VIEWERS.member);
    expect(status({ status: "succeeded", completed_at: NOW })).toBe(
      "`✓ DONE` Status notice posted <t:1790169000:R>",
    );
    // A window whose changes cancelled out, and a guild with no officer notifications channel.
    expect(
      status({ status: "succeeded", completed_at: NOW, result: { skipped: "nothing to post" } }),
    ).toBe("`– SKIPPED` Status notice: nothing to do");
    expect(
      jobLine(
        job({
          kind: "officer.status",
          status: "succeeded",
          completed_at: NOW,
          result: { skipped: "officer notifications unconfigured" },
        }),
        VIEWERS.officer,
      ),
    ).toBe(
      "`– SKIPPED` officer.status `1a2b3c4d` · <t:1790169000:R>\n> officer notifications unconfigured",
    );
  });

  test("paused work names the deployment switch when effects are off for the deployment", () => {
    expect(
      jobLine(job({ status: "disabled" }), VIEWERS.member, { effectsMode: "deployment_disabled" }),
    ).toBe("`‖ PAUSED` Role update: Discord changes are off for this deployment");
  });

  test("diagnostics stay inert: user syntax is escaped, only complete ID mentions render", () => {
    const line = jobLine(
      job({
        status: "blocked",
        last_error:
          "blocked: **Bold** <t:1790169000:R> [x](https://example.com) in <#223456789012345678>",
      }),
      VIEWERS.officer,
    );
    expect(line).toContain("\\*\\*Bold\\*\\*");
    expect(line).toContain("\\<t:1790169000:R>");
    expect(line).toContain("\\[x](https://example.com)");
    expect(line).toContain("in <#223456789012345678>");
  });

  test("labels fall back to the raw kind, and codes come from the last_error prefix", () => {
    expect(jobLabel("guest.review")).toBe("Guest review message");
    expect(jobLabel("reconcile.guild")).toBe("Server-wide role check");
    // Every kind the queue runs has a member label, including the character profile refresh.
    expect(jobLabel("profile")).toBe("Character profile refresh");
    expect(jobLabel("future.kind")).toBe("future.kind");
    expect(jobLabel("constructor")).toBe("constructor");
    expect(jobLine(job({ kind: "future.kind" }), VIEWERS.member)).toBe("`… QUEUED` future.kind");
    expect(jobLine(job({ kind: "future.kind", status: "succeeded" }), VIEWERS.member)).toBe(
      "`✓ DONE` future.kind finished",
    );
    expect(jobCode("cooldown: FC refresh cooldown.")).toBe("cooldown");
    expect(jobCode("transient")).toBe("transient");
    expect(jobCode(null)).toBeNull();
  });
});

describe("job lists", () => {
  /** 25 outstanding jobs, the most /sync status returns. */
  const rows: JobView[] = Array.from({ length: 25 }, (_, index) =>
    job({ id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` }),
  );

  test("25 rows render as 10 lines plus '…and 15 more' for both audiences", () => {
    for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
      const lines = jobLines(rows, viewer);
      expect(lines).toHaveLength(11);
      expect(lines.at(-1)).toBe("…and 15 more");
    }
    expect(jobLines(rows.slice(0, 3), VIEWERS.member)).toHaveLength(3);
  });

  test("maximal officer diagnostics split across fields that all fit one embed", () => {
    const fields = jobFields("Needs attention", stress.jobs(25), VIEWERS.officer);
    expect(fields.length).toBeGreaterThan(1);
    fields.forEach((field, index) => {
      expect(field.name).toBe(`Needs attention (${index + 1}/${fields.length})`);
      expect(field.value.length).toBeLessThanOrEqual(1_024);
    });
    const lines = fields
      .flatMap((field) => field.value.split("\n"))
      .filter((line) => !line.startsWith("> "));
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe("…and 15 more");
    expectHouseStyle(
      reply({
        tone: "warning",
        title: "Sync status · server",
        description: "**Recent runs**",
        fields,
        timestamp: NOW,
      }),
      { timestamp: true },
    );
  });
});

describe("effects and roster evidence", () => {
  test("live effects read … QUEUED; paused effects never do, and only officers see why", () => {
    expect(effectsField("live", "Role update", VIEWERS.member)).toEqual({
      name: "Discord changes",
      value: "`… QUEUED` Role update",
      inline: true,
    });
    expect(effectsField("awaiting_activation", "", VIEWERS.member).value).toBe(
      "`‖ PAUSED` until activation",
    );
    expect(effectsField("awaiting_activation", "Role update", VIEWERS.officer).value).toBe(
      "`‖ PAUSED` Role update until activation\nWhy: Server activation pending",
    );
    expect(effectsField("deployment_disabled", "", VIEWERS.member).value).toBe(
      "`‖ PAUSED` Discord changes are off for this deployment",
    );
    expect(
      effectsField("deployment_disabled", "Channel post", VIEWERS.manager, "Delivery"),
    ).toEqual({
      name: "Delivery",
      value:
        "`‖ PAUSED` Channel post: Discord changes are off for this deployment\nWhy: Disabled globally (ENABLE_EFFECTS)",
      inline: true,
    });
    for (const mode of ["awaiting_activation", "deployment_disabled"] as const)
      for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
        const value = effectsField(mode, "Role update", viewer).value;
        expect(value).not.toContain("QUEUED");
        expect(value).not.toContain("shortly");
      }
  });

  test("a paused save is the approved pending card; only officers see why it waits", () => {
    expect(pausedSave("awaiting_activation", VIEWERS.member)).toEqual({
      tone: "pending",
      title: "Saved, Discord changes paused",
      sentence:
        "TaruBot won't change roles, nicknames or channels in this server until activation finishes. It will apply this change automatically then.",
      fields: [
        { name: "Saved", value: "`• SAVED`", inline: true },
        { name: "Discord changes", value: "`‖ PAUSED` until activation", inline: true },
      ],
      footer: "Check progress any time with /sync status",
    });
    const deployment = pausedSave("deployment_disabled", VIEWERS.officer);
    expect(deployment.sentence).toContain("Discord changes are off for this deployment");
    expect(deployment.sentence).not.toContain("activation");
    expect(deployment.fields[1].value).toBe(
      "`‖ PAUSED` Discord changes are off for this deployment\nWhy: Disabled globally (ENABLE_EFFECTS)",
    );
    expect(
      ["live", "awaiting_activation", "deployment_disabled"].map((mode) =>
        whenApplied(mode as EffectsMode),
      ),
    ).toEqual([
      "shortly",
      "once this server is activated",
      "once Discord changes are turned back on",
    ]);
  });

  test("roster evidence is a Member role field, never a title", () => {
    expect(rosterEvidenceValue({ fcLinked: false })).toBeNull();
    expect(rosterEvidenceValue({ fresh: false, checkedAt: at(-3_180) })).toBe(
      "`↻ WAITING` for the next roster check (last one <t:1790165820:R>)",
    );
    expect(rosterEvidenceValue({ fresh: false, checkedAt: null })).toBe(
      "`↻ WAITING` for the first roster check",
    );
    expect(rosterEvidenceValue({})).toBe("`… QUEUED`");
    expect(rosterEvidenceValue({}, "awaiting_activation")).toBe("`‖ PAUSED` until activation");
    expect(rosterEvidenceValue({ listed: false })).toBe(
      "Doesn't apply: not in the FC roster checked <t:1790165820:R>",
    );
  });
});

/** The Member-role field's value for evidence overrides, or null when there is no field. */
function rosterEvidenceValue(
  overrides: Partial<RosterEvidence>,
  mode: EffectsMode = "live",
): string | null {
  const field = rosterEvidence(roster(overrides), mode);
  if (field) expect(field.name).toBe("Member role");
  return field?.value ?? null;
}
