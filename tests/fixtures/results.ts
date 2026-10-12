/**
 * Typed sample service results and viewers for presenter tests. Values echo the approved mockups
 * (Example Character @ Diabolos, Example Free Company, the mockups' IDs), and each builder takes
 * overrides so a test states only what it varies. Group fixtures under tests/fixtures/replies/
 * build their catalog states from these.
 */
import type {
  CharacterRef,
  DeliveryRow,
  FcRef,
  JobView,
  RosterEvidence,
} from "../../src/application/results.js";
import type { Actor } from "../../src/domain/policy.js";
import { actorOf } from "./actors.js";
import { viewerOf, type Audience, type Viewer } from "../../src/discord/presenters/audience.js";

/** The mockups' "current time": every <t:…> in the approved cards is rendered against it. */
export const NOW = new Date(1_790_169_000_000);

/** A time `seconds` after NOW (negative for the past), as stored rows carry it. */
export const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1_000);

/** The guild and people the mockups show. */
export const GUILD_ID = "123456789012345678";
export const MEMBER_ID = "345678901234567890";
export const OFFICER_ID = "456789012345678901";
export const GUEST_ID = "234567890123456789";
/** The interaction reference failure footers carry. */
export const REF = "1290000000000000001";

/**
 * Actors for each audience, as the router resolves them (2.44.0): an officer counts through the
 * Officer role (officer: true), a manager through Manage Server and Manage Roles together.
 */
export const ACTORS: Readonly<Record<Audience, Actor>> = {
  member: actorOf({
    guildId: GUILD_ID,
    userId: MEMBER_ID,
    manageRoles: false,
    serverManager: false,
  }),
  officer: actorOf({
    guildId: GUILD_ID,
    userId: OFFICER_ID,
    officer: true,
    manageRoles: false,
    serverManager: false,
  }),
  manager: actorOf({
    guildId: GUILD_ID,
    userId: OFFICER_ID,
    officer: true,
    manageRoles: true,
    serverManager: true,
  }),
};

/** The viewer each audience's replies are rendered for. */
export const VIEWERS: Readonly<Record<Audience, Viewer>> = {
  member: viewerOf(ACTORS.member, REF),
  officer: viewerOf(ACTORS.officer, REF),
  manager: viewerOf(ACTORS.manager, REF),
};

/** The approved cards' character. */
export const CHARACTER: CharacterRef = {
  id: "12345678",
  name: "Example Character",
  world: "Diabolos",
};

/** The approved cards' Free Company. */
export const FC: FcRef = {
  id: "9234567890123456789",
  name: "Example Free Company",
  tag: "EXFC",
  world: "Diabolos",
};

/** Roster evidence: fresh and listed unless overridden. */
export const roster = (overrides: Partial<RosterEvidence> = {}): RosterEvidence => ({
  fcLinked: true,
  fresh: true,
  checkedAt: at(-3_180),
  listed: true,
  ...overrides,
});

/** A queued Discord job; override the status, error, attempts and times per case. */
export const job = (overrides: Partial<JobView> = {}): JobView => ({
  id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  kind: "reconcile.user",
  status: "queued",
  attempts: 0,
  due_at: at(420),
  created_at: at(-600),
  completed_at: null,
  last_error: null,
  result: null,
  ...overrides,
});

/** A ledger channel-post row, as ledger views read them. */
export const delivery = (overrides: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
  status: "succeeded",
  last_error: null,
  message_id: "789012345678901234",
  // As a post made before 2.14.0 stored it: its link uses the configured ledger channel.
  channel_id: null,
  entry_id: "7c1d2e3f-8a9b-4c0d-8e1f-2a3b4c5d6e7f",
  sequence: 41n,
  attempts: 1,
  due_at: at(-60),
  ...overrides,
});
