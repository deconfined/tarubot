/**
 * TaruBot's own permission catalog (2.44.0, RBAC), not Discord's: Discord permission bits and their
 * arithmetic live in permissions.ts. Every gated TaruBot function is one permission id, and a
 * single check (can() and requirePermission() in policy.ts) answers whether an actor holds it. Permissions reach people
 * only through roles TaruBot manages (owner decision 2, 2026-10-12): the bound Member and Guest
 * roles, the Officer role and, from 2.47.0, rank roles. Server managers hold them implicitly.
 *
 * Tiers say where a permission may sit (owner decision Q1 A):
 * - `fixed`: changes who holds authority, so its holder could grant themselves everything. Server
 *   managers only; never on a role.
 * - `staff`: officer work. Never on Member or Guest, because delegated officers can hand those
 *   roles out (/assign, /guest grant), so a staff permission there would let one officer appoint
 *   another.
 * - `member`: self-service features, on any managed role.
 * - `baseline`: everyone in the server holds it, lobby newcomers included, who hold no managed
 *   role. It can be stopped per person (2.45.0), never per role.
 *
 * Ids are stable: stored permission sets (2.46.0) and blocks (2.45.0) name them, so an id is never
 * renamed or reused. Identity rights that are no permission at all (your own /unclaim, /main,
 * /nickname, your own records, /ping, /version, /channel, /dashboard, signing in) stay outside
 * the catalog and can't be refused.
 */

/** Where a permission may sit; see the file comment. */
export type PermissionTier = "fixed" | "staff" | "member" | "baseline";

/** Seeing something, or changing it. */
export type PermissionKind = "read" | "write";

/** The dashboard's grouping, in display order. */
export const PERMISSION_AREAS = [
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
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/** One catalog entry. */
export interface PermissionSpec {
  readonly area: PermissionArea;
  readonly kind: PermissionKind;
  readonly tier: PermissionTier;
  /** Plain words, shown on the dashboard and in refusals. */
  readonly label: string;
  /**
   * Acting as a member rather than with authority: /suggest and opening a mod mail case. Server
   * managers don't hold these implicitly; they follow the manager's own Member or Guest role, as
   * in 2.43.0, where officer authority never counted for either.
   */
  readonly memberSide?: true;
}

/**
 * Every permission. Adding one needs a surface that checks it (tests/unit/rbac.test.ts pins
 * the list), and from 2.46.0 a migration that decides which stored sets get it.
 */
export const PERMISSIONS = {
  // Server setup: changing who holds authority.
  "admin.fc": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Link or unlink the Free Company",
  },
  "admin.roles": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Choose the roles TaruBot manages, and their layout",
  },
  "admin.ranks": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Choose the officer rank",
  },
  "admin.grants": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Grant, revoke and reset officer access",
  },
  "admin.links": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Make or remove character links that count for rank",
  },
  "admin.setup": {
    area: "Server setup",
    kind: "write",
    tier: "fixed",
    label: "Run /setup",
  },
  // Configuration.
  "config.view": {
    area: "Configuration",
    kind: "read",
    tier: "staff",
    label: "See the configuration and health check",
  },
  "config.channels": {
    area: "Configuration",
    kind: "write",
    tier: "staff",
    label: "Choose the ledger and update channels",
  },
  "config.officer_channel": {
    area: "Configuration",
    kind: "write",
    tier: "staff",
    label: "Choose the officer notifications channel",
  },
  "config.guest_applications": {
    area: "Configuration",
    kind: "write",
    tier: "staff",
    label: "Open or close guest applications",
  },
  // Members.
  "members.view": {
    area: "Members",
    kind: "read",
    tier: "staff",
    label: "Look up other members' characters and guest records",
  },
  "characters.assign": {
    area: "Members",
    kind: "write",
    tier: "staff",
    label: "Link a character to a member (/assign)",
  },
  "characters.unassign": {
    area: "Members",
    kind: "write",
    tier: "staff",
    label: "Remove a member's character link (/unassign)",
  },
  "characters.claim": {
    area: "Members",
    kind: "write",
    tier: "baseline",
    label: "Link your own character (/claim, /verify)",
  },
  // Roster.
  "sync.view_all": {
    area: "Roster",
    kind: "read",
    tier: "staff",
    label: "See everyone's background work",
  },
  "roster.refresh": {
    area: "Roster",
    kind: "write",
    tier: "baseline",
    label: "Ask for a roster check (/refresh)",
  },
  "roster.refresh_force": {
    area: "Roster",
    kind: "write",
    tier: "staff",
    label: "Force a roster check (/refresh force)",
  },
  // Guests.
  "guests.apply": {
    area: "Guests",
    kind: "write",
    tier: "baseline",
    label: "Apply for guest access",
  },
  "guests.decide": {
    area: "Guests",
    kind: "write",
    tier: "staff",
    label: "Approve or deny guest applications",
  },
  "guests.manage": {
    area: "Guests",
    kind: "write",
    tier: "staff",
    label: "Grant, revoke and reset guest access",
  },
  // Ledger.
  "ledger.view": {
    area: "Ledger",
    kind: "read",
    tier: "member",
    label: "See the ledger balance and history",
  },
  "ledger.deposit": {
    area: "Ledger",
    kind: "write",
    tier: "member",
    label: "Record deposits",
  },
  "ledger.audit": {
    area: "Ledger",
    kind: "read",
    tier: "staff",
    label: "See ledger details and past Free Companies' ledgers",
  },
  "ledger.withdraw": {
    area: "Ledger",
    kind: "write",
    tier: "staff",
    label: "Record withdrawals",
  },
  "ledger.adjust": {
    area: "Ledger",
    kind: "write",
    tier: "staff",
    label: "Correct the balance",
  },
  "ledger.initialize": {
    area: "Ledger",
    kind: "write",
    tier: "staff",
    label: "Set the opening balance",
  },
  // Mod mail.
  "modmail.open": {
    area: "Mod mail",
    kind: "write",
    tier: "member",
    label: "Open mod mail cases and follow your own",
    memberSide: true,
  },
  "modmail.inbox": {
    area: "Mod mail",
    kind: "read",
    tier: "staff",
    label: "Read every mod mail case",
  },
  "modmail.read_log": {
    area: "Mod mail",
    kind: "read",
    tier: "staff",
    label: "See who read each mod mail case",
  },
  "modmail.respond": {
    area: "Mod mail",
    kind: "write",
    tier: "staff",
    label: "Reply to, close and reopen mod mail cases",
  },
  "modmail.settings": {
    area: "Mod mail",
    kind: "write",
    tier: "staff",
    label: "Turn mod mail on or off",
  },
  // Role menu.
  "rolemenu.view": {
    area: "Role menu",
    kind: "read",
    tier: "staff",
    label: "See the role menu, drafts included",
  },
  "rolemenu.edit": {
    area: "Role menu",
    kind: "write",
    tier: "staff",
    label: "Edit role menu categories and options",
  },
  "rolemenu.publish": {
    area: "Role menu",
    kind: "write",
    tier: "staff",
    label: "Add roles to the menu and publish them",
  },
  // Moderation (2.45.0): pausing one person's use of a feature.
  "moderation.view": {
    area: "Moderation",
    kind: "read",
    tier: "staff",
    label: "See who is paused, and who sent a suggestion",
  },
  "moderation.block": {
    area: "Moderation",
    kind: "write",
    tier: "staff",
    label: "Pause a member's use of a feature",
  },
  // Member features.
  "selfroles.use": {
    area: "Member features",
    kind: "write",
    tier: "member",
    label: "Pick your own roles on My roles",
  },
  "suggest.use": {
    area: "Member features",
    kind: "write",
    tier: "member",
    label: "Suggest features (/suggest)",
    memberSide: true,
  },
  "issue.use": {
    area: "Member features",
    kind: "write",
    tier: "baseline",
    label: "Report a problem (/issue)",
  },
} as const satisfies Readonly<Record<string, PermissionSpec>>;

