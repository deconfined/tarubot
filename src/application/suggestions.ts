/**
 * Public feature suggestions (2.28.0, issue #32; REQUIREMENTS.md "Approved public-suggestion
 * amendments (2026-09-25)"): `/suggest idea:…` opens an issue in TaruBot's public repository at
 * once, as the TaruBot GitHub App, and replies with its link. The owner moderates afterwards.
 *
 * Who: anyone holding the server's Member or Guest role, and only in the Free Company server this
 * deployment serves (production's allowlist, or DevBot's test guild), so a server that merely
 * invites the bot can't post. What goes public: the member's cleaned text and TaruBot's version,
 * nothing else (src/domain/suggestions.ts). Limits: one per member per hour, three per member and
 * ten in total per day, counted from the audit table; an attempt GitHub didn't confirm counts too.
 *
 * Unlike /issue, nothing is saved first: an idea is easy to retype, and posting in the request the
 * router already deferred needs no table, job or migration. Submissions run one at a time in this
 * process (only the writer-lease holder serves interactions), so the limits are exact without
 * holding a database connection across the GitHub calls. Shutdown drains them before the lease is
 * handed over (`drain`), so a post still at GitHub records its row before the next writer counts.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Configuration } from "../config/env.js";
import { deployments } from "../config/deployment.js";
import { project } from "../config/project.js";
import type { Actor } from "../domain/policy.js";
import { after, secondsUntil } from "../domain/reports.js";
import {
  assertPublic,
  clean,
  MEMBER_SUGGESTION_INTERVAL_SECONDS,
  MEMBER_SUGGESTIONS_PER_DAY,
  maySuggest,
  normalise,
  SUGGESTION_ACTIONS,
  SUGGESTION_LABELS,
  SUGGESTION_MIN,
  suggestionAccessRefused,
  suggestionBody,
  SUGGESTIONS_PER_DAY,
  suggestionTitle,
  suggestionTooShort,
} from "../domain/suggestions.js";
import { Failure } from "../domain/values.js";
import { GitHubApp } from "../infrastructure/github/app.js";
import { GitHubIssues } from "../infrastructure/github/issues.js";
import { audit } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import type { Reporter } from "./reporting.js";
import type { Service } from "./service.js";

/** Where suggestions go, and how to get a client that can open issues there. */
export interface SuggestionTarget {
  /** `owner/name`: the public repository in production, the private reports one on DevBot. */
  readonly repository: string;
  /** A client for one post; production mints a fresh installation token each time. */
  client(): Promise<Pick<GitHubIssues, "create">>;
}

/** What /suggest posted, for the reply. */
export interface SuggestionPosted {
  readonly number: number;
  readonly url: string;
  readonly repository: string;
}

/** The settings a refused production post names, in place of the reports token's. */
const APP_SETTINGS =
  "the GitHub App (GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY) and its installation";

/**
 * The servers /suggest works in: DevBot's test guild, or production's allowlist. A new FC server
 * is deliberately a code change (src/config/deployment.ts).
 */
export function suggestionGuilds(config: Pick<Configuration, "TEST_GUILD_ID">): readonly string[] {
  return config.TEST_GUILD_ID ? [config.TEST_GUILD_ID] : deployments.production.guilds;
}

/**
 * Where this deployment posts, or null when /suggest is switched off.
 * - DevBot (TEST_GUILD_ID set) previews into the private reports repository with the reports
 *   token, and ignores the app settings even if a copied production .env holds them.
 * - Production posts to TaruBot's public repository as the GitHub App; either app setting empty
 *   switches /suggest off (the owner's off switch).
 */
export function suggestionTarget(config: Configuration): SuggestionTarget | null {
  if (config.TEST_GUILD_ID) {
    if (!config.GITHUB_REPORTS_TOKEN) return null;
    const repository = config.GITHUB_REPORTS_REPO;
    return {
      repository,
      client: async () => new GitHubIssues(config.GITHUB_REPORTS_TOKEN, repository),
    };
  }
  if (!config.GITHUB_APP_CLIENT_ID || !config.GITHUB_APP_PRIVATE_KEY) return null;
  const repository = project.repository;
  const app = new GitHubApp(config.GITHUB_APP_CLIENT_ID, config.GITHUB_APP_PRIVATE_KEY, repository);
  return {
    repository,
    client: async () =>
      new GitHubIssues(await app.installationToken(), repository, fetch, undefined, APP_SETTINGS),
  };
}

export class Suggestions {
  /** The end of the one-at-a-time chain; a failed submission never blocks the next. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Set once shutdown drains the chain: submissions that haven't started are refused. */
  private draining = false;

  constructor(
    private readonly app: Service,
    private readonly target: SuggestionTarget | null,
    /** main.ts's reporter: an error-level report also opens a private issue report. */
    private readonly report: Reporter,
    private readonly guilds: readonly string[] = suggestionGuilds(app.config),
  ) {}

