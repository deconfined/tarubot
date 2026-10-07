/**
 * Character presenters: /claim, /verify and its buttons, /unclaim and /unassign, /characters,
 * /main, /nickname and /assign, plus character autocomplete choices. Each renders a typed service
 * result for its viewer as one card, reproducing the approved mockups (characters#0, #9, #18, #20,
 * #26 and #29) exactly and the reply specs for the other states. Failures are never caught here:
 * the router's failure presenter renders them. Pure; the clock is injected for embed timestamps.
 *
 * Change receipts branch on effectsMode (C5): while Discord changes are paused the receipt is the
 * approved paused-save card (errors-and-style#26, owner decision O2), pending tone and titled
 * 'Saved, Discord changes paused', keeping the receipt's own facts. No-op results are info (C4),
 * except the approved neutral 'Nickname sync already off'.
 */
import type { ApplicationCommandOptionChoiceData } from "discord.js";
import type {
  AssignResult,
  CharacterRef,
  CharacterRow,
  CharactersResult,
  ClaimResult,
  EffectsMode,
  PreferencesResult,
  UnlinkResult,
  VerifyResult,
} from "../../application/results.js";
import { nickname } from "../../domain/values.js";
import { isOfficer, type Viewer } from "./audience.js";
import {
  detailsButton,
  editProfileButton,
  lodestoneProfileButton,
  verifyButton,
} from "./controls.js";
import {
  characterName,
  choice,
  cmd,
  code,
  count,
  cutMarkdown,
  deadline,
  link,
  list,
  lodestone,
  member,
  mentionUser,
  plain,
  title,
  titleText,
  when,
} from "./format.js";
import { pausedSave, rosterEvidence, whenApplied } from "./jobs.js";
import { LINK_PROVENANCE } from "./labels.js";
import { reply, type FieldSpec, type Presented, type ReplySpec } from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS, marker } from "./style.js";

/**
 * Every character reply kind, with whether its embed carries a timestamp: the approved card's
 * `timestamp` value, or the reply spec's for states without a drawn card (C11). Paused saves follow
 * errors-and-style#26, which has none. The reply catalog must cover every kind.
 */
const TIMESTAMP = {
  "claim.pending": false,
  "claim.already_linked": false,
  "verify.verified": true,
  "verify.paused": false,
  "verify.already_verified": false,
  "unclaim.unlinked": true,
  "unclaim.paused": false,
  "unassign.unlinked": true,
  "unassign.paused": false,
  "characters.self": false,
  "characters.self_empty": false,
  "characters.officer": false,
  "characters.officer_empty": false,
  "main.saved": true,
  "main.unchanged": false,
  "main.paused": false,
  "nickname.on": true,
  "nickname.on_owner": true,
  "nickname.off": true,
  "nickname.unchanged": false,
  "nickname.already_on": false,
  "nickname.paused": false,
  "assign.assigned": true,
  "assign.delegated": true,
  "assign.already_assigned": false,
  "assign.paused": false,
} as const satisfies Record<string, boolean>;

/** A character reply state; tests catalogue one case per kind. */
export type CharactersReplyKind = keyof typeof TIMESTAMP;

/** Every character reply kind, for catalog completeness checks. */
export const CHARACTER_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly CharactersReplyKind[];

/** Options every character presenter takes. */
export interface CharacterReplyOptions {
  /** The current time for embed timestamps; commands omit it, tests inject the mockups' clock. */
  readonly now?: Date | undefined;
}

/** How many active links /characters lists before 'Showing 8 of N' (house limit of 10 fields). */
export const MAX_LISTED_CHARACTERS = 8;
/** How many ended links 'Previously linked' shows before '…and N more'. */
const MAX_PREVIOUS = 5;

