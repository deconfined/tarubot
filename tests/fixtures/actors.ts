/**
 * Test actors for the permission model (2.44.0). Production actors get `access` from
 * Service.enrichActor; fixtures describe a person the 2.43.0 way and get the same access the
 * resolver would give them:
 * - `serverManager` (Manage Server) together with `manageRoles` makes a server manager, who holds
 *   every permission;
 * - `officer: true` means the Officer role counts for them (held and backed by rank or a grant);
 * - `member` and `guest` mean they hold the bound Member or Guest role;
 * - `paused` (2.45.0) lists the features whose use is paused for them: the pauses the resolver
 *   would read for this person. As in production, a pause on a permission they don't hold is
 *   dropped, and a server manager is never paused.
 * Manage Server alone grants nothing (owner decision Q2 A). Any `access` already on the input is
 * recomputed, so `actorOf({ ...MEMBER, officer: true })` gives an officer. That includes pauses:
 * spreading an already-paused Actor into a new spec drops its pauses unless `paused` is passed
 * again.
 */
import { type Access, type Actor, accessFor, type Pause } from "../../src/domain/policy.js";
import type { ManagedRole, PermissionId } from "../../src/domain/rbac.js";

/** One pause as a fixture writes it; an end time left out means until lifted. */
export type PauseSpec = { until?: Date | null; reason?: string };

/** An actor as a fixture describes it. */
export type ActorSpec = Omit<Actor, "access"> & {
  officer?: boolean;
  /** Active pauses on features, by permission (2.45.0). */
  paused?: Partial<Record<PermissionId, PauseSpec>>;
  access?: Access;
};

/** The reason a fixture's pause carries when it names none. */
export const PAUSE_REASON = "Paused while an officer looks into it.";

/** The pauses `spec` describes, as the resolver reads them from the database. */
export function pausesOf(spec: Pick<ActorSpec, "paused">): ReadonlyMap<PermissionId, Pause> {
  return new Map(
    Object.entries(spec.paused ?? {}).map(([id, pause]) => [
      id as PermissionId,
      { until: pause?.until ?? null, reason: pause?.reason ?? PAUSE_REASON },
    ]),
  );
}

/** The access the resolver gives the person `spec` describes. */
export function accessOf(spec: ActorSpec): Access {
  const manager = spec.serverManager === true && spec.manageRoles;
  const roles: ManagedRole[] = [];
  if (spec.member === true) roles.push("member");
  if (spec.guest === true) roles.push("guest");
  if (spec.officer === true && !manager) roles.push("officer");
  return accessFor(manager, roles, pausesOf(spec));
}

/** An Actor for `spec`, with `officer` folded into `access` and `paused` into its pauses. */
export function actorOf(spec: ActorSpec): Actor {
  const { officer: _officer, paused: _paused, access: _access, ...rest } = spec;
  return { ...rest, access: accessOf(spec) };
}