  /**
   * /suggest: check where and who, clean the idea into its public form, then, one submission at a
   * time, check the limits, post, and record who sent it. Refusals come before any GitHub call.
   */
  async submit(actor: Actor, idea: string): Promise<SuggestionPosted> {
    // A server outside the allowlist gets "Not available here", even for its server managers.
    if (!this.guilds.includes(actor.guildId))
      throw new Failure(
        "forbidden",
        "Suggestions can be sent only from the Free Company server this TaruBot serves.",
      );
    // The owner's off switch: an expected state, reported at info and never privately.
    const target = this.target;
    if (!target)
      throw new Failure("forbidden", "Suggestions are switched off on this TaruBot right now.");
    // The server must be set up; suggest.use comes from its bound Member and Guest roles.
    await this.app.guild(actor);
    if (!maySuggest(actor)) throw suggestionAccessRefused();
    const normalised = normalise(idea);
    if ([...normalised].length < SUGGESTION_MIN) throw suggestionTooShort();
    const text = clean(normalised);
    const title = suggestionTitle(text);
    const body = suggestionBody(text, project.version);
    // A failure is a bug in the cleaning, so it reaches the member as unexpected and the owner as
    // a private report; it runs before the limits, and repeats group into one report.
    assertPublic(text, title, body);
    return this.serial(async () => {
      // A restart is under way: nothing new reaches GitHub, and the member's card ("TaruBot is
      // restarting right now") asks them to try again shortly.
      if (this.draining)
        throw new Failure("stopping", "Shutdown began before this suggestion was sent.");
      await this.limits(actor);
      const posted = await this.publish(actor, target, title, body);
      // Written after the post: if it fails, the member still gets their link, the owner a
      // private report, and the limits undercount by one.
      try {
        await audit(
          this.app.db.pool,
          actor.guildId,
          actor.userId,
          "suggestion.posted",
          `#${posted.number}`,
          { repository: posted.repository, issue: posted.number },
        );
      } catch (error) {
        this.report(error, "/suggest audit");
      }
      return posted;
    });
  }

  /**
   * The three limits, against the database clock, each counting posted and unconfirmed rows.
   * Rows are read newest first, so the refusal names when enough of them have aged out.
   */
  private async limits(actor: Actor): Promise<void> {
    const recent = (seconds: number, userId: string | null, limit: number) =>
      this.app.db.orm
        .select({ at: t.auditEvents.event_at })
        .from(t.auditEvents)
        .where(
          and(
            inArray(t.auditEvents.action, [...SUGGESTION_ACTIONS]),
            userId === null ? undefined : eq(t.auditEvents.actor_id, userId),
            gt(t.auditEvents.event_at, sql`now()-${seconds}*interval '1 second'`),
          ),
        )
        .orderBy(desc(t.auditEvents.event_at))
        .limit(limit);
    const refuse = (message: string, at: Date, seconds: number) =>
      new Failure("cooldown", message, secondsUntil(at, seconds), {
        kind: "limit",
        limit: "suggest",
        until: after(at, seconds),
      });
    // The member's across every server, then the deployment's.
    const [last] = await recent(MEMBER_SUGGESTION_INTERVAL_SECONDS, actor.userId, 1);
    if (last)
      throw refuse(
        "You sent a suggestion in the last hour. You can send one an hour, and three a day.",
        last.at,
        MEMBER_SUGGESTION_INTERVAL_SECONDS,
      );
    const mine = await recent(86400, actor.userId, MEMBER_SUGGESTIONS_PER_DAY);
    const mineOldest = mine[MEMBER_SUGGESTIONS_PER_DAY - 1]?.at;
    if (mineOldest)
      throw refuse("You've sent three suggestions in the last day.", mineOldest, 86400);
    const all = await recent(86400, null, SUGGESTIONS_PER_DAY);
    const allOldest = all[SUGGESTIONS_PER_DAY - 1]?.at;
    if (allOldest)
      throw refuse(
        `TaruBot has posted ${SUGGESTIONS_PER_DAY} suggestions in the last day, its daily limit.`,
        allOldest,
        86400,
      );
  }

  /**
   * Mint the client (production's token) and create the issue. Only three failures prove nothing
   * was created: GitHub's rate limit, a rejected request and a refused credential, whether at the
   * app's sign-in or at the create. Anything else, a plain error included (a timeout while reading
   * a created issue's answer arrives as one), may have posted, so it is recorded as
   * `suggestion.unconfirmed`, which every limit counts. An outage during the sign-in is treated the
   * same way although nothing could have been posted yet, deliberately: one path and one card,
   * at the cost of an hour's wait after a GitHub outage.
   */
  private async publish(
    actor: Actor,
    target: SuggestionTarget,
    title: string,
    body: string,
  ): Promise<SuggestionPosted> {
    let number: number;
    try {
      const github = await target.client();
      ({ number } = await github.create(title, body, SUGGESTION_LABELS));
    } catch (error) {
      if (error instanceof Failure && error.code === "rate_limited")
        throw new Failure(
          "rate_limited",
          "GitHub is limiting new issues right now.",
          error.retryAfter,
          {
            kind: "limit",
            limit: "suggest",
            until: after(new Date(), error.retryAfter),
          },
        );
      // A rejected request is TaruBot's fault, not the member's: unexpected, reported privately.
      if (error instanceof Failure && error.code === "invalid_data")
        throw new Failure("configuration", error.message);
      if (error instanceof Failure && error.code === "configuration") throw error;
      try {
        await audit(this.app.db.pool, actor.guildId, actor.userId, "suggestion.unconfirmed", null, {
          repository: target.repository,
        });
      } catch (auditError) {
        this.report(auditError, "/suggest audit");
      }
      // The member's card hides a plain error's class, so a bug here still reaches the owner.
      if (!(error instanceof Failure)) this.report(error, "/suggest publish");
      throw new Failure("unavailable", "GitHub didn't confirm the suggestion.", 60, {
        kind: "github",
      });
    }
    return {
      number,
      url: `https://github.com/${target.repository}/issues/${number}`,
      repository: target.repository,
    };
  }

  /**
   * For shutdown: refuse submissions that haven't started, then resolve once the one in progress
   * has finished, its audit row or failure report included. The lifecycle awaits this before it
   * releases the writer lease and closes the pool, so the next writer's limits count that post.
   * A submission that joins while draining is waited for too. Never rejects.
   */
  async drain(): Promise<void> {
    this.draining = true;
    let tail: Promise<unknown>;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  /** Run `work` after every earlier submission has finished, whatever its outcome. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}
