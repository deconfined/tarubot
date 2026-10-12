/** Pure authorization and access policy; these functions require no Discord or database I/O. */
import {
  type ManagedRole,
  PERMISSION_IDS,
  PERMISSIONS,
  type PermissionId,
  permission,
  permissionsOfTier,
  ROLE_TIERS,
  TEMPLATES_V1,
} from "./rbac.js";
import { Failure } from "./values.js";

/**
 * What an actor may do in one server (2.44.0, RBAC): computed once per resolution by
 * Service.enrichActor from the actor's Discord permissions and the managed roles they hold, and
 * read through can() and requirePermission(), the single decision point. Never cached apart from
 * the actor it belongs to, so it is exactly as fresh as the resolution (ActorResolution).
 */
export interface Access {
  /**
   * A server manager: Discord's Manage Server and Manage Roles together (the server owner and
   * Administrator imply both). Managers hold every permission implicitly, the fixed ones included,
   * so nothing TaruBot stores can lock a server out of its own bot; only the member-side ones
   * (/suggest, opening mod mail) follow their own Member or Guest role instead.
   */
  readonly manager: boolean;
  /**
   * The managed roles that count for this actor now: held, and for the Officer role also backed
   * by TaruBot's own evidence (a rank on a trusted link, or a manager's grant). A role given by
   * hand alone counts for nothing.
   */
  readonly roles: readonly ManagedRole[];
  readonly permissions: ReadonlySet<PermissionId>;
}

/**
 * No permission beyond the baseline. What actor resolution starts from (gateway.actor) until
 * Service.enrichActor reads the server's managed roles, so a path that skips enrichment refuses
 * every gated function rather than guessing.
 */
export const NO_ACCESS: Access = accessFor(false, []);

/**
 * Permissions from Discord authority and the managed roles that count. Each role carries its code
 * template (TEMPLATES_V1) until sets become editable; the tier rule is applied again here, so a
 * template or (later) a stored set naming a permission its role may not carry grants nothing.
 * Managers add every permission except the member-side ones (/suggest, opening mod mail), which
 * follow their own Member or Guest role, as in 2.43.0.
 */
export function accessFor(manager: boolean, roles: Iterable<ManagedRole>): Access {
  const held = [...new Set(roles)];
  const permissions = new Set<PermissionId>(permissionsOfTier("baseline"));
  for (const role of held)
    for (const id of TEMPLATES_V1[role])
      if (ROLE_TIERS[role].includes(PERMISSIONS[id].tier)) permissions.add(id);
  if (manager) for (const id of PERMISSION_IDS) if (!permission(id).memberSide) permissions.add(id);
  return { manager, roles: held, permissions };
}

/**
 * A person acting in one guild, resolved against that guild's current Discord state (gateway.actor,
 * then Service.enrichActor). The optional facts below (2.40.0) are read only by the web's admission,
 * member self-service and mod mail; an actor built without them (a command fixture, an
 * autocomplete payload) passes no A2 gate, because every reader requires an explicit true or false.
 */
export interface Actor {
  guildId: string;
  userId: string;
  /** Discord's Manage Roles, which binding a role also needs natively (validateRole). */
  manageRoles: boolean;
  /** Discord's Manage Server. With Manage Roles it makes a server manager (Access.manager). */
  serverManager?: boolean;
  roleIds?: readonly string[];
  /** What this actor may do here (2.44.0). NO_ACCESS until Service.enrichActor runs. */
  access: Access;
  /**
   * Holds the server's bound Member role (guilds.member_role_id) at resolution time. False when no
   * Member role is bound or there is no active guild row (TaruBot isn't set up there).
   */
  member?: boolean;
  /** Holds the server's bound Guest role (guilds.guest_role_id) at resolution time, likewise. */
  guest?: boolean;
  /**
   * TaruBot holds Administrator in this server, or its own member isn't cached so that can't be
   * told (fails closed: true). Members and guests are refused while it is anything but false
   * (owner decision A2): a leaked token in a server where TaruBot is Administrator must not also
   * be reachable through pages every member can open. Staff are unaffected.
   */
  botAdministrator?: boolean;
  /** In a Discord time-out: may view their own roles, but self-service saves refuse (Q6). */
  timedOut?: boolean;
}

/**
 * How an actor is resolved (#43's "actor cache for member GETs"; docs/MODULES.md, "Add a page",
 * says which web requests use each). Both read the member from Discord with a forced fetch, so a
 * departure or a role change is never missed:
 * - `full`: the guild and its role definitions are fetched as well (3 REST calls). Slash commands
 *   and every web POST use it, so no write is ever authorized from a cache.
 * - `light`: the guild and its roles come from the gateway cache, which the Guilds intent keeps
 *   current, and only the member is fetched (1 REST call). Web GETs on a memo miss and sign-in
 *   admission use it; a guild that isn't cached and available falls back to `full`.
 */
