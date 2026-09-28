/**
 * Managed role presentation policy, independent of Discord I/O and membership eligibility.
 * Presentation is a per-guild opt-in (guilds.role_layout_enabled); callers gate on that switch.
 */
import { Failure } from "./values.js";

/** Highest first; partial configurations retain the relative order of the roles that exist. */
export function managedRoleOrder(bindings: {
  leader_role_id: string | null;
  officer_role_id: string | null;
  member_role_id: string | null;
  guest_role_id: string | null;
}): string[] {
  return [
    bindings.leader_role_id,
    bindings.officer_role_id,
    bindings.member_role_id,
    bindings.guest_role_id,
  ].filter((value): value is string => value !== null);
}

/** Pack one consecutive block at the lowest managed slot, preserving unrelated role order. */
export function rolePositionChanges(
  ascendingIds: readonly string[],
  priority: readonly string[],
): { role: string; position: number }[] {
  const managed = new Set(priority);
  if (managed.size !== priority.length)
    throw new Failure(
      "blocked",
      "Managed roles must be distinct before arranging their hierarchy.",
    );
  const slots = ascendingIds.flatMap((id, position) => (managed.has(id) ? [{ id, position }] : []));
  if (slots.length !== priority.length)
    throw new Failure(
      "blocked",
      "A managed role is missing; run /setup onboarding or repair its configuration.",
    );
  const first = slots[0]?.position;
  if (first === undefined) return [];
  if (first === 0) throw new Failure("blocked", "The everyone role cannot be managed.");
  const unrelated = ascendingIds.filter((id) => !managed.has(id));
  const wanted = [
    ...unrelated.slice(0, first),
    ...[...priority].reverse(),
    ...unrelated.slice(first),
  ];
  if (wanted.every((id, index) => ascendingIds[index] === id)) return [];
  // Discord's bulk endpoint needs the full final order; sparse moves can interleave other roles.
  return wanted.map((role, position) => ({ role, position }));
}

/** One role as a read-only layout plan sees it: identity, display name and current hoist flag. */
export interface LayoutRole {
  id: string;
  name: string;
  hoist: boolean;
}

/**
 * The writes one layout pass would make now, without making them. `order` is the managed priority
 * (highest first); `hoist` lists managed roles not yet displayed separately; `moved` lists every
 * role whose effective ascending index would change (0 is @everyone, higher numbers display
 * higher), including unrelated roles shifted by the packed block; `positions` is the exact bulk
 * payload a pass would send (empty when the hierarchy has converged).
 */
export interface RoleLayoutPlan {
  order: string[];
  hoist: { id: string; name: string }[];
  moved: { id: string; name: string; from: number; to: number }[];
  positions: { role: string; position: number }[];
}

/**
 * Plan a layout pass from the current ascending hierarchy. It shares rolePositionChanges with the
 * real pass, so missing, duplicated or @everyone-managed configurations block the plan with the
 * same diagnostics the pass would raise. Used by the read-only cutover preview; never writes.
 */
export function roleLayoutPlan(
  ascending: readonly LayoutRole[],
  priority: readonly string[],
): RoleLayoutPlan {
  const positions = rolePositionChanges(
    ascending.map((role) => role.id),
    priority,
  );
  const byId = new Map(ascending.map((role, index) => [role.id, { role, index }]));
  // rolePositionChanges has already proven every managed ID is present and distinct.
  const hoist = priority.flatMap((id) => {
    const role = byId.get(id)?.role;
    return role && !role.hoist ? [{ id: role.id, name: role.name }] : [];
  });
  const moved = positions.flatMap(({ role, position }) => {
    const current = byId.get(role);
    return current && current.index !== position
      ? [{ id: role, name: current.role.name, from: current.index, to: position }]
      : [];
  });
  return { order: [...priority], hoist, moved, positions };
}
