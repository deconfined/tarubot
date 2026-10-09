/** TaruBot's durable application jobs, distinct from dynamically loaded gateway/command adapters. */
import { escapeMarkdown } from "discord.js";
import { z } from "zod";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import type { Service } from "../application/service.js";
import type { Synchronization } from "../application/synchronization.js";
import type { GuildAccess } from "../application/guild-access.js";
import type { IssueReports } from "../application/issue-reports.js";
import { deliverStatus, dropStatus } from "../application/status-notices.js";
import { project } from "../config/project.js";
import { changelogStep } from "../domain/changelog.js";
import { effectsPaused } from "../domain/failures.js";
import { RELEASE_NOTES } from "../domain/release-notes.js";
import { Failure } from "../domain/values.js";
import { managedRoleOrder } from "../domain/role-layout.js";
import { enqueue, type Job } from "./queue.js";

/**
 * Bind application capabilities once; each invocation revalidates its persisted payload. `notes`
 * is the release-note map update posts read (the compiled RELEASE_NOTES); tests pass their own.
 */
export function dispatcher(
  app: Service,
  sync: Synchronization,
  access: GuildAccess,
  reports?: IssueReports,
  notes: Readonly<Record<string, string>> = RELEASE_NOTES,
): (job: Job, guard: () => Promise<void>) => Promise<unknown> {
  return async (job, guard) => {
    if (job.payload_version !== 1)
      throw new Failure(
        "invalid_job",
        "Unsupported job payload version. Use a compatible application image.",
      );
    if (job.kind === "roster") return sync.roster(job, guard);
    if (job.kind === "issue.report") {
      // Delivery to the private reports repository (2.18.0); guild-independent like rosters.
      const input = z.object({ fingerprint: z.string() }).parse(job.payload);
      if (!reports)
        throw new Failure("configuration", "Issue reports aren't wired in this process.");
      return reports.deliver(input.fingerprint, guard);
    }
    if (job.kind === "channels.access") {
      if (!job.guild_id)
        throw new Failure("invalid_job", "Missing guild for access reconciliation.");
      return access.reconcile(job.guild_id, guard);
    }
    if (job.kind === "roster.confirm") {
      // Confirmation shares the normal FC lock, deduplication key, and acquisition bounds.
      const input = z.object({ fcId: z.string() }).parse(job.payload);
      await enqueue(app.db.pool, "roster", `roster:${input.fcId}`, input);
      return { status: "queued" };
    }
    if (job.kind === "reconcile.guild") {
      if (!job.guild_id) throw new Failure("invalid_job", "Missing guild.");
      return sync.guild(job.guild_id, job.id);
    }
    if (job.kind === "reconcile.user") return sync.user(job, guard);
    // Scheduled profile refreshes were retired (#86): profiles are read only to verify ownership.
    // A refresh an older image queued before the upgrade completes without a Lodestone request.
    // A later release can drop this once no such job can remain queued.
    if (job.kind === "profile") return { skipped: "profile refreshes retired" };
    // 2.40.0's member role choices (self-service roles). An older image that meets one after a
    // rollback completes it without a Discord call or a delivery_attempts row, and the database
    // then clears its payload (migration 012's trigger); the member is told to save again. Without
    // this, a rollback would fail each one as invalid_job and file an issue report.
    if (job.kind === "roles.self") return { skipped: "needs a newer TaruBot" };
    // Outbound messages use current guild configuration, not a stale channel copied into a job.
    const [guild] = await app.db.orm
      .select()
      .from(t.guilds)
      .where(
        and(job.guild_id ? eq(t.guilds.id, job.guild_id) : sql`false`, eq(t.guilds.active, true)),
      );
    if (!guild) return { skipped: "guild inactive" };
    // Role presentation is a per-guild opt-in and this is its authoritative gate: every enqueue
    // path, retry, activation requeue and /config requeue reaches it. It precedes the effects
    // check so an unactivated imported guild completes the job as skipped rather than parking it
    // as `disabled`, which activation or a later /config change would requeue.
    if (job.kind === "roles.layout" && !guild.role_layout_enabled)
      return { skipped: "layout disabled" };
    // Update posts (2.25.0) complete every no-post outcome here, before the effects gate, so a
    // paused guild never parks a job with nothing to send (the roles.layout precedent above). The
    // release range comes from the guild's current row, never the payload.
    const changelog =
      job.kind === "changelog.post"
        ? changelogStep(guild.changelog_channel_id, guild.changelog_version, project.version, notes)
        : null;
    if (changelog?.kind === "skip") return { skipped: changelog.reason };
    if (changelog?.kind === "advance") {
      // No release in the range has a note (owner decision 2): move the baseline without posting.
      // The stored reason keeps its 2.25.0 wording, which job rows and /sync status already show.
      // The lease fence comes first, as before every write.
      await guard();
      await app.advanceChangelog(guild.id, changelog.from, project.version, null);
      return { skipped: "nothing for members", version: project.version };
    }
    // Status posts (2.29.0): with no officer notifications channel nothing is saved for later
    // (owner decision 5), and the drop completes here, before the effects gate, so no job parks
    // just because the channel is unset. The lease fence comes first, as before every write.
    if (job.kind === "officer.status" && !guild.officer_notifications_channel_id) {
      await guard();
      return dropStatus(app, guild.id);
    }
    if (!app.config.ENABLE_EFFECTS || !guild.effects_enabled)
      throw effectsPaused(app.config.ENABLE_EFFECTS);
    // The status post has its own resume, window, freeze, send and mark (status-notices.ts), and
    // records its own delivery attempts, so it bypasses the shared single-send tail below.
    if (job.kind === "officer.status") return deliverStatus(app, guild, job, guard);
    if (job.kind === "roles.layout") {
      // Setup and layout share a session lock, keeping network operations outside transactions.
      const client = await app.db.pool.connect();
      let locked = false;
      try {
        locked =
          (
            await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
              [`setup:${guild.id}`],
            )
          ).rows[0]?.locked ?? false;
        if (!locked)
          throw new Failure("busy", "Role setup/layout is already running for this guild.");
        const [current] = await app.db.orm
          .select()
          .from(t.guilds)
          .where(and(eq(t.guilds.id, guild.id), eq(t.guilds.active, true)));
        if (!current) return { skipped: "guild inactive" };
        // Re-read under the setup lock: the switch may have been turned off while the job waited.
        if (!current.role_layout_enabled) return { skipped: "layout disabled" };
        const currentGuard = async () => {
          await guard();
          const valid = await app.db.orm
            .select({ id: t.guilds.id })
            .from(t.guilds)
            .where(
              and(
                eq(t.guilds.id, guild.id),
                eq(t.guilds.revision, current.revision),
                eq(t.guilds.active, true),
                eq(t.guilds.effects_enabled, true),
                // A mid-pass disable fences the next hoist/position write even without a revision
                // bump (for example a direct operator edit); the retry then completes as skipped.
                eq(t.guilds.role_layout_enabled, true),
              ),
            );
          if (!valid.length)
            throw new Failure("superseded", "Role configuration changed during layout.");
        };
        await currentGuard();
        return await app.discord.layoutRoles(guild.id, managedRoleOrder(current), currentGuard);
      } finally {
        if (locked)
          await client
            .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${guild.id}`])
            .catch(() => {});
        client.release();
      }
    }
    await guard();
    await app.db.orm.insert(t.deliveryAttempts).values({ job_id: job.id, status: "started" });
    let messageId: string | undefined;
    // The channel a ledger or update post went to, kept in the job result: the channel can be
    // rebound later, and a jump link must pair the message with the channel it was actually sent to.
    let channelId: string | undefined;
    // Kind-specific facts for the job result (an update post's version).
    let extra: Record<string, unknown> = {};
    try {
      if (job.kind === "changelog.post") {
        // The range was decided above; only a post reaches here, and only with Discord changes on.
        if (changelog?.kind !== "post")
          throw new Failure("invalid_job", "Update post state is unavailable.");
        channelId = changelog.channel;
        // The nonce key names the running version, never the stored one: an earlier post for the
        // stored version would come back from Discord's check, and the compare-and-set would then
        // skip releases that were never posted.
        messageId = await app.discord.send(
          guild.id,
          changelog.channel,
          {
            kind: "changelog",
            view: {
              version: project.version,
              previous: changelog.from,
              notes: changelog.notes,
              url: `${project.url}/blob/${project.branch}/CHANGELOG.md`,
            },
          },
          `changelog:${guild.id}:${project.version}`,
        );
        await guard();
        await app.advanceChangelog(guild.id, changelog.from, project.version, messageId);
        extra = { version: project.version };
      } else if (job.kind === "ledger.notify") {
        // The immutable entry is authoritative; retrying this job never changes money again.
        const { entryId } = z.object({ entryId: z.string().uuid() }).parse(job.payload);
        const [entry] = await app.db.orm
          .select()
          .from(t.ledgerEntries)
          .where(and(eq(t.ledgerEntries.id, entryId), eq(t.ledgerEntries.guild_id, guild.id)));
        if (!entry) throw new Failure("invalid_job", "Ledger entry is unavailable.");
        // Keep visible account history ordered even if later jobs are claimed concurrently.
        const earlier = await app.db.orm
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .innerJoin(
            t.ledgerEntries,
            sql`${t.ledgerEntries.id}::text=${t.jobs.payload}->>'entryId'`,
          )
          .where(
            and(
              eq(t.jobs.kind, "ledger.notify"),
              eq(t.ledgerEntries.account_id, entry.account_id),
              lt(t.ledgerEntries.sequence, entry.sequence),
              ne(t.jobs.status, "succeeded"),
            ),
          )
          .limit(1);
        if (earlier.length)
          throw new Failure("ordered", "An earlier ledger notification is still pending.", 30);
        if (!guild.ledger_channel_id)
          throw new Failure("blocked", "Configure a ledger notification channel.");
        // A correction names the entry it fixes by number ('Corrects #42'): one read on the same
        // account, so an entry ID from elsewhere can never be shown.
        let correctionSequence: bigint | null = null;
        if (entry.correction_id) {
          const [corrected] = await app.db.orm
            .select({ sequence: t.ledgerEntries.sequence })
            .from(t.ledgerEntries)
            .where(
              and(
                eq(t.ledgerEntries.id, entry.correction_id),
                eq(t.ledgerEntries.account_id, entry.account_id),
              ),
            );
          correctionSequence = corrected?.sequence ?? null;
        }
        // The gateway renders the post from this stored data; the nonce key is unchanged.
        channelId = guild.ledger_channel_id;
        messageId = await app.discord.send(
          guild.id,
          guild.ledger_channel_id,
          { kind: "ledger", view: { entry, correctionSequence } },
          `ledger:${entry.id}`,
        );
      } else if (job.kind === "guest.review" || job.kind === "guest.dm") {
        // Review repair and best-effort DMs have independent delivery outcomes.
        const { applicationId } = z.object({ applicationId: z.string().uuid() }).parse(job.payload);
        const [application] = await app.db.orm
          .select()
          .from(t.guestApplications)
          .where(
            and(
              eq(t.guestApplications.id, applicationId),
              eq(t.guestApplications.guild_id, guild.id),
            ),
          );
        if (!application) throw new Failure("invalid_job", "Application unavailable.");
        // The gateway renders the review message and the DM from the stored application.
        if (job.kind === "guest.dm") {
          // Only a decision sends a DM (decide() queues it for approvals and denials, which are
          // final), so any other state is a corrupt job rather than something to announce.
          if (application.state !== "approved" && application.state !== "denied")
            throw new Failure("invalid_job", "Only approved or denied applications send a DM.");
          await app.discord.dm(application.user_id, {
            kind: "decision",
            application,
            cooldownSeconds: app.config.GUEST_COOLDOWN_SECONDS,
          });
        } else {
          messageId = await app.discord.editReview(application);
          await guard();
          await app.db.orm
            .update(t.guestApplications)
            .set({ message_id: messageId })
            .where(
              and(
                eq(t.guestApplications.id, application.id),
                eq(t.guestApplications.guild_id, guild.id),
              ),
            );
        }
      } else if (job.kind === "officer.notify") {
        if (!guild.officer_notifications_channel_id)
          return { skipped: "officer notifications unconfigured" };
        const { message } = z.object({ message: z.string() }).parse(job.payload);
        // Officer notices stay escaped plain text in 2.14.0, a documented exclusion from the
        // embed posts: 2.15.0 (OPS-11) redesigns them. That is a deferral, not a limitation, since
        // payload_version 1 can gain optional structured fields that this parser ignores today.
        messageId = await app.discord.send(
          guild.id,
          guild.officer_notifications_channel_id,
          { kind: "text", text: escapeMarkdown(message) },
          `${job.id}:${job.generation}`,
        );
      } else throw new Failure("invalid_job", "Unknown job kind.");
      await guard();
      // An ambiguous acknowledgement can yield duplicates, all associated with the same decision.
      await app.db.orm
        .update(t.jobs)
        .set({ message_id: messageId ?? t.jobs.message_id })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)));
      await app.db.orm
        .insert(t.deliveryAttempts)
        .values({ job_id: job.id, status: "delivered", message_id: messageId ?? null });
      // The queue stores this object as jobs.result, so no column is needed for the channel.
      return {
        status: "delivered",
        messageId: messageId ?? null,
        ...(channelId ? { channelId } : {}),
        ...extra,
      };
    } catch (error) {
      // Delivery failure is operational history; the application decision remains committed.
      await app.db.orm.insert(t.deliveryAttempts).values({
        job_id: job.id,
        status: "failed",
        diagnostic: error instanceof Failure ? error.code : "delivery_failed",
      });
      throw error;
    }
  };
}