/** Build a character reply of `kind`, stamping it only when its approved card does. */
function card(
  kind: CharactersReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: CharacterReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/**
 * A title around an already title-escaped name, cutting only the name so the whole title stays
 * within the 60-character house limit: 'Verify <name>', '<name> is verified'.
 */
function namedTitle(before: string, name: string, after = ""): string {
  return `${before}${cutMarkdown(name, HOUSE_LIMITS.title - before.length - after.length)}${after}`;
}

/** The character in bold for a sentence: '**Example Character @ Diabolos**'. */
const bold = (character: CharacterRef): string => `**${characterName(character)}**`;

/** The Nickname field for the server owner, whose nickname Discord never lets a bot change. */
const OWNER_NICKNAME = "Discord doesn't let bots change the server owner's nickname.";

/** The projected server nickname (the name cut to 32 graphemes), bold for a sentence. */
const nicknameText = (character: CharacterRef): string =>
  `**${plain(nickname(character.name), HOUSE_LIMITS.characterName)}**`;

/**
 * The Character field value: '[Name](profile) · World', with the Lodestone ID on its own line for
 * officers (approved characters#29).
 */
function characterValue(character: CharacterRef, withId: boolean): string {
  const linked = `${link(character.name, lodestone.character(character.id))} · ${plain(character.world, HOUSE_LIMITS.characterName)}`;
  return withId ? `${linked}\n${code(character.id)}` : linked;
}

/** Whether a change's Discord work is held, which turns its receipt into the paused-save card. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

// ---------------------------------------------------------------------------------------------
// /claim

/**
 * /claim. A new token (approved characters#0): the token is the reply's copyable content, never
 * part of the embed, and the challenge ID and service instructions are not shown. The buttons
 * open the profile, open the Lodestone page where the token is pasted, and verify now (a new
 * reply, so this message and its token are never edited). An existing link of the caller's own
 * is the info card characters#1.
 */
export function claimReply(
  result: ClaimResult,
  _viewer: Viewer,
  options: CharacterReplyOptions = {},
): Presented {
  if (result.status === "already_linked")
    return card(
      "claim.already_linked",
      {
        tone: "info",
        title: "Already linked to you",
        description: `${bold(result.character)} is already one of your linked characters here, so there's no token to add. ${
          paused(result.effectsMode)
            ? `TaruBot will check your roles and nickname ${whenApplied(result.effectsMode)}.`
            : "TaruBot has queued a fresh check of your roles and nickname."
        }`,
        fields: [
          {
            name: "Next",
            value:
              "See everything you've linked with `/characters`, or make this character your main with `/main`.",
          },
        ],
      },
      options,
    );
  const character: CharacterRef = { id: result.character, name: result.name, world: result.world };
  return card(
    "claim.pending",
    {
      tone: "pending",
      title: namedTitle("Verify ", characterName(character, "title")),
      description: [
        "Prove this character is yours by adding a one-time token to its Lodestone biography.",
        "",
        "**1.** Copy the token shown above this card.",
        "**2.** Paste it anywhere in the character's **Character Profile** on the Lodestone, then save.",
        `**3.** Run ${cmd("verify", { character: character.id })}.`,
        "",
        "The Lodestone can take several minutes to publish changes. Your roles and nickname don't change until verification succeeds.",
        // Joined here: an array description drops empty entries, and these are paragraph breaks.
      ].join("\n"),
      fields: [
        { name: "Character", value: characterValue(character, false), inline: true },
        { name: "Token expires", value: deadline(result.expiresAt), inline: true },
        {
          name: "Good to know",
          value:
            "The token only works for you, in this server, for this character. Running `/claim` again for this character replaces the token.",
        },
      ],
      footer: "You can delete the token from your biography once you're verified.",
      copyable: result.token,
      buttons: [
        lodestoneProfileButton(character.id),
        editProfileButton(),
        verifyButton("claim", character.id),
      ],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /verify, 'I've added it — verify now' and 'Check again'

/**
 * The Server roles field after a new link. It never names a role, because roles follow the
 * roster (approved characters#9); without a linked FC there is no roster to mention.
 */
function serverRoles(fcLinked: boolean, mode: EffectsMode): FieldSpec {
  const basis = fcLinked ? ", based on the Free Company roster." : ".";
  return { name: "Server roles", value: `Updating ${whenApplied(mode)}${basis}` };
}

/** Options for /verify: whether the viewer owns the server, as /main and /nickname take it. */
export interface VerifyReplyOptions extends CharacterReplyOptions {
  /**
   * The viewer owns the Discord server, whose nickname no bot may change. Read from the cached
   * guild by the command and button; the Nickname field then states that instead of a change.
   */
  readonly guildOwner?: boolean;
}

/**
 * /verify and its buttons. Verified (approved characters#9, success): the Main character field
 * says whether this became the main; the Nickname field appears only then (with /main's owner
 * wording for the server owner, since Discord refuses that change); stale roster evidence adds the
 * '↻ WAITING' Member role field. Paused effects give the paused-save card with the same facts. An
 * already consumed claim is the neutral-worded info card characters#14.
 */
export function verifyReply(
  result: VerifyResult,
  viewer: Viewer,
  options: VerifyReplyOptions = {},
): Presented {
  if (result.status === "already_verified")
    return card(
      "verify.already_verified",
      {
        tone: "info",
        title: "Already verified",
        description:
          "This claim was already completed. See your linked characters with `/characters`.",
      },
      options,
    );
  const { character, effectsMode: mode } = result;
  const linked = `${bold(character)} is now linked to your Discord account in this server.`;
  const facts: FieldSpec[] = [
    {
      name: "Main character",
      value: !result.primary
        ? `Unchanged. Switch with ${cmd("main", { character: character.id })}.`
        : result.firstLink
          ? "Set as your main because it's your first linked character."
          : "Set as your main because you didn't have one.",
      inline: true,
    },
  ];
  if (result.primary)
    facts.push({
      name: "Nickname",
      // A receipt never promises Discord work that can't happen: the gateway always refuses the
      // server owner's nickname, so the owner reads mainNickname's caveat instead of a change. A
      // re-link keeps the member's sync setting, so sync that is off says how to turn it on.
      value: options.guildOwner
        ? OWNER_NICKNAME
        : result.nicknameSync
          ? `Changes to ${nicknameText(character)} ${whenApplied(mode)}. Turn this off with \`/nickname enabled:false\`.`
          : "Nickname sync is off. Turn it on with `/nickname enabled:true` to use this name.",
      inline: true,
    });
  const waiting = result.roster.fresh ? null : rosterEvidence(result.roster, mode);
  if (paused(mode)) {
    const held = pausedSave(mode, viewer);
    return card(
      "verify.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `The Lodestone shows your token, so ${linked} ${held.sentence}`,
        fields: [...held.fields, ...facts, waiting],
        footer: held.footer,
      },
      options,
    );
  }
  return card(
    "verify.verified",
    {
      tone: "success",
      title: namedTitle("", titleText(character.name), " is verified"),
      description: `The Lodestone shows your token, so ${linked} You can remove the token from your biography.`,
      fields: [...facts, serverRoles(result.roster.fcLinked, mode), waiting],
      footer: "Track updates with /sync status",
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /unclaim and /unassign

/** Which command ended the link: the owner's own /unclaim, or an officer's /unassign. */
export interface UnlinkReplyOptions extends CharacterReplyOptions {
  readonly command: "unclaim" | "unassign";
}

/**
 * /unclaim (characters#16, the owner's voice) and /unassign (characters#34, officer voice).
 * Removals are success tone. The main-character sentence appears only when the ended link was the
 * main, and the Guest caveat only when no active link remains; both hedge, since access also
 * depends on roster evidence and durable grants. Paused effects give the paused-save card.
 */
export function unlinkReply(
  result: UnlinkResult,
  viewer: Viewer,
  options: UnlinkReplyOptions,
): Presented {
  const { character, effectsMode: mode } = result;
  const held = paused(mode) ? pausedSave(mode, viewer) : null;
  if (options.command === "unclaim") {
    const unlinked = `${bold(character)} is no longer linked to your Discord account in this server.`;
    const fields: FieldSpec[] = [
      result.primaryCleared && {
        name: "Main character",
        value:
          result.remainingActive > 0
            ? "This was your main. Choose another with `/main`. Your previous nickname will be restored."
            : "This was your main. Your previous nickname will be restored.",
      },
      {
        name: "Server roles",
        value: [
          `Updating ${whenApplied(mode)}.`,
          "If this was your only Free Company character, you may lose Member access.",
          result.remainingActive === 0 &&
            "You have no linked characters left, so you may lose Guest access unless an officer granted it.",
        ]
          .filter(Boolean)
          .join(" "),
      },
    ].filter((field): field is FieldSpec => Boolean(field));
    if (held)
      return card(
        "unclaim.paused",
        {
          tone: held.tone,
          title: held.title,
          description: `${unlinked} ${held.sentence}`,
          fields: [...held.fields, ...fields],
          footer: held.footer,
        },
        options,
      );
    return card(
      "unclaim.unlinked",
      {
        tone: "success",
        title: namedTitle("", titleText(character.name), " unlinked"),
        description: unlinked,
        fields,
        footer: "Officers can still see the link history.",
      },
      options,
    );
  }
  const consequences = [
    result.primaryCleared &&
      "This was their main, so their previous nickname will be restored and they can pick another with `/main`.",
    result.remainingActive === 0 &&
      "They have no linked characters left, so they may lose Guest access unless an officer granted it.",
  ].filter((sentence): sentence is string => Boolean(sentence));
  const effects = held ? consequences : ["Role and nickname update queued.", ...consequences];
  const fields: (FieldSpec | false)[] = [
    { name: "Member", value: member(result.owner, viewer, "stacked"), inline: true },
    { name: "Character", value: characterValue(character, true), inline: true },
    result.reason !== null && {
      name: "Reason",
      value: plain(result.reason, HOUSE_LIMITS.userText),
    },
    effects.length > 0 && { name: "Effects", value: effects.join(" ") },
  ];
  const unassigned = `${bold(character)} is no longer linked to ${mentionUser(result.owner)}.`;
  const footer = [`Link ${result.link}`, "Recorded in the audit log"];
  if (held)
    return card(
      "unassign.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${unassigned} ${held.sentence}`,
        fields: [...held.fields, ...fields],
        // The approved #26 footer: every paused-save card points to /sync status.
        footer: held.footer,
      },
      options,
    );
  return card(
    "unassign.unlinked",
    { tone: "success", title: "Character unassigned", description: unassigned, fields, footer },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /characters

/** Which record /characters shows and whether its member option was given. */
export interface CharactersReplyOptions extends CharacterReplyOptions {
  /** Whose links these are. */
  readonly owner: string;
  /** The member option was given (the officer layout needs it, even for the officer's own ID). */
  readonly memberOption: boolean;
}

/** A link's provenance in the words of the layout's approved card, or the stored value. */
function provenance(value: string, officerLayout: boolean): string {
  const table: Readonly<Record<string, string>> = officerLayout
    ? LINK_PROVENANCE.officer
    : LINK_PROVENANCE.member;
  return Object.hasOwn(table, value) ? (table[value] ?? value) : value;
}

/** One active link as a field: the main is named as such (approved characters#18 and #20). */
function activeField(row: CharacterRow, officerLayout: boolean): FieldSpec {
  const character = { id: row.character_id, name: row.name, world: row.world };
  const main = row.primary_character_id === row.character_id;
  const lines = officerLayout
    ? [
        `${link("Lodestone", lodestone.character(row.character_id))} · ID ${code(row.character_id)}`,
        `${provenance(row.provenance, true)} · ${when(row.created_at, "f")}`,
        `Link ${code(row.id)}`,
      ]
    : [
        link("Lodestone profile", lodestone.character(row.character_id)),
        `${provenance(row.provenance, false)} · linked ${when(row.created_at, "R")}`,
      ];
  return {
    name: title(characterName(character, "title"), main && "Main"),
    value: lines.join("\n"),
  };
}

/** The Nickname sync field from the owner's preferences, which every row carries. */
function nicknameSync(row: CharacterRow, officerLayout: boolean): FieldSpec {
  const main = row.primary_character_id !== null;
  let value: string;
  if (!row.nickname_enabled)
    value = officerLayout ? "Off" : "Off. Turn it on with `/nickname enabled:true`.";
  else if (row.nickname_suspended)
    value = officerLayout
      ? "Paused (manual nickname detected)"
      : "Paused because you changed your nickname yourself. Resume with `/nickname enabled:true`.";
  else if (!main)
    value = officerLayout ? "On (no main set)" : "On, but no main is set. Choose one with `/main`.";
  else value = officerLayout ? "On" : "On. Your nickname follows your main.";
  return { name: "Nickname sync", value, inline: true };
}

/** Ended links, newest first by end time, as the Previously linked field. */
function previousField(rows: readonly CharacterRow[], officerLayout: boolean): FieldSpec | null {
  if (!rows.length) return null;
  const ended = [...rows].sort(
    (a, b) => (b.ended_at?.getTime() ?? 0) - (a.ended_at?.getTime() ?? 0),
  );
  const lines = ended.map((row) => {
    const name = characterName(row);
    const linked = `linked ${when(row.created_at, "D")}`;
    return officerLayout
      ? `${name} (${code(row.character_id)}), ${linked}, link ${code(row.id)}`
      : `${name}, ${linked}`;
  });
  return {
    name: "Previously linked",
    value: list(lines, { max: MAX_PREVIOUS, budget: DISCORD_LIMITS.fieldValue }),
  };
}

/**
 * /characters. The officer layout (approved characters#20: IDs, link UUIDs, full dates, FC IDs and
 * short provenance labels, plus Full details) applies only when an officer gave the member option;
 * everyone else, including an officer looking at their own record, gets the self layout (#18).
 * Active links come first with the main at the top, at most eight of them ('Showing 8 of N'),
 * then Nickname sync and the five newest ended links. Empty records are characters#19 and #21.
 */
export function charactersReply(
  result: CharactersResult,
  viewer: Viewer,
  options: CharactersReplyOptions,
): Presented {
  const officerLayout = isOfficer(viewer) && options.memberOption;
  const rows = result.characters;
  const active = rows
    .filter((row) => row.active)
    .sort(
      (a, b) =>
        Number(b.primary_character_id === b.character_id) -
          Number(a.primary_character_id === a.character_id) ||
        a.created_at.getTime() - b.created_at.getTime(),
    );
  const previous = previousField(
    rows.filter((row) => !row.active),
    officerLayout,
  );
  const first = rows[0];
  const shown = active.slice(0, MAX_LISTED_CHARACTERS);
  const showing =
    active.length > shown.length ? `Showing ${shown.length} of ${active.length}.` : null;
  const fields: (FieldSpec | null)[] = [
    ...shown.map((row) => activeField(row, officerLayout)),
    active.length > 0 && first ? nicknameSync(first, officerLayout) : null,
    previous,
  ];
  if (officerLayout) {
    const who = member(options.owner, viewer);
    const footer = active.length ? ["Officer view", "Assign: /assign", "Remove: /unassign"] : [];
    return card(
      active.length ? "characters.officer" : "characters.officer_empty",
      {
        tone: "info",
        title: active.length ? "Linked characters" : "No linked characters",
        description: active.length
          ? [
              `Member: ${who}`,
              [
                `${active.length} active`,
                `${rows.length - active.length} previous`,
                showing && `showing ${shown.length}`,
              ]
                .filter(Boolean)
                .join(" · "),
            ]
          : previous
            ? `${who} has no active characters linked in this server. Link one with \`/assign\`.`
            : `${who} has no characters linked in this server, now or previously. Link one with \`/assign\`.`,
        fields,
        footer: footer.length ? footer : "Officer view",
        // The complete rows as JSON, re-read under the presser's fresh authorization.
        buttons: rows.length
          ? [detailsButton({ action: "characters", userId: options.owner })]
          : [],
      },
      options,
    );
  }
  if (!active.length)
    return card(
      "characters.self_empty",
      {
        tone: "info",
        title: "No linked characters",
        description: [
          "Link your FFXIV character so TaruBot can match you with the Free Company roster:",
          "**1.** Run `/claim` with your Lodestone ID, profile URL, or name and world.",
          "**2.** Paste the token into your Lodestone biography.",
          "**3.** Run `/verify`.",
        ],
        fields,
      },
      options,
    );
  const nicknameFollows =
    first?.nickname_enabled && !first.nickname_suspended && first.primary_character_id !== null;
  return card(
    "characters.self",
    {
      tone: "info",
      title: "Your characters",
      description: [
        `${count(active.length, "character")} ${active.length === 1 ? "is" : "are"} linked to your Discord account in this server.`,
        showing,
        nicknameFollows && "Your main sets your server nickname.",
      ]
        .filter(Boolean)
        .join(" "),
      fields,
      footer: ["Switch main: /main", "Remove: /unclaim", "Add: /claim"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /main and /nickname

/** Which preference command ran, and whether the viewer owns the server. */
export interface PreferencesReplyOptions extends CharacterReplyOptions {
  readonly command: "main" | "nickname";
  /**
   * The viewer owns the Discord server, whose nickname no bot may change. Read from the cached
   * guild by the command; it only adds the caveat.
   */
  readonly guildOwner: boolean;
}

/** The server-owner caveat, as its own field. */
const SERVER_OWNER: FieldSpec = {
  name: "Server owner",
  value:
    "Discord doesn't allow bots to change the server owner's nickname, so this won't have a visible effect for you.",
};

/** /main's Nickname field: what happens to the nickname now that this is the main. */
function mainNickname(
  result: PreferencesResult,
  primary: CharacterRef,
  guildOwner: boolean,
): string {
  if (guildOwner) return OWNER_NICKNAME;
  if (!result.nickname.enabled)
    return "Nickname sync is off. Turn it on with `/nickname enabled:true` to use this name.";
  if (result.nickname.suspended)
    return "Paused because you changed your nickname yourself. Resume with `/nickname enabled:true`.";
  return `Changes to ${nicknameText(primary)} ${whenApplied(result.effectsMode)}.`;
}

/**
 * /main (characters#24) and /nickname on (approved characters#26) and off (#27). The server owner
 * turning sync on gets the warning variant with the owner caveat, since Discord refuses bots that
 * change. Turning off sync that is already off is the approved neutral '= NO CHANGE' card. A /main
 * naming the current main, or turning on sync that is already on, is an info '= NO CHANGE' card
 * that never implies a change (owner decision, 2026-09-24). Paused effects give the paused-save
 * card; a no-op saves nothing, so it never does.
 */
export function preferencesReply(
  result: PreferencesResult,
  viewer: Viewer,
  options: PreferencesReplyOptions,
): Presented {
  const mode = result.effectsMode;
  const held = paused(mode) ? pausedSave(mode, viewer) : null;
  if (options.command === "main") {
    const primary = result.primary;
    if (result.status === "unchanged" && primary)
      return card(
        "main.unchanged",
        {
          tone: "info",
          title: "Already your main character",
          description: `${marker("unchanged")} ${bold(primary)} is already your main character in this server.`,
          footer: "Switch to another linked character with /main",
        },
        options,
      );
    const saved = primary
      ? `${bold(primary)} is now your main character in this server.`
      : "Your main character is saved.";
    const fields: FieldSpec[] = primary
      ? [{ name: "Nickname", value: mainNickname(result, primary, options.guildOwner) }]
      : [];
    if (held)
      return card(
        "main.paused",
        {
          tone: held.tone,
          title: held.title,
          description: `${saved} ${held.sentence}`,
          fields: [...held.fields, ...fields],
          footer: held.footer,
        },
        options,
      );
    return card(
      "main.saved",
      { tone: "success", title: "Main character updated", description: saved, fields },
      options,
    );
  }
  if (result.status === "unchanged" && result.nickname.enabled)
    return card(
      "nickname.already_on",
      {
        tone: "info",
        title: "Nickname sync already on",
        description: `${marker("unchanged")} ${
          result.primary
            ? `Your server nickname already follows your main, ${nicknameText(result.primary)}.`
            : "Your server nickname already follows your main."
        }`,
        fields: [options.guildOwner && SERVER_OWNER],
        footer: "Turn off anytime with /nickname enabled:false",
      },
      options,
    );
  if (result.status === "unchanged")
    return card(
      "nickname.unchanged",
      {
        tone: "neutral",
        title: "Nickname sync already off",
        description: `${marker("unchanged")} TaruBot isn't managing your nickname, so there was nothing to turn off.`,
        footer: "Turn it on with /nickname enabled:true",
      },
      options,
    );
  const enabled = result.nickname.enabled;
  const follows = result.primary
    ? `Your server nickname will follow your main, ${nicknameText(result.primary)}.`
    : "Your server nickname will follow your main.";
  const owner = enabled && options.guildOwner;
  if (held)
    return card(
      "nickname.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${enabled ? follows : "TaruBot will stop managing your nickname."} ${held.sentence}`,
        fields: [...held.fields, owner && SERVER_OWNER],
        footer: held.footer,
      },
      options,
    );
  if (!enabled)
    return card(
      "nickname.off",
      {
        tone: "success",
        title: "Nickname sync off",
        description:
          "TaruBot will stop managing your nickname. If TaruBot set your current nickname, your previous one will be restored shortly.",
        footer: "Turn back on with /nickname enabled:true",
      },
      options,
    );
  return card(
    owner ? "nickname.on_owner" : "nickname.on",
    {
      tone: owner ? "warning" : "success",
      title: "Nickname sync on",
      description: `${follows} If you change your nickname yourself later, sync pauses automatically.`,
      fields: [owner && SERVER_OWNER],
      footer: "Turn off anytime with /nickname enabled:false",
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /assign

/**
 * /assign (approved characters#29, officer receipt). The Reason is the officer's own text, escaped
 * and cut to the 300-character field cap. A delegated officer's new link gets the Officer rank
 * field (characters#30), a first link says it became the main, and stale roster evidence adds the
 * '↻ WAITING' Member role field. The idempotent repeat is the info card 'Already linked to this
 * member'. Paused effects give the paused-save card.
 */
export function assignReply(
  result: AssignResult,
  viewer: Viewer,
  options: CharacterReplyOptions = {},
): Presented {
  const { character, effectsMode: mode } = result;
  const held = paused(mode) ? pausedSave(mode, viewer) : null;
  const who = mentionUser(result.owner);
  const identity: FieldSpec[] = [
    { name: "Member", value: member(result.owner, viewer, "stacked"), inline: true },
    { name: "Character", value: characterValue(character, true), inline: true },
    { name: "Reason", value: plain(result.reason, HOUSE_LIMITS.userText) },
  ];
  const footer = [`Link ${result.link}`, "Recorded in the audit log"];
  if (result.status === "already_assigned")
    return card(
      "assign.already_assigned",
      {
        tone: "info",
        title: "Already linked to this member",
        description: `${bold(character)} was already linked to ${who}. ${
          held
            ? `TaruBot will check their roles and nickname ${whenApplied(mode)}.`
            : "TaruBot has queued a fresh check of their roles and nickname."
        }`,
        fields: identity,
        footer,
      },
      options,
    );
  const delegated = !result.officerAuthority;
  const effects = [
    !held && "Role and nickname update queued for this member. Track it with `/sync status`.",
    result.primary &&
      (result.firstLink
        ? "It's their first link, so it's also their main, with nickname sync on."
        : "They had no main character, so it's now their main."),
  ].filter((sentence): sentence is string => Boolean(sentence));
  const fields: (FieldSpec | false | null)[] = [
    ...identity,
    delegated && {
      name: "Officer rank",
      value:
        "You assigned this as a delegated officer, so this link can grant Member or Guest but never the Officer role, even if the character holds the officer rank.",
    },
    effects.length > 0 && { name: "Effects", value: effects.join(" ") },
    result.roster.fresh ? null : rosterEvidence(result.roster, mode),
  ];
  const assigned = `${bold(character)} is now linked to ${who}.`;
  if (held)
    return card(
      "assign.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${assigned} ${held.sentence}`,
        fields: [...held.fields, ...fields],
        // The approved #26 footer: every paused-save card points to /sync status.
        footer: held.footer,
      },
      options,
    );
  return card(
    delegated ? "assign.delegated" : "assign.assigned",
    { tone: "success", title: "Character assigned", description: assigned, fields, footer },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// Autocomplete

/**
 * One character autocomplete choice: the service's 'Name @ World (id)' label as plain text within
 * Discord's 100 characters, and the character ID as the value.
 */
export const characterChoice = (row: {
  readonly name: string;
  readonly value: string;
}): ApplicationCommandOptionChoiceData<string> => choice(row.name, row.value);
