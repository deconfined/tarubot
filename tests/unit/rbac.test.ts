/**
 * TaruBot's permission catalog (2.44.0, RBAC): the catalog's shape, the pinned id list (stored
 * sets and blocks name these ids from 2.45.0, so one is never renamed or reused), the code
 * templates and the tier rule they obey, and the module declaration check.
 */
import { describe, expect, test } from "bun:test";
import {
  isPermissionId,
  type ManagedRole,
  modulePermissions,
  PERMISSION_AREAS,
  PERMISSION_IDS,
  PERMISSIONS,
  type PermissionId,
  type PermissionTier,
  permission,
  permissionsOfTier,
  ROLE_TIERS,
  TEMPLATES_V1,
} from "../../src/domain/rbac.js";

const ROLES: readonly ManagedRole[] = ["member", "guest", "officer", "leader"];
const TIERS: readonly PermissionTier[] = ["fixed", "staff", "member", "baseline"];

describe("the catalog", () => {
  test("every entry is well formed", () => {
    expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
    expect(PERMISSION_IDS).toEqual(Object.keys(PERMISSIONS) as PermissionId[]);
    expect(Object.isFrozen(PERMISSION_IDS)).toBe(true);
    for (const id of PERMISSION_IDS) {
      expect(id).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      const spec = permission(id);
      expect(spec).toBe(PERMISSIONS[id]);
      expect(PERMISSION_AREAS).toContain(spec.area);
      expect(["read", "write"]).toContain(spec.kind);
      expect(TIERS).toContain(spec.tier);
      expect(typeof spec.label).toBe("string");
      expect(spec.label.trim().length).toBeGreaterThan(0);
      if ("memberSide" in spec) expect(spec.memberSide).toBe(true);
    }
  });

  test("the ids, their tiers and their order are pinned", () => {
    // Adding a permission needs a surface that checks it; renaming one would orphan stored sets.
    const pinned: Readonly<Record<string, PermissionTier>> = {
      "admin.fc": "fixed",
      "admin.roles": "fixed",
      "admin.ranks": "fixed",
      "admin.grants": "fixed",
      "admin.links": "fixed",
      "admin.setup": "fixed",
      "config.view": "staff",
      "config.channels": "staff",
      "config.officer_channel": "staff",
      "config.guest_applications": "staff",
      "members.view": "staff",
      "characters.assign": "staff",
      "characters.unassign": "staff",
      "characters.claim": "baseline",
      "sync.view_all": "staff",
      "roster.refresh": "baseline",
      "roster.refresh_force": "staff",
      "guests.apply": "baseline",
      "guests.decide": "staff",
      "guests.manage": "staff",
      "ledger.view": "member",
      "ledger.deposit": "member",
      "ledger.audit": "staff",
      "ledger.withdraw": "staff",
      "ledger.adjust": "staff",
      "ledger.initialize": "staff",
      "modmail.open": "member",
      "modmail.inbox": "staff",
      "modmail.read_log": "staff",
      "modmail.respond": "staff",
      "modmail.settings": "staff",
      "rolemenu.view": "staff",
      "rolemenu.edit": "staff",
      "rolemenu.publish": "staff",
      "selfroles.use": "member",
      "suggest.use": "member",
      "issue.use": "baseline",
    };
    expect(Object.fromEntries(PERMISSION_IDS.map((id) => [id, PERMISSIONS[id].tier]))).toEqual(
      pinned,
    );
    // toEqual ignores key order; the catalog order is the dashboard's, so pin it too.
    expect([...PERMISSION_IDS]).toEqual(Object.keys(pinned) as PermissionId[]);
  });

  test("only /suggest and opening mod mail are member-side", () => {
    // Server managers don't hold these implicitly; they follow the manager's own roles.
    expect(PERMISSION_IDS.filter((id) => permission(id).memberSide === true)).toEqual([
      "modmail.open",
      "suggest.use",
    ]);
  });

  test("the fixed permissions are exactly Server setup", () => {
    for (const id of PERMISSION_IDS)
      expect(PERMISSIONS[id].tier === "fixed").toBe(PERMISSIONS[id].area === "Server setup");
  });

  test("the tiers partition the catalog, each in catalog order", () => {
    const byTier = TIERS.flatMap((tier) => permissionsOfTier(tier));
    expect([...byTier].sort()).toEqual([...PERMISSION_IDS].sort());
    for (const tier of TIERS)
      expect(permissionsOfTier(tier)).toEqual(
        PERMISSION_IDS.filter((id) => PERMISSIONS[id].tier === tier),
      );
  });

  test("isPermissionId accepts known ids only", () => {
    for (const id of PERMISSION_IDS) expect(isPermissionId(id)).toBe(true);
    for (const value of [
      "admin",
      "admin.everything",
      "Admin.fc",
      " admin.fc",
      "",
      "toString",
      "__proto__",
      "constructor",
      null,
      undefined,
      1,
      ["admin.fc"],
      { id: "admin.fc" },
    ])
      expect(isPermissionId(value)).toBe(false);
  });
});

