/**
 * Pure policy/value regression tests: precision, role precedence, evidence timing, Unicode, and the
 * permission model's single decision point (2.44.0, RBAC).
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
  isStaff,
  MANAGERS_ONLY,
  membershipClass,
  NO_ACCESS,
  OFFICERS_ONLY,
  requireAnyPermission,
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
import { gil, id, lodestoneId, nickname } from "../../src/domain/values.js";
import { actorOf } from "../fixtures/actors.js";

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
    expect(NO_ACCESS).toEqual({ manager: false, roles: [], permissions: new Set(baseline) });
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
    expect(isStaff({ access: { manager: true, roles: [], permissions: new Set() } })).toBe(true);
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
      access: { manager: false, roles: [], permissions: new Set() },
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