export type ActorResolution = "light" | "full";

/** Whether the actor holds a permission here. The one decision every gated function asks. */
export const can = (actor: Pick<Actor, "access">, id: PermissionId): boolean =>
  actor.access.permissions.has(id);

/**
 * Holds any staff or fixed permission: an officer in the replies' wording (audienceOf), and the
 * people the A2 gate never applies to, as officers in 2.43.0.
 */
export const isStaff = (actor: Pick<Actor, "access">): boolean =>
  actor.access.manager ||
  [...actor.access.permissions].some((id) => STAFF_TIERS.has(PERMISSIONS[id].tier));

const STAFF_TIERS: ReadonlySet<string> = new Set(["staff", "fixed"]);

/**
 * Who may use member self-service in a server (owner decision Q6 A): holding selfroles.use (the
 * Member, Guest or Officer role), with the A2 gate for anyone who isn't staff: TaruBot must hold
 * no Administrator there (unknown counts as holding it). A time-out doesn't change this (the
 * person may still view their roles); SelfRoles refuses the save itself. Shared by the web's
 * admission and the application operation that reauthorizes the save, so the two can't disagree.
 */
export const selfServiceAccess = (actor: Actor): boolean =>
  can(actor, "selfroles.use") && (isStaff(actor) || actor.botAdministrator === false);

/**
 * The fixed-permission refusal. It carries scope 'manager', so the reply names the missing Discord
 * permissions: authority over authority can't be delegated through any role.
 */
export const MANAGERS_ONLY =
  "Changing who has officer authority needs Discord's Manage Server and Manage Roles permissions. Bot officer access isn't enough.";

/**
 * The generic officer-level refusal. The reply presenter recognises exactly this text and names the
 * command instead ("Only FC officers can use /config."); refusals with their own approved wording
 * (withdrawals, a past FC's ledger, forced refreshes) are shown as written.
 */
export const OFFICERS_ONLY = "Only FC officers can do that.";

/**
 * Recheck guild ownership at the application boundary, including private reads. Exactly two
 * arguments (2.44.0): the officer level of 2.43.0 is a permission now (requirePermission), and a
 * leftover level string must fail to compile rather than read as an owner.
 */
export function authorize(actor: Actor, guildId: string): void {
  if (actor.guildId !== guildId)
    throw new Failure("forbidden", "That record belongs to another server.", 0, {
      kind: "scope",
      scope: "test_guild",
    });
}

/**
 * authorize(), plus: another member's record is read only with members.view. The refusal names
 * its rule in the scope detail, so replies never match on message text.
 */
export function authorizeOwner(actor: Actor, guildId: string, owner: string): void {
  authorize(actor, guildId);
  if (owner !== actor.userId && !can(actor, "members.view"))
    throw new Failure(
      "forbidden",
      "You can view only your own records. Officers can look up other members.",
      0,
      { kind: "scope", scope: "owner", permission: "members.view" },
    );
}

/**
 * The single decision point (2.44.0): the guild check, then the permission. A fixed permission
 * refuses as server managers only, a staff one as officers only, keeping each throw site's own
 * approved wording when it passes one; a member or baseline one names the membership rule. The
 * scope detail names the permission, so a reply never matches on text.
 */
export function requirePermission(
  actor: Actor,
  guildId: string,
  id: PermissionId,
  message?: string,
): void {
  authorize(actor, guildId);
  if (can(actor, id)) return;
  const tier = PERMISSIONS[id].tier;
  if (tier === "fixed")
    throw new Failure("forbidden", message ?? MANAGERS_ONLY, 0, {
      kind: "scope",
      scope: "manager",
      permission: id,
    });
  if (tier === "staff")
    throw new Failure("forbidden", message ?? OFFICERS_ONLY, 0, {
      kind: "scope",
      scope: "officer",
      permission: id,
    });
  throw new Failure("forbidden", message ?? "Your roles in this server don't include this.", 0, {
    kind: "scope",
    scope: "membership",
    permission: id,
  });
}

/**
 * The router's gate for a module's declared permissions, any-of (2.44.0). Passes for an empty list
 * (any human member of the guild). Refuses like requirePermission for the first non-fixed id, so
 * a module that admits officers says "officers only", and only a module open to server managers
 * alone (/officer, /setup) says "server managers only".
 */
export function requireAnyPermission(
  actor: Actor,
  guildId: string,
  ids: readonly PermissionId[],
): void {
  authorize(actor, guildId);
  if (ids.length === 0 || ids.some((id) => can(actor, id))) return;
  const first = ids.find((id) => PERMISSIONS[id].tier !== "fixed") ?? ids[0];
  if (first !== undefined) requirePermission(actor, guildId, first);
}

