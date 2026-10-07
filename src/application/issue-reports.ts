/**
 * Issue reports (2.18.0, owner decisions of 2026-09-24): /issue from any member, and automatic
 * reports of unexpected errors, terminal job failures and repeated trouble, opened as issues in a
 * private GitHub repository with as much context as the bot can safely collect.
 *
 * A report is saved first (issue_reports, migration 008) and delivered by an `issue.report` job,
 * so a GitHub outage or a missing token loses nothing. Automatic reports are grouped by
 * fingerprint: the first occurrence opens an issue, and repeats add a comment at most hourly with
 * the count since the last post. A repeat of a closed issue opens a new one that refers back to it.
 * Daily caps bound automatic issues and comments; /issue has its own per-user and per-server limits.
 *
 * Everything that leaves the process passes redact(): known secret shapes and this deployment's own
 * secrets. User text goes into fenced blocks, so it can't @mention anyone on GitHub.
 */
import { and, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Configuration } from "../config/env.js";
import { project } from "../config/project.js";
import { classifyFailure } from "../domain/failures.js";
import type { Actor } from "../domain/policy.js";
import {
  after,
  AUTO_COMMENTS_PER_DAY,
  AUTO_ISSUES_PER_DAY,
  bounded,
  details,
  duration,
  fenced,
  fields,
  fingerprint,
  firstPartyFrames,
  GUILD_REPORTS_PER_DAY,
  LODESTONE_DOWN_SECONDS,
  LODESTONE_RECENT_ATTEMPT_SECONDS,
  logLines,
  redact,
  REPEAT_COMMENT_SECONDS,
  type ReportSource,
  ROSTER_STALE_SECONDS,
  secondsUntil,
  table,
  USER_REPORT_INTERVAL_SECONDS,
  when,
  yesNo,
} from "../domain/reports.js";
import { Failure } from "../domain/values.js";
import type { GitHubIssues } from "../infrastructure/github/issues.js";
import type { Lodestone } from "../infrastructure/lodestone/client.js";
import {
  type Connection,
  type Database,
  type Orm,
  orm,
} from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { scheduleJob } from "../jobs/queue.js";
import type { RecentLogs } from "./recent-logs.js";

/** How often the trouble checks run; the lifecycle ticks every 30 seconds. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/**
 * One fingerprint's context is collected at most this often. Collecting it reads the database
 * several times, so a bug hit on every interaction only
 * counts its repeats in between, keeping `latest` at most this stale.
 */
const RENDER_INTERVAL_MS = 60 * 1000;

/** What /issue did with a report. */
export interface IssueSubmitted {
  /** `queued`: on its way to GitHub. `saved`: kept until issue reporting is configured. */
  readonly delivery: "queued" | "saved";
  readonly ref: string;
}

/** The job fields a terminal-failure report names. */
export interface FailedJob {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
  readonly guild_id: string | null;
  readonly user_id: string | null;
}

/** A report to save: its identity, where it came from, and its rendered Markdown. */
interface Draft {
  readonly fingerprint: string;
  readonly source: ReportSource;
  readonly title: string;
  readonly body: string;
  readonly guildId?: string | null;
  readonly userId?: string | null;
}

export class IssueReports {
  private readonly started = new Date();
  private lastCheck = 0;
  /** When each fingerprint's context was last collected, for RENDER_INTERVAL_MS. */
  private readonly rendered = new Map<string, number>();
  /**
   * When each linked FC was first seen with no accepted roster at all. Its timestamp can't show
   * how long that has lasted (a freshly linked FC has none yet), so the check keeps its own clock.
   */
  private readonly neverAccepted = new Map<string, number>();
  private status: () => unknown = () => null;
  /** Secret values of this deployment, removed from every report even in unfamiliar shapes. */
  private readonly secrets: string[];

  constructor(
    private readonly config: Configuration,
    private readonly db: Database,
    private readonly lodestone: Lodestone,
    private readonly logs: RecentLogs,
    private readonly github: GitHubIssues | null,
  ) {
    const password = (() => {
      try {
        return decodeURIComponent(new URL(config.DATABASE_URL).password);
      } catch {
        return "";
      }
    })();
    this.secrets = [
      config.DISCORD_TOKEN,
      config.GITHUB_REPORTS_TOKEN,
      config.HEALTHCHECKS_PING_URL,
      // The web sign-in's OAuth client secret (#43); unset until the web is configured.
      config.DISCORD_CLIENT_SECRET ?? "",
      password,
    ].filter(Boolean);
  }

