/**
 * Pure policy/value regression tests: precision, role precedence, evidence timing, Unicode, the
 * permission model's single decision point (2.44.0, RBAC), and how a pause on one person's use of
 * a feature (2.45.0) changes it: can against holds, the refusal, and its place in the order.
 */
import { describe, expect, test } from "bun:test";
import {
  type Access,
  accessFor,
  type Actor,
  authorize,
  authorizeOwner,
  can,
  departure,
  desiredAccess,
  holds,
  isStaff,
  MANAGERS_ONLY,
  membershipClass,
  NO_ACCESS,
  OFFICERS_ONLY,
  type Pause,
  pauseOn,
  pausedFailure,
  requireAnyPermission,
  requireNotPaused,
  requirePermission,
  selfServiceAccess,
} from "../../src/domain/policy.js";
import {
  PERMISSION_IDS,
  type PermissionId,
  permission,
  permissionsOfTier,
  TEMPLATES_V1,
} from "../../src/domain/rbac.js";
import { Failure, gil, id, lodestoneId, nickname } from "../../src/domain/values.js";
import { type ActorSpec, actorOf } from "../fixtures/actors.js";

test("IDs preserve unsigned 64-bit values and reject unsafe numbers", () => {
  // The unsafe Number is deliberate: adapters must reject precision that is already lost.
  expect(id("9232097761132958152")).toBe("9232097761132958152");
  for (const invalid of [Number("9232097761132958152"), "01", "0", "18446744073709551616", -1, 1.2])
    expect(() => id(invalid)).toThrow();
  expect(() => lodestoneId("https://evil.test/lodestone/character/1/", "character")).toThrow();
});
test("money is exact, bounded, and integral", () => {
  expect(gil("9223372036854775807")).toBe(9223372036854775807n);
  for (const invalid of ["9223372036854775808", "1.2", "-1", "00"])
    expect(() => gil(invalid)).toThrow();
});
test("departure needs two separated observations and reappearance resets it", () => {
  // Exact boundary instants make the two-observation rule independent of wall-clock sleeps.
  const first = new Date("2026-01-01T00:00:00Z");
  expect(departure("present", false, null, first).state).toBe("missing");
  expect(departure("missing", false, first, new Date(first.getTime() + 59999)).state).toBe(
    "missing",
  );
  expect(departure("missing", false, first, new Date(first.getTime() + 60000)).state).toBe(
    "absent",
  );
  expect(departure("missing", true, first, first)).toEqual({
    state: "present",
    firstAbsence: null,
  });
});
test("member precedence, revocation, former membership, and uncertain evidence", () => {
  const base = {
    fresh: true,
    former: true,
    grant: true,
    revoked: true,
    hasMember: false,
    hasGuest: true,
  };
  expect(desiredAccess({ ...base, membership: "member" })).toEqual({ member: true, guest: false });
  expect(desiredAccess({ ...base, membership: "ineligible" })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...base, membership: "ineligible", revoked: false })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...base, membership: "uncertain", hasMember: true })).toEqual({
    member: true,
    guest: false,
  });
  expect(desiredAccess({ ...base, membership: "member", fresh: false })).toEqual({
    member: false,
    guest: false,
  });
});
test("nickname truncation does not split graphemes or exceed Discord's limit", () => {
  // A multi-code-point astronaut is one grapheme and must be retained or removed as a whole.
  const name = `${"x".repeat(30)}👩‍🚀`;
  expect(nickname(name)).toBe("x".repeat(30));
});

test("verified visitors require current classification; revocation wins and uncertain rosters never invent access", () => {
  const visitor = {
    membership: "ineligible" as const,
    fresh: true,
    former: false,
    grant: false,
    revoked: false,
    hasMember: false,
    hasGuest: false,
    verified: true,
  };
  expect(desiredAccess(visitor)).toEqual({ member: false, guest: true });
  expect(desiredAccess({ ...visitor, verified: false })).toEqual({ member: false, guest: false });
  expect(desiredAccess({ ...visitor, revoked: true, hasGuest: true })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...visitor, fresh: false })).toEqual({ member: false, guest: false });
  expect(desiredAccess({ ...visitor, fresh: false, hasGuest: true })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...visitor, membership: "uncertain" })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...visitor, membership: "member", revoked: true })).toEqual({
    member: true,
    guest: false,
  });
});

