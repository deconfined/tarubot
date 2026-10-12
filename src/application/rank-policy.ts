/** Derive extra roles only from trusted links and accepted FC roster rank observations. */
import type { Database } from "../infrastructure/postgres/database.js";
import type { GuildRecord } from "./records.js";
import { and, eq, exists, gt, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";

/**
 * What TaruBot's evidence says about one rank or leader role (2.44.0 splits 2.43.0's "unknown"):
 * - `yes`: a confirmed, trusted character holds it (or, for the Officer role, a manager granted it);
 * - `no`: none does, or a manager revoked it;
 * - `unreadable`: a confirmed, trusted character whose rank or leader flag the roster didn't carry
 *   (an import baseline, or the Lodestone's rank markup changed). Authority is kept, so an upstream
 *   selector change can't strip every rank officer at once;
 * - `unresolved`: only links not yet checked against any roster. A held role is kept, but it grants
 *   no authority: a hand-given role plus a fresh link must not make an officer before the roster
 *   says so.
 */
export type RankState = "yes" | "no" | "unreadable" | "unresolved";

/** One active link's accepted evidence for the guild's currently linked FC. */
export interface RankEvidence {
  /** Membership for the linked FC; null means the link has not been evaluated against a roster. */
  state: "present" | "missing" | "absent" | null;
  /** Normalized FC rank from the roster that last confirmed the character. */
  fc_rank_key: string | null;
  is_fc_leader: boolean | null;
  /**
   * The link may confer rank: false only for an officer_assignment made by someone without
   * admin.links (service.ts assign()), and for one that predates the recorded flag. Every rank
   * role, FC Leader included, counts only such links (2.44.0): otherwise one delegated officer
   * could make another, or themselves, FC Leader by assigning the leader's character.
   */
  rank_authority: boolean;
}

/**
 * Officer and FC Leader are unions over a user's trusted linked characters (ROLE-07): any trusted
 * character with confirmed membership (present, or awaiting departure confirmation) that holds the
 * leader flag or the configured officer rank qualifies. A trusted confirmed character without rank
 * data makes the answer `unreadable`; trusted links still waiting for their first roster make it
 * `unresolved`, unless a local unlink already removed the last confirmed character. Links that
 * can't confer rank are ignored entirely. Manager overrides are applied by the caller, not here.
 */
export function rankUnion(
  rows: readonly RankEvidence[],
  context: { fcLinked: boolean; officerRankKey: string | null; localLoss: boolean },
): { officer: RankState; leader: RankState } {
  const trusted = rows.filter((row) => row.rank_authority);
  const eligible = trusted.filter((row) => row.state === "present" || row.state === "missing");
  const unresolved = !context.localLoss && trusted.some((row) => row.state === null);
  const decide = (
    holds: (row: RankEvidence) => boolean,
    unreadable: (row: RankEvidence) => boolean,
  ): RankState =>
    eligible.some(holds)
      ? "yes"
      : eligible.some(unreadable)
        ? "unreadable"
        : unresolved
          ? "unresolved"
          : "no";
  if (!context.fcLinked) return { officer: "no", leader: "no" };
  const rankKey = context.officerRankKey;
  return {
    leader: decide(
      (row) => row.is_fc_leader === true,
      (row) => row.is_fc_leader === null,
    ),
    officer: rankKey
      ? decide(
          (row) => row.fc_rank_key === rankKey,
          (row) => row.fc_rank_key === null,
        )
      : "no",
  };
}

/**
 * Whether a `links` row may confer rank: anything but an /assign, or an /assign made with
 * admin.links. Every /assign has recorded officerAuthority since the baseline (c388b0a), so a
 * missing flag is no evidence of authority and confers nothing.
 */
export const linkConfersRankSql = sql<boolean>`(${t.links.provenance}<>'officer_assignment' OR COALESCE(${t.links.source}->'officerAuthority' = 'true'::jsonb,false))`;

/**
 * linkConfersRankSql for a row already read (/unassign, under its lock). The two must agree;
 * tests/integration/persistence.test.ts checks them against each other.
 */
export function linkConfersRank(provenance: string, source: unknown): boolean {
  if (provenance !== "officer_assignment") return true;
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { officerAuthority?: unknown }).officerAuthority === true
  );
}