  /** The lifecycle's readiness, once the lifecycle exists (it is built after the reporter). */
  useStatus(status: () => unknown): void {
    this.status = status;
  }

  /** Whether reports are delivered, or only saved until a token is configured. */
  get enabled(): boolean {
    return this.github !== null;
  }

  /** Where these reports come from: DevBot confines itself to its test guild. */
  private get environment(): string {
    return this.config.TEST_GUILD_ID ? "devbot" : "production";
  }

  // ---------------------------------------------------------------------------------------------
  // Sources

  /**
   * /issue: the member's own report, with a snapshot of their account and the bot. One per member
   * per 10 minutes and 20 per server per day (owner decision); both refusals say when to try again.
   */
  async user(
    actor: Actor,
    reporter: string,
    ref: string,
    description: string,
  ): Promise<IssueSubmitted> {
    const text = description.trim();
    if (text.length < 10)
      throw new Failure("input", "Describe the problem in at least 10 characters.", 0, {
        kind: "option",
        option: "description",
      });
    // Refuse before collecting context, so hitting the limits costs two reads, not a snapshot.
    await this.limits(this.db.orm, actor);
    const body = await this.render({
      source: "user",
      what: [
        `**Reported by** ${redact(reporter, this.secrets)} (\`${actor.userId}\`) with \`/issue\`.`,
        fenced(redact(text, this.secrets), "text"),
      ].join("\n\n"),
      guildId: actor.guildId,
      userId: actor.userId,
      ref,
    });
    const title = `[${this.environment}] /issue: ${oneLine(redact(text, this.secrets), 80)}`;
    await this.db.transaction(async (client) => {
      const db = orm(client);
      // Serialize both limits: the member's (across every server) and the server's. Every /issue
      // takes the member lock first, then the server's, so two reports can't both pass either
      // limit, and the fixed order can't deadlock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `issue:user:${actor.userId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `issue:${actor.guildId}`,
      ]);
      await this.limits(db, actor);
      await this.save(client, {
        fingerprint: `user:${ref}`,
        source: "user",
        title,
        body,
        guildId: actor.guildId,
        userId: actor.userId,
      });
    });
    return { delivery: this.enabled ? "queued" : "saved", ref };
  }

  /** /issue's limits: one per member per 10 minutes, twenty per server in any 24 hours. */
  private async limits(db: Orm, actor: Actor): Promise<void> {
    const [mine] = await db
      .select({ at: t.issueReports.first_at })
      .from(t.issueReports)
      .where(
        and(
          eq(t.issueReports.source, "user"),
          eq(t.issueReports.user_id, actor.userId),
          gt(
            t.issueReports.first_at,
            sql`now()-${USER_REPORT_INTERVAL_SECONDS}*interval '1 second'`,
          ),
        ),
      )
      .orderBy(desc(t.issueReports.first_at))
      .limit(1);
    if (mine)
      throw new Failure(
        "cooldown",
        "You sent a report a few minutes ago. You can send one every 10 minutes.",
        secondsUntil(mine.at, USER_REPORT_INTERVAL_SECONDS),
        { kind: "limit", limit: "issue", until: after(mine.at, USER_REPORT_INTERVAL_SECONDS) },
      );
    const today = await db
      .select({ at: t.issueReports.first_at })
      .from(t.issueReports)
      .where(
        and(
          eq(t.issueReports.source, "user"),
          eq(t.issueReports.guild_id, actor.guildId),
          gt(t.issueReports.first_at, sql`now()-interval '1 day'`),
        ),
      )
      .orderBy(t.issueReports.first_at)
      .limit(GUILD_REPORTS_PER_DAY);
    const oldest = today[0]?.at;
    if (today.length >= GUILD_REPORTS_PER_DAY && oldest)
      throw new Failure(
        "cooldown",
        `This server has sent ${GUILD_REPORTS_PER_DAY} reports in the last day.`,
        secondsUntil(oldest, 86400),
        { kind: "limit", limit: "issue", until: after(oldest, 86400) },
      );
  }

  /**
   * An unexpected failure (the reporter's error level): grouped by catalog code, error class,
   * where it happened and the first first-party frame, so a bug hit repeatedly is one issue.
   * Never rejects: reporting must not become a second failure. Callers need not await it.
   */
  error(error: unknown, operation: string, scope?: string): Promise<void> {
    return this.errorReport(error, operation, scope).catch(() => {});
  }

  private async errorReport(error: unknown, operation: string, scope?: string): Promise<void> {
    const { code, category, source } = classifyFailure(error);
    const stack = firstPartyFrames(error instanceof Error ? error.stack : undefined);
    const where = scope ?? operation;
    const key = fingerprint("error", code, source, scopeRoot(where), stack[0]);
    if (await this.counted(key)) return;
    const message = error instanceof Error ? error.message : String(error);
    const body = await this.render({
      source: "error",
      what: [
        table(
          ["Code", "Category", "Error", "Where", "Operation"],
          [[code, category, source, where, operation]],
        ),
        `**Message**\n${fenced(redact(message, this.secrets).slice(0, 2000), "text")}`,
        stack.length
          ? `**First-party stack**\n${fenced(redact(stack.join("\n"), this.secrets))}`
          : "_No first-party stack frames._",
      ].join("\n\n"),
      ref: operation,
    });
    await this.saveAndQueue({
      fingerprint: key,
      source: "error",
      title: `[${this.environment}] ${source} (${code}) in ${scopeRoot(where)}`,
      body,
    });
  }

  /**
   * A job that ended failed at error level. Grouped by kind and code, so a kind failing repeatedly
   * is one issue whose comments count the failures. The issue.report kind never reports itself.
   * Never rejects; callers need not await it.
   */
  jobFailed(
    job: FailedJob,
    outcome: { code: string; diagnostic: string; source: string },
  ): Promise<void> {
    if (job.kind === "issue.report") return Promise.resolve();
    return (async () => {
      const key = fingerprint("job", job.kind, outcome.code);
      if (await this.counted(key)) return;
      const body = await this.render({
        source: "job",
        what: table(
          ["Kind", "Job", "Attempts", "Code", "Error", "Diagnostic"],
          [
            [
              job.kind,
              job.id,
              job.attempts,
              outcome.code,
              outcome.source,
              redact(outcome.diagnostic, this.secrets),
            ],
          ],
        ),
        guildId: job.guild_id,
        userId: job.user_id,
        ref: job.id,
      });
      await this.saveAndQueue({
        fingerprint: key,
        source: "job",
        title: `[${this.environment}] ${job.kind} jobs failing (${outcome.code})`,
        body,
        guildId: job.guild_id,
      });
    })().catch(() => {});
  }

  /**
   * Periodic, from the lifecycle's scheduler tick: every five minutes, check for repeated trouble,
   * then queue any saved report that is due (new, or repeats past the hourly comment window).
   */
  async tick(now = Date.now()): Promise<void> {
    if (now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    await this.checkRosters(now);
    await this.checkLodestone(now);
    await this.sweep();
  }

  /**
   * A linked FC whose roster hasn't been accepted for 12 hours is repeated trouble. One with no
   * accepted roster yet (freshly linked, say) counts from when this check first saw it that way,
   * so it is reported only after 12 hours of never succeeding, not minutes after linking.
   */
  private async checkRosters(now: number): Promise<void> {
    const stale = await this.db.orm
      .selectDistinct({
        id: t.freeCompanies.id,
        name: t.freeCompanies.name,
        accepted: t.freeCompanies.last_successful_roster_at,
        attempted: t.freeCompanies.last_attempt_at,
        error: t.freeCompanies.last_error,
      })
      .from(t.freeCompanies)
      .innerJoin(t.guilds, and(eq(t.guilds.fc_id, t.freeCompanies.id), eq(t.guilds.active, true)))
      .where(
        or(
          isNull(t.freeCompanies.last_successful_roster_at),
          lte(
            t.freeCompanies.last_successful_roster_at,
            sql`now()-${ROSTER_STALE_SECONDS}*interval '1 second'`,
          ),
        ),
      );
    const seen = new Set(stale.map((fc) => fc.id));
    for (const id of this.neverAccepted.keys()) if (!seen.has(id)) this.neverAccepted.delete(id);
    for (const fc of stale) {
      if (!fc.accepted) {
        const since = this.neverAccepted.get(fc.id) ?? now;
        this.neverAccepted.set(fc.id, since);
        if (now - since < ROSTER_STALE_SECONDS * 1000) continue;
      }
      const body = await this.render({
        source: "trouble",
        what: [
          `No roster for **${fc.name}** (\`${fc.id}\`) has been accepted for over ${ROSTER_STALE_SECONDS / 3600} hours, so membership changes aren't being picked up.`,
          table(
            ["Last accepted", "Last attempt", "Last error"],
            [[when(fc.accepted), when(fc.attempted), fc.error]],
          ),
        ].join("\n\n"),
        ref: `roster:${fc.id}`,
      });
      await this.saveAndQueue({
        fingerprint: fingerprint("trouble", "roster-stale", fc.id),
        source: "trouble",
        title: `[${this.environment}] Roster for ${fc.name} not accepted for ${ROSTER_STALE_SECONDS / 3600}+ hours`,
        body,
      });
    }
  }

  /**
   * The Lodestone unreachable or throttling, with no answer for an hour, and
   * still failing: the last attempt recent. One failure followed by a quiet hour is no outage.
   */
  private async checkLodestone(now: number): Promise<void> {
    const reach = this.lodestone.reachability();
    if (!reach.failingSince || !reach.lastAttemptAt) return;
    if (now - reach.failingSince.getTime() < LODESTONE_DOWN_SECONDS * 1000) return;
    if (now - reach.lastAttemptAt.getTime() > LODESTONE_RECENT_ATTEMPT_SECONDS * 1000) return;
    const body = await this.render({
      source: "trouble",
      what: [
        `TaruBot hasn't had an answer from the Lodestone since ${when(reach.failingSince)}; the latest request ended \`${reach.lastFailure}\`. Profile refreshes, verification and roster checks are waiting.`,
        table(
          ["Last answer", "Failing since", "Last attempt", "Latest code"],
          [
            [
              when(reach.lastAnswerAt),
              when(reach.failingSince),
              when(reach.lastAttemptAt),
              reach.lastFailure,
            ],
          ],
        ),
      ].join("\n\n"),
      ref: "lodestone",
    });
    await this.saveAndQueue({
      fingerprint: fingerprint("trouble", "lodestone-unreachable"),
      source: "trouble",
      title: `[${this.environment}] Lodestone unreachable for over an hour`,
      body,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Saving and delivery

  /**
   * Count a repeat without collecting context, when this fingerprint's context was collected
   * within RENDER_INTERVAL_MS. Returns false (collect and save) otherwise, or for a new report.
   */
  private async counted(key: string): Promise<boolean> {
    const last = this.rendered.get(key);
    if (last !== undefined && Date.now() - last < RENDER_INTERVAL_MS) {
      const [row] = await this.db.orm
        .update(t.issueReports)
        .set({ occurrences: sql`${t.issueReports.occurrences}+1`, last_at: sql`now()` })
        .where(eq(t.issueReports.fingerprint, key))
        .returning({ due: DUE });
      if (row) {
        if (row.due && this.enabled) await this.queue(this.db.pool, key);
        return true;
      }
    }
    // Bounded: fingerprints are few, but a long-lived process must not grow this without end.
    if (this.rendered.size > 1000) this.rendered.clear();
    this.rendered.set(key, Date.now());
    return false;
  }

  /** Save outside any caller transaction, then queue delivery if it's due. */
  private async saveAndQueue(draft: Draft): Promise<void> {
    await this.db.transaction((client) => this.save(client, draft));
  }

  /**
   * Save a report: a new fingerprint inserts it; a repeat counts the occurrence and keeps its report
   * as `latest`. Delivery is queued when the report is due: never delivered yet, or repeats waiting
   * past the hourly comment window. Otherwise the sweep queues it once it is due.
   */
  private async save(client: Connection, draft: Draft): Promise<void> {
    const body = bounded(draft.body);
    const [row] = await orm(client)
      .insert(t.issueReports)
      .values({
        fingerprint: draft.fingerprint,
        source: draft.source,
        title: draft.title.slice(0, 250),
        body,
        guild_id: draft.guildId ?? null,
        user_id: draft.userId ?? null,
      })
      .onConflictDoUpdate({
        target: t.issueReports.fingerprint,
        set: {
          occurrences: sql`${t.issueReports.occurrences}+1`,
          last_at: sql`now()`,
          latest: body,
        },
      })
      .returning({ due: DUE });
    if (row?.due && this.enabled) await this.queue(client, draft.fingerprint);
  }

  /** Queue delivery of reports that are due; the tick runs this after its checks. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    const due = await this.db.orm
      .select({ fingerprint: t.issueReports.fingerprint })
      .from(t.issueReports)
      .where(
        or(
          isNull(t.issueReports.issue_number),
          and(
            gt(t.issueReports.occurrences, t.issueReports.posted_occurrences),
            or(
              isNull(t.issueReports.posted_at),
              lte(
                t.issueReports.posted_at,
                sql`now()-${REPEAT_COMMENT_SECONDS}*interval '1 second'`,
              ),
            ),
          ),
        ),
      )
      .orderBy(t.issueReports.last_at)
      .limit(50);
    for (const { fingerprint: key } of due) await this.queue(this.db.pool, key);
  }

  /** One active delivery per fingerprint; a short delay folds a burst into one post. */
  private async queue(client: Connection, key: string): Promise<void> {
    await scheduleJob(client, "issue.report", `issue:${key}`, { fingerprint: key }, null, 10);
  }

  /**
   * The issue.report job: open the issue, or comment with the repeats since the last post, or open
   * a new issue when the old one was closed. Automatic reports respect the daily caps; /issue
   * reports have their own limits and are always delivered.
   */
  async deliver(key: string, guard: () => Promise<void>): Promise<unknown> {
    if (!this.github)
      throw new Failure(
        "configuration",
        "Issue reporting is off: GITHUB_REPORTS_TOKEN is not set.",
      );
    const [row] = await this.db.orm
      .select()
      .from(t.issueReports)
      .where(eq(t.issueReports.fingerprint, key));
    if (!row) return { skipped: "report missing" };
    const automatic = row.source !== "user";
    const labels = ["tarubot-report", `source:${row.source}`, `env:${this.environment}`];
    if (row.issue_number !== null) {
      if (row.occurrences <= row.posted_occurrences) return { skipped: "nothing new" };
      if (row.posted_at && Date.now() - row.posted_at.getTime() < REPEAT_COMMENT_SECONDS * 1000)
        return { skipped: "within the hourly comment window" };
    }
    // A repeat of a closed issue opens a new one, so it spends the new-issue allowance, not the
    // comment allowance; the state is read before choosing which daily cap applies.
    const closed =
      row.issue_number !== null && (await this.github.get(row.issue_number)).state === "closed";
    const opening = row.issue_number === null || closed;
    if (automatic && (await this.capped(opening ? "created" : "commented")))
      return { skipped: "daily cap", source: row.source };
    const repeats = row.occurrences - row.posted_occurrences;
    let status: "created" | "commented" | "reopened";
    let number: number;
    if (row.issue_number === null) {
      const created = await this.github.create(
        row.title,
        bounded(
          // A member's report is one message; an automatic one says how often it has happened.
          automatic
            ? `${row.body}\n\n---\n_${row.occurrences} occurrence${row.occurrences === 1 ? "" : "s"} when this issue was opened · fingerprint \`${row.fingerprint}\`_`
            : row.body,
        ),
        labels,
      );
      status = "created";
      number = created.number;
    } else {
      if (closed) {
        const created = await this.github.create(
          row.title,
          bounded(
            `This came back after #${row.issue_number} was closed: ${repeats} more occurrence${repeats === 1 ? "" : "s"} since ${when(row.posted_at)}.\n\n${row.latest ?? row.body}`,
          ),
          labels,
        );
        status = "reopened";
        number = created.number;
      } else {
        await this.github.comment(
          row.issue_number,
          bounded(
            `**${repeats} more occurrence${repeats === 1 ? "" : "s"}** since ${when(row.posted_at)} (${row.occurrences} in total). The latest:\n\n${row.latest ?? row.body}`,
          ),
        );
        status = "commented";
        number = row.issue_number;
      }
    }
    await guard();
    await this.db.orm
      .update(t.issueReports)
      .set({
        issue_number: number,
        issue_created_at: status === "commented" ? row.issue_created_at : sql`now()`,
        posted_occurrences: row.occurrences,
        posted_at: sql`now()`,
      })
      .where(eq(t.issueReports.fingerprint, key));
    return { status, issue: number, source: row.source, occurrences: row.occurrences };
  }

  /** Whether automatic delivery used today's allowance of new issues or comments. */
  private async capped(kind: "created" | "commented"): Promise<boolean> {
    const [row] = await this.db.orm
      .select({ n: count() })
      .from(t.jobs)
      .where(
        and(
          eq(t.jobs.kind, "issue.report"),
          eq(t.jobs.status, "succeeded"),
          gte(t.jobs.completed_at, sql`now()-interval '1 day'`),
          sql`${t.jobs.result}->>'source' <> 'user'`,
          kind === "created"
            ? sql`${t.jobs.result}->>'status' IN ('created','reopened')`
            : sql`${t.jobs.result}->>'status' = 'commented'`,
        ),
      );
    return (row?.n ?? 0) >= (kind === "created" ? AUTO_ISSUES_PER_DAY : AUTO_COMMENTS_PER_DAY);
  }

  // ---------------------------------------------------------------------------------------------
  // Context

  /**
   * The report body: what happened, then the bot's state when it happened: deployment, readiness,
   * the Lodestone, the queue, the server and (for /issue or member-scoped work) the member, and
   * the newest log records. Each section is collected separately; one failing read becomes a note.
   * Single records are two-column tables, times read as UTC, and every code fence starts its line.
   */
  private async render(input: {
    source: ReportSource;
    what: string;
    guildId?: string | null;
    userId?: string | null;
    ref: string;
  }): Promise<string> {
    const section = async (title: string, collect: () => Promise<string>) => {
      try {
        return `### ${title}\n\n${await collect()}`;
      } catch (error) {
        return `### ${title}\n\n_Couldn't collect this: ${error instanceof Error ? error.name : "error"}._`;
      }
    };
    const logs = logLines(this.logs.recent());
    const parts = [
      fields([
        ["Environment", this.environment],
        ["Version", project.version],
        ["Runtime", `Bun ${Bun.version}`],
        ["Up since", when(this.started)],
        ["Reported", when(new Date())],
        ["Source", input.source],
        ["Ref", `\`${input.ref}\``],
      ]),
      `### What happened\n\n${input.what}`,
      await section("Readiness", async () => this.readiness()),
      await section("Lodestone", async () => this.lodestoneState()),
      await section("Queue", () => this.queueState()),
      input.guildId ? await section("Server", () => this.guildState(input.guildId ?? "")) : "",
      input.guildId && input.userId
        ? await section("Member", () => this.memberState(input.guildId ?? "", input.userId ?? ""))
        : "",
      details(
        "Recent log records (UTC, newest last)",
        fenced(redact(logs.join("\n"), this.secrets) || "(none)", "text"),
      ),
    ];
    return redact(parts.filter(Boolean).join("\n\n"), this.secrets);
  }

  /** What /health/ready says, field by field. */
  private async readiness(): Promise<string> {
    const status = (this.status() ?? {}) as Record<string, unknown>;
    const capabilities = (status.capabilities ?? {}) as Record<string, unknown>;
    const flag = (value: unknown) => yesNo(typeof value === "boolean" ? value : undefined);
    return fields([
      ["Ready", flag(status.ready)],
      ["Database", flag(status.database)],
      ["Writer lease", flag(status.writerLease)],
      ["Discord", flag(status.discord)],
      ["Discord changes", flag(status.effects)],
      ["Pending jobs", capabilities.pending ?? "—"],
      ["Blocked jobs", capabilities.blocked ?? "—"],
      ["Oldest roster", duration(capabilities.oldest_roster_age_seconds)],
      ["Degraded FCs", capabilities.degraded_fcs ?? "—"],
    ]);
  }

  /** Whether the Lodestone has been answering, and the adapter's gate, parse slots and selectors. */
  private lodestoneState(): string {
    const reach = this.lodestone.reachability();
    const state = this.lodestone.status();
    const live = state.selectors;
    const sha = (value: unknown) => (typeof value === "string" ? `\`${value.slice(0, 7)}\`` : "—");
    return [
      fields([
        ["Last Lodestone answer", when(reach.lastAnswerAt)],
        ["Last attempt", when(reach.lastAttemptAt)],
        ["Failing since", when(reach.failingSince)],
        ["Latest failure", reach.lastFailure ?? "—"],
        ["Parses running", state.parsing],
        ["Waiting for a slot", state.waiting],
        ["429 cooldown", duration(state.cooldownSeconds)],
        ["429s in a row", state.strikes],
        ["Selector upstream", state.upstream.status],
        // The live selector set (2.19.0): its commit, and whether it came from upstream or the bundle.
        [
          "Selectors",
          `${sha(live.revision)} (${live.source === "upstream" && live.activatedAt ? `live since ${when(new Date(live.activatedAt))}` : "bundled"})`,
        ],
      ]),
      state.upstream.components.length
        ? table(
            ["Upstream", "Deployed", "Latest", "Current"],
            state.upstream.components.map((row) => [
              row.repository,
              sha(row.deployed),
              sha(row.latest),
              yesNo(row.current),
            ]),
          )
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Active work by kind and status, failures in the last day, and the newest failures. */
  private async queueState(): Promise<string> {
    const active = await this.db.orm
      .select({ kind: t.jobs.kind, status: t.jobs.status, n: count() })
      .from(t.jobs)
      .where(inArray(t.jobs.status, ["queued", "running", "blocked", "disabled"]))
      .groupBy(t.jobs.kind, t.jobs.status)
      .orderBy(t.jobs.kind, t.jobs.status);
    const failed = await this.db.orm
      .select({
        id: t.jobs.id,
        kind: t.jobs.kind,
        attempts: t.jobs.attempts,
        error: t.jobs.last_error,
        created: t.jobs.created_at,
      })
      .from(t.jobs)
      .where(and(eq(t.jobs.status, "failed"), gt(t.jobs.created_at, sql`now()-interval '1 day'`)))
      .orderBy(desc(t.jobs.created_at))
      .limit(10);
    return [
      active.length
        ? table(
            ["Kind", "Status", "Jobs"],
            active.map((row) => [row.kind, row.status, row.n]),
          )
        : "_No active jobs._",
      failed.length
        ? `**Newest failures (last day)**\n\n${table(
            ["Kind", "Job", "Attempts", "Last error", "Created"],
            failed.map((row) => [
              row.kind,
              `\`${row.id.slice(0, 8)}\``,
              row.attempts,
              row.error,
              when(row.created),
            ]),
          )}`
        : "_No failed jobs in the last day._",
    ].join("\n\n");
  }

  /** The server's TaruBot settings and its FC's roster state. */
  private async guildState(guildId: string): Promise<string> {
    const [guild] = await this.db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
    if (!guild) return "_No TaruBot configuration for this server._";
    const [fc] = guild.fc_id
      ? await this.db.orm.select().from(t.freeCompanies).where(eq(t.freeCompanies.id, guild.fc_id))
      : [];
    return [
      fields(
        [
          ["Server ID", `\`${guild.id}\``],
          ["Active", yesNo(guild.active)],
          ["Discord changes", yesNo(guild.effects_enabled)],
          ["Settings revision", guild.revision],
          ["Role layout", yesNo(guild.role_layout_enabled)],
          ["Guest applications", yesNo(guild.guest_applications_enabled)],
          ["Officer rank", guild.officer_rank_name ?? "—"],
        ],
        ["Server", "Value"],
      ),
      fc
        ? fields(
            [
              ["Free Company", `${fc.name} (\`${fc.id}\`)`],
              ["Last accepted roster", when(fc.last_successful_roster_at)],
              ["Last attempt", when(fc.last_attempt_at)],
              ["Last error", fc.last_error ?? "—"],
            ],
            ["Roster", "Value"],
          )
        : "_No linked Free Company._",
    ].join("\n\n");
  }

  /** The member's links, main, nickname state, guest and officer standing, work and audit. */
  private async memberState(guildId: string, userId: string): Promise<string> {
    const db = this.db.orm;
    const [member] = await db
      .select()
      .from(t.guildUsers)
      .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, userId)));
    const links = await db
      .select({
        character: t.links.character_id,
        name: t.characters.name,
        world: t.characters.world,
        active: t.links.active,
        provenance: t.links.provenance,
        missing: t.characters.profile_missing_at,
      })
      .from(t.links)
      .leftJoin(t.characters, eq(t.characters.id, t.links.character_id))
      .where(and(eq(t.links.guild_id, guildId), eq(t.links.user_id, userId)))
      .orderBy(desc(t.links.active), desc(t.links.created_at))
      .limit(10);
    const grants = await db
      .select({ provenance: t.guestGrants.provenance, ended: t.guestGrants.ended_at })
      .from(t.guestGrants)
      .where(and(eq(t.guestGrants.guild_id, guildId), eq(t.guestGrants.user_id, userId)));
    const [guest] = await db
      .select({ revoked: t.guestState.revoked })
      .from(t.guestState)
      .where(and(eq(t.guestState.guild_id, guildId), eq(t.guestState.user_id, userId)));
    const [officer] = await db
      .select({ state: t.officerOverrides.state })
      .from(t.officerOverrides)
      .where(and(eq(t.officerOverrides.guild_id, guildId), eq(t.officerOverrides.user_id, userId)));
    const work = await db
      .select({
        kind: t.jobs.kind,
        status: t.jobs.status,
        attempts: t.jobs.attempts,
        error: t.jobs.last_error,
        created: t.jobs.created_at,
      })
      .from(t.jobs)
      .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.user_id, userId)))
      .orderBy(desc(t.jobs.created_at))
      .limit(5);
    const history = await db
      .select({
        action: t.auditEvents.action,
        actor: t.auditEvents.actor_id,
        at: t.auditEvents.event_at,
      })
      .from(t.auditEvents)
      .where(
        and(
          eq(t.auditEvents.guild_id, guildId),
          or(eq(t.auditEvents.actor_id, userId), eq(t.auditEvents.target, userId)),
        ),
      )
      .orderBy(desc(t.auditEvents.event_at))
      .limit(10);
    const main = links.find((row) => row.character === member?.primary_character_id);
    const who = (actor: string | null) =>
      actor === null ? "TaruBot" : actor === userId ? "this member" : `\`${actor}\``;
    return [
      member
        ? fields(
            [
              ["User ID", `\`${userId}\``],
              ["In the server", yesNo(member.present)],
              ["Joined", when(member.joined_at)],
              [
                "Main character",
                main
                  ? `${main.name ?? "?"} @ ${main.world ?? "?"} (\`${main.character}\`)`
                  : (member.primary_character_id ?? "none"),
              ],
              ["Nickname sync", yesNo(member.nickname_enabled)],
              ["Nickname sync suspended", yesNo(member.nickname_suspended)],
              [
                "Guest grants",
                grants
                  .map((grant) => `${grant.provenance}${grant.ended ? " (ended)" : ""}`)
                  .join(", ") || "none",
              ],
              ["Guest revoked", yesNo(guest?.revoked ?? false)],
              ["Officer override", officer?.state ?? "none"],
            ],
            ["Member", "Value"],
          )
        : "_TaruBot has no record of this member in this server._",
      links.length
        ? table(
            ["Character", "World", "ID", "Active", "Provenance", "First 404"],
            links.map((row) => [
              row.name ?? "?",
              row.world ?? "?",
              `\`${row.character}\``,
              yesNo(row.active),
              row.provenance,
              when(row.missing),
            ]),
          )
        : "_No character links._",
      work.length
        ? `**Recent work**\n\n${table(
            ["Kind", "Status", "Attempts", "Last error", "Created"],
            work.map((row) => [row.kind, row.status, row.attempts, row.error, when(row.created)]),
          )}`
        : "_No recent work for this member._",
      history.length
        ? `**Recent audit**\n\n${table(
            ["Action", "By", "When"],
            history.map((row) => [row.action, who(row.actor), when(row.at)]),
          )}`
        : "_No audit entries for this member._",
    ].join("\n\n");
  }
}

/** A saved report needs delivery: never delivered, or repeats past the hourly comment window. */
const DUE = sql<boolean>`${t.issueReports.issue_number} IS NULL OR ${t.issueReports.posted_at} IS NULL OR ${t.issueReports.posted_at} <= now()-${REPEAT_COMMENT_SECONDS}*interval '1 second'`;

/** One line of user text for a title: no newlines, no GitHub @mentions, bounded. */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").replaceAll("@", "＠").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The command or job kind an operation belongs to, for grouping: '/ledger deposit' → '/ledger'. */
function scopeRoot(scope: string): string {
  const root = scope.split(" ")[0] ?? scope;
  // Interaction and job IDs are unique per occurrence and would defeat grouping.
  return /^\d+$|^[0-9a-f-]{36}$/u.test(root) ? "an operation" : root;
}