/** Confirmed policy facts plus observed roles; uncertainty must not masquerade as absence. */
export interface AccessFacts {
  membership: "member" | "ineligible" | "uncertain";
  fresh: boolean;
  former: boolean;
  grant: boolean;
  revoked: boolean;
  hasMember: boolean;
  hasGuest: boolean;
  /**
   * Any active trusted character link registers the user; in every guild, with or without lobby
   * onboarding, it qualifies a non-member for Guest (ROLE-07). The name predates 2.13.0 and is kept
   * because reconciliation and `/guest status` read it.
   */
  verified?: boolean;
}

/**
 * Classify FC membership as the union over a user's active trusted links for the guild's currently
 * linked FC (ROLE-07): one confirmed character (present, or awaiting departure confirmation) makes
 * the user a member whatever their other links show. An unevaluated link keeps the user uncertain
 * unless a local unlink already removed their last confirmed character.
 */
export function membershipClass(counts: {
  fcLinked: boolean;
  confirmed: bigint;
  unknown: bigint;
  localLoss: boolean;
}): AccessFacts["membership"] {
  if (!counts.fcLinked) return "ineligible";
  if (counts.confirmed > 0n) return "member";
  return counts.unknown > 0n && !counts.localLoss ? "uncertain" : "ineligible";
}

/**
 * Member access wins; revocation suppresses guest access without changing FC eligibility.
 * Precedence over the link union: a member class never gains Guest (stale evidence only keeps one
 * already held until Member can be added); an uncertain class keeps held roles and honors durable
 * grants, but neither former-member history nor registration creates a role; an ineligible class
 * receives Guest from a durable grant, former-member history, or registration (at least one
 * trusted link, `verified`), where registration needs fresh evidence to add Guest and stale
 * evidence only keeps a held one.
 */
export function desiredAccess(facts: AccessFacts): { member: boolean; guest: boolean } {
  if (facts.membership === "member") {
    // Stale evidence can retain an existing grant, but cannot create a new member-role grant.
    const member = facts.fresh || facts.hasMember;
    return { member, guest: member ? false : facts.revoked ? false : facts.hasGuest };
  }
  if (facts.membership === "uncertain") {
    // Explicit local guest decisions remain enforceable while upstream membership is unknown.
    return {
      member: facts.hasMember,
      guest: !facts.hasMember && !facts.revoked && (facts.grant || facts.hasGuest),
    };
  }
  return {
    member: false,
    guest:
      !facts.revoked &&
      (facts.grant || facts.former || (facts.verified === true && (facts.fresh || facts.hasGuest))),
  };
}

/**
 * Which desiredAccess decisions don't depend on the roles the member already holds (officer status
 * notices, issue #31). The real policy runs once per combination of holding Member and Guest; a
 * flag is decisive when all four agree. Only decisive values are recorded for status posts, so a
 * rebind, an out-of-date roster or a hand edit the policy keeps can never read as a change.
 * Probing the function itself keeps this right if the policy changes. Worked out by class:
 * - member: `member` is decisive only with fresh evidence; `guest` when fresh or revoked (false);
 * - uncertain: `member` never is; `guest` only when revoked (a grant still defers to held Member);
 * - ineligible: `member` always is (false); `guest` is, except for a registered user with stale
 *   evidence and no grant, FC history or revocation (then a held Guest is kept).
 */
export function accessDecisive(facts: AccessFacts): { member: boolean; guest: boolean } {
  const probes = [false, true].flatMap((hasMember) =>
    [false, true].map((hasGuest) => desiredAccess({ ...facts, hasMember, hasGuest })),
  );
  const agree = (flag: "member" | "guest") =>
    probes.every((probe) => probe[flag] === probes[0]?.[flag]);
  return { member: agree("member"), guest: agree("guest") };
}

/** Advance only on accepted complete observations; reappearance clears pending departure. */
export function departure(
  previous: "present" | "missing" | "absent" | undefined,
  appears: boolean,
  firstAbsence: Date | null,
  observation: Date,
): { state: "present" | "missing" | "absent"; firstAbsence: Date | null } {
  if (appears) return { state: "present", firstAbsence: null };
  if (previous === undefined || previous === "absent")
    // A newly linked absent character has no prior confirmed membership to demote.
    return { state: "absent", firstAbsence: null };
  if (
    previous === "missing" &&
    firstAbsence &&
    observation.getTime() - firstAbsence.getTime() >= 60_000
  ) {
    // The first absence is retained across restarts and intermediate observations.
    return { state: "absent", firstAbsence };
  }
  return { state: "missing", firstAbsence: firstAbsence ?? observation };
}
