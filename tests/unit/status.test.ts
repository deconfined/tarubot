/**
 * Officer status notices (2.29.0, issue #31), the pure rules: which decisions count (the probe
 * table for accessDecisive and rankDecisive), how one pass is recorded (baselines, changes,
 * cancelling, unbinding and rejoining), every reason, the entry a pending member contributes, the
 * mark after a post (including a rejoin while the post was in flight), and the no-channel drop.
 */
import { describe, expect, test } from "bun:test";
import { rankDecisive } from "../../src/application/rank-policy.js";
import { type AccessFacts, accessDecisive, desiredAccess } from "../../src/domain/policy.js";
import {
  addDeparture,
  applyPosted,
  changedFlags,
  type Departure,
  dropPending,
  entryFor,
  entryVisible,
  type Flag,
  type FlagObservation,
  type Flags,
  isPending,
  levelOf,
  type Observation,
  observe,
  REASON_CODES,
  type ReasonCode,
  type ReasonFacts,
  readPosting,
  readState,
  STATUS_FLAGS,
  type StatusState,
  statusObservation,
  statusReason,
} from "../../src/domain/status.js";

/** Facts for one probe case; the held roles are irrelevant, since accessDecisive varies them. */
const facts = (overrides: Partial<AccessFacts>): AccessFacts => ({
  membership: "ineligible",
  fresh: false,
  former: false,
  grant: false,
  revoked: false,
  hasMember: false,
  hasGuest: false,
  verified: false,
  ...overrides,
});

describe("decisive decisions (the held-role fix)", () => {
  test("accessDecisive matches the plan's probe table", () => {
    const cases: [string, Partial<AccessFacts>, { member: boolean; guest: boolean }][] = [
      ["member, fresh", { membership: "member", fresh: true }, { member: true, guest: true }],
      ["member, stale", { membership: "member" }, { member: false, guest: false }],
      [
        "member, stale and revoked",
        { membership: "member", revoked: true },
        { member: false, guest: true },
      ],
      ["uncertain", { membership: "uncertain", fresh: true }, { member: false, guest: false }],
      [
        "uncertain and revoked",
        { membership: "uncertain", revoked: true },
        { member: false, guest: true },
      ],
      // The policy adds Guest for this member with no roles, but a held Member would stop it.
      [
        "uncertain with a grant",
        { membership: "uncertain", grant: true },
        {
          member: false,
          guest: false,
        },
      ],
      ["ineligible with a grant", { grant: true }, { member: true, guest: true }],
      ["ineligible former member", { former: true }, { member: true, guest: true }],
      [
        "ineligible verified, fresh",
        { verified: true, fresh: true },
        { member: true, guest: true },
      ],
      ["ineligible verified, stale", { verified: true }, { member: true, guest: false }],
      ["ineligible revoked", { verified: true, revoked: true }, { member: true, guest: true }],
      ["ineligible unverified", {}, { member: true, guest: true }],
    ];
    for (const [name, overrides, expected] of cases)
      expect({ name, decisive: accessDecisive(facts(overrides)) }).toEqual({
        name,
        decisive: expected,
      });
  });

  test("a decisive value is the same whichever roles are held", () => {
    // The definition itself, over every class and fact combination.
    for (const membership of ["member", "uncertain", "ineligible"] as const)
      for (const bits of Array.from({ length: 32 }, (_, n) => n)) {
        const base = facts({
          membership,
          fresh: Boolean(bits & 1),
          former: Boolean(bits & 2),
          grant: Boolean(bits & 4),
          revoked: Boolean(bits & 8),
          verified: Boolean(bits & 16),
        });
        const decisive = accessDecisive(base);
        const values = [false, true].flatMap((hasMember) =>
          [false, true].map((hasGuest) => desiredAccess({ ...base, hasMember, hasGuest })),
        );
        for (const flag of ["member", "guest"] as const)
          if (decisive[flag]) expect(new Set(values.map((value) => value[flag])).size).toBe(1);
      }
  });

  test("rankDecisive: no always, yes with a grant or fresh evidence, unreadable and unresolved never", () => {
    // 2.44.0 splits 2.43.0's "unknown" in two; both keep whatever is held, so neither is decisive.
    for (const state of ["unreadable", "unresolved"] as const) {
      expect(rankDecisive(state, true)).toBe(false);
      expect(rankDecisive(state, false, true)).toBe(false);
    }
    expect(rankDecisive("no", false)).toBe(true);
    expect(rankDecisive("no", true, true)).toBe(true);
    expect(rankDecisive("yes", false, true)).toBe(true);
    expect(rankDecisive("yes", true)).toBe(true);
    expect(rankDecisive("yes", false)).toBe(false);
  });
});