/** A permission id. */
export type PermissionId = keyof typeof PERMISSIONS;

/** Every id, in catalog order. */
export const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS) as PermissionId[]);

/** The catalog entry for an id. */
export const permission = (id: PermissionId): PermissionSpec => PERMISSIONS[id];

/** Whether an untrusted string names a permission this release knows. */
export const isPermissionId = (value: unknown): value is PermissionId =>
  typeof value === "string" && Object.hasOwn(PERMISSIONS, value);

/**
 * A module's declared router permissions, checked once at definition: discovered modules are
 * untyped at runtime, so an unknown id must fail at startup rather than admit or refuse oddly.
 */
export function modulePermissions(value: unknown): readonly PermissionId[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || !value.every(isPermissionId))
    throw new Error("A module's permissions must be TaruBot permission ids.");
  return Object.freeze([...value]);
}

/** Ids of one tier, in catalog order. */
export const permissionsOfTier = (tier: PermissionTier): readonly PermissionId[] =>
  PERMISSION_IDS.filter((id) => PERMISSIONS[id].tier === tier);

/**
 * What one person's use can be paused for (2.45.0, owner decision 3): every member and baseline
 * permission, the features people use rather than the work officers do. A pause is deny-only and
 * touches no Discord role. Staff permissions can't be paused yet; the stored column is general, so
 * allowing them later needs no migration.
 */
export const BLOCKABLE: readonly PermissionId[] = Object.freeze(
  PERMISSION_IDS.filter(
    (id) => PERMISSIONS[id].tier === "member" || PERMISSIONS[id].tier === "baseline",
  ),
);

/** Whether `id` can be paused for a person. */
export const isBlockable = (id: PermissionId): boolean => BLOCKABLE.includes(id);

/**
 * The pauses only a server manager may set or lift (owner decision Q6 B): mod mail is how members
 * raise concerns about officers, so officers can't cut it off.
 */
export const MANAGER_ONLY_BLOCKS: ReadonlySet<PermissionId> = new Set(["modmail.open"]);

/** The roles TaruBot manages that can carry permissions. Rank roles join in 2.47.0. */
export type ManagedRole = "member" | "guest" | "officer" | "leader";

/** The tiers each managed role may carry. */
export const ROLE_TIERS: Readonly<Record<ManagedRole, readonly PermissionTier[]>> = {
  member: ["member"],
  guest: ["member"],
  officer: ["staff", "member"],
  leader: ["staff", "member"],
};

/**
 * The code templates (owner decision 1): named starting points, which together reproduce 2.43.0's
 * access exactly. Until permission sets become editable (2.46.0), each managed role carries its
 * template. Officer is every staff permission plus the member features officers used through
 * their officer status; it leaves out /suggest and opening mod mail, which officers reach only
 * through the Member or Guest role, as before. FC Leader carries no bot permission: in 2.43.0 it
 * only opened staff channels under onboarding, which stays a role projection.
 */
export const TEMPLATES_V1 = {
  officer: [
    ...permissionsOfTier("staff"),
    "ledger.view",
    "ledger.deposit",
    "selfroles.use",
  ] as readonly PermissionId[],
  member: [
    "ledger.view",
    "ledger.deposit",
    "modmail.open",
    "selfroles.use",
    "suggest.use",
  ] as readonly PermissionId[],
  guest: ["modmail.open", "selfroles.use", "suggest.use"] as readonly PermissionId[],
  leader: [] as readonly PermissionId[],
} as const satisfies Readonly<Record<ManagedRole, readonly PermissionId[]>>;