test("FC membership is the union of trusted links", () => {
  // Counts mirror accessFacts: confirmed = present/missing links, unknown = links never evaluated.
  const counts = { fcLinked: true, confirmed: 0n, unknown: 0n, localLoss: false };
  expect(membershipClass({ ...counts, fcLinked: false, confirmed: 1n })).toBe("ineligible");
  expect(membershipClass({ ...counts, confirmed: 1n, unknown: 1n })).toBe("member");
  expect(membershipClass({ ...counts, confirmed: 1n, localLoss: true })).toBe("member");
  expect(membershipClass(counts)).toBe("ineligible");
  expect(membershipClass({ ...counts, unknown: 1n })).toBe("uncertain");
  // A local unlink of the last confirmed character stops later unevaluated links from protecting access.
  expect(membershipClass({ ...counts, unknown: 1n, localLoss: true })).toBe("ineligible");
});

test("registered users are Guest whatever their other links, and Member wins", () => {
  // `verified` means at least one active trusted link, in onboarding-enabled and -disabled guilds.
  const registered = {
    fresh: true,
    former: false,
    grant: false,
    revoked: false,
    hasMember: false,
    hasGuest: false,
    verified: true,
  };
  const union = (confirmed: bigint, unknown: bigint) =>
    membershipClass({ fcLinked: true, confirmed, unknown, localLoss: false });
  // One character present in the FC and one outside it: Member, never both roles.
  expect(desiredAccess({ ...registered, membership: union(1n, 0n) })).toEqual({
    member: true,
    guest: false,
  });
  // Two characters, both evaluated outside the FC: registered Guest from fresh evidence.
  expect(desiredAccess({ ...registered, membership: union(0n, 0n) })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...registered, membership: union(0n, 0n), revoked: true })).toEqual({
    member: false,
    guest: false,
  });
  // One absent plus one unevaluated character: uncertain, so no new Guest is created.
  expect(union(0n, 1n)).toBe("uncertain");
  expect(desiredAccess({ ...registered, membership: union(0n, 1n) })).toEqual({
    member: false,
    guest: false,
  });
});

/** The people the permission tests use; `officer: true` means the Officer role counts for them. */
const MEMBER = actorOf({ guildId: "100", userId: "400", manageRoles: false, member: true });
const GUEST = actorOf({ guildId: "100", userId: "402", manageRoles: false, guest: true });
const LOBBY = actorOf({ guildId: "100", userId: "403", manageRoles: false });
const OFFICER = actorOf({ ...MEMBER, userId: "401", officer: true });
const MANAGER = actorOf({ ...LOBBY, userId: "404", serverManager: true, manageRoles: true });

/** The refusal a call raised, or null when it was allowed. */
function refusal(run: () => void): { scope: string; permission?: string; message: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toMatchObject({ code: "forbidden", detail: { kind: "scope" } });
    const {
      detail: { kind: _kind, ...detail },
      message,
    } = error as { detail: { kind: string; scope: string; permission?: string }; message: string };
    return { ...detail, message };
  }
}
/** The scope a refusal carries, or null when the call is allowed. */
const scope = (run: () => void): string | null => refusal(run)?.scope ?? null;

test("authorization refusals name their rule in a scope detail; the decisions are unchanged", () => {
  // Allowed exactly as before: own records, officer reads of others, officer-level actions.
  expect(scope(() => authorize(MEMBER, "100"))).toBeNull();
  expect(scope(() => authorizeOwner(MEMBER, "100", "400"))).toBeNull();
  expect(scope(() => authorizeOwner(OFFICER, "100", "999"))).toBeNull();
  expect(scope(() => requirePermission(OFFICER, "100", "config.view"))).toBeNull();
  expect(scope(() => requirePermission(MANAGER, "100", "admin.grants"))).toBeNull();
  // Refused, each by its own rule.
  expect(scope(() => requirePermission(MEMBER, "100", "config.view"))).toBe("officer");
  expect(scope(() => authorizeOwner(MEMBER, "100", "999"))).toBe("owner");
  expect(scope(() => authorize(OFFICER, "101"))).toBe("test_guild");
  // Bot officer access alone never authorizes authority changes, and neither does Manage Server
  // without Manage Roles.
  expect(scope(() => requirePermission(OFFICER, "100", "admin.grants"))).toBe("manager");
  expect(
    scope(() =>
      requirePermission(
        actorOf({ ...OFFICER, officer: true, serverManager: true, manageRoles: false }),
        "100",
        "admin.grants",
      ),
    ),
  ).toBe("manager");
  // Q2 A (2.44.0): Manage Server without Manage Roles grants nothing at all; in 2.43.0 it made a
  // full bot officer.
  const manageServerOnly = actorOf({ ...LOBBY, serverManager: true, manageRoles: false });
  expect(manageServerOnly.access.manager).toBe(false);
  expect(scope(() => requirePermission(manageServerOnly, "100", "config.view"))).toBe("officer");
});