/** One flag as a pass sees it. */
const seen = (
  value: boolean | null,
  decisive = true,
  reason: ReasonCode = "in_fc",
): FlagObservation => ({ value, decisive, reason });
/** A pass with every flag unbound unless given. */
const pass = (flags: Partial<Record<Flag, FlagObservation>>): Observation => ({
  member: seen(null),
  guest: seen(null),
  officer: seen(null),
  leader: seen(null),
  ...flags,
});
const JOINED = "2026-01-01T00:00:00.000Z";
const flags = (values: Partial<Flags> = {}): Flags => ({
  member: null,
  guest: null,
  officer: null,
  leader: null,
  ...values,
});
const departure = (character: string, snapshot = "s1"): Departure => ({
  character,
  name: `Alt ${character}`,
  world: "Diabolos",
  snapshot,
});
/** A state with the given announced and current values. */
const state = (
  announced: Partial<Flags>,
  current: Partial<Flags> = announced,
  extra: Partial<StatusState> = {},
): StatusState => ({
  joined: JOINED,
  announced: flags(announced),
  current: flags(current),
  reasons: {},
  departed: [],
  ...extra,
});

describe("recording a pass", () => {
  test("a first pass is a silent baseline of decisive flags only", () => {
    const recorded = observe(
      null,
      pass({
        member: seen(false, true, "not_in_fc"),
        guest: seen(true, false, "registered"),
        officer: seen(false, true, "no_officer_rank"),
      }),
      JOINED,
    );
    expect(recorded).toEqual({
      next: state({ member: false, officer: false }),
      changed: true,
      pending: false,
      moved: false,
    });
  });

  test("a decisive change waits with its reason, and a change back cancels it", () => {
    const base = state({ member: true, guest: false });
    const lost = observe(
      base,
      pass({ member: seen(false, true, "not_in_fc"), guest: seen(true, true, "former_member") }),
      JOINED,
    );
    expect(lost).toMatchObject({ changed: true, pending: true, moved: true });
    expect(lost.next.current).toEqual(flags({ member: false, guest: true }));
    expect(lost.next.reasons).toEqual({ member: "not_in_fc", guest: "former_member" });
    expect(changedFlags(lost.next)).toEqual(["member", "guest"]);
    const back = observe(
      lost.next,
      pass({ member: seen(true, true, "in_fc"), guest: seen(false, true, "is_member") }),
      JOINED,
    );
    expect(back).toMatchObject({ changed: true, pending: false, moved: true });
    expect(back.next).toEqual(base);
  });

  test("a non-decisive value moves nothing in either direction", () => {
    const base = state({ member: true, guest: false });
    const stale = observe(
      base,
      pass({ member: seen(false, false), guest: seen(true, false) }),
      JOINED,
    );
    expect(stale).toEqual({ next: base, changed: false, pending: false, moved: false });
  });

  test("unbinding clears a flag silently, and a rebind is a silent baseline", () => {
    const base = state({ officer: true }, { officer: false }, { reasons: { officer: "no_fc" } });
    const unbound = observe(base, pass({}), JOINED);
    expect(unbound).toMatchObject({ changed: true, pending: false, moved: false });
    expect(unbound.next).toEqual(state({}));
    const rebound = observe(
      unbound.next,
      pass({ officer: seen(true, true, "officer_rank") }),
      JOINED,
    );
    expect(rebound).toMatchObject({ changed: true, pending: false, moved: false });
    expect(rebound.next).toEqual(state({ officer: true }));
  });

  test("a new join time resets every flag and keeps unposted departures", () => {
    const base = state(
      { member: true, guest: false },
      { member: false, guest: true },
      { reasons: { member: "not_in_fc" }, departed: [departure("1")] },
    );
    const rejoined = observe(
      base,
      pass({ member: seen(false, false), guest: seen(true, true, "former_member") }),
      "2026-02-01T00:00:00.000Z",
    );
    expect(rejoined).toMatchObject({ changed: true, pending: true, moved: false });
    expect(rejoined.next).toEqual({
      joined: "2026-02-01T00:00:00.000Z",
      announced: flags({ guest: true }),
      current: flags({ guest: true }),
      reasons: {},
      departed: [departure("1")],
    });
  });

  test("an unchanged pass reports no change, whatever the key order stored", () => {
    const base = state({ member: false, guest: true, leader: false });
    const reordered = JSON.parse(
      JSON.stringify({
        ...base,
        current: { leader: false, guest: true, officer: null, member: false },
      }),
    );
    const again = observe(
      readState(reordered),
      pass({
        member: seen(false, true, "not_in_fc"),
        guest: seen(true, true, "registered"),
        leader: seen(false, true, "no_fc_leader"),
      }),
      JOINED,
    );
    expect(again.changed).toBe(false);
    // A reason that moves while the value still differs is rewritten, without queuing a post.
    const waiting = state({ guest: false }, { guest: true }, { reasons: { guest: "registered" } });
    const regranted = observe(waiting, pass({ guest: seen(true, true, "guest_grant") }), JOINED);
    expect(regranted).toMatchObject({ changed: true, pending: true, moved: false });
    expect(regranted.next.reasons).toEqual({ guest: "guest_grant" });
  });

  test("stored states are validated on read; a bad one counts as none", () => {
    expect(readState(null)).toBeNull();
    expect(readState({ joined: JOINED })).toBeNull();
    expect(readState({ ...state({}), reasons: { member: "because" } })).toBeNull();
    expect(readState(state({ member: true }))).toEqual(state({ member: true }));
    expect(readPosting({ batch: "not-a-uuid", seq: 0, frozenAt: JOINED, entry: {} })).toBeNull();
  });
});

