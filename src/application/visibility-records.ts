/**
 * The stored facts TaruBot's visibility analysis needs beyond the guild row (2.35.0, #46): retired
 * roles (which TaruBot must stay above while anyone holds them), the review channels of pending
 * guest applications and of applications whose review redraw hasn't finished (posting channels,
 * since the redraw fetches and edits the review there), and the channels the newest /setup
 * overrides run found hidden from TaruBot on purpose. /config validate, the overrides run and the
 * officer alert all load them here, so the three agree. Read-only; no migration.
 */
import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { VisibilityRecords } from "../domain/visibility.js";
import { idSchema } from "../domain/values.js";
import type { Orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";

/**
 * The part of a 'setup.overrides' audit row read back: the channel IDs that run judged hidden on
 * purpose (or denied) from real data. Recording them keeps an obfuscated channel's deliberate deny
 * recognisable once Administrator is off and its real overwrites can no longer be read.
 */
const OVERRIDES_DETAILS = z.object({ hiddenOnPurpose: z.array(idSchema) });

/**
 * A guest.review job that hasn't finished: it still redraws the review in its application's
 * channel, which needs Read Message History there (validateChannel requires all four posting
 * permissions). A parked (blocked or disabled) one counts too, since /setup overrides requeues it.
 */
const UNFINISHED = ["queued", "running", "blocked", "disabled"];

/**
 * Load the guild's visibility records in three reads. A malformed or missing hiddenOnPurpose is
 * treated as none recorded, never as an error: the analysis then calls those channels missing,
 * which /setup overrides re-examines.
 */
export async function loadVisibilityRecords(db: Orm, guildId: string): Promise<VisibilityRecords> {
  const retired = await db
    .select({ role: t.retiredRoles.role_id })
    .from(t.retiredRoles)
    .where(eq(t.retiredRoles.guild_id, guildId));
  // A decision moves an application out of 'pending' before its review redraw runs, so the
  // redraw's job keeps the channel a posting channel until it finishes (keyed review:<id>).
  const redraw = db
    .select({ id: t.jobs.id })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.kind, "guest.review"),
        eq(t.jobs.guild_id, guildId),
        eq(t.jobs.dedupe_key, sql`'review:' || ${t.guestApplications.id}::text`),
        inArray(t.jobs.status, UNFINISHED),
      ),
    );
  const pending = await db
    .selectDistinct({ channel: t.guestApplications.channel_id })
    .from(t.guestApplications)
    .where(
      and(
        eq(t.guestApplications.guild_id, guildId),
        or(eq(t.guestApplications.state, "pending"), exists(redraw)),
      ),
    );
  const [latest] = await db
    .select({ details: t.auditEvents.details })
    .from(t.auditEvents)
    .where(and(eq(t.auditEvents.guild_id, guildId), eq(t.auditEvents.action, "setup.overrides")))
    .orderBy(desc(t.auditEvents.id))
    .limit(1);
  const recorded = OVERRIDES_DETAILS.safeParse(latest?.details);
  return {
    retiredRoles: retired.map((row) => row.role).sort(),
    pendingReviewChannels: pending.map((row) => row.channel).sort(),
    recordedHidden: recorded.success ? [...new Set(recorded.data.hiddenOnPurpose)] : [],
  };
}
