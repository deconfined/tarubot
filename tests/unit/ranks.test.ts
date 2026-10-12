/** Privileged rank projections require trustworthy observations and explicit management authority. */
import { describe, expect, test } from "bun:test";
import { requirePermission } from "../../src/domain/policy.js";
import {
  desiredRankRole,
  linkConfersRank,
  rankBacks,
  rankDecisive,
  rankUnion,
  type RankEvidence,
  type RankState,
} from "../../src/application/rank-policy.js";
import {
  character,
  markRosterLeader,
  type CharacterIdentity,
} from "../../src/infrastructure/lodestone/client.js";
import { actorOf } from "../fixtures/actors.js";

test("bot-only officers cannot provision or delegate officer authority", () => {
  // Granting officer access is fixed (admin.grants): Manage Roles plus the Officer role isn't enough.
  expect(() =>
    requirePermission(
      actorOf({
        guildId: "1",
        userId: "2",
        officer: true,
        serverManager: false,
        manageRoles: true,
      }),
      "1",
      "admin.grants",
    ),
  ).toThrow();
  expect(() =>
    requirePermission(
      actorOf({ guildId: "1", userId: "2", officer: true, serverManager: true, manageRoles: true }),
      "1",
      "admin.grants",
    ),
  ).not.toThrow();
});
test("uncertain or stale rank data preserves existing roles without new automatic grants", () => {
  // 2.43.0's "unknown" is now "unreadable" (no rank data) or "unresolved" (no roster yet): both
  // keep a held role and never add one.
  for (const state of ["unreadable", "unresolved"] as const) {
    expect(desiredRankRole(state, true, false)).toBe(true);
    expect(desiredRankRole(state, false, true)).toBe(false);
    expect(desiredRankRole(state, false, true, true)).toBe(false);
    expect(desiredRankRole(state, true, true, true)).toBe(true);
  }
  expect(desiredRankRole("yes", false, false)).toBe(false);
  expect(desiredRankRole("yes", false, false, true)).toBe(true);
  expect(desiredRankRole("no", true, true)).toBe(false);
});
test("FC rank fields are separate from Grand Company rank and a custom leader title", () => {
  const member = character({
    ID: "123",
    Name: "Test Character",
    World: "Diabolos",
    DC: "Crystal",
    FcRank: "Fussy Bunbun",
    FcRankIcon: "https://lds-img.finalfantasyxiv.com/h/Z/W5a6yeRyN2eYiaV-AGU7mJKEhs.png",
    RankName: "Serpent Captain",
  });
  const officer: CharacterIdentity = {
    id: "456",
    name: "Another Character",
    world: "Diabolos",
    dc: "Crystal",
    fcId: null,
    fcRankName: "Officer",
    fcRankIcon: "https://lds-img.finalfantasyxiv.com/h/6/p94F1j-5xhM2ySM16VNrA08qjU.png",
  };
  markRosterLeader([member, officer]);
  expect(member.fcRankName).toBe("Fussy Bunbun");
  expect(member.isFcLeader).toBe(true);
  expect(officer.isFcLeader).toBe(false);
  const unknown = { ...officer };
  markRosterLeader([unknown]);
  expect(unknown.isFcLeader).toBeUndefined();
  const changed: CharacterIdentity = {
    ...member,
    fcRankIcon: "https://lds-img.finalfantasyxiv.com/changed.png",
  };
  delete changed.isFcLeader;
  markRosterLeader([changed]);
  expect(changed.isFcLeader).toBeUndefined();
});

/** One active link with the evidence accepted for the guild's current FC; trusted unless overridden. */
const row = (
  state: RankEvidence["state"],
  rank: string | null,
  extra: Partial<RankEvidence> = {},
): RankEvidence => ({
  state,
  fc_rank_key: rank,
  is_fc_leader: false,
  rank_authority: true,
  ...extra,
});
const context = { fcLinked: true, officerRankKey: "officer", localLoss: false };

test("officer and leader use any qualifying linked character", () => {
  const officer = (rows: RankEvidence[], overrides: Partial<typeof context> = {}) =>
    rankUnion(rows, { ...context, ...overrides }).officer;
  expect(officer([row("present", "member"), row("present", "officer")])).toBe("yes");
  expect(officer([row("absent", "officer")])).toBe("no");
  // A character awaiting departure confirmation still counts (SYNC-10).
  expect(officer([row("missing", "officer")])).toBe("yes");
  // A bot-only officer's assignment vouches for membership but cannot appoint an officer.
  expect(officer([row("present", "officer", { rank_authority: false })])).toBe("no");
  // 2.43.0's "unknown", split (2.44.0): a link waiting for its first roster is "unresolved", a
  // confirmed character the roster carried no rank for is "unreadable".
  expect(officer([row("present", "member"), row(null, null)])).toBe("unresolved");
  expect(officer([row("present", "member"), row(null, null)], { localLoss: true })).toBe("no");
  expect(officer([row("present", null)])).toBe("unreadable");
  expect(rankUnion([row("present", null, { is_fc_leader: null })], context).leader).toBe(
    "unreadable",
  );
  expect(
    rankUnion([row("present", "officer", { is_fc_leader: true })], { ...context, fcLinked: false }),
  ).toEqual({ officer: "no", leader: "no" });
  // Without a configured officer rank the leader union is still computed.
  expect(
    rankUnion([row("present", "member"), row("present", "leader", { is_fc_leader: true })], {
      ...context,
      officerRankKey: null,
    }),
  ).toEqual({ officer: "no", leader: "yes" });
});

