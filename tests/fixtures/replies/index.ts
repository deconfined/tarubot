/**
 * The reply catalog: one case per reply state, rendered from typed sample results. Each group
 * (characters, ledger, configuration, guests, sync and utilities, posts, setup) exports its catalog as
 * `satisfies ReplyCatalog<GroupReplyKind>` from a sibling module and adds it to CATALOGS, so a new
 * reply kind cannot ship without a case, and reply-consistency.test compares concepts across
 * groups. The timestamp flag of each case comes from its approved card.
 */
import { describe, test } from "bun:test";
import type { Audience } from "../../../src/discord/presenters/audience.js";
import type { Presented } from "../../../src/discord/presenters/reply.js";
import type { Tone } from "../../../src/discord/presenters/style.js";
import { expectHouseStyle } from "../replies.js";
import { CHARACTER_CASES } from "./characters.js";
import { CONFIG_CASES } from "./configuration.js";
import { FAILURE_CASES } from "./failures.js";
import { GUEST_CASES } from "./guests.js";
import { LEDGER_CASES } from "./ledger.js";
import { POST_CASES } from "./posts.js";
import { SETUP_CASES } from "./setup.js";
import { SYNC_CASES, UTILITY_CASES, VERSION_CASES } from "./sync-utility.js";

/** One catalogued reply state. */
export interface ReplyCase {
  /**
   * The approved mockup card it reproduces (a selected-specs id such as 'characters#9') or the
   * reply-specs state it implements; null for a gap state that has no drawn card.
   */
  readonly spec: string | null;
  /** Who receives it: a viewer audience, anyone (failures before the actor is known), or a channel. */
  readonly audience: Audience | "any" | "channel";
  /**
   * The concept it presents, when the same concept is reachable from several commands or states
   * (a failure concept such as 'ownership_conflict'). reply-consistency.test requires one title
   * and tone per (concept, audience) across every catalog.
   */
  readonly concept?: string;
  /**
   * A no-op result (nothing new was saved). The C4 tone table makes these info, except the
   * approved neutral cards; reply-consistency.test checks every one.
   */
  readonly noOp?: boolean;
  /**
   * A read-only check (/config validate and its Re-check): nothing is saved, so its approved copy
   * says "Nothing was changed." even on success (C2). Change receipts never say it.
   */
  readonly readOnly?: boolean;
  readonly tone: Tone;
  readonly title: string;
  /** Whether the embed carries a timestamp, as the approved card's `timestamp` records. */
  readonly timestamp: boolean;
  /** A documented exemption from the ten-field house limit (/config show allows 15). */
  readonly maxFields?: number;
  /** Render the state with its presenter. */
  readonly render: () => Presented;
}

/** A group's catalog, keyed by its reply kinds. */
export type ReplyCatalog<Kind extends string> = Readonly<Record<Kind, ReplyCase>>;

/**
 * Every group's catalog. A new reply group registers its catalog module here; the cross-group
 * consistency pins read this map.
 */
export const CATALOGS: Readonly<Record<string, ReplyCatalog<string>>> = {
  failures: FAILURE_CASES,
  characters: CHARACTER_CASES,
  ledger: LEDGER_CASES,
  configuration: CONFIG_CASES,
  guests: GUEST_CASES,
  sync: SYNC_CASES,
  utility: UTILITY_CASES,
  version: VERSION_CASES,
  posts: POST_CASES,
  // 2.35.0 (#46): /setup onboarding's dry run and /setup overrides.
  setup: SETUP_CASES,
};

/**
 * Register one bun test per case: it renders within the house style, with its catalogued tone,
 * title and timestamp flag.
 */
export function catalogTests<Kind extends string>(
  group: string,
  catalog: ReplyCatalog<Kind>,
): void {
  describe(`${group} replies`, () => {
    for (const [kind, reply] of Object.entries<ReplyCase>(catalog))
      test(`${kind} follows the house style`, () => {
        expectHouseStyle(reply.render(), {
          tone: reply.tone,
          title: reply.title,
          timestamp: reply.timestamp,
          ...(reply.maxFields !== undefined && { maxFields: reply.maxFields }),
        });
      });
  });
}
