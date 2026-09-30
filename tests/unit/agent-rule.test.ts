/**
 * The rule for agents around deployments, as the owner confirmed it (moved here from
 * deploy-workflow.test.ts in 2.37.0, when that file stopped being about one workflow's text).
 *
 * - The SSH-deploy rule (REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)"): the owner's
 *   answer to question 1 and the clauses @deconfined confirmed on 2026-09-26, quoted verbatim in
 *   AGENTS.md, and every paragraph that names it says it was confirmed.
 * - The widened rule (REQUIREMENTS.md "Approved pipeline amendments (2026-09-29)"), verbatim in
 *   AGENTS.md too.
 * - 2.37.0's proposed wording for the one path (REQUIREMENTS.md "Approved unified-pipeline
 *   amendments (2026-09-29)", question 1). It is the one text allowed to call itself pending, and
 *   only in the unit that quotes it whole. When @deconfined confirms it, the pull request that
 *   records the confirmation removes that allowance (PROPOSAL below) and the "pending" words.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

/** The files that carry or point to the rule; each must name it at least once. */
const POINTERS = [
  "REQUIREMENTS.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/CI_CD.md",
  "docs/HOSTING.md",
] as const;

/**
 * 2.37.0's proposed wording, exactly as @deconfined was asked to confirm it (question 1). Until
 * confirmed, it may appear only as a proposal: in a unit that quotes it whole and says it is
 * proposed and pending.
 */
const PROPOSAL =
  "Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` or any other environment secret; never enable or disable the Deploy or Publish containers workflow; never approve, reject, bypass, cancel or re-run a Deploy or Publish containers run or any of its jobs; never change the `staging`, `prod`, `production`, `notify` or `infra-plan` environments, their secrets or their variables, or `DEPLOY_ENABLED`; and dispatch Deploy only when the owner asks in that session.";

