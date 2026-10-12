/**
 * Pauses on one person's use of one feature (2.45.0, migration 015): the rule for when one is
 * active, and the read Service.enrichActor makes for everyone who isn't a server manager. A pause
 * is active while it has no lift and has not ended, judged on the database clock so a slow or
 * skewed bot clock can't extend or cut one short. Reads and writes share this one definition.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Pause } from "../domain/policy.js";
import { isPermissionId, type PermissionId } from "../domain/rbac.js";
import type { Orm } from "../infrastructure/postgres/database.js";
import { memberBlocks as b } from "../infrastructure/postgres/schema.js";

/** SQL for "active now": not lifted, and not past its end. */
export const ACTIVE_BLOCK = and(
  isNull(b.lifted_at),
  or(isNull(b.expires_at), gt(b.expires_at, sql`now()`)),
);

/**
 * A person's active pauses in one server, by permission. One indexed read (the open-pause index).
 * An id this release doesn't know (a later release's, after a rollback) is ignored, not trusted.
 */
export async function activeBlocks(
  db: Orm,
  guildId: string,
  userId: string,
): Promise<Map<PermissionId, Pause>> {
  const rows = await db
    .select({ permission: b.permission, until: b.expires_at, reason: b.reason })
    .from(b)
    .where(and(eq(b.guild_id, guildId), eq(b.user_id, userId), ACTIVE_BLOCK));
  const pauses = new Map<PermissionId, Pause>();
  for (const row of rows)
    if (isPermissionId(row.permission))
      pauses.set(row.permission, { until: row.until, reason: row.reason });
  return pauses;
}
