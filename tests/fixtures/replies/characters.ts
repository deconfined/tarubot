/**
 * The characters reply catalog: one case per CharactersReplyKind, rendered from typed sample
 * results that reproduce the approved mockups (characters#0, #9, #18, #20, #26 and #29) and the
 * reply-specs states. The sample results are exported so command and component tests can return
 * them from service stubs and expect the same cards.
 */
import type {
  AssignResult,
  CharacterRow,
  CharactersResult,
  ClaimResult,
  PreferencesResult,
  UnlinkResult,
  VerifyResult,
} from "../../../src/application/results.js";
import {
  assignReply,
  charactersReply,
  claimReply,
  preferencesReply,
  unlinkReply,
  verifyReply,
  type CharactersReplyKind,
} from "../../../src/discord/presenters/characters.js";
import { CHARACTER, MEMBER_ID, NOW, roster, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** The member the approved officer cards show (characters#20, #29 and #34). */
export const TARGET_ID = "123456789012345678";
/** The approved cards' link UUIDs. */
export const LINK_ID = "3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f98";
const ALT_LINK_ID = "8a1b2c3d-4e5f-4a6b-9c7d-0e1f2a3b4c5d";
const OLD_LINK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6e5f4d3c2b1a";
/** The mockup's example token (characters#0); a real one is 'tarubot_' plus 43 characters too. */
export const TOKEN = "tarubot_ExampleTokenOnly-DoNotUse_0123456789abcdefg";

/** A stored link row as /characters reads it; overrides state only what a case varies. */
export const linkRow = (overrides: Partial<CharacterRow> = {}): CharacterRow => ({
  id: LINK_ID,
  character_id: CHARACTER.id,
  active: true,
  provenance: "profile_token",
  created_at: new Date(1_787_270_400_000),
  ended_at: null,
  name: CHARACTER.name,
  world: CHARACTER.world,
  primary_character_id: CHARACTER.id,
  nickname_enabled: true,
  nickname_suspended: false,
  ...overrides,
});

/** The alt and the ended link the approved /characters cards list beside the main. */
const altRow = (overrides: Partial<CharacterRow> = {}): CharacterRow =>
  linkRow({
    id: ALT_LINK_ID,
    character_id: "23456789",
    provenance: "officer_assignment",
    created_at: new Date(1_789_000_000_000),
    name: "Example Alt",
    ...overrides,
  });
const oldRow = (overrides: Partial<CharacterRow> = {}): CharacterRow =>
  linkRow({
    id: OLD_LINK_ID,
    character_id: "34567890",
    active: false,
    created_at: new Date(1_780_000_000_000),
    ended_at: new Date(1_785_000_000_000),
    name: "Example Old Character",
    ...overrides,
  });

/** Sample service results for every character state, named by the kind they render as. */
export const CHARACTER_RESULTS = {
  claimPending: {
    status: "pending",
    character: CHARACTER.id,
    name: CHARACTER.name,
    world: CHARACTER.world,
    token: TOKEN,
    challenge: "0f1e2d3c-4b5a-4968-8776-655443322110",
    expiresAt: new Date(1_790_123_400_000),
    instructions: "Place the exact token in your public Lodestone biography.",
  },
  claimLinked: {
    status: "already_linked",
    effects: "queued",
    effectsMode: "live",
    character: CHARACTER,
  },
  verified: {
    status: "verified",
    link: LINK_ID,
    effects: "queued",
    effectsMode: "live",
    character: CHARACTER,
    primary: true,
    firstLink: true,
    nicknameSync: true,
    roster: roster(),
  },
  verifiedPaused: {
    status: "verified",
    link: LINK_ID,
    effects: "queued",
    effectsMode: "awaiting_activation",
    character: CHARACTER,
    primary: false,
    firstLink: false,
    nicknameSync: true,
    roster: roster(),
  },
  alreadyVerified: { status: "already_verified", character: CHARACTER },
  unclaimed: {
    status: "unlinked",
    effects: "queued",
    effectsMode: "live",
    instructions: "If this was your primary character, select another with /main.",
    link: LINK_ID,
    owner: MEMBER_ID,
    character: CHARACTER,
    primaryCleared: true,
    remainingActive: 1,
    reason: null,
  },
  unassigned: {
    status: "unlinked",
    effects: "queued",
    effectsMode: "live",
    instructions: "If this was your primary character, select another with /main.",
    link: LINK_ID,
    owner: TARGET_ID,
    character: CHARACTER,
    primaryCleared: true,
    remainingActive: 0,
    reason: "Character transferred to another account.",
  },
  selfList: { characters: [linkRow(), altRow(), oldRow()] },
  officerList: {
    characters: [
      linkRow({ provenance: "officer_assignment", nickname_suspended: true }),
      altRow({ provenance: "profile_token", nickname_suspended: true }),
      oldRow({ nickname_suspended: true }),
    ],
  },
  emptyList: { characters: [] },
  mainSaved: {
    status: "saved",
    effects: "queued",
    effectsMode: "live",
    primary: CHARACTER,
    nickname: { enabled: true, suspended: false },
  },
  nicknameOff: {
    status: "saved",
    effects: "queued",
    effectsMode: "live",
    primary: CHARACTER,
    nickname: { enabled: false, suspended: false },
  },
  nicknameUnchanged: {
    status: "unchanged",
    effects: "unchanged",
    effectsMode: "live",
    primary: null,
    nickname: { enabled: false, suspended: false },
  },
  /** /main naming the current main, or /nickname enabled:true while sync is already on. */
  preferencesUnchanged: {
    status: "unchanged",
    effects: "unchanged",
    effectsMode: "live",
    primary: CHARACTER,
    nickname: { enabled: true, suspended: false },
  },
  assigned: {
    status: "assigned",
    link: LINK_ID,
    effects: "queued",
    effectsMode: "live",
    character: CHARACTER,
    owner: TARGET_ID,
    reason: "Confirmed in-game with the member.",
    primary: false,
    firstLink: false,
    nicknameSync: false,
    officerAuthority: true,
    roster: roster(),
  },
} as const satisfies Record<
  string,
  ClaimResult | VerifyResult | UnlinkResult | CharactersResult | PreferencesResult | AssignResult
>;

/** Shorthands for the sample results. */
const R = CHARACTER_RESULTS;
/** Every case renders against the mockups' clock. */
const now = NOW;

/** Every character reply state, rendered for the audience its card is written for. */
export const CHARACTER_CASES = {
  "claim.pending": {
    spec: "characters#0",
    audience: "member",
    tone: "pending",
    title: "Verify Example Character @ Diabolos",
    timestamp: false,
    render: () => claimReply(R.claimPending, VIEWERS.member, { now }),
  },
  "claim.already_linked": {
    spec: "characters#1",
    audience: "member",
    noOp: true,
    tone: "info",
    title: "Already linked to you",
    timestamp: false,
    render: () => claimReply(R.claimLinked, VIEWERS.member, { now }),
  },
  "verify.verified": {
    spec: "characters#9",
    audience: "member",
    tone: "success",
    title: "Example Character is verified",
    timestamp: true,
    render: () => verifyReply(R.verified, VIEWERS.member, { now }),
  },
  "verify.paused": {
    spec: "errors-and-style#26",
    audience: "member",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () => verifyReply(R.verifiedPaused, VIEWERS.member, { now }),
  },
  "verify.already_verified": {
    spec: "characters#14",
    audience: "member",
    noOp: true,
    tone: "info",
    title: "Already verified",
    timestamp: false,
    render: () => verifyReply(R.alreadyVerified, VIEWERS.member, { now }),
  },
  "unclaim.unlinked": {
    spec: "characters#16",
    audience: "member",
    tone: "success",
    title: "Example Character unlinked",
    timestamp: true,
    render: () => unlinkReply(R.unclaimed, VIEWERS.member, { command: "unclaim", now }),
  },
  "unclaim.paused": {
    spec: "errors-and-style#26",
    audience: "member",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      unlinkReply({ ...R.unclaimed, effectsMode: "deployment_disabled" }, VIEWERS.member, {
        command: "unclaim",
        now,
      }),
  },
  "unassign.unlinked": {
    spec: "characters#34",
    audience: "officer",
    tone: "success",
    title: "Character unassigned",
    timestamp: true,
    render: () => unlinkReply(R.unassigned, VIEWERS.officer, { command: "unassign", now }),
  },
  "unassign.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      unlinkReply({ ...R.unassigned, effectsMode: "awaiting_activation" }, VIEWERS.officer, {
        command: "unassign",
        now,
      }),
  },
  "characters.self": {
    spec: "characters#18",
    audience: "member",
    tone: "info",
    title: "Your characters",
    timestamp: false,
    render: () =>
      charactersReply(R.selfList, VIEWERS.member, { owner: MEMBER_ID, memberOption: false, now }),
  },
  "characters.self_empty": {
    spec: "characters#19",
    audience: "member",
    tone: "info",
    title: "No linked characters",
    timestamp: false,
    render: () =>
      charactersReply(R.emptyList, VIEWERS.member, { owner: MEMBER_ID, memberOption: false, now }),
  },
  "characters.officer": {
    spec: "characters#20",
    audience: "officer",
    tone: "info",
    title: "Linked characters",
    timestamp: false,
    render: () =>
      charactersReply(R.officerList, VIEWERS.officer, {
        owner: TARGET_ID,
        memberOption: true,
        now,
      }),
  },
  "characters.officer_empty": {
    spec: "characters#21",
    audience: "officer",
    tone: "info",
    title: "No linked characters",
    timestamp: false,
    render: () =>
      charactersReply(R.emptyList, VIEWERS.officer, { owner: TARGET_ID, memberOption: true, now }),
  },
  "main.saved": {
    spec: "characters#24",
    audience: "member",
    tone: "success",
    title: "Main character updated",
    timestamp: true,
    render: () =>
      preferencesReply(R.mainSaved, VIEWERS.member, { command: "main", guildOwner: false, now }),
  },
  "main.unchanged": {
    spec: null,
    audience: "member",
    noOp: true,
    tone: "info",
    title: "Already your main character",
    timestamp: false,
    render: () =>
      preferencesReply(R.preferencesUnchanged, VIEWERS.member, {
        command: "main",
        guildOwner: false,
        now,
      }),
  },
  "main.paused": {
    spec: "errors-and-style#26",
    audience: "member",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      preferencesReply({ ...R.mainSaved, effectsMode: "awaiting_activation" }, VIEWERS.member, {
        command: "main",
        guildOwner: false,
        now,
      }),
  },
  "nickname.on": {
    spec: "characters#26",
    audience: "member",
    tone: "success",
    title: "Nickname sync on",
    timestamp: true,
    render: () =>
      preferencesReply(R.mainSaved, VIEWERS.member, {
        command: "nickname",
        guildOwner: false,
        now,
      }),
  },
  "nickname.on_owner": {
    spec: "characters#26",
    audience: "member",
    tone: "warning",
    title: "Nickname sync on",
    timestamp: true,
    render: () =>
      preferencesReply(R.mainSaved, VIEWERS.member, { command: "nickname", guildOwner: true, now }),
  },
  "nickname.off": {
    spec: "characters#27",
    audience: "member",
    tone: "success",
    title: "Nickname sync off",
    timestamp: true,
    render: () =>
      preferencesReply(R.nicknameOff, VIEWERS.member, {
        command: "nickname",
        guildOwner: false,
        now,
      }),
  },
  "nickname.already_on": {
    spec: null,
    audience: "member",
    noOp: true,
    tone: "info",
    title: "Nickname sync already on",
    timestamp: false,
    render: () =>
      preferencesReply(R.preferencesUnchanged, VIEWERS.member, {
        command: "nickname",
        guildOwner: false,
        now,
      }),
  },
  "nickname.unchanged": {
    spec: null,
    audience: "member",
    noOp: true,
    tone: "neutral",
    title: "Nickname sync already off",
    timestamp: false,
    render: () =>
      preferencesReply(R.nicknameUnchanged, VIEWERS.member, {
        command: "nickname",
        guildOwner: false,
        now,
      }),
  },
  "nickname.paused": {
    spec: "errors-and-style#26",
    audience: "member",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      preferencesReply({ ...R.nicknameOff, effectsMode: "deployment_disabled" }, VIEWERS.member, {
        command: "nickname",
        guildOwner: false,
        now,
      }),
  },
  "assign.assigned": {
    spec: "characters#29",
    audience: "manager",
    tone: "success",
    title: "Character assigned",
    timestamp: true,
    render: () => assignReply(R.assigned, VIEWERS.manager, { now }),
  },
  "assign.delegated": {
    spec: "characters#30",
    audience: "officer",
    tone: "success",
    title: "Character assigned",
    timestamp: true,
    render: () => assignReply({ ...R.assigned, officerAuthority: false }, VIEWERS.officer, { now }),
  },
  "assign.already_assigned": {
    spec: null,
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Already linked to this member",
    timestamp: false,
    render: () =>
      assignReply({ ...R.assigned, status: "already_assigned" }, VIEWERS.officer, { now }),
  },
  "assign.paused": {
    spec: "errors-and-style#26",
    audience: "manager",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      assignReply({ ...R.assigned, effectsMode: "awaiting_activation" }, VIEWERS.manager, { now }),
  },
} as const satisfies ReplyCatalog<CharactersReplyKind>;