describe("the agent rule", () => {
  test("AGENTS.md carries REQUIREMENTS.md's wording verbatim, every part confirmed", () => {
    // The rule is the blockquote in "Approved SSH-deploy amendments (2026-09-26)": the owner's
    // answer to question 1, then the clauses PR #44 proposed, which @deconfined confirmed on
    // 2026-09-26 in a comment on #41.
    const requirements = read("REQUIREMENTS.md");
    const confirmed =
      /\n> (Confirmed \(question 1\): [^\n]+)\n/u.exec(requirements)?.[1] ?? "no confirmed part";
    const clauses =
      /\n> (Confirmed by @deconfined on 2026-09-26 \(\[#41\]\(https:\/\/github\.com\/deconfined\/tarubot\/issues\/41#issuecomment-5846407419\)\): [^\n]+)\n/u.exec(
        requirements,
      )?.[1] ?? "no confirmed clauses";
    for (const clause of [
      "the owner's approval of the `production` environment in GitHub is the go-ahead",
      "a chat go-ahead doesn't replace it",
      "Claude sessions never approve a deployment",
      "a deploy by hand still needs the owner's explicit go-ahead",
      "provider, token, key, firewall and account changes stay separate owner steps",
    ])
      expect({ clause, confirmed: confirmed.includes(clause) }).toEqual({
        clause,
        confirmed: true,
      });
    // No clause was dropped when the proposal became the owner's decision.
    for (const clause of [
      "never approve, reject or bypass a deployment",
      "never create, read or hold the deploy key",
      "never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`",
      "never enable, disable, cancel or re-run the Deploy production workflow",
      "dispatch it only when the owner asks in that session",
    ])
      expect({ clause, confirmed: clauses.includes(clause) }).toEqual({ clause, confirmed: true });
    const agents = read("AGENTS.md");
    expect(agents).toContain(`- ${confirmed}\n`);
    expect(agents).toContain(`- ${clauses}\n`);
    // Nothing still calls any confirmed part of it pending: not the rule itself, and not the text
    // in the files that point to it, each of which says it was confirmed. The one exception is the
    // unit that quotes 2.37.0's proposal whole (the next test holds it to that).
    expect({ confirmed: PENDING.test(confirmed), clauses: PENDING.test(clauses) }).toEqual({
      confirmed: false,
      clauses: false,
    });
    for (const file of POINTERS) {
      const units = agentRuleUnits(read(file)).filter((unit) => !unit.includes(PROPOSAL));
      expect({ file, points: units.length > 0 }).toEqual({ file, points: true });
      for (const unit of units) {
        // The unit's first words name it in a failure.
        const at = unit.slice(0, 80);
        expect({
          file,
          at,
          pending: PENDING.test(unit),
          confirmed: CONFIRMATION.test(unit),
        }).toEqual({ file, at, pending: false, confirmed: true });
      }
    }
  });

  test("the widened rule of 2026-09-29 is in AGENTS.md verbatim", () => {
    // The blockquote in "Approved pipeline amendments (2026-09-29)", "The widened rule for agents".
    const widened =
      /\n> (Agents, Claude sessions included, never hold `ANSIBLE_SSH_KEY` [^\n]*an Infrastructure run[^\n]+)\n/u.exec(
        read("REQUIREMENTS.md"),
      )?.[1] ?? "no widened rule";
    expect(widened).toContain(
      "never change the `staging`, `production`, `notify`, `infra-plan` or `infra` environments",
    );
    expect(read("AGENTS.md")).toContain(`  - ${widened}\n`);
  });

  test("2.37.0's wording is only a proposal: quoted whole, marked, and pending", () => {
    // REQUIREMENTS.md and AGENTS.md each quote it exactly once, in a unit that names the rule, says
    // it is proposed and pending @deconfined's confirmation, and holds the whole text; no other
    // file may quote it as if it were in force.
    const count = (text: string) => text.split(PROPOSAL).length - 1;
    const requirements = read("REQUIREMENTS.md");
    expect(requirements).toContain(`\n> ${PROPOSAL}\n`);
    const agents = read("AGENTS.md");
    expect(agents).toContain(`\n  - ${PROPOSAL}\n`);
    for (const file of POINTERS) {
      const text = read(file);
      const proposals = agentRuleUnits(text).filter((unit) => unit.includes(PROPOSAL));
      // Every copy of the text sits in a unit that names the rule, so none escapes the checks, and
      // no file holds more than one: REQUIREMENTS.md and AGENTS.md exactly one each.
      const required = file === "REQUIREMENTS.md" || file === "AGENTS.md";
      expect({ file, copies: count(text) }).toEqual({ file, copies: proposals.length });
      expect({ file, units: proposals.length }).toEqual({
        file,
        units: required ? 1 : Math.min(proposals.length, 1),
      });
      for (const unit of proposals)
        expect({
          file,
          proposed: /\bproposed\b/iu.test(unit),
          pending: /\bpending @deconfined's confirmation in the pull request\b/u.test(unit),
        }).toEqual({ file, proposed: true, pending: true });
    }
  });

  test("the unit reader keeps each mention to its own paragraph, list item or table row", () => {
    const text = [
      "# The agent rule",
      "",
      "A paragraph that names the agent rule,",
      "over two lines:",
      "",
      "- A deny rule for the pending-deployments endpoint.",
      "- The agent rule, with its parts:",
      "  - Confirmed on 2026-09-26.",
      "- Another item.",
      "",
      "| Rule | State |",
      "| agent rule | confirmed |",
      "| other | pending |",
    ].join("\n");
    expect(agentRuleUnits(text)).toEqual([
      "# The agent rule",
      "A paragraph that names the agent rule,\nover two lines:",
      "- The agent rule, with its parts:\n  - Confirmed on 2026-09-26.",
      "| agent rule | confirmed |",
    ]);
  });
});

/**
 * Words that call the agent rule unconfirmed. `\b` keeps `pending_deployments`, the REST endpoint
 * CLAUDE.md names beside the rule, from counting.
 */
const PENDING = /\bpending\b|\bin the meantime\b/iu;
/**
 * The owner's confirmation: the link to the #41 comment, or "confirmed" and 2026-09-26 in one
 * sentence. The date alone is not enough, because it is also in the amendment's heading, "Approved
 * SSH-deploy amendments (2026-09-26)", which every pointer names.
 */
const CONFIRMATION = /issuecomment-5846407419|confirmed[^.]*2026-09-26/iu;

/**
 * The Markdown units of a file that mention the agent rule (any case). A unit is a paragraph, a
 * top-level list item with its indented continuation lines and nested items, a table row, or a
 * heading. A blank line, a heading, a table row or a new top-level list item ends the unit before
 * it, so text beside the rule, such as CI_CD.md's deny rules for the pending-deployments endpoint,
 * is never tested with it.
 */
function agentRuleUnits(text: string): string[] {
  const units: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      current = null;
      continue;
    }
    const indented = /^\s/u.test(line);
    const single = !indented && (line.startsWith("|") || line.startsWith("#"));
    const item = !indented && /^(?:[-*+]|\d+\.)\s/u.test(line);
    if (current === null || single || item) {
      current = [];
      units.push(current);
    }
    current.push(line);
    // A table row or a heading is a unit of its own line.
    if (single) current = null;
  }
  return units.map((unit) => unit.join("\n")).filter((unit) => /agent rule/iu.test(unit));
}