/** Whether an Officer state lets its held role count for permissions (Access.roles). */
export const rankBacks = (state: RankState): boolean => state === "yes" || state === "unreadable";

export interface RankAccess {
  officer: RankState;
  leader: RankState;
  manualOfficer: boolean;
  revoked: boolean;
  fresh: boolean;
}

/** Missing rank evidence preserves old projections; it never manufactures a new privilege. */
export async function rankAccess(
  db: Database,
  guild: GuildRecord,
  user: string,
  freshnessSeconds: number,
): Promise<RankAccess> {
  const [override] = await db.orm
    .select({ state: t.officerOverrides.state })
    .from(t.officerOverrides)
    .where(and(eq(t.officerOverrides.guild_id, guild.id), eq(t.officerOverrides.user_id, user)));
  const rows = await db.orm
    .select({
      state: t.membership.state,
      fc_rank_key: t.rosterMembers.fc_rank_key,
      is_fc_leader: t.rosterMembers.is_fc_leader,
      rank_authority: linkConfersRankSql,
    })
    .from(t.links)
    .leftJoin(
      t.membership,
      and(
        eq(t.membership.guild_id, t.links.guild_id),
        eq(t.membership.character_id, t.links.character_id),
        guild.fc_id ? eq(t.membership.fc_id, guild.fc_id) : sql`false`,
      ),
    )
    .leftJoin(
      t.rosterMembers,
      and(
        eq(t.rosterMembers.snapshot_id, t.membership.confirmed_snapshot_id),
        eq(t.rosterMembers.character_id, t.links.character_id),
      ),
    )
    .where(
      and(eq(t.links.guild_id, guild.id), eq(t.links.user_id, user), eq(t.links.active, true)),
    );
  const fresh = guild.fc_id
    ? exists(
        db.orm
          .select({ id: t.freeCompanies.id })
          .from(t.freeCompanies)
          .where(
            and(
              eq(t.freeCompanies.id, guild.fc_id),
              gt(
                t.freeCompanies.last_successful_roster_at,
                sql`now()-${freshnessSeconds}*interval '1 second'`,
              ),
            ),
          ),
      )
    : sql<boolean>`false`;
  const localLoss = exists(
    db.orm
      .select({ user_id: t.guildUsers.user_id })
      .from(t.guildUsers)
      .where(
        and(
          eq(t.guildUsers.guild_id, guild.id),
          eq(t.guildUsers.user_id, user),
          eq(t.guildUsers.local_member_loss, true),
        ),
      ),
  );
  const [facts] = await db.orm
    .select({ fresh: sql<boolean>`${fresh}`, local_loss: sql<boolean>`${localLoss}` })
    .from(t.guilds)
    .where(eq(t.guilds.id, guild.id));
  let { officer, leader } = rankUnion(rows, {
    fcLinked: Boolean(guild.fc_id),
    officerRankKey: guild.officer_rank_key,
    localLoss: facts?.local_loss ?? false,
  });
  // Explicit manager grants and revocations override the automatic officer union.
  if (override?.state === "granted") officer = "yes";
  if (override?.state === "revoked") officer = "no";
  return {
    officer,
    leader,
    manualOfficer: override?.state === "granted",
    revoked: override?.state === "revoked",
    fresh: facts?.fresh ?? false,
  };
}

/**
 * Fresh evidence gates new automatic roles; explicit local grants do not depend on Lodestone.
 * `unreadable` and `unresolved` keep whatever is held, exactly as 2.43.0's "unknown" did.
 */
export function desiredRankRole(
  state: RankState,
  held: boolean,
  fresh: boolean,
  manual = false,
): boolean {
  if (state === "unreadable" || state === "unresolved") return held;
  return state === "yes" && (manual || fresh || held);
}

/**
 * Whether desiredRankRole decides the same whether or not the member already holds the role
 * (officer status notices, issue #31): "no" always is, "yes" is with a manual grant or fresh
 * evidence, and "unreadable" and "unresolved" never are, since they keep whatever is held.
 */
export function rankDecisive(state: RankState, fresh: boolean, manual = false): boolean {
  return (
    desiredRankRole(state, true, fresh, manual) === desiredRankRole(state, false, fresh, manual)
  );
}