describe("access from managed roles (accessFor)", () => {
  const baseline = permissionsOfTier("baseline");
  const sorted = (access: Access): PermissionId[] => [...access.permissions].sort();
  const ids = (list: readonly PermissionId[]): PermissionId[] => [...new Set(list)].sort();

  test("everyone holds the baseline, and NO_ACCESS holds nothing more", () => {
    expect(baseline).toEqual(["characters.claim", "roster.refresh", "guests.apply", "issue.use"]);
    expect(NO_ACCESS).toEqual({
      manager: false,
      roles: [],
      permissions: new Set(baseline),
      blocked: new Map(),
    });
    expect(sorted(accessFor(false, []))).toEqual(ids(baseline));
    for (const role of ["member", "guest", "officer", "leader"] as const)
      for (const id of baseline) expect(accessFor(false, [role]).permissions.has(id)).toBe(true);
  });

  test("each role carries its template, plus the baseline", () => {
    for (const role of ["member", "guest", "officer", "leader"] as const)
      expect(sorted(accessFor(false, [role]))).toEqual(ids([...baseline, ...TEMPLATES_V1[role]]));
    // FC Leader carries no permission in this release.
    expect(sorted(accessFor(false, ["leader"]))).toEqual(ids(baseline));
    // Roles add up.
    expect(sorted(accessFor(false, ["officer", "guest"]))).toEqual(
      ids([...baseline, ...TEMPLATES_V1.officer, ...TEMPLATES_V1.guest]),
    );
  });

  test("server managers hold everything except the member-side permissions", () => {
    const memberSide = PERMISSION_IDS.filter((id) => permission(id).memberSide === true);
    expect(memberSide).toEqual(["modmail.open", "suggest.use"]);
    const manager = accessFor(true, []);
    expect(manager.manager).toBe(true);
    expect(manager.roles).toEqual([]);
    expect(sorted(manager)).toEqual(ids(PERMISSION_IDS.filter((id) => !memberSide.includes(id))));
    // Those follow the manager's own Member or Guest role, as in 2.43.0.
    expect(sorted(accessFor(true, ["member"]))).toEqual(ids(PERMISSION_IDS));
    expect(sorted(accessFor(true, ["guest"]))).toEqual(ids(PERMISSION_IDS));
  });

  test("the tier rule is applied again, so a template naming a forbidden tier grants nothing", () => {
    // Simulate a mistaken template (later, a stored set): staff and fixed permissions on Member.
    const member = TEMPLATES_V1.member as PermissionId[];
    const saved = [...member];
    member.push("config.view", "admin.grants");
    try {
      const access = accessFor(false, ["member"]);
      expect(access.permissions.has("config.view")).toBe(false);
      expect(access.permissions.has("admin.grants")).toBe(false);
      expect(sorted(access)).toEqual(ids([...baseline, ...saved]));
      expect(isStaff({ access })).toBe(false);
    } finally {
      member.splice(0, member.length, ...saved);
    }
    expect(TEMPLATES_V1.member).toEqual(saved);
  });

  test("a role listed twice counts once", () => {
    const access = accessFor(false, ["member", "member", "guest", "member"]);
    expect(access.roles).toEqual(["member", "guest"]);
    expect(sorted(access)).toEqual(sorted(accessFor(false, ["guest", "member"])));
  });
});

