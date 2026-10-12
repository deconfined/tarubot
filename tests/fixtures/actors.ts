/**
 * Test actors for the permission model (2.44.0). Production actors get `access` from
 * Service.enrichActor; fixtures describe a person the 2.43.0 way and get the same access the
 * resolver would give them:
 * - `serverManager` (Manage Server) together with `manageRoles` makes a server manager, who holds
 *   every permission;
 * - `officer: true` means the Officer role counts for them (held and backed by rank or a grant);
 * - `member` and `guest` mean they hold the bound Member or Guest role.
 * Manage Server alone grants nothing (owner decision Q2 A). Any `access` already on the input is
 * recomputed, so `actorOf({ ...MEMBER, officer: true })` gives an officer.
 */
import { type Access, type Actor, accessFor } from "../../src/domain/policy.js";
import type { ManagedRole } from "../../src/domain/rbac.js";

/** An actor as a fixture describes it. */
export type ActorSpec = Omit<Actor, "access"> & { officer?: boolean; access?: Access };

/** The access the resolver gives the person `spec` describes. */
export function accessOf(spec: ActorSpec): Access {
  const manager = spec.serverManager === true && spec.manageRoles;
  const roles: ManagedRole[] = [];
  if (spec.member === true) roles.push("member");
  if (spec.guest === true) roles.push("guest");
  if (spec.officer === true && !manager) roles.push("officer");
  return accessFor(manager, roles);
}

/** An Actor for `spec`, with `officer` folded into `access`. */
export function actorOf(spec: ActorSpec): Actor {
  const { officer: _officer, access: _access, ...rest } = spec;
  return { ...rest, access: accessOf(spec) };
}