describe("reasons", () => {
  const none: ReasonFacts = {
    fcLinked: true,
    officerRankSet: true,
    grant: false,
    former: false,
    guestRevoked: false,
    manualOfficer: false,
    officerRevoked: false,
  };
  test("every reason code, in the policy's precedence", () => {
    const produced = new Set<ReasonCode>();
    const reason = (
      flag: Flag,
      value: boolean,
      overrides: Partial<ReasonFacts> = {},
      member = false,
    ) => {
      const code = statusReason(flag, value, member, { ...none, ...overrides });
      produced.add(code);
      return code;
    };
    expect(reason("member", true)).toBe("in_fc");
    expect(reason("member", false)).toBe("not_in_fc");
    expect(reason("member", false, { fcLinked: false })).toBe("no_fc");
    expect(reason("guest", true, { grant: true, former: true })).toBe("guest_grant");
    expect(reason("guest", true, { former: true })).toBe("former_member");
    expect(reason("guest", true)).toBe("registered");
    expect(reason("guest", false, { guestRevoked: true }, true)).toBe("is_member");
    expect(reason("guest", false, { guestRevoked: true })).toBe("guest_revoked");
    expect(reason("guest", false)).toBe("no_guest_basis");
    expect(reason("officer", true, { manualOfficer: true })).toBe("officer_override");
    expect(reason("officer", true)).toBe("officer_rank");
    expect(reason("officer", false, { officerRevoked: true, fcLinked: false })).toBe(
      "officer_revoked",
    );
    expect(reason("officer", false, { fcLinked: false, officerRankSet: false })).toBe("no_fc");
    // A guild with an FC but no officer rank: not "no linked character holds the officer rank".
    expect(reason("officer", false, { officerRankSet: false })).toBe("officer_rank_unset");
    expect(reason("officer", false)).toBe("no_officer_rank");
    expect(reason("leader", true)).toBe("fc_leader");
    expect(reason("leader", false)).toBe("no_fc_leader");
    expect(reason("leader", false, { fcLinked: false })).toBe("no_fc");
    expect([...produced].sort()).toEqual([...REASON_CODES].sort());
  });

  test("an observation carries unbound flags as null and reads the pass's Member decision", () => {
    const observed = statusObservation({
      bound: { member: true, guest: true, officer: false, leader: true },
      values: { member: true, guest: false, officer: true, leader: false },
      decisive: { member: true, guest: true, officer: true, leader: false },
      facts: none,
    });
    expect(observed).toEqual({
      member: { value: true, decisive: true, reason: "in_fc" },
      guest: { value: false, decisive: true, reason: "is_member" },
      officer: { value: null, decisive: true, reason: "officer_rank" },
      leader: { value: false, decisive: false, reason: "no_fc_leader" },
    });
  });

  /** One pass's Guest observation from real policy facts, as Synchronization.user builds it. */
  const guestSeen = (input: AccessFacts, memberBound = true): FlagObservation => {
    const desired = desiredAccess(input);
    const decisive = accessDecisive(input);
    return statusObservation({
      bound: { member: memberBound, guest: true, officer: true, leader: true },
      values: { member: desired.member, guest: desired.guest, officer: false, leader: false },
      decisive: { member: decisive.member, guest: decisive.guest, officer: true, leader: true },
      facts: { ...none, guestRevoked: input.revoked },
    }).guest;
  };

  test("a lost Guest is `is_member` only when the same pass decided Member", () => {
    // Member held by hand on an out-of-date roster, Guest revoked: Member isn't decisive, so the
    // revocation is the reason, not "a linked character is in the FC".
    expect(
      guestSeen(facts({ membership: "member", revoked: true, hasMember: true, verified: true })),
    ).toEqual({ value: false, decisive: true, reason: "guest_revoked" });
    // The same member with a fresh roster: Member is decisive, and the lost Guest is part of it.
    expect(
      guestSeen(
        facts({
          membership: "member",
          fresh: true,
          revoked: true,
          hasMember: true,
          verified: true,
        }),
      ),
    ).toEqual({ value: false, decisive: true, reason: "is_member" });
    // No Member role bound: a decisive FC member still loses Guest because of the FC, so the
    // reason stays the true one ("Guest → No access · a linked character is in the FC"); the
    // other two would claim a revocation or no FC history that isn't there.
    expect(
      guestSeen(
        facts({ membership: "member", fresh: true, hasGuest: true, verified: true }),
        false,
      ),
    ).toEqual({ value: false, decisive: true, reason: "is_member" });
  });
});