describe("roles and templates (owner decision 1)", () => {
  test("each managed role may carry only its tiers; fixed and baseline sit on no role", () => {
    expect(ROLE_TIERS).toEqual({
      member: ["member"],
      guest: ["member"],
      officer: ["staff", "member"],
      leader: ["staff", "member"],
    });
    for (const role of ROLES) {
      expect(ROLE_TIERS[role]).not.toContain("fixed");
      expect(ROLE_TIERS[role]).not.toContain("baseline");
    }
  });

  test("the templates are pinned", () => {
    expect(TEMPLATES_V1).toEqual({
      officer: [
        "config.view",
        "config.channels",
        "config.officer_channel",
        "config.guest_applications",
        "members.view",
        "characters.assign",
        "characters.unassign",
        "sync.view_all",
        "roster.refresh_force",
        "guests.decide",
        "guests.manage",
        "ledger.audit",
        "ledger.withdraw",
        "ledger.adjust",
        "ledger.initialize",
        "modmail.inbox",
        "modmail.read_log",
        "modmail.respond",
        "modmail.settings",
        "rolemenu.view",
        "rolemenu.edit",
        "rolemenu.publish",
        "ledger.view",
        "ledger.deposit",
        "selfroles.use",
      ],
      member: ["ledger.view", "ledger.deposit", "modmail.open", "selfroles.use", "suggest.use"],
      guest: ["modmail.open", "selfroles.use", "suggest.use"],
      leader: [],
    });
  });

  test("each template holds only tiers its role may carry, once each", () => {
    for (const role of ROLES) {
      const template = TEMPLATES_V1[role];
      expect(new Set(template).size).toBe(template.length);
      for (const id of template) expect(ROLE_TIERS[role]).toContain(PERMISSIONS[id].tier);
    }
  });

  test("Officer is every staff permission plus the member features officers used", () => {
    // It leaves out /suggest and opening mod mail: officers reach those only through Member or
    // Guest, as in 2.43.0.
    expect([...TEMPLATES_V1.officer].sort()).toEqual(
      [
        ...permissionsOfTier("staff"),
        "ledger.view",
        "ledger.deposit",
        "selfroles.use",
      ].sort() as PermissionId[],
    );
    for (const id of TEMPLATES_V1.officer) expect(permission(id).memberSide).toBeUndefined();
  });

  test("Member and Guest differ only by the ledger, and FC Leader carries nothing", () => {
    expect(TEMPLATES_V1.member.filter((id) => !TEMPLATES_V1.guest.includes(id))).toEqual([
      "ledger.view",
      "ledger.deposit",
    ]);
    for (const id of TEMPLATES_V1.guest) expect(TEMPLATES_V1.member).toContain(id);
    expect(TEMPLATES_V1.leader).toEqual([]);
  });
});

describe("module declarations (modulePermissions)", () => {
  test("known ids pass as a frozen copy; none means an empty list", () => {
    const declared: PermissionId[] = ["config.view", "admin.fc"];
    const checked = modulePermissions(declared);
    expect(checked).toEqual(["config.view", "admin.fc"]);
    expect(checked).not.toBe(declared);
    expect(Object.isFrozen(checked)).toBe(true);
    // Changing the declaration afterwards doesn't reach the checked list.
    declared.push("admin.grants");
    expect(checked).toEqual(["config.view", "admin.fc"]);
    for (const none of [undefined, []]) {
      expect(modulePermissions(none)).toEqual([]);
      expect(Object.isFrozen(modulePermissions(none))).toBe(true);
    }
  });

  test("an unknown id or anything but an array fails at definition", () => {
    const message = "A module's permissions must be TaruBot permission ids.";
    for (const value of [
      ["config.view", "config.everything"],
      ["officer"],
      ["user"],
      [1],
      [null],
      "config.view",
      "officer",
      { 0: "config.view", length: 1 },
      null,
      0,
      true,
    ])
      expect(() => modulePermissions(value)).toThrow(message);
  });
});