describe("rank evidence states (2.44.0)", () => {
  test("FC Leader ignores links that can't confer rank, as the Officer union does", () => {
    // The gap fix (D1): a delegated officer's /assign of the leader's character made its assignee
    // FC Leader in 2.43.0. Now neither rank role counts such a link, whatever it says.
    const assigned = row("present", "officer", { is_fc_leader: true, rank_authority: false });
    expect(rankUnion([assigned], context)).toEqual({ officer: "no", leader: "no" });
    expect(
      rankUnion([row("present", null, { is_fc_leader: null, rank_authority: false })], context),
    ).toEqual({ officer: "no", leader: "no" });
    // A trusted link beside it still decides.
    expect(
      rankUnion([assigned, row("present", "member", { is_fc_leader: true })], context).leader,
    ).toBe("yes");
  });

  test("a confirmed character without rank data beats links waiting for a roster", () => {
    // unreadable keeps authority (an upstream selector change mustn't strip every officer at
    // once); unresolved doesn't, so the stronger answer wins.
    expect(
      rankUnion([row(null, null), row("present", null, { is_fc_leader: null })], context),
    ).toEqual({ officer: "unreadable", leader: "unreadable" });
    // And a holder beats both.
    expect(
      rankUnion(
        [row(null, null), row("present", null), row("missing", "officer", { is_fc_leader: true })],
        context,
      ),
    ).toEqual({ officer: "yes", leader: "yes" });
  });

  test("unresolved comes only from trusted links", () => {
    // D2/D3: an untrusted /assign that hasn't met a roster yet is no evidence at all.
    expect(rankUnion([row(null, null, { rank_authority: false })], context)).toEqual({
      officer: "no",
      leader: "no",
    });
    expect(rankUnion([row(null, null)], context)).toEqual({
      officer: "unresolved",
      leader: "unresolved",
    });
    // Evaluated links that aren't confirmed (absent) give no evidence either way.
    expect(rankUnion([row("absent", null, { is_fc_leader: null })], context)).toEqual({
      officer: "no",
      leader: "no",
    });
  });

  test("a local unlink of the last confirmed character suppresses unresolved", () => {
    const local = { ...context, localLoss: true };
    expect(rankUnion([row(null, null)], local)).toEqual({ officer: "no", leader: "no" });
    // It never hides confirmed evidence.
    expect(
      rankUnion([row(null, null), row("present", null, { is_fc_leader: null })], local),
    ).toEqual({ officer: "unreadable", leader: "unreadable" });
    expect(rankUnion([row(null, null), row("present", "officer")], local).officer).toBe("yes");
  });

  test("unreadable and unresolved keep what is held, so neither is decisive", () => {
    for (const state of ["unreadable", "unresolved"] as const)
      for (const fresh of [false, true])
        for (const manual of [false, true]) {
          expect(desiredRankRole(state, true, fresh, manual)).toBe(true);
          expect(desiredRankRole(state, false, fresh, manual)).toBe(false);
          expect(rankDecisive(state, fresh, manual)).toBe(false);
        }
  });

  test("only yes and unreadable let a held Officer role count", () => {
    const backs: Record<RankState, boolean> = {
      yes: true,
      unreadable: true,
      unresolved: false,
      no: false,
    };
    for (const [state, expected] of Object.entries(backs) as [RankState, boolean][])
      expect(rankBacks(state)).toBe(expected);
  });

  test("a held Officer role backed only by links awaiting a roster is kept but counts for nothing", () => {
    // D2 (2.44.0): in 2.43.0 "unknown" made its holder a bot officer; now the projection keeps the
    // role while enrichment leaves it out of Access.roles until a roster confirms the rank.
    const { officer } = rankUnion([row(null, null)], context);
    expect(officer).toBe("unresolved");
    expect(desiredRankRole(officer, true, true)).toBe(true);
    expect(rankBacks(officer)).toBe(false);
    // A confirmed character whose rank the roster didn't carry keeps authority as well as the role.
    const unreadable = rankUnion([row("present", null)], context).officer;
    expect(desiredRankRole(unreadable, true, true)).toBe(true);
    expect(rankBacks(unreadable)).toBe(true);
  });

  test("a link confers rank unless it is an /assign made without admin.links", () => {
    // Verified and imported links always may; their source is irrelevant.
    for (const provenance of ["profile_token", "imported_link"]) {
      expect(linkConfersRank(provenance, {})).toBe(true);
      expect(linkConfersRank(provenance, null)).toBe(true);
      expect(linkConfersRank(provenance, { officerAuthority: false })).toBe(true);
    }
    expect(linkConfersRank("officer_assignment", { officerAuthority: true })).toBe(true);
    expect(linkConfersRank("officer_assignment", { officerAuthority: false })).toBe(false);
    // D3: a missing flag is no evidence of authority.
    expect(linkConfersRank("officer_assignment", {})).toBe(false);
    expect(linkConfersRank("officer_assignment", { reason: "Vouched for" })).toBe(false);
    // A source that isn't an object never does.
    for (const source of [null, undefined, true, "officerAuthority", 1])
      expect(linkConfersRank("officer_assignment", source)).toBe(false);
  });
});