describe("the decision point (can, isStaff, requirePermission)", () => {
  test("can reads the actor's own permissions", () => {
    expect(can(MEMBER, "ledger.deposit")).toBe(true);
    expect(can(MEMBER, "config.view")).toBe(false);
    expect(can(GUEST, "ledger.view")).toBe(false);
    expect(can(GUEST, "suggest.use")).toBe(true);
    expect(can(LOBBY, "issue.use")).toBe(true);
    expect(can(LOBBY, "selfroles.use")).toBe(false);
    expect(can(OFFICER, "ledger.withdraw")).toBe(true);
    expect(can(OFFICER, "admin.links")).toBe(false);
    expect(can(MANAGER, "admin.links")).toBe(true);
    expect(can(MANAGER, "suggest.use")).toBe(false);
  });

  test("staff is anyone holding a staff or fixed permission, and every manager", () => {
    expect(isStaff(OFFICER)).toBe(true);
    expect(isStaff(MANAGER)).toBe(true);
    for (const actor of [MEMBER, GUEST, LOBBY]) expect(isStaff(actor)).toBe(false);
    expect(isStaff({ access: NO_ACCESS })).toBe(false);
    expect(isStaff({ access: accessFor(false, ["leader"]) })).toBe(false);
    // A manager is staff by the flag alone, even with no permission set.
    expect(
      isStaff({ access: { manager: true, roles: [], permissions: new Set(), blocked: new Map() } }),
    ).toBe(true);
  });

  test("each tier refuses with its own scope and message, naming the permission", () => {
    expect(refusal(() => requirePermission(OFFICER, "100", "admin.fc"))).toEqual({
      scope: "manager",
      permission: "admin.fc",
      message: MANAGERS_ONLY,
    });
    expect(refusal(() => requirePermission(MEMBER, "100", "modmail.inbox"))).toEqual({
      scope: "officer",
      permission: "modmail.inbox",
      message: OFFICERS_ONLY,
    });
    expect(refusal(() => requirePermission(GUEST, "100", "ledger.view"))).toEqual({
      scope: "membership",
      permission: "ledger.view",
      message: "Your roles in this server don't include this.",
    });
    // Baseline permissions are stopped only per person (2.45.0); without one, membership wording.
    const stopped: Actor = {
      ...LOBBY,
      access: { manager: false, roles: [], permissions: new Set(), blocked: new Map() },
    };
    expect(refusal(() => requirePermission(stopped, "100", "issue.use"))).toEqual({
      scope: "membership",
      permission: "issue.use",
      message: "Your roles in this server don't include this.",
    });
  });

  test("a throw site's own approved wording replaces the default, keeping the scope", () => {
    const custom = "Only officers can force a refresh.";
    for (const [actor, id, expected] of [
      [OFFICER, "admin.links", "manager"],
      [MEMBER, "roster.refresh_force", "officer"],
      [GUEST, "ledger.deposit", "membership"],
    ] as const)
      expect(refusal(() => requirePermission(actor, "100", id, custom))).toEqual({
        scope: expected,
        permission: id,
        message: custom,
      });
  });

  test("the guild check comes first, even for a permission the actor holds", () => {
    expect(refusal(() => requirePermission(MANAGER, "101", "admin.fc"))).toEqual({
      scope: "test_guild",
      message: "That record belongs to another server.",
    });
    expect(scope(() => requirePermission(MANAGER, "100", "admin.fc"))).toBeNull();
    expect(scope(() => requirePermission(LOBBY, "100", "characters.claim"))).toBeNull();
  });
});

describe("guild and owner checks", () => {
  test("authorize takes exactly the actor and the guild", () => {
    // 2.43.0's level argument is gone: a leftover level string must fail to compile.
    expect(authorize.length).toBe(2);
    expect(scope(() => authorize(LOBBY, "100"))).toBeNull();
    expect(scope(() => authorize(MANAGER, "101"))).toBe("test_guild");
  });

  test("your own records need nothing; someone else's need members.view", () => {
    for (const actor of [MEMBER, GUEST, LOBBY])
      expect(scope(() => authorizeOwner(actor, "100", actor.userId))).toBeNull();
    for (const actor of [MEMBER, GUEST, LOBBY])
      expect(refusal(() => authorizeOwner(actor, "100", "999"))).toEqual({
        scope: "owner",
        permission: "members.view",
        message: "You can view only your own records. Officers can look up other members.",
      });
    expect(scope(() => authorizeOwner(OFFICER, "100", "999"))).toBeNull();
    expect(scope(() => authorizeOwner(MANAGER, "100", "999"))).toBeNull();
    // Another server's record is refused even when it is your own.
    expect(scope(() => authorizeOwner(MEMBER, "101", "400"))).toBe("test_guild");
  });
});

describe("the router's any-of gate (requireAnyPermission)", () => {
  test("an empty list admits any human member of the guild", () => {
    expect(scope(() => requireAnyPermission(LOBBY, "100", []))).toBeNull();
    expect(
      scope(() => requireAnyPermission({ ...LOBBY, access: NO_ACCESS }, "100", [])),
    ).toBeNull();
    expect(scope(() => requireAnyPermission(LOBBY, "101", []))).toBe("test_guild");
  });

  test("any one listed permission admits", () => {
    expect(
      scope(() => requireAnyPermission(MEMBER, "100", ["config.view", "ledger.view"])),
    ).toBeNull();
    expect(
      scope(() => requireAnyPermission(OFFICER, "100", ["admin.fc", "config.view"])),
    ).toBeNull();
    expect(scope(() => requireAnyPermission(MANAGER, "100", ["admin.grants"]))).toBeNull();
  });

  test("a refusal speaks for the first permission that isn't fixed", () => {
    // /config admits officers too, so a member is told "officers only", not "managers only".
    expect(
      refusal(() =>
        requireAnyPermission(MEMBER, "100", ["admin.fc", "config.view", "config.channels"]),
      ),
    ).toEqual({ scope: "officer", permission: "config.view", message: OFFICERS_ONLY });
    expect(
      refusal(() => requireAnyPermission(GUEST, "100", ["admin.roles", "ledger.view"])),
    ).toEqual({
      scope: "membership",
      permission: "ledger.view",
      message: "Your roles in this server don't include this.",
    });
  });

  test("a module open to server managers alone refuses as managers only", () => {
    // /officer and /setup.
    expect(refusal(() => requireAnyPermission(OFFICER, "100", ["admin.grants"]))).toEqual({
      scope: "manager",
      permission: "admin.grants",
      message: MANAGERS_ONLY,
    });
    expect(refusal(() => requireAnyPermission(MEMBER, "100", ["admin.setup", "admin.fc"]))).toEqual(
      { scope: "manager", permission: "admin.setup", message: MANAGERS_ONLY },
    );
  });
});