describe("entries and marks", () => {
  test("each access transition, Officer and FC Leader, and a departure-only entry", () => {
    const level = (from: Partial<Flags>, to: Partial<Flags>) => {
      const entry = entryFor("1", state(from, to));
      return entry && [levelOf(entry.from), levelOf(entry.to)];
    };
    expect(level({ member: false, guest: false }, { guest: true })).toEqual(["none", "guest"]);
    expect(level({ member: false, guest: false }, { member: true })).toEqual(["none", "member"]);
    expect(level({ member: false, guest: true }, { member: true, guest: false })).toEqual([
      "guest",
      "member",
    ]);
    expect(level({ member: true, guest: false }, { member: false, guest: true })).toEqual([
      "member",
      "guest",
    ]);
    expect(level({ member: true, guest: false }, { member: false, guest: false })).toEqual([
      "member",
      "none",
    ]);
    expect(level({ member: false, guest: true }, { member: false, guest: false })).toEqual([
      "guest",
      "none",
    ]);
    // Only the flags that changed move; the reasons come with them.
    const rank = entryFor(
      "2",
      state(
        { member: true, guest: false, officer: false, leader: true },
        { member: true, guest: false, officer: true, leader: false },
        { reasons: { officer: "officer_override", leader: "no_fc_leader" } },
      ),
    );
    expect(rank).toEqual({
      user: "2",
      joined: JOINED,
      from: flags({ member: true, guest: false, officer: false, leader: true }),
      to: flags({ member: true, guest: false, officer: true, leader: false }),
      reasons: { officer: "officer_override", leader: "no_fc_leader" },
      departed: [],
    });
    const alt = entryFor("3", addDeparture(null, departure("77")));
    expect(alt).toEqual({
      user: "3",
      joined: null,
      from: flags(),
      to: flags(),
      reasons: {},
      departed: [departure("77")],
    });
    expect(alt && entryVisible(alt)).toBe(true);
    expect(entryFor("4", state({ member: true, guest: false }))).toBeNull();
  });

  test("a Member or Guest move that keeps the level has no line of its own", () => {
    const entry = entryFor(
      "5",
      state({ member: true, guest: false }, { member: true, guest: true }),
    );
    expect(entry && entryVisible(entry)).toBe(false);
  });

  test("the mark announces what was posted and keeps later changes and departures", () => {
    const frozen = state(
      { member: true, guest: false, officer: true },
      { member: false, guest: true, officer: true },
      { reasons: { member: "not_in_fc", guest: "former_member" }, departed: [departure("1")] },
    );
    const entry = entryFor("9", frozen);
    if (!entry) throw new Error("Missing entry");
    // In flight: Officer is revoked and a second alt leaves.
    const later: StatusState = {
      ...frozen,
      current: { ...frozen.current, officer: false },
      reasons: { ...frozen.reasons, officer: "officer_revoked" },
      departed: [departure("1"), departure("2", "s2")],
    };
    const marked = applyPosted(later, entry);
    expect(marked).toEqual({
      joined: JOINED,
      announced: flags({ member: false, guest: true, officer: true }),
      current: flags({ member: false, guest: true, officer: false }),
      reasons: { officer: "officer_revoked" },
      departed: [departure("2", "s2")],
    });
    expect(isPending(marked)).toBe(true);
    // Everything posted and nothing new: nothing waits.
    expect(isPending(applyPosted(frozen, entry))).toBe(false);
  });

  test("a flag unbound while the post was in flight stays null", () => {
    const frozen = state(
      { officer: false },
      { officer: true },
      { reasons: { officer: "officer_rank" } },
    );
    const entry = entryFor("9", frozen);
    if (!entry) throw new Error("Missing entry");
    const unbound = observe(frozen, pass({}), JOINED).next;
    expect(applyPosted(unbound, entry)).toEqual(state({}));
  });

  test("a rejoin while the post was in flight keeps the new baseline and drops posted departures", () => {
    const frozen = state(
      { member: true, guest: false },
      { member: false, guest: true },
      { reasons: { member: "not_in_fc", guest: "former_member" }, departed: [departure("1")] },
    );
    const entry = entryFor("9", frozen);
    if (!entry) throw new Error("Missing entry");
    // The member left and rejoined; the first pass of the new join sees them back in the FC.
    const rejoined = observe(
      frozen,
      pass({ member: seen(true, true, "in_fc"), guest: seen(false, true, "is_member") }),
      "2026-03-01T00:00:00.000Z",
    ).next;
    const marked = applyPosted(rejoined, entry);
    expect(marked).toEqual({
      joined: "2026-03-01T00:00:00.000Z",
      announced: flags({ member: true, guest: false }),
      current: flags({ member: true, guest: false }),
      reasons: {},
      departed: [],
    });
    // The next pass of the new join finds nothing to post: no false "Member → Guest".
    const next = observe(
      marked,
      pass({ member: seen(true, true, "in_fc"), guest: seen(false, true, "is_member") }),
      "2026-03-01T00:00:00.000Z",
    );
    expect(next).toMatchObject({ changed: false, pending: false, moved: false });
  });

  test("with no channel, what waits becomes announced and departures are dropped", () => {
    const waiting = state(
      { member: true, guest: false, leader: true },
      { member: false, guest: true, leader: false },
      {
        reasons: { member: "no_fc", guest: "registered", leader: "no_fc" },
        departed: [departure("1")],
      },
    );
    const dropped = dropPending(waiting);
    expect(dropped).toEqual(state({ member: false, guest: true, leader: false }));
    expect(isPending(dropped)).toBe(false);
  });

  test("a departure is added once per character and snapshot", () => {
    const first = addDeparture(null, departure("1"));
    expect(first).toEqual({
      joined: null,
      announced: flags(),
      current: flags(),
      reasons: {},
      departed: [departure("1")],
    });
    expect(addDeparture(first, departure("1")).departed).toHaveLength(1);
    expect(addDeparture(first, departure("1", "s2")).departed).toHaveLength(2);
    expect(STATUS_FLAGS).toEqual(["member", "guest", "officer", "leader"]);
  });
});
