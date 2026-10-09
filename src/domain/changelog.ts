/**
 * Update posts (issue #30, owner decisions of 2026-09-25): which releases a guild still has to be
 * told about, and what one changelog.post job does about them. Each guild stores the newest version
 * it was told about (guilds.changelog_version); a post lists the release notes of every release
 * after that version up to the running one, newest first, and then moves the stored version
 * forward. Releases without a note (recorded in NO_RELEASE_NOTE) are never shown, and a range with
 * no notes moves the version without posting (decision 2: silent when an update has nothing anyone
 * can notice). A note added for a release a guild has already moved past is never posted there.
 * Pure; versions are compared with Bun.semver.order, and the database CHECK keeps stored versions
 * comparable.
 */
import { RELEASE_NOTES } from "./release-notes.js";

/** One release's note, as an update post lists it. */
export interface ReleaseNote {
  readonly version: string;
  readonly note: string;
}

/**
 * The notes of every release after `after` and up to and including `through`, newest first. A
 * rollback (`after` at or above `through`) gives none.
 */
export function notesSince(
  after: string,
  through: string,
  notes: Readonly<Record<string, string>> = RELEASE_NOTES,
): ReleaseNote[] {
  return Object.entries(notes)
    .filter(
      ([version]) =>
        Bun.semver.order(version, after) > 0 && Bun.semver.order(version, through) <= 0,
    )
    .sort(([left], [right]) => Bun.semver.order(right, left))
    .map(([version, note]) => ({ version, note }));
}

/**
 * Whether startup queues a post: only when a baseline exists (a channel was set) and the running
 * version is newer than it. A restart on the same version, or an older process after a rollback,
 * queues nothing.
 */
export const changelogDue = (stored: string | null, running: string): boolean =>
  stored !== null && Bun.semver.order(running, stored) > 0;

/**
 * The higher of a stored baseline and the running version: what setting a channel stores, so an
 * operator's higher baseline (or one a newer release wrote) is never lowered.
 */
export const newerVersion = (stored: string | null, running: string): string =>
  stored !== null && Bun.semver.order(stored, running) >= 0 ? stored : running;

/** Why a changelog.post job completes without posting or moving the stored version. */
export type ChangelogSkip = "changelog unconfigured" | "already announced";

/**
 * What one changelog.post job does, from the guild's current row:
 * - skip: no channel or no baseline (posts turned off while the job waited), or the stored version
 *   is already at or past the running one (announced by an earlier job, or left by a newer release);
 * - advance: the releases since the baseline have no release notes, so the version moves without
 *   a post;
 * - post: list `notes` in `channel`, then move the version from `from` to the running one.
 */
export type ChangelogStep =
  | { readonly kind: "skip"; readonly reason: ChangelogSkip }
  | { readonly kind: "advance"; readonly from: string }
  | {
      readonly kind: "post";
      readonly from: string;
      /** The channel to post in: the guild's current changelog channel. */
      readonly channel: string;
      readonly notes: readonly ReleaseNote[];
    };

/** Decide a changelog.post job from the channel and baseline it reads when it runs (never a payload). */
export function changelogStep(
  channel: string | null,
  stored: string | null,
  running: string,
  notes: Readonly<Record<string, string>> = RELEASE_NOTES,
): ChangelogStep {
  if (channel === null || stored === null)
    return { kind: "skip", reason: "changelog unconfigured" };
  if (!changelogDue(stored, running)) return { kind: "skip", reason: "already announced" };
  const listed = notesSince(stored, running, notes);
  return listed.length
    ? { kind: "post", from: stored, channel, notes: listed }
    : { kind: "advance", from: stored };
}