describe("member self-service (selfServiceAccess, owner decisions Q6 A and A2)", () => {
  const free = { botAdministrator: false } as const;
  test("Member and Guest holders need TaruBot to hold no Administrator, known for sure", () => {
    for (const actor of [MEMBER, GUEST]) {
      expect(selfServiceAccess({ ...actor, ...free })).toBe(true);
      expect(selfServiceAccess({ ...actor, botAdministrator: true })).toBe(false);
      // Unknown (an actor resolved without TaruBot's own member) counts as holding it.
      expect(selfServiceAccess(actor)).toBe(false);
    }
  });

  test("staff are never held back by the A2 gate", () => {
    for (const actor of [OFFICER, MANAGER]) {
      expect(selfServiceAccess({ ...actor, botAdministrator: true })).toBe(true);
      expect(selfServiceAccess(actor)).toBe(true);
    }
  });

  test("without selfroles.use nobody qualifies, and a time-out changes nothing here", () => {
    expect(selfServiceAccess({ ...LOBBY, ...free })).toBe(false);
    // Manage Server alone grants nothing (Q2 A).
    expect(selfServiceAccess({ ...actorOf({ ...LOBBY, serverManager: true }), ...free })).toBe(
      false,
    );
    // FC Leader carries no permission in this release.
    expect(selfServiceAccess({ ...LOBBY, ...free, access: accessFor(false, ["leader"]) })).toBe(
      false,
    );
    expect(selfServiceAccess({ ...MEMBER, ...free, timedOut: true })).toBe(true);
  });
});

