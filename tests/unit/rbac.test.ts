/**
 * TaruBot's permission catalog (2.44.0, RBAC): the catalog's shape, the pinned id list (stored
 * sets and pauses name these ids from 2.45.0, so one is never renamed or reused), the code
 * templates and the tier rule they obey, the module declaration check, and what a pause may name
 * (2.45.0: BLOCKABLE and MANAGER_ONLY_BLOCKS).
 */
import { describe, expect, test } from "bun:test";
import { featuresMatchCatalog, PAUSE_FEATURE_IDS } from "../../src/domain/moderation.js";
import {
  BLOCKABLE,
  isBlockable,
  isPermissionId,
  MANAGER_ONLY_BLOCKS,
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
      "moderation.view": "staff",
      "moderation.block": "staff",
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

  test("the areas and their order are pinned, and every area holds a permission", () => {
    // The dashboard groups by area in this order; Moderation (2.45.0) sits before Member features.
    expect([...PERMISSION_AREAS]).toEqual([
      "Server setup",
      "Configuration",
      "Members",
      "Roster",
      "Guests",
      "Ledger",
      "Mod mail",
      "Role menu",
      "Moderation",
      "Member features",
    ]);
    for (const area of PERMISSION_AREAS)
      expect(PERMISSION_IDS.some((id) => PERMISSIONS[id].area === area)).toBe(true);
  });

  test("moderation.view and moderation.block are staff permissions in the Moderation area (2.45.0)", () => {
    expect(permission("moderation.view")).toMatchObject({
      area: "Moderation",
      kind: "read",
      tier: "staff",
    });
    expect(permission("moderation.block")).toMatchObject({
      area: "Moderation",
      kind: "write",
      tier: "staff",
    });
    expect(PERMISSION_IDS.filter((id) => PERMISSIONS[id].area === "Moderation")).toEqual([
      "moderation.view",
      "moderation.block",
    ]);
    // Neither is member-side: a manager holds both implicitly.
    expect("memberSide" in permission("moderation.view")).toBe(false);
    expect("memberSide" in permission("moderation.block")).toBe(false);
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
        "moderation.view",
        "moderation.block",
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

describe("what a pause may name (BLOCKABLE, 2.45.0)", () => {
  test("it is exactly the member and baseline permissions, in catalog order", () => {
    expect([...BLOCKABLE]).toEqual([
      "characters.claim",
      "roster.refresh",
      "guests.apply",
      "ledger.view",
      "ledger.deposit",
      "modmail.open",
      "selfroles.use",
      "suggest.use",
      "issue.use",
    ]);
    // The list above is the pin; this is the rule that produces it.
    expect([...BLOCKABLE]).toEqual(
      PERMISSION_IDS.filter((id) => ["member", "baseline"].includes(PERMISSIONS[id].tier)),
    );
    expect(Object.isFrozen(BLOCKABLE)).toBe(true);
    expect(new Set(BLOCKABLE).size).toBe(BLOCKABLE.length);
  });

  test("isBlockable agrees for every id, and no staff or fixed permission can be paused", () => {
    for (const id of PERMISSION_IDS) expect(isBlockable(id)).toBe(BLOCKABLE.includes(id));
    for (const id of [...permissionsOfTier("fixed"), ...permissionsOfTier("staff")])
      expect(isBlockable(id)).toBe(false);
    // Pausing the pausing, or the reading of mod mail cases, is deferred: staff ones aren't offered.
    expect(isBlockable("moderation.block")).toBe(false);
    expect(isBlockable("modmail.inbox")).toBe(false);
  });

  test("the pause features the dashboard and /moderate offer are exactly these, in the same order", () => {
    expect([...PAUSE_FEATURE_IDS]).toEqual([...BLOCKABLE]);
    expect(featuresMatchCatalog()).toBe(true);
  });

  test("only a server manager may pause or lift mod mail opening (owner decision Q6 B)", () => {
    expect([...MANAGER_ONLY_BLOCKS]).toEqual(["modmail.open"]);
    for (const id of MANAGER_ONLY_BLOCKS) expect(isBlockable(id)).toBe(true);
    expect(MANAGER_ONLY_BLOCKS.has("suggest.use")).toBe(false);
  });

  test("the Officer template carries both moderation permissions, and no other role does", () => {
    expect(TEMPLATES_V1.officer).toContain("moderation.view");
    expect(TEMPLATES_V1.officer).toContain("moderation.block");
    for (const role of ["member", "guest", "leader"] as const) {
      expect(TEMPLATES_V1[role]).not.toContain("moderation.view");
      expect(TEMPLATES_V1[role]).not.toContain("moderation.block");
    }
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
