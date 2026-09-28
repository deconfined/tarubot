/**
 * Cross-catalog consistency over every reply the bot sends: one title and tone per (concept,
 * audience) however a concept is reached, the approved titles pinned per concept, the C4 tone
 * table, the UX-02 status-marker rules (✓ DONE only for succeeded jobs; paused views never promise
 * queued Discord work), the banned catch-all titles, the ' · ' separator and footer vocabulary,
 * where the health-check tokens may appear, and one pin for each of the 27 inconsistencies the
 * reply specs recorded and 2.14.0 resolved. docs/REPLIES.md describes the same rules in prose.
 */
import { describe, expect, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import { audienceOf, type Audience } from "../../src/discord/presenters/audience.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import { applicationsClosedReply } from "../../src/discord/presenters/guests.js";
import { jobLine } from "../../src/discord/presenters/jobs.js";
import type { Tone } from "../../src/discord/presenters/style.js";
import { userId } from "../../src/discord/selectors.js";
import { Failure, note } from "../../src/domain/values.js";
import { buttonsOf, onlyEmbed, visibleText } from "../fixtures/replies.js";
import { FAILURE_SOURCES } from "../fixtures/replies/failures.js";
import { CATALOGS, type ReplyCase } from "../fixtures/replies/index.js";
import { ACTORS, CHARACTER, GUEST_ID, job, NOW, REF, VIEWERS } from "../fixtures/results.js";

/** Every case of every catalog, with its catalog and kind for failure messages. */
const CASES: readonly (ReplyCase & { readonly key: string })[] = Object.entries(CATALOGS).flatMap(
  ([group, catalog]) =>
    Object.entries<ReplyCase>(catalog).map(([kind, reply]) => ({
      ...reply,
      key: `${group}/${kind}`,
    })),
);

/** An approved title and tone per audience group: members (and no viewer) or officers. */
interface Pin {
  readonly member: readonly [Tone, string];
  readonly officer?: readonly [Tone, string];
}

/**
 * The approved presentation of each failure concept (errors-and-style board and the resolved
 * inconsistencies). Officers and managers share the officer pin; replies before the actor is
 * known share the member pin.
 */
const FAILURE_PINS: Readonly<Record<string, Pin>> = {
  input: { member: ["warning", "Check your input"] },
  "forbidden.officer": { member: ["error", "Officers only"] },
  "forbidden.owner": { member: ["error", "Only your own records"] },
  "forbidden.manager": { member: ["error", "Server managers only"] },
  "forbidden.administrator": { member: ["error", "Administrator or server owner only"] },
  "forbidden.membership": { member: ["warning", "FC membership needed"] },
  "forbidden.context": { member: ["error", "Not available here"] },
  "setup.guild": {
    member: ["info", "TaruBot isn't set up here yet"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.fc": {
    member: ["info", "No Free Company linked"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.ledger": {
    member: ["info", "Ledger isn't set up"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.guest_applications": { member: ["info", "Guest applications are closed"] },
  "not_found.character": { member: ["warning", "Character not found"] },
  "not_found.freecompany": { member: ["warning", "Free Company not found"] },
  "ambiguous.character": { member: ["warning", "Several characters match"] },
  ownership_conflict: { member: ["error", "Linked to another member"] },
  insufficient_funds: { member: ["warning", "Not enough recorded gil"] },
  initialized: { member: ["warning", "Opening balance already set"] },
  uninitialized: { member: ["warning", "Opening balance not set"] },
  "stale.settings": { member: ["warning", "Settings changed — try again"] },
  "stale.control": { member: ["warning", "This control is out of date"] },
  "stale.form": { member: ["warning", "Please reopen /apply"] },
  // Guest failures: an obsolete review message, a missing application and the
  // reapply cooldown keep one presentation from the command, the buttons and the form.
  "stale.review": { member: ["warning", "This review message is out of date"] },
  "not_found.application": { member: ["warning", "Application not found"] },
  "wait.apply": { member: ["pending", "You can apply again later"] },
  pending_proof: { member: ["pending", "Token not on the Lodestone yet"] },
  "wait.claims_own": { member: ["pending", "Too many unfinished claims"] },
  "wait.retry": { member: ["pending", "Please wait a moment"] },
  eligible: { member: ["info", "No application needed"] },
  "upstream.lodestone": { member: ["warning", "The Lodestone isn't responding"] },
  blocked: {
    member: ["warning", "Server setup issue"],
    officer: ["warning", "Discord permissions need attention"],
  },
  // C4 tone table: a paused refusal is pending like every paused state. The rows for change
  // results, the officer sync overview and no-op results are pinned below.
  paused: { member: ["pending", "Discord changes paused"] },
  unexpected: { member: ["error", "Something went wrong"] },
};

/**
 * The C4 tone table's rows for results:
 * - a change saved while Discord effects are paused is the approved errors-and-style#26 card in
 *   every group;
 * - the officer sync overview is pending while work is in progress, even with a failed job
 *   (approved guests#44), warning only when focused on blocked or failed work with nothing in
 *   progress (#45), and pending when only paused work remains (#46).
 */
const RESULT_PINS: Readonly<Record<string, readonly [Tone, string]>> = {
  paused_save: ["pending", "Saved, Discord changes paused"],
  sync_overview_active: ["pending", "Sync status · server"],
  sync_overview_focused: ["warning", "Sync status · server"],
  sync_overview_paused: ["pending", "Sync status · server"],
};

/** No-op results are info (C4), except these approved neutral cards. */
const NEUTRAL_NO_OPS: ReadonlySet<string> = new Set([
  "No correction needed",
  "Nickname sync already off",
]);

/** Officers and managers read the officer pin; members and pre-actor replies the member pin. */
const officerAudience = (reply: ReplyCase): boolean =>
  reply.audience === "officer" || reply.audience === "manager";

describe("one presentation per concept", () => {
  test("each (concept, audience) has one title and one tone across every command", () => {
    const seen = new Map<string, { title: string; tone: Tone; key: string }>();
    for (const reply of CASES) {
      if (!reply.concept) continue;
      const id = `${reply.concept} · ${reply.audience}`;
      const first = seen.get(id);
      if (!first) seen.set(id, { title: reply.title, tone: reply.tone, key: reply.key });
      else
        expect({ id, title: reply.title, tone: reply.tone }).toEqual({
          id,
          title: first.title,
          tone: first.tone,
        });
    }
  });

  test("the approved failure concepts keep their pinned titles and tones", () => {
    for (const reply of CASES) {
      const pin = reply.concept ? FAILURE_PINS[reply.concept] : undefined;
      if (!pin) continue;
      const [tone, title] = officerAudience(reply) ? (pin.officer ?? pin.member) : pin.member;
      const embed = onlyEmbed(reply.render());
      expect({ key: reply.key, title: embed.title, tone: reply.tone }).toEqual({
        key: reply.key,
        title,
        tone,
      });
    }
  });

  test("'Discord permissions need attention' is only the officer view of code blocked", () => {
    for (const reply of CASES) {
      const embed = onlyEmbed(reply.render());
      if (embed.title !== "Discord permissions need attention") continue;
      expect({ key: reply.key, officer: officerAudience(reply) }).toEqual({
        key: reply.key,
        officer: true,
      });
      expect(embed.footer?.text).toStartWith("Code blocked · ");
    }
  });

  test("change results keep the C4 tone table's pinned title and tone", () => {
    for (const reply of CASES) {
      const pin = reply.concept ? RESULT_PINS[reply.concept] : undefined;
      if (!pin) continue;
      const embed = onlyEmbed(reply.render());
      expect({ key: reply.key, title: embed.title, tone: reply.tone }).toEqual({
        key: reply.key,
        title: pin[1],
        tone: pin[0],
      });
    }
    // Every pinned row is exercised by at least one catalog case.
    const concepts = new Set(CASES.map((reply) => reply.concept));
    for (const concept of Object.keys(RESULT_PINS)) expect(concepts).toContain(concept);
  });

  test("no-op results are info, except the approved neutral cards", () => {
    const noOps = CASES.filter((reply) => reply.noOp);
    expect(noOps.length).toBeGreaterThan(0);
    for (const reply of noOps)
      expect({ key: reply.key, tone: reply.tone }).toEqual({
        key: reply.key,
        tone: NEUTRAL_NO_OPS.has(reply.title) ? "neutral" : "info",
      });
  });

  test("every pinned failure concept is present in the catalogs", () => {
    const concepts = new Set(CASES.map((reply) => reply.concept));
    for (const concept of Object.keys(FAILURE_PINS)) expect(concepts).toContain(concept);
  });
});

describe("titles and footers", () => {
  test("titles are sentence-like, use ' · ' between sections and never ': '", () => {
    for (const reply of CASES) {
      const title = onlyEmbed(reply.render()).title ?? "";
      expect({ key: reply.key, colon: title.includes(": "), period: /\.$/u.test(title) }).toEqual({
        key: reply.key,
        colon: false,
        period: false,
      });
      expect(title.length).toBeLessThanOrEqual(60);
    }
  });

  test("failure footers are exactly 'Code <code> · Ref <interaction ID>'", () => {
    for (const reply of CASES) {
      const footer = onlyEmbed(reply.render()).footer?.text ?? "";
      expect(footer).not.toMatch(/\b(?:Operation|Reference)\b/u);
      if (reply.key.startsWith("failures/"))
        expect(footer).toMatch(/^Code [a-z_]+ · Ref \d{17,20}$/u);
    }
  });

  test("health-check tokens appear only in health checklists and approved /setup access", () => {
    // [OK] [WARN] [FAIL] [OFF] [WAIT] belong to /config validate (configuration#7–#9); status views
    // use the job markers. The one exception is /setup's approved Channel access line (#37).
    const allowed = (key: string): boolean =>
      key.startsWith("configuration/validate.") ||
      /^configuration\/setup\.(?:created|reused)$/u.test(key);
    for (const reply of CASES) {
      const text = JSON.stringify(onlyEmbed(reply.render()));
      expect({ key: reply.key, tokens: /\[(?:OK|WARN|FAIL|OFF|WAIT)\]/u.test(text) }).toEqual({
        key: reply.key,
        tokens: allowed(reply.key),
      });
    }
  });

  test("success replies never say nothing changed, except read-only health checks", () => {
    for (const reply of CASES) {
      // C2: the sentence comes from each concept's approved copy. /config validate and Re-check
      // are read-only, so their cards say it on every verdict; change receipts never do.
      if (reply.tone !== "success" || reply.readOnly) continue;
      expect({
        key: reply.key,
        said: onlyEmbed(reply.render()).description?.includes("Nothing was changed.") ?? false,
      }).toEqual({
        key: reply.key,
        said: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Shared lookups for the pins below

/** Catalog cases by their 'group/kind' key. */
const BY_KEY: ReadonlyMap<string, ReplyCase & { readonly key: string }> = new Map(
  CASES.map((reply) => [reply.key, reply]),
);

/** The catalog case under `key`; a renamed kind fails loudly instead of skipping its pin. */
function caseOf(key: string): ReplyCase & { readonly key: string } {
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`No catalog case ${key}`);
  return found;
}

/** The one embed a catalog case renders. */
const embedOf = (key: string): APIEmbed => onlyEmbed(caseOf(key).render());

/** Everything a reader sees in a catalog case: content, embed text, button labels, file names. */
const textOf = (key: string): string => visibleText(caseOf(key).render());

/** The cases whose key matches a pattern, which must match at least one. */
function casesMatching(pattern: RegExp): (ReplyCase & { readonly key: string })[] {
  const found = CASES.filter((reply) => pattern.test(reply.key));
  if (!found.length) throw new Error(`No catalog case matches ${pattern}`);
  return found;
}

/** Re-render a failure case's own error for another audience or interaction scope. */
function failureAs(kind: string, audience: Audience | "any", scope?: string): APIEmbed {
  const reply = CATALOGS.failures?.[kind];
  const source = reply && FAILURE_SOURCES.get(reply);
  if (!source) throw new Error(`No failure case ${kind}`);
  return onlyEmbed(
    failureReply(source.error, {
      ref: REF,
      viewer: audience === "any" ? undefined : VIEWERS[audience],
      scope: scope ?? source.scope,
      now: NOW,
    }),
  );
}

/** Render a Failure as the router would for `audience` in `scope`. */
const render = (error: unknown, audience: Audience | "any", scope?: string): APIEmbed =>
  onlyEmbed(
    failureReply(error, {
      ref: REF,
      viewer: audience === "any" ? undefined : VIEWERS[audience],
      scope,
      now: NOW,
    }),
  );

/** The field called `name`, if the embed has one. */
const fieldOf = (embed: APIEmbed, name: string) =>
  embed.fields?.find((field) => field.name === name);

/** The error a throwing call raised. */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

// ---------------------------------------------------------------------------------------------
// UX-02: saved versus delivered

describe("status markers", () => {
  test("✓ DONE marks only a succeeded job, for every stored status and audience", () => {
    const statuses = ["queued", "running", "succeeded", "failed", "blocked", "disabled"];
    const errors = [null, "cooldown: FC refresh cooldown.", "transient: Discord timed out."];
    const results = [null, { skipped: "layout disabled" }];
    for (const status of statuses)
      for (const last_error of errors)
        for (const result of results)
          for (const audience of ["member", "officer"] as const) {
            const line = jobLine(job({ status, last_error, result }), VIEWERS[audience]);
            const succeeded = status === "succeeded" && result === null;
            expect({ status, last_error, result, audience, done: line.includes("✓ DONE") }).toEqual(
              { status, last_error, result, audience, done: succeeded },
            );
          }
  });

  test("✓ DONE appears only in views that read stored jobs back, never in a change receipt", () => {
    // Completion words wait for a succeeded job read back by a status view (approved rule:
    // 'Discord work reads … QUEUED until it has actually happened; roles are never promised').
    const readBack = /^(?:guests\/status|sync\/(?:status|run)|ledger\/(?:balance|history))\./u;
    for (const reply of CASES)
      if (textOf(reply.key).includes("✓ DONE"))
        expect({ key: reply.key, readBack: readBack.test(reply.key) }).toEqual({
          key: reply.key,
          readBack: true,
        });
  });

  test("paused views never promise queued Discord work or say 'shortly'", () => {
    const paused = CASES.filter(
      (reply) =>
        reply.concept === "paused_save" ||
        reply.concept === "paused" ||
        textOf(reply.key).includes("‖ PAUSED"),
    );
    expect(paused.length).toBeGreaterThan(10);
    for (const reply of paused) {
      const text = textOf(reply.key);
      expect({ key: reply.key, shortly: /\bshortly\b/iu.test(text) }).toEqual({
        key: reply.key,
        shortly: false,
      });
      // The Lodestone roster read is not a Discord change, so it still runs (and can be queued)
      // while Discord changes are paused; nothing else may read as queued.
      for (const line of text.split("\n").filter((part) => part.includes("… QUEUED")))
        expect({ key: reply.key, line, lodestone: line.includes("Lodestone") }).toEqual({
          key: reply.key,
          line,
          lodestone: true,
        });
    }
  });

  test("every paused-save card carries the approved errors-and-style#26 footer", () => {
    // One approved card, one footer, whichever command saved the change (O2).
    const saves = CASES.filter((reply) => reply.concept === "paused_save");
    expect(saves.length).toBeGreaterThan(10);
    for (const reply of saves)
      expect({ key: reply.key, footer: onlyEmbed(reply.render()).footer?.text }).toEqual({
        key: reply.key,
        footer: "Check progress any time with /sync status",
      });
  });

  test("paused-save cards carry the drawn #26 sentence and no buttons, with the documented exceptions", () => {
    // REPLIES.md's errors-and-style#26 deviation row: a ledger receipt says when its post goes
    // out and the /apply receipt when officers see the application (their held work is no role,
    // nickname or channel change), and /setup keeps its approved Check sync status button
    // (configuration#37).
    const ownSentence = new Set(["ledger/receipt.paused", "guests/apply.held"]);
    const drawn = /TaruBot won't change roles, nicknames or channels/u;
    const saves = CASES.filter((reply) => reply.concept === "paused_save");
    for (const reply of saves) {
      const presented = reply.render();
      expect({
        key: reply.key,
        drawn: drawn.test(onlyEmbed(presented).description ?? ""),
        buttons: buttonsOf(presented).length > 0,
      }).toEqual({
        key: reply.key,
        drawn: !ownSentence.has(reply.key),
        buttons: reply.key === "configuration/setup.paused",
      });
    }
    // Each exception is still a catalogued paused save, so the list can't go stale silently.
    for (const key of [...ownSentence, "configuration/setup.paused"])
      expect(caseOf(key).concept).toBe("paused_save");
  });

  test("a paused view is pending unless something is also blocked or failed (C4)", () => {
    for (const reply of CASES) {
      const text = textOf(reply.key);
      if (!text.includes("‖ PAUSED") || /! BLOCKED|✗ FAILED/u.test(text)) continue;
      expect({ key: reply.key, tone: reply.tone }).toEqual({ key: reply.key, tone: "pending" });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Member privacy and times

/** A canonical UUID anywhere in visible text. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

describe("member privacy and times", () => {
  test("no reply shows an ISO time; times are Discord timestamps", () => {
    for (const reply of CASES)
      expect({
        key: reply.key,
        iso: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(textOf(reply.key)),
      }).toEqual({
        key: reply.key,
        iso: false,
      });
  });

  test("member views show a UUID only where the member needs it as input or a reference", () => {
    // Allowed: the 'Run', 'Application' or 'Entry' footer part, and the run_id a follow-up
    // /sync status needs (approved guests#36). Job and entry IDs otherwise stay officer-only.
    const allowed = new RegExp(`(?:\\b(?:Run|Application|Entry) |run_id:)${UUID.source}`, "giu");
    for (const reply of CASES) {
      if (reply.audience !== "member" && reply.audience !== "any") continue;
      const leftover = textOf(reply.key).replace(allowed, "").match(UUID) ?? [];
      expect({ key: reply.key, leftover }).toEqual({ key: reply.key, leftover: [] });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Titles that the resolutions retired

/**
 * Catch-all and superseded titles that must never come back: the per-feature catch-alls the
 * single failure catalog replaced (inconsistency 16), the spec titles the resolutions renamed, and
 * the pre-2.14.0 stale-roster notice (inconsistency 20).
 */
const BANNED_TITLES: ReadonlySet<string> = new Set([
  "Can't show guest access",
  "Couldn't change guest access",
  "Couldn't decide the application",
  "Can't refresh yet",
  "Character verified",
  "Character already linked",
  "Token not visible yet",
  "Settings changed, please try again",
  "Challenge expired",
  "Too many open challenges",
  "Several roles or channels match",
  "No Officer role",
  "Ledger not configured",
  "The FC ledger isn't set up yet",
]);

describe("retired titles", () => {
  test("no reply uses a banned catch-all or superseded title", () => {
    for (const reply of CASES) {
      const title = onlyEmbed(reply.render()).title ?? "";
      expect({ key: reply.key, banned: BANNED_TITLES.has(title) }).toEqual({
        key: reply.key,
        banned: false,
      });
    }
  });

  test("'Something went wrong' is only the unexpected concept", () => {
    for (const reply of CASES)
      if (onlyEmbed(reply.render()).title === "Something went wrong")
        expect({ key: reply.key, concept: reply.concept }).toEqual({
          key: reply.key,
          concept: "unexpected",
        });
  });
});

// ---------------------------------------------------------------------------------------------
// The 27 inconsistencies recorded in the reply specs, each pinned to its resolution

describe("resolved inconsistencies", () => {
  test("1. an ownership conflict is one error card; only officers on /assign see the owner (O3)", () => {
    const conflicts = casesMatching(/^failures\/ownership · /u);
    for (const reply of conflicts) {
      const embed = onlyEmbed(reply.render());
      expect(embed.title).toBe("Linked to another member");
      expect(reply.tone).toBe("error");
      expect(embed.footer?.text).toStartWith("Code ownership_conflict · ");
      // Only an officer on /assign sees who owns the character, the "Linked to" field and the
      // /unassign next step; members, and officers on their own /claim or /verify, never do.
      const assigning = reply.key === "failures/ownership · /assign · officer";
      const text = textOf(reply.key);
      expect({ key: reply.key, owner: text.includes(GUEST_ID) }).toEqual({
        key: reply.key,
        owner: assigning,
      });
      expect({ key: reply.key, unassign: text.includes("/unassign") }).toEqual({
        key: reply.key,
        unassign: assigning,
      });
      expect({ key: reply.key, linkedTo: fieldOf(embed, "Linked to") !== undefined }).toEqual({
        key: reply.key,
        linkedTo: assigning,
      });
    }
    expect(conflicts.map((reply) => reply.key)).toContain("failures/ownership · /claim · officer");
    const officer = embedOf("failures/ownership · /assign · officer");
    expect(fieldOf(officer, "Linked to")?.value).toBe(`<@${GUEST_ID}> (\`${GUEST_ID}\`)`);
    expect(officer.description).toContain("/unassign");
  });

  test("2. every Lodestone outage reads the same; a bad FC ID or URL is input", () => {
    for (const reply of casesMatching(/^failures\/lodestone unavailable · /u))
      expect(onlyEmbed(reply.render()).title).toBe("The Lodestone isn't responding");
    const badId = new Failure("input", "Use a Free Company ID or Lodestone link.", 0, {
      kind: "option",
      option: "fc_id",
    });
    // /setup onboarding (2.35.0) takes the same fc_id option as the pre-split /setup.
    for (const scope of ["/config fc link", "/setup onboarding"])
      expect(render(badId, "officer", scope).title).toBe("Check your input");
  });

  test("3. Lodestone not_found names its resource", () => {
    expect(embedOf("failures/not_found freecompany · /config fc link · officer").title).toBe(
      "Free Company not found",
    );
    expect(embedOf("failures/not_found character search · /claim · any").title).toBe(
      "Character not found",
    );
  });

  test("4. an ambiguous character search lists up to 10 IDs, then '…and N more'", () => {
    const ids = Array.from({ length: 12 }, (_, index) => String(99_000_001 + index));
    const embed = render(
      new Failure("ambiguous", "12 characters with that name were found.", 0, {
        kind: "matches",
        resource: "character",
        name: CHARACTER.name,
        world: CHARACTER.world,
        ids,
      }),
      "member",
      "/claim",
    );
    expect(embed.title).toBe("Several characters match");
    expect(embed.footer?.text).toStartWith("Code ambiguous · ");
    const text = JSON.stringify(embed);
    for (const shown of ids.slice(0, 10)) expect(text).toContain(`\`${shown}\``);
    expect(text).not.toContain(ids[10] ?? "");
    expect(text).toContain("…and 2 more");
  });

  test("5. a token not yet visible is one pending state with the checklist and Check again", () => {
    for (const reply of casesMatching(/^failures\/pending proof · /u)) {
      const presented = reply.render();
      const embed = onlyEmbed(presented);
      expect([reply.tone, embed.title]).toEqual(["pending", "Token not on the Lodestone yet"]);
      expect(embed.footer?.text).toStartWith("Code pending_proof · ");
      expect(embed.description).toContain("only the newest token works");
      expect(visibleText(presented)).toContain("Check again");
    }
  });

  test("6. every time-bound refusal is pending with a relative Try again", () => {
    const retry = /<t:\d+:R>/u;
    for (const code of ["cooldown", "rate_limited", "busy", "transient", "stopping"] as const) {
      const embed = render(new Failure(code, "Please wait.", 60), "member", "/claim");
      expect({ code, title: embed.title, color: embed.color }).toEqual({
        code,
        title: "Please wait a moment",
        color: 0xfee75c,
      });
      expect(fieldOf(embed, "Try again")?.value).toMatch(retry);
    }
    // Contention and shutdown throw without a deadline (retryAfter 0), so they say "shortly",
    // as REPLIES.md documents, rather than inventing a time.
    for (const code of ["busy", "stopping", "transient"] as const)
      expect(
        fieldOf(render(new Failure(code, "Please wait."), "member", "/claim"), "Try again")?.value,
      ).toBe("shortly");
    for (const kind of [
      "claims limit · /claim · member",
      "apply cooldown · form submit · member",
      "global claim limit · /claim · member",
    ]) {
      expect(caseOf(`failures/${kind}`).tone).toBe("pending");
      expect(fieldOf(embedOf(`failures/${kind}`), "Try again")?.value).toMatch(retry);
    }
  });

  test("7. an unconfigured feature is member info or officer 'Finish setup first'", () => {
    for (const reply of casesMatching(/^failures\/setup (?:guild|fc|ledger|officer_role) · /u)) {
      const embed = onlyEmbed(reply.render());
      if (officerAudience(reply))
        expect([reply.tone, embed.title]).toEqual(["warning", "Finish setup first"]);
      else {
        expect(reply.tone).toBe("info");
        expect(embed.title).not.toBe("Finish setup first");
      }
    }
  });

  test("8. FC membership is required alike for deposit, balance and history", () => {
    for (const scope of ["/ledger deposit", "/ledger balance", "/ledger history"]) {
      const embed = failureAs("forbidden membership · /ledger deposit · member", "member", scope);
      expect({ scope, title: embed.title, color: embed.color }).toEqual({
        scope,
        title: "FC membership needed",
        color: 0xe67e22,
      });
    }
  });

  test("9. only a below-zero withdrawal is insufficient_funds; a deposit overflow is input", () => {
    const funds = embedOf("failures/insufficient funds · /ledger withdraw · officer");
    expect([funds.title, funds.color]).toEqual(["Not enough recorded gil", 0xe67e22]);
    expect(funds.footer?.text).toStartWith("Code insufficient_funds · ");
    const overflow = new Failure("input", "That amount is larger than the ledger can store.", 0, {
      kind: "option",
      option: "amount",
    });
    expect(render(overflow, "member", "/ledger deposit").title).toBe("Check your input");
  });

  test("10. an unset opening balance has one title and a next step per viewer", () => {
    const member = embedOf("failures/uninitialized · /ledger deposit · member");
    const officer = embedOf("failures/uninitialized · /ledger withdraw · officer");
    expect([member.title, officer.title]).toEqual([
      "Opening balance not set",
      "Opening balance not set",
    ]);
    expect(fieldOf(member, "Next step")?.value).not.toBe(fieldOf(officer, "Next step")?.value);
    // A missing FC or ledger channel belongs to the setup family instead.
    expect(embedOf("failures/setup ledger · /ledger deposit without an FC · member").title).toBe(
      "Ledger isn't set up",
    );
  });

  test("11. the vocabulary is 'opening balance' throughout", () => {
    expect(embedOf("ledger/initialize.recorded").title).toBe("Opening balance recorded");
    expect(embedOf("failures/initialized · /ledger initialize · officer").title).toBe(
      "Opening balance already set",
    );
    expect(embedOf("posts/post.opening").title).toBe("Opening balance · 95,000,000 gil");
    for (const reply of CASES)
      expect({ key: reply.key, initial: /initial balance/iu.test(textOf(reply.key)) }).toEqual({
        key: reply.key,
        initial: false,
      });
  });

  test("12. every revision fence says 'Settings changed — try again', /setup onboarding with its reuse line", () => {
    for (const code of ["conflict", "superseded"] as const)
      expect(
        render(new Failure(code, "Settings changed.", 0), "officer", "/config ledger").title,
      ).toBe("Settings changed — try again");
    expect(embedOf("failures/stale settings · /setup onboarding · manager").description).toContain(
      "reused",
    );
  });

  test("13. /apply by someone already eligible is 'No application needed'", () => {
    const reply = caseOf("failures/eligible · form submit · member");
    expect([reply.tone, embedOf(reply.key).title]).toEqual(["info", "No application needed"]);
  });

  test("14. 'Discord permissions need attention' carries Affected, How to fix and Then", () => {
    for (const reply of casesMatching(/^failures\/blocked /u)) {
      const embed = onlyEmbed(reply.render());
      if (!officerAudience(reply)) {
        expect(embed.title).toBe("Server setup issue");
        continue;
      }
      expect(embed.title).toBe("Discord permissions need attention");
      expect(fieldOf(embed, "Then")).toBeDefined();
    }
    // Affected names the role or channel whenever the refusal knows which one, and How to fix
    // appears when the throw site names the remedy (TaruBot's role position or channel
    // permissions); a raw Discord permission error names neither, so its card keeps the officer
    // diagnostic instead.
    const role = embedOf("failures/blocked role · /config roles guest · officer");
    expect([fieldOf(role, "Affected"), fieldOf(role, "How to fix")]).not.toContain(undefined);
  });

  test("15. every committed removal is success", () => {
    for (const key of [
      "guests/revoke.revoked",
      "guests/decision.denied",
      "configuration/officer.revoked",
      "configuration/channel.ledger_cleared",
      "configuration/channel.notifications_cleared",
      "configuration/channel.changelog_cleared",
      "configuration/applications.closed",
      "configuration/applications.review_unset",
      "configuration/role.cleared",
      "configuration/rank.cleared",
      "configuration/fc.unlinked",
      "configuration/layout.off",
      "characters/unclaim.unlinked",
      "characters/unassign.unlinked",
    ])
      expect({ key, tone: caseOf(key).tone }).toEqual({ key, tone: "success" });
  });

  test("15b. a change saved with a caveat the user or an officer must fix is warning", () => {
    // The C4 tone table's caveat row: saved, but something still needs fixing before it applies.
    for (const key of [
      "characters/nickname.on_owner",
      "configuration/role.leader_no_fc",
      "configuration/role.officer_no_rank",
      "configuration/channel.ledger_no_fc",
      // 2.25.0: a changelog channel onboarding hides from members and guests (warn only).
      "configuration/channel.changelog_hidden",
      "configuration/applications.no_role",
      "configuration/applications.no_channel",
      "configuration/rank.heads_up",
      "guests/grant.no_role",
    ])
      expect({ key, tone: caseOf(key).tone }).toEqual({ key, tone: "warning" });
  });

  test("16. guest and officer refusals get per-concept cards from the one catalog", () => {
    // Every catalogued code except the unexpected family renders a specific title.
    const specific = [
      "forbidden",
      "setup",
      "not_found",
      "conflict",
      "cooldown",
      "blocked",
    ] as const;
    for (const code of specific)
      for (const scope of ["/guest grant", "/officer grant", "button guest"])
        expect(render(new Failure(code, "Refused.", 60), "officer", scope).title).not.toBe(
          "Something went wrong",
        );
  });

  test("17. owner-scoped reads refuse members alike on /characters and /guest status", () => {
    for (const scope of ["/characters", "/guest status"])
      expect(
        failureAs("forbidden owner · /characters member: · member", "member", scope).title,
      ).toBe("Only your own records");
  });

  test("18. sections are joined with ' · '", () => {
    const titles = new Set(CASES.map((reply) => onlyEmbed(reply.render()).title));
    for (const title of [
      "Guest access · member record",
      "Sync status · server",
      "Configuration health · all checks passed",
      "Guest application · approved",
      "Ledger history · Example Free Company",
    ])
      expect(titles).toContain(title);
  });

  test("19. ledger titles use the plain FC name; another FC's account is historical", () => {
    for (const reply of casesMatching(/^ledger\/(?:balance|history)\./u))
      expect(onlyEmbed(reply.render()).title).not.toMatch(/«|»/u);
    expect(embedOf("ledger/balance.historical").title).toStartWith("Historical ledger");
  });

  test("20. stale roster evidence is a field on the success card, never a title", () => {
    for (const reply of CASES)
      expect({
        key: reply.key,
        roster: /roster/iu.test(onlyEmbed(reply.render()).title ?? ""),
      }).toEqual({ key: reply.key, roster: false });
  });

  test("21. /refresh refuses only for permission or setup; a cooldown is a pending result", () => {
    for (const reply of casesMatching(/^failures\/.* · \/refresh · /u))
      expect(reply.concept).toMatch(/^(?:forbidden|setup)\./u);
    for (const reply of casesMatching(/^sync\/refresh\./u)) expect(reply.tone).toBe("pending");
  });

  test("22. member options suggest members and still take an ID or mention (2026-09-24)", () => {
    // The owner's decision replaced the free-text wording: every member option autocompletes.
    const error = thrown(() => userId("Wrenfield"));
    expect(error).toBeInstanceOf(Failure);
    const text = JSON.stringify(render(error, "officer", "/assign"));
    expect(text).toContain(
      "Pick a member from the suggestions, or paste a Discord user ID or @mention.",
    );
  });

  test("23. note checks name their option and are all 'Check your input'", () => {
    for (const label of ["note", "reason", "rank"] as const) {
      const error = thrown(() => note(" ", label));
      expect(error).toMatchObject({
        code: "input",
        message: `Add a ${label} of 1–1,000 characters.`,
        detail: { kind: "option", option: label },
      });
      expect(render(error, "member", "/ledger deposit").title).toBe("Check your input");
    }
  });

  test("24. channel posts are colored by operation; receipts are success; minus is U+2212", () => {
    expect(
      ["post.deposit", "post.withdraw", "post.opening", "post.correction"].map(
        (kind) => caseOf(`posts/${kind}`).tone,
      ),
    ).toEqual(["success", "info", "info", "warning"]);
    for (const kind of ["deposit", "withdraw", "initialize", "adjust"])
      expect(caseOf(`ledger/${kind}.recorded`).tone).toBe("success");
    expect(embedOf("posts/post.withdraw").title).toBe("Withdrawal · −2,500,000 gil");
    for (const reply of casesMatching(/^(?:ledger|posts)\//u))
      expect({
        key: reply.key,
        hyphen: /-\d{1,3}(?:,\d{3})* gil/u.test(textOf(reply.key)),
      }).toEqual({
        key: reply.key,
        hyphen: false,
      });
  });

  test("25. titles never carry IDs; follow-up IDs stay complete and copyable", () => {
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-|\b\d{17,20}\b/iu;
    for (const reply of CASES)
      expect({ key: reply.key, id: id.test(onlyEmbed(reply.render()).title ?? "") }).toEqual({
        key: reply.key,
        id: false,
      });
    // /refresh keeps the full run ID, as approved (guests#36), in the next command and the footer.
    const refresh = embedOf("sync/refresh.cached");
    const run = /run_id:([0-9a-f-]{36})/u.exec(JSON.stringify(refresh))?.[1];
    expect(run).toBeDefined();
    expect(refresh.footer?.text).toBe(`Run ${run}`);
    // Officer history rows carry full entry UUIDs in code; posts carry them in the footer.
    expect(textOf("ledger/history.officer")).toMatch(/`[0-9a-f]{8}-[0-9a-f-]{27}`/u);
    expect(embedOf("posts/post.deposit").footer?.text).toMatch(/^Entry [0-9a-f-]{36}$/u);
  });

  test("26. the closed-applications card is the same before the form and at submission", () => {
    const before = onlyEmbed(applicationsClosedReply({ officerHint: false }));
    const after = embedOf("failures/setup guest_applications · form submit · member");
    expect([after.title, after.description]).toEqual([before.title, before.description]);
    expect(before.footer).toBeUndefined();
    expect(after.footer?.text).toMatch(/^Code setup · Ref \d+$/u);
  });

  test("27. the audience comes from audienceOf alone; officer and leader changes are managers'", () => {
    expect(
      (["member", "officer", "manager"] as const).map((audience) => audienceOf(ACTORS[audience])),
    ).toEqual(["member", "officer", "manager"]);
    for (const key of [
      "configuration/role.cleared",
      "configuration/role.leader",
      "configuration/role.officer_adopted",
    ])
      expect({ key, audience: caseOf(key).audience }).toEqual({ key, audience: "manager" });
  });
});