describe("pauses on one person's use of a feature (2.45.0)", () => {
  const ENDS = new Date("2026-10-19T12:00:00.000Z");
  const REASON = "Please wait a week before suggesting more.";
  /** A week-long pause, as the resolver reads it from the database. */
  const week: Pause = { until: ENDS, reason: REASON };
  /** One that lasts until an officer lifts it. */
  const open: Pause = { until: null, reason: "Under review." };
  /** The refusal a pause gives, as `refusal` reports it. */
  const blockedBy = (id: PermissionId, pause: Pause = week) => ({
    scope: "blocked",
    permission: id,
    ...(pause.until && { until: pause.until }),
    reason: pause.reason,
    message: "Your use of this feature here is paused.",
  });
  const paused = (spec: NonNullable<ActorSpec["paused"]>, extra = {}): Actor =>
    actorOf({
      guildId: "100",
      userId: "405",
      manageRoles: false,
      member: true,
      ...extra,
      paused: spec,
    });

  describe("accessFor keeps the pauses on what the person holds", () => {
    test("a pause on a held permission is recorded, and leaves the permission held", () => {
      const access = accessFor(false, ["member"], new Map([["suggest.use", week]]));
      expect(access.blocked.get("suggest.use")).toEqual(week);
      expect([...access.blocked.keys()]).toEqual(["suggest.use"]);
      // Deny-only: the held set is what the roles gave, untouched; the pause is read apart.
      expect(access.permissions.has("suggest.use")).toBe(true);
      expect(sortedIds(access)).toEqual(sortedIds(accessFor(false, ["member"])));
      // Its own map, so a caller changing theirs afterwards changes nothing here.
      const given = new Map<PermissionId, Pause>([["suggest.use", week]]);
      const made = accessFor(false, ["member"], given);
      given.set("issue.use", open);
      expect([...made.blocked.keys()]).toEqual(["suggest.use"]);
    });

    test("a pause on a permission the person doesn't hold is dropped", () => {
      // A Guest holds no ledger; the lobby holds no Member features; a Member holds no staff ones.
      expect(accessFor(false, ["guest"], new Map([["ledger.view", week]])).blocked.size).toBe(0);
      expect(accessFor(false, [], new Map([["suggest.use", week]])).blocked.size).toBe(0);
      expect(accessFor(false, ["member"], new Map([["config.view", week]])).blocked.size).toBe(0);
      expect(accessFor(false, ["member"], new Map([["admin.fc", week]])).blocked.size).toBe(0);
      // Only the held one of two is kept.
      const access = accessFor(
        false,
        ["guest"],
        new Map([
          ["ledger.view", week],
          ["suggest.use", open],
        ]),
      );
      expect([...access.blocked]).toEqual([["suggest.use", open]]);
    });

    test("the baseline is held by everyone, so a pause on it always applies", () => {
      for (const roles of [[], ["member"], ["guest"], ["officer"]] as const)
        for (const id of permissionsOfTier("baseline"))
          expect(accessFor(false, roles, new Map([[id, open]])).blocked.get(id)).toEqual(open);
    });

    test("server managers can't be paused, whatever is stored", () => {
      const everything = new Map<PermissionId, Pause>(PERMISSION_IDS.map((id) => [id, week]));
      for (const roles of [[], ["member"], ["guest"], ["officer"]] as const) {
        const access = accessFor(true, roles, everything);
        expect(access.blocked.size).toBe(0);
        // Nothing a manager held is gone: with pauses ignored, the set is the unpaused set.
        expect(sortedIds(access)).toEqual(sortedIds(accessFor(true, roles)));
      }
      // A manager who is also a Member still suggests, and still opens mod mail.
      const member = actorOf({
        guildId: "100",
        userId: "406",
        manageRoles: true,
        serverManager: true,
        member: true,
        paused: { "suggest.use": week, "modmail.open": week, "issue.use": week },
      });
      for (const id of ["suggest.use", "modmail.open", "issue.use"] as const) {
        expect(can(member, id)).toBe(true);
        expect(pauseOn(member, id)).toBeUndefined();
      }
    });

    test("no pauses is the default, and NO_ACCESS carries none", () => {
      expect(accessFor(false, ["member"]).blocked).toEqual(new Map());
      expect(accessFor(true, []).blocked).toEqual(new Map());
      expect(NO_ACCESS.blocked.size).toBe(0);
    });

    test("accessFor doesn't judge the pause itself: expiry is the database's, and any held id applies", () => {
      // The end time is compared on the database clock when pauses are read (ACTIVE_BLOCK), so
      // what arrives here is active; a date in the past is still kept, not second-guessed.
      const lapsed: Pause = { until: new Date("2020-01-01T00:00:00.000Z"), reason: "Old." };
      expect(accessFor(false, ["member"], new Map([["suggest.use", lapsed]])).blocked.size).toBe(1);
      // Which ids may be paused is the application's rule (BLOCKABLE); the policy is general, so
      // pausing a staff permission later needs no change here.
      const officer = accessFor(false, ["officer"], new Map([["modmail.respond", week]]));
      expect(officer.blocked.has("modmail.respond")).toBe(true);
    });
  });

  describe("can, holds and pauseOn", () => {
    test("a pause removes the use and not the permission", () => {
      const actor = paused({ "suggest.use": { until: ENDS, reason: REASON } });
      expect(holds(actor, "suggest.use")).toBe(true);
      expect(can(actor, "suggest.use")).toBe(false);
      expect(pauseOn(actor, "suggest.use")).toEqual(week);
      // Everything else about the person is as it was.
      expect(can(actor, "ledger.deposit")).toBe(true);
      expect(can(actor, "modmail.open")).toBe(true);
      expect(can(actor, "issue.use")).toBe(true);
      expect(pauseOn(actor, "ledger.deposit")).toBeUndefined();
    });

    test("an unpaused person is unchanged: can and holds agree, and there is no pause", () => {
      for (const actor of [MEMBER, GUEST, LOBBY, OFFICER, MANAGER])
        for (const id of PERMISSION_IDS) {
          expect(can(actor, id)).toBe(holds(actor, id));
          expect(pauseOn(actor, id)).toBeUndefined();
        }
    });

    test("holds is false for what the person was never given, paused or not", () => {
      const actor = paused({ "ledger.view": week }, { member: false, guest: true });
      expect(holds(actor, "ledger.view")).toBe(false);
      expect(can(actor, "ledger.view")).toBe(false);
      expect(pauseOn(actor, "ledger.view")).toBeUndefined();
    });

    test("an end of null lasts until lifted, and the pause carries its reason as given", () => {
      const actor = paused({ "issue.use": { reason: "Report spam." } });
      expect(pauseOn(actor, "issue.use")).toEqual({ until: null, reason: "Report spam." });
      expect(can(actor, "issue.use")).toBe(false);
    });

    test("a pause is read from the actor's own access, with no other field of it", () => {
      const access = accessFor(false, ["member"], new Map([["suggest.use", week]]));
      expect(can({ access }, "suggest.use")).toBe(false);
      expect(holds({ access }, "suggest.use")).toBe(true);
      expect(pauseOn({ access }, "suggest.use")).toEqual(week);
    });
  });

  describe("the refusal (pausedFailure, requireNotPaused)", () => {
    test("it names the feature, the end and the reason, and is a scope refusal", () => {
      const failure = pausedFailure("suggest.use", week);
      expect(failure).toBeInstanceOf(Failure);
      expect(failure).toMatchObject({
        code: "forbidden",
        message: "Your use of this feature here is paused.",
        retryAfter: 0,
        detail: {
          kind: "scope",
          scope: "blocked",
          permission: "suggest.use",
          until: ENDS,
          reason: REASON,
        },
      });
    });

    test("an open-ended pause has no end at all, rather than an empty one", () => {
      const detail = pausedFailure("modmail.open", open).detail;
      expect(detail).toEqual({
        kind: "scope",
        scope: "blocked",
        permission: "modmail.open",
        reason: "Under review.",
      });
      expect(Object.hasOwn(detail ?? {}, "until")).toBe(false);
    });

    test("it never says who set the pause (owner decision Q5 A)", () => {
      // The Pause type has no such field, so a stored issuer can't reach the reply by this route.
      const failure = pausedFailure("suggest.use", {
        ...week,
        issuer: "400000000000000001",
      } as Pause);
      expect(Object.keys(failure.detail ?? {}).sort()).toEqual([
        "kind",
        "permission",
        "reason",
        "scope",
        "until",
      ]);
      expect(JSON.stringify(failure.detail)).not.toContain("400000000000000001");
    });

    test("requireNotPaused passes for anything not paused and throws for what is", () => {
      const actor = paused({ "suggest.use": week });
      expect(() => requireNotPaused(actor, "suggest.use")).toThrow(Failure);
      expect(refusal(() => requireNotPaused(actor, "suggest.use"))).toEqual(
        blockedBy("suggest.use"),
      );
      // Only the named feature: the person's other features are not checked.
      expect(() => requireNotPaused(actor, "ledger.deposit")).not.toThrow();
      expect(() => requireNotPaused(actor, "modmail.open")).not.toThrow();
      // It judges pauses only: a missing permission is requirePermission's refusal, not this.
      expect(() => requireNotPaused(LOBBY, "suggest.use")).not.toThrow();
      expect(() => requireNotPaused({ access: NO_ACCESS }, "admin.fc")).not.toThrow();
    });

    test("the thrown failure is what pausedFailure builds from the actor's own pause", () => {
      const actor = paused({ "ledger.deposit": open });
      let thrown: unknown;
      try {
        requireNotPaused(actor, "ledger.deposit");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "forbidden",
        detail: pausedFailure("ledger.deposit", open).detail,
      });
    });
  });

  describe("requirePermission reports a pause before anything else but the server", () => {
    test("a member-tier feature is a pause, not a missing role", () => {
      const actor = paused({ "suggest.use": week });
      expect(refusal(() => requirePermission(actor, "100", "suggest.use"))).toEqual(
        blockedBy("suggest.use"),
      );
      // The same call for a person who merely lacks the role is the membership card.
      expect(scope(() => requirePermission(LOBBY, "100", "suggest.use"))).toBe("membership");
      // And one unpaused feature of the same person passes.
      expect(scope(() => requirePermission(actor, "100", "ledger.deposit"))).toBeNull();
    });

    test("a baseline feature is a pause for a person who held it", () => {
      const actor = actorOf({
        guildId: "100",
        userId: "407",
        manageRoles: false,
        paused: { "characters.claim": open },
      });
      expect(scope(() => requirePermission(actor, "100", "characters.claim"))).toBe("blocked");
      expect(scope(() => requirePermission(actor, "100", "issue.use"))).toBeNull();
    });

    test("a staff permission reports the pause ahead of the officers-only card", () => {
      const officer = actorOf({
        guildId: "100",
        userId: "408",
        manageRoles: false,
        member: true,
        officer: true,
        paused: { "guests.decide": week },
      });
      expect(scope(() => requirePermission(officer, "100", "guests.decide"))).toBe("blocked");
      expect(scope(() => requirePermission(officer, "100", "guests.manage"))).toBeNull();
    });

    test("a pause comes first even where the permission is missing too, for every tier", () => {
      // A hand-built access: accessFor never keeps a pause on a permission that isn't held, but
      // the order is the point, so each tier is checked with the permission absent.
      for (const id of ["admin.fc", "config.view", "ledger.view", "issue.use"] as const) {
        const access: Access = {
          manager: false,
          roles: [],
          permissions: new Set(),
          blocked: new Map([[id, week]]),
        };
        const actor: Actor = { ...LOBBY, access };
        expect(refusal(() => requirePermission(actor, "100", id))).toEqual(blockedBy(id));
        // Without the pause, the same absence is the tier's own refusal.
        const without = { ...actor, access: { ...access, blocked: new Map() } };
        expect(scope(() => requirePermission(without, "100", id))).not.toBe("blocked");
      }
    });

    test("a throw site's own wording never replaces the pause's", () => {
      const actor = paused({ "suggest.use": week });
      expect(
        refusal(() => requirePermission(actor, "100", "suggest.use", "Only members can do that.")),
      ).toEqual(blockedBy("suggest.use"));
    });

    test("the guild check still comes first", () => {
      const actor = paused({ "suggest.use": week });
      expect(refusal(() => requirePermission(actor, "101", "suggest.use"))).toEqual({
        scope: "test_guild",
        message: "That record belongs to another server.",
      });
    });

    test("a pause refuses nobody else, and a lifted pause refuses nobody", () => {
      expect(scope(() => requirePermission(MEMBER, "100", "suggest.use"))).toBeNull();
      expect(scope(() => requirePermission(paused({}), "100", "suggest.use"))).toBeNull();
      expect(scope(() => requirePermission(MANAGER, "100", "admin.fc"))).toBeNull();
    });
  });

  describe("the pages and the routers read what is held", () => {
    test("a paused holder of My roles still qualifies for the page", () => {
      const free = { botAdministrator: false } as const;
      const actor = paused({ "selfroles.use": week }, free);
      expect(can(actor, "selfroles.use")).toBe(false);
      expect(holds(actor, "selfroles.use")).toBe(true);
      // selfServiceAccess is the page's admission and the save's re-check; the pause itself is
      // SelfRoles.choose's own refusal, so a paused person opens the page and cannot save.
      expect(selfServiceAccess(actor)).toBe(true);
      // The A2 gate applies as before.
      expect(selfServiceAccess({ ...actor, botAdministrator: true })).toBe(false);
      expect(selfServiceAccess(paused({ "selfroles.use": week }))).toBe(false);
      // A pause on another feature changes nothing about it.
      expect(selfServiceAccess(paused({ "suggest.use": week }, free))).toBe(true);
      // And a person who never held it is still refused.
      expect(selfServiceAccess({ ...LOBBY, ...free })).toBe(false);
    });

    test("isStaff reads what is held, so pausing a feature never makes an officer a member", () => {
      const officer = actorOf({
        guildId: "100",
        userId: "408",
        manageRoles: false,
        officer: true,
        paused: { "ledger.audit": week, "selfroles.use": week },
      });
      expect(isStaff(officer)).toBe(true);
      expect(isStaff(paused({ "suggest.use": week }))).toBe(false);
    });

    test("requireAnyPermission uses can: an empty list admits, a held unpaused id admits, a lone paused id refuses", () => {
      const actor = paused({ "ledger.view": week, "suggest.use": week });
      // No declared permission: any human, paused or not.
      expect(scope(() => requireAnyPermission(actor, "100", []))).toBeNull();
      // One id still usable beside the paused one.
      expect(
        scope(() => requireAnyPermission(actor, "100", ["ledger.view", "ledger.deposit"])),
      ).toBeNull();
      // Only paused ids: the refusal is the pause.
      expect(refusal(() => requireAnyPermission(actor, "100", ["ledger.view"]))).toEqual(
        blockedBy("ledger.view"),
      );
      expect(scope(() => requireAnyPermission(actor, "100", ["suggest.use", "ledger.view"]))).toBe(
        "blocked",
      );
      // The guild check first.
      expect(scope(() => requireAnyPermission(actor, "101", []))).toBe("test_guild");
    });

    test("authorizeOwner needs a usable members.view, not just a held one", () => {
      const officer = actorOf({
        guildId: "100",
        userId: "408",
        manageRoles: false,
        officer: true,
        paused: { "members.view": week },
      });
      expect(refusal(() => authorizeOwner(officer, "100", "999"))?.scope).toBe("owner");
      expect(scope(() => authorizeOwner(officer, "100", officer.userId))).toBeNull();
    });
  });
});

/** The held permissions of an access, sorted. */
function sortedIds(access: Access): PermissionId[] {
  return [...access.permissions].sort();
}
