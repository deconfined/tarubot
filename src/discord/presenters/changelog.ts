/**
 * The update post (2.25.0, issue #30), which the gateway renders for the changelog.post job: after
 * the bot starts on a newer version, one message in the guild's changelog channel lists the note of
 * each release since the last post (owner decisions of 2026-09-25; every release people can notice
 * has one since 2026-10-09). People read what changed for them, not the technical side; the title
 * links the full CHANGELOG, and /version lists the commits. Pure.
 *
 * The post has no button, no timestamp and nothing per attempt, so every retry of the same job
 * renders byte-identical JSON and Discord's nonce check returns the first message. At most ten
 * releases are listed, newest first; any more are counted in the footer, so nothing is ever cut.
 */
import type { ChangelogPostView } from "../../application/records.js";
import { andMore, plain } from "./format.js";
import { post, type Presented } from "./reply.js";
import { HOUSE_LIMITS } from "./style.js";

/**
 * Every update post kind, with whether its embed carries a timestamp. It has none: the send time
 * would differ between retries, and the post is about the release, not the moment it went out.
 */
const POST_TIMESTAMP = {
  "changelog.update": false,
} as const satisfies Record<string, boolean>;

/** An update post state; tests catalogue one case per kind. */
export type ChangelogPostKind = keyof typeof POST_TIMESTAMP;

/** Every update post kind, for catalog completeness checks. */
export const CHANGELOG_POST_KINDS = Object.keys(POST_TIMESTAMP) as readonly ChangelogPostKind[];

/**
 * 'TaruBot updated to v<version>' linking the CHANGELOG, 'What's new since v<previous>.', then one
 * field per release ('v2.25.0': its note), newest first. Notes are escaped like user text and kept
 * within the 300-character house limit for text in fields; the release-notes test keeps every note
 * inside it, so none is cut. Info tone: an announcement, not an outcome.
 */
export function changelogPost(view: ChangelogPostView): Presented {
  const shown = view.notes.slice(0, HOUSE_LIMITS.fields);
  const hidden = view.notes.length - shown.length;
  return post({
    tone: "info",
    title: `TaruBot updated to v${view.version}`,
    url: view.url,
    description: `What's new since v${view.previous}.`,
    fields: shown.map((release) => ({
      name: `v${release.version}`,
      value: plain(release.note, HOUSE_LIMITS.userText),
    })),
    footer: hidden > 0 ? `${andMore(hidden)} in the full changelog` : undefined,
    // POST_TIMESTAMP: never stamped.
    timestamp: null,
  });
}
