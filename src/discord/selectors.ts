/**
 * Option parsers and the character selector shared by command modules. Every malformed option
 * becomes Failure('input') with an option detail, so commands never call bare z.parse and a
 * remaining ZodError can only mean unexpected external data.
 */
import type { ChatInputCommandInteraction } from "discord.js";
import { z } from "zod";
import type { CharacterQuery, Service } from "../application/service.js";
import type { CharacterIdentity } from "../infrastructure/lodestone/client.js";
import {
  type EntryRef,
  Failure,
  idSchema,
  lodestoneId,
  MAX_GIL,
  sequenceCursor,
} from "../domain/values.js";

/** Longest Lodestone search inputs the adapter accepts (its request schema's bounds). */
const MAX_NAME = 100;
const MAX_WORLD = 80;

/**
 * User IDs remain usable after a member leaves the server; mentions are presentation sugar. Every
 * member option suggests server members (their user IDs) as the officer types, and a pasted ID or
 * mention still works, so the failure names both.
 */
export function userId(value: string, option = "member"): string {
  const candidate = /^<@!?([0-9]+)>$/.exec(value.trim())?.[1] ?? value.trim();
  if (!idSchema.safeParse(candidate).success)
    throw new Failure(
      "input",
      "Pick a member from the suggestions, or paste a Discord user ID or @mention.",
      0,
      { kind: "option", option },
    );
  return candidate;
}

/** Where each kind of UUID option comes from: its option name and where to copy a valid one. */
const UUID_OPTIONS = {
  application: {
    option: "application",
    message:
      "That isn't a valid application ID. Pick one from the suggestions, or copy it from /guest status.",
  },
  run: {
    option: "run_id",
    message: "That isn't a valid run ID. Copy it from your /refresh reply.",
  },
} as const;

/** Parse an application or sync run UUID option. */
export function uuid(value: string, kind: keyof typeof UUID_OPTIONS): string {
  const parsed = z.uuid().safeParse(value.trim());
  const { option, message } = UUID_OPTIONS[kind];
  if (!parsed.success) throw new Failure("input", message, 0, { kind: "option", option });
  return parsed.data;
}

/**
 * /ledger adjust's entry option: the entry number history, receipts and posts show ('5' or '#5'),
 * or the entry's full ID. A number is digits only and an ID is a UUID, so the two forms can't be
 * confused (owner decision, 2026-09-24: the UUID-only option read as the entry number).
 */
export function entryRef(value: string): EntryRef {
  const text = value.trim();
  const number = /^#?\s*([1-9][0-9]{0,18})$/u.exec(text)?.[1];
  if (number !== undefined && BigInt(number) <= MAX_GIL) return { sequence: BigInt(number) };
  const parsed = z.uuid().safeParse(text);
  if (parsed.success) return { id: parsed.data };
  throw new Failure(
    "input",
    "That isn't an entry number or ID. Use the number from /ledger history, such as 5, or the entry's full ID.",
    0,
    { kind: "option", option: "entry" },
  );
}

/**
 * Validate a /ledger history `before` option early; the service parses it again at its own
 * boundary. Returns the canonical decimal entry number, or null for the newest page.
 */
export function cursor(value: string | null): string | null {
  return value === null ? null : sequenceCursor(value.trim()).toString();
}

/** Bound a search input to what the Lodestone adapter accepts, naming the offending option. */
function searchText(value: string, max: number, option: string): string {
  if (value.length > max)
    throw new Failure("input", "Names can be up to 100 characters and worlds up to 80.", 0, {
      kind: "option",
      option,
    });
  return value;
}

/** Resolve exactly one selector form, including complete paginated exact-match searches. */
export async function resolveCharacter(
  app: Service,
  interaction: ChatInputCommandInteraction,
): Promise<CharacterIdentity> {
  return lookUp(app, characterQuery(interaction));
}

/**
 * /claim's selector (#86): a character the server's latest stored roster lists is named from that
 * roster, so the claim's only Lodestone request is /verify's ownership check. Any other character
 * is looked up as resolveCharacter does; `read` says which happened.
 */
export async function resolveClaimCharacter(
  app: Service,
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<{ identity: CharacterIdentity; read: boolean }> {
  const query = characterQuery(interaction);
  const listed = await app.rosterCharacter(guildId, query);
  if (listed) return { identity: listed, read: false };
  return { identity: await lookUp(app, query), read: true };
}

/** Exactly one selector form, validated without any Lodestone request. */
function characterQuery(interaction: ChatInputCommandInteraction): CharacterQuery {
  const options = interaction.options;
  const selector = options.getString("character");
  const forename = options.getString("forename");
  const surname = options.getString("surname");
  const world = options.getString("world");
  if (selector) {
    if (forename !== null || surname !== null || world !== null)
      throw new Failure(
        "input",
        "Use either character: (ID or Lodestone link) or forename + surname + world, not both.",
        0,
        { kind: "option", option: "character" },
      );
    return { id: lodestoneId(selector, "character") };
  }
  if (!forename?.trim() || !surname?.trim() || !world?.trim())
    throw new Failure(
      "input",
      "Add a character ID or Lodestone link, or all three of forename, surname and world.",
      0,
      { kind: "option", option: "character" },
    );
  return {
    name: searchText(`${forename.trim()} ${surname.trim()}`, MAX_NAME, "forename"),
    world: searchText(world.trim(), MAX_WORLD, "world"),
  };
}

/** Read the character's profile, after a complete paginated exact-match search for a name. */
async function lookUp(app: Service, query: CharacterQuery): Promise<CharacterIdentity> {
  if ("id" in query) return app.lodestone.profile(query.id);
  const { name, world } = query;
  const matches = await app.lodestone.search(name, world);
  if (!matches.length)
    throw new Failure(
      "not_found",
      "The Lodestone has no character with that exact name on that world.",
      0,
      { kind: "resource", resource: "character", name, world },
    );
  if (matches.length !== 1)
    // The detail carries every match's ID; the reply lists as many as fit.
    throw new Failure(
      "ambiguous",
      `${matches.length} characters with that name were found. Run the command again with the right one's ID or Lodestone link.`,
      0,
      {
        kind: "matches",
        resource: "character",
        name,
        world,
        ids: matches.map((value) => value.id),
      },
    );
  const found = matches[0];
  if (!found) throw new Error("Missing match");
  return app.lodestone.profile(found.id);
}
