/**
 * Self-service roles (v4's first use case, 2.39.0; owner decisions of 2026-10-09): officers list
 * existing Discord roles in categories on the web Role menu, and from 2.40.0 members and guests
 * pick their own. Pure: src/application/self-roles.ts reads and writes the menu and calls these
 * functions under its locks.
 *
 * The menu is one versioned JSON document per server (self_role_menus, migration 012). Every edit
 * is "parse the stored document, apply one pure operation, compare, validate, write", so each
 * operation here is a function from a menu to a menu. A stored document that doesn't parse (written
 * by a newer release before a rollback, or damaged) is never edited: only an audited reset replaces
 * it, and nothing on it counts as listed, so members and the job fail closed.
 *
 * Discord is the record of who holds which role; nothing here stores anyone's picks.
 *
 * selfRoleChecker is the one rule set for what may be self-assigned. Any officer may change the
 * menu, adding roles included, with no Discord Manage Roles requirement and no check of the
 * officer's own role position (owner decision, 2026-10-09), so safety rests entirely on these rules
 * and TaruBot's own position. A self-service role:
 * - is an ordinary role TaruBot can assign: it exists, isn't @everyone, an integration, booster or
 *   bot role or TaruBot's own, sits below TaruBot's highest role, and TaruBot has Manage Roles;
 * - is never one of the four access roles TaruBot binds, nor a retired one. Reconciliation adds and
 *   removes those from durable facts, so it would add or strip a menu role from everyone who picked
 *   it (src/application/synchronization.ts's delta). The application layer enforces this under the
 *   guild row lock in the menu editor, Service.configure() and /setup onboarding;
 * - sits below the bound Officer and FC Leader roles and below every role under TaruBot that holds
 *   Kick Members, Ban Members, Time Out Members, Manage Nicknames or Administrator, managed bot
 *   roles such as Dyno's included (the owner's "Refuse them", 2026-10-09). Discord lets someone use
 *   those powers only on people whose highest role is lower than theirs, so a menu role above such
 *   a role would put everyone who picks it out of that role's reach;
 * - holds no server permission @everyone lacks, and never Administrator, Manage Server, Manage
 *   Roles or Manage Channels, whatever @everyone holds;
 * - changes nothing in a channel that everyone, members or guests can already see (the Member and
 *   Guest baselines matter: a Send Messages allow in a members-only announcements channel would
 *   otherwise let every member post there);
 * - allows no permission @everyone lacks server-wide in any channel, opened or not, View Channel
 *   aside: a Manage Messages allow in a channel members see through their Member role would
 *   otherwise make every member who picks the role a moderator there (the owner's rule of
 *   2026-10-09: "no more than @everyone's server permissions there"). View Channel is judged by
 *   what the role opens, below, so opt-in channels work where @everyone lacks it server-wide;
 * - lifts no deny another role's overwrite sets in any channel, and no deny at all in a channel it
 *   doesn't open, View Channel included: Discord lets any role's allow beat every role's deny, so a
 *   Send Messages allow would otherwise undo a mute role, a View Channel allow a jail or
 *   quarantine role, or let people who see a read-only channel through an officer-assigned role
 *   post there. In a channel the role opens, lifting @everyone's own deny is what an opt-in channel
 *   is, and lifting the Member or Guest role's View Channel deny is how one works in a server
 *   private by default, so those two stay allowed there;
 * - takes nothing away from the people who hold it: no deny of its own in a channel it doesn't
 *   open, and nothing lost by everyone, members or guests in a channel they already see. Otherwise
 *   a mute, jail or quarantine role could be listed, and the people it restricts could remove it;
 * - may open channels those people can't see (opt-in channels, owner decision 2026-10-09), but
 *   never one TaruBot recognises as officer-facing. That recognition is a heuristic (see
 *   officerFacing), so the editor lists every channel each role opens.
 *
 * Channels TaruBot can't read (src/domain/visibility.ts's unreadable) are outside every channel
 * rule: their real overwrites, the role's own entry included, aren't in the snapshot at all, so a
 * Manage Messages allow there is as invisible as a View Channel one. They are counted instead, and
 * an add needs the officer's confirmation that the roles neither open them nor give any permission
 * in them.
 *
 * Messages are plain sentences that name roles and channels with Discord's mention grammar (<@&id>,
 * <#id>), which the web renders through src/web/mentions.ts; they never contain officer-typed text.
 */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { z } from "zod";
import {
  type ApiRole,
  ascendingRoles,
  channelPermissions,
  guildPermissions,
  LABELLED_PERMISSIONS,
  type PermissionKey,
  permissionLabel,
} from "./permissions.js";
import { idSchema } from "./values.js";
import { unreadable, type VisibilityChannel, type VisibilityGuild } from "./visibility.js";

/** The menu's caps (the owner's, 2026-10-09), which bound each save's Discord work and the page. */
export const MENU_LIMITS = {
  categories: 10,
  optionsPerCategory: 25,
  options: 50,
  /** Characters (code points) in a category name. */
  name: 40,
  /** Characters in a category description. */
  description: 200,
  /** Characters in an option's description. */
  optionDescription: 100,
  /** The highest "pick up to N". */
  max: 25,
} as const;

/** A category's state. */
export const CATEGORY_STATES = ["draft", "published", "removal_only"] as const;
/**
 * - draft: only officers see it, and the job ignores it;
 * - published: everyone with Member or Guest can pick its roles;
 * - removal_only ("Stop offering"): shown only to people who hold one of its roles, who may remove
 *   it; nobody may add one.
 */
export type CategoryState = (typeof CATEGORY_STATES)[number];

export interface SelfRoleOption {
  readonly roleId: string;
  readonly description: string;
  /** "Not offered" for one role: holders may remove it; nobody may add it. */
  readonly removalOnly: boolean;
}

export interface SelfRoleCategory {
  /** A UUID minted by the form that created it, so a repeated create is recognised. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 1 = pick one; 2..MENU_LIMITS.max = pick up to N; null = any number. */
  readonly max: number | null;
  readonly state: CategoryState;
  readonly options: readonly SelfRoleOption[];
}

/** The whole menu, in display order. `v` changes whenever the document's shape does. */
export interface SelfRoleMenu {
  readonly v: 1;
  readonly categories: readonly SelfRoleCategory[];
}

/** What a server without a saved menu has, and what a reset writes (the migration's default). */
export const EMPTY_MENU: SelfRoleMenu = { v: 1, categories: [] };

/**
 * The job kind of a member's own role choices (queued from 2.40.0). Its rows say who changed their
 * roles and when, never which, and never name the member to anyone else: officers' job views show
 * "a member" (owner decision Q4 A), and finished rows are deleted after 30 days.
 */
export const ROLE_CHOICE_KIND = "roles.self";
/** How long a finished role-choice job is kept (owner decision Q4 A). */
export const ROLE_CHOICE_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------------------------
// Text

/**
 * The invisible characters text still needs, which the hidden-character rule allows: the zero-width
 * joiner (emoji sequences, Indic scripts) and non-joiner (Persian), and the variation selectors
 * (text or emoji style, ideographic variants).
 */
const JOINERS = /\u200C|\u200D|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
/**
 * An emoji tag sequence's tags, such as a subdivision flag's (Scotland's): tag characters right
 * after U+1F3F4 WAVING BLACK FLAG, ending in U+E007F CANCEL TAG. A tag character anywhere else
 * stays hidden.
 */
const EMOJI_TAGS = /(?<=\u{1F3F4})[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
/** Text with the invisible characters it may keep (JOINERS, EMOJI_TAGS) removed. */
const drawn = (text: string): string => text.replace(EMOJI_TAGS, "").replace(JOINERS, "");
/**
 * What stored text may not hold once drawn() has removed what it may keep: C0 and C1 controls, line
 * and paragraph separators, lone surrogates, every format character (the bidi controls and marks,
 * zero-width spaces, word joiners, the byte order mark, tag characters…) and every other
 * default-ignorable code point (the soft hyphen, Hangul fillers…). So a name can't look blank, and
 * two names can't differ only by something nobody sees.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
/**
 * A character that draws something: a letter, number, punctuation mark or symbol, apart from
 * U+2800 BRAILLE PATTERN BLANK, a symbol that draws nothing. Non-empty text needs one.
 */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const BLANK_SYMBOL = /\u2800/gu;
/** Characters as people count them (code points), not UTF-16 units. */
const characters = (text: string): number => [...text].length;
/** Trimmed and in NFC: the only form a stored text has. */
export const cleanText = (value: string): string => value.trim().normalize("NFC");

export const TEXT_MESSAGES = {
  hidden: "Remove hidden formatting characters.",
  name: "Give the category a name.",
  tooLong: (limit: number) => `Use at most ${limit} characters.`,
} as const;

/** Why a cleaned text can't be stored, or null. */
function textProblem(text: string, limit: number, required: boolean): string | null {
  const shown = drawn(text);
  if (HIDDEN.test(shown)) return TEXT_MESSAGES.hidden;
  if (text !== "" && !VISIBLE.test(shown.replace(BLANK_SYMBOL, "")))
    return required ? TEXT_MESSAGES.name : TEXT_MESSAGES.hidden;
  if (required && text === "") return TEXT_MESSAGES.name;
  if (characters(text) > limit) return TEXT_MESSAGES.tooLong(limit);
  return null;
}

/** A stored text: already clean, within its limit, and non-empty when required. */
const storedText = (limit: number, required = false) =>
  z.string().refine((text) => text === cleanText(text) && !textProblem(text, limit, required));

// ---------------------------------------------------------------------------------------------
// The document

const optionSchema = z.strictObject({
  roleId: idSchema,
  description: storedText(MENU_LIMITS.optionDescription),
  removalOnly: z.boolean(),
});
const maxSchema = z.number().int().min(1).max(MENU_LIMITS.max).nullable();
const categorySchema = z.strictObject({
  id: z.uuid(),
  name: storedText(MENU_LIMITS.name, true),
  description: storedText(MENU_LIMITS.description),
  max: maxSchema,
  state: z.enum(CATEGORY_STATES),
  options: z.array(optionSchema).max(MENU_LIMITS.optionsPerCategory),
});

/**
 * The stored document, checked on every read and before every write. Strict, so a field a newer
 * release added makes the document unreadable here rather than silently dropped by the next edit.
 * Each role appears once in the whole menu and each category ID once: zod rules, not SQL
 * constraints, because the menu is one JSON value.
 */
export const menuSchema = z
  .strictObject({
    v: z.literal(1),
    categories: z.array(categorySchema).max(MENU_LIMITS.categories),
  })
  .refine((menu) => {
    const roles = menu.categories.flatMap((category) => category.options.map((o) => o.roleId));
    const ids = menu.categories.map((category) => category.id);
    return (
      roles.length <= MENU_LIMITS.options &&
      new Set(roles).size === roles.length &&
      new Set(ids).size === ids.length
    );
  });

/** A stored menu, or null when this build can't read it (see the module comment). */
export function readMenu(value: unknown): SelfRoleMenu | null {
  const parsed = menuSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The menu rebuilt with a fixed key order. PostgreSQL's jsonb doesn't keep key order, so a stored
 * menu and an edited one compare only in this form.
 */
function canonical(menu: SelfRoleMenu): SelfRoleMenu {
  return {
    v: 1,
    categories: menu.categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      max: category.max,
      state: category.state,
      options: category.options.map((option) => ({
        roleId: option.roleId,
        description: option.description,
        removalOnly: option.removalOnly,
      })),
    })),
  };
}

/** Whether two menus are the same document (the equal-state rule). */
export function sameMenu(left: SelfRoleMenu, right: SelfRoleMenu): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

// ---------------------------------------------------------------------------------------------
// What the menu lists

/** Where a role is on the menu, or undefined. */
export function findOption(
  menu: SelfRoleMenu,
  roleId: string,
): { readonly category: SelfRoleCategory; readonly option: SelfRoleOption } | undefined {
  for (const category of menu.categories) {
    const option = category.options.find((candidate) => candidate.roleId === roleId);
    if (option) return { category, option };
  }
  return undefined;
}

/** Every role on the menu, drafts included, in display order. */
export function menuRoleIds(menu: SelfRoleMenu): string[] {
  return menu.categories.flatMap((category) => category.options.map((option) => option.roleId));
}

/** Someone may add the role: it is offered in a published category. */
export function addable(menu: SelfRoleMenu, roleId: string): boolean {
  const found = findOption(menu, roleId);
  return found !== undefined && found.category.state === "published" && !found.option.removalOnly;
}

/** The role is shown to members, so whoever holds it can remove it: any category but a draft. */
export function listed(menu: SelfRoleMenu, roleId: string): boolean {
  const found = findOption(menu, roleId);
  return found !== undefined && found.category.state !== "draft";
}

// ---------------------------------------------------------------------------------------------
// Officer edits

/**
 * An option's row in the Edit roles form. A form's rows come in the order it rendered them, the
 * category's options in order, so the row at index i was shown at position i + 1 (editOptions
 * relies on it to break ties).
 */
export interface OptionRow {
  readonly roleId: string;
  readonly description: string;
  /** 1-based, as typed; rows are ordered by it (see editOptions for ties). */
  readonly position: number;
  /** "offered", "removal_only" (Not offered), or "remove" (people keep the role in Discord). */
  readonly state: "offered" | "removal_only" | "remove";
}

/**
 * One officer edit, by ID, never by index: `to` is the absolute zero-based place a category moves
 * to (clamped to the list), so a repeated Move up changes nothing the second time.
 */
export type MenuOperation =
  | {
      readonly op: "category.create";
      readonly categoryId: string;
      readonly name: string;
      readonly description: string;
      readonly max: number | null;
    }
  | {
      readonly op: "category.edit";
      readonly categoryId: string;
      readonly name: string;
      readonly description: string;
      readonly max: number | null;
    }
  | { readonly op: "category.move"; readonly categoryId: string; readonly to: number }
  | { readonly op: "category.setState"; readonly categoryId: string; readonly state: CategoryState }
  | { readonly op: "category.delete"; readonly categoryId: string }
  | { readonly op: "menu.publishAll" }
  | { readonly op: "menu.reset" }
  | {
      readonly op: "options.add";
      readonly categoryId: string;
      readonly roleIds: readonly string[];
      /**
       * The officer confirmed they checked the channels TaruBot can't read. Required (by the
       * application layer) only when there are some.
       */
      readonly unreadableAcknowledged: boolean;
    }
  | {
      readonly op: "options.edit";
      readonly categoryId: string;
      readonly rows: readonly OptionRow[];
    };

/** Every operation's name, which is also its audit target. */
export const MENU_OPERATIONS = [
  "category.create",
  "category.edit",
  "category.move",
  "category.setState",
  "category.delete",
  "menu.publishAll",
  "menu.reset",
  "options.add",
  "options.edit",
] as const satisfies readonly MenuOperation["op"][];

/**
 * A refused field. `field` names what the form should mark: "name", "description", "max",
 * "roleIds", "acknowledged", "rows", `description:<roleId>` and `position:<roleId>` for an Edit
 * roles row, or "form" for the form as a whole. Messages never quote what was typed.
 */
export interface MenuFieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * An operation's result: the menu it produces (which may equal the current one: the caller's
 * equal-state rule), `gone` when it names a category or option that no longer exists (another
 * officer removed it; a 409), or `invalid` with the refused fields (a 422).
 */
export type MenuEdit =
  | { readonly kind: "menu"; readonly menu: SelfRoleMenu }
  | { readonly kind: "gone" }
  | { readonly kind: "invalid"; readonly errors: readonly MenuFieldError[] };

export const LIMIT_MESSAGES = {
  categories: `A role menu can have at most ${MENU_LIMITS.categories} categories.`,
  optionsPerCategory: `A category can hold at most ${MENU_LIMITS.optionsPerCategory} roles.`,
  options: `The role menu can hold at most ${MENU_LIMITS.options} roles in all.`,
  max: "Choose how many roles someone can pick.",
  roleIds: "Choose at least one role to add.",
  unknownRole: "Choose roles from the list.",
  otherCategory: (roleId: string) => `<@&${roleId}> is already in another category.`,
  position: "Use a whole number of 1 or more.",
  rows: "Each role can appear only once.",
  /** Not "reload": the page answering a POST would send the same form again. */
  form: "This form is out of date. Open the page again, then redo your change.",
  duplicateName: "Another category already has this name.",
} as const;

/** The category's text and limit, cleaned, or the fields that refuse. */
function categoryFields(
  input: { readonly name: string; readonly description: string; readonly max: number | null },
  errors: MenuFieldError[],
): { name: string; description: string; max: number | null } {
  const name = cleanText(input.name);
  const description = cleanText(input.description);
  const nameProblem = textProblem(name, MENU_LIMITS.name, true);
  if (nameProblem) errors.push({ field: "name", message: nameProblem });
  const descriptionProblem = textProblem(description, MENU_LIMITS.description, false);
  if (descriptionProblem) errors.push({ field: "description", message: descriptionProblem });
  if (!maxSchema.safeParse(input.max).success)
    errors.push({ field: "max", message: LIMIT_MESSAGES.max });
  return { name, description, max: input.max };
}

/**
 * Refuse a category name another category already has, ignoring case: the page tells each
 * category's repeated controls apart by its name (WCAG 2.4.6), and so will members. Checked here,
 * on create and edit, rather than in menuSchema, so a stored menu is never made unreadable by it.
 * Only a name that passed its own checks is compared, without the joiners and variation selectors
 * it may keep (JOINERS), so "Pro<ZWJ>nouns" can't pass as a second "Pronouns". This isn't a
 * homoglyph defence: a Cyrillic o (U+043E) for a Latin one still makes a different name.
 */
function duplicateName(
  categories: readonly SelfRoleCategory[],
  name: string,
  except: string,
  errors: MenuFieldError[],
): void {
  if (errors.some((error) => error.field === "name")) return;
  const fold = (text: string): string => drawn(text).toLowerCase();
  const folded = fold(name);
  if (categories.some((other) => other.id !== except && fold(other.name) === folded))
    errors.push({ field: "name", message: LIMIT_MESSAGES.duplicateName });
}

const withCategories = (categories: readonly SelfRoleCategory[]): MenuEdit => ({
  kind: "menu",
  menu: { v: 1, categories },
});
const invalid = (errors: readonly MenuFieldError[]): MenuEdit => ({ kind: "invalid", errors });

/**
 * Apply one officer edit to `menu` (see MenuOperation and MenuEdit). Pure. Roles being added are
 * checked here only for the menu's own rules (format, one place on the menu, the caps); whether a
 * role may be self-assigned at all is selfRoleChecker's, which needs a Discord snapshot.
 */
export function applyOperation(menu: SelfRoleMenu, operation: MenuOperation): MenuEdit {
  const categories = menu.categories;
  if (operation.op === "menu.reset") return { kind: "menu", menu: EMPTY_MENU };
  if (operation.op === "menu.publishAll")
    return withCategories(
      categories.map((category) =>
        category.state === "draft" ? { ...category, state: "published" } : category,
      ),
    );
  const index = categories.findIndex((category) => category.id === operation.categoryId);
  const current = categories[index];
  if (operation.op === "category.create") {
    // The form mints the ID, so a repeated submit finds its own category: success, no write.
    if (current) return { kind: "menu", menu };
    if (!z.uuid().safeParse(operation.categoryId).success)
      return invalid([{ field: "form", message: LIMIT_MESSAGES.form }]);
    const errors: MenuFieldError[] = [];
    const fields = categoryFields(operation, errors);
    duplicateName(categories, fields.name, operation.categoryId, errors);
    if (categories.length >= MENU_LIMITS.categories)
      errors.push({ field: "form", message: LIMIT_MESSAGES.categories });
    if (errors.length > 0) return invalid(errors);
    return withCategories([
      ...categories,
      { id: operation.categoryId, ...fields, state: "draft", options: [] },
    ]);
  }
  // Deleting what is already gone is the repeat of a delete: success, no write.
  if (operation.op === "category.delete")
    return current
      ? withCategories(categories.filter((_, at) => at !== index))
      : { kind: "menu", menu };
  if (!current) return { kind: "gone" };
  const replaced = (category: SelfRoleCategory): MenuEdit =>
    withCategories(categories.map((candidate, at) => (at === index ? category : candidate)));
  switch (operation.op) {
    case "category.edit": {
      const errors: MenuFieldError[] = [];
      const fields = categoryFields(operation, errors);
      duplicateName(categories, fields.name, current.id, errors);
      return errors.length > 0 ? invalid(errors) : replaced({ ...current, ...fields });
    }
    case "category.setState":
      return replaced({ ...current, state: operation.state });
    case "category.move": {
      if (!Number.isInteger(operation.to))
        return invalid([{ field: "form", message: LIMIT_MESSAGES.form }]);
      const to = Math.min(Math.max(operation.to, 0), categories.length - 1);
      const rest = categories.filter((_, at) => at !== index);
      return withCategories([...rest.slice(0, to), current, ...rest.slice(to)]);
    }
    case "options.add":
      return addOptions(menu, index, current, operation.roleIds);
    case "options.edit":
      return editOptions(menu, index, current, operation.rows);
  }
}

/** options.add: append the roles not already in the category, in the order given. */
function addOptions(
  menu: SelfRoleMenu,
  index: number,
  category: SelfRoleCategory,
  roleIds: readonly string[],
): MenuEdit {
  const requested = [...new Set(roleIds)];
  if (requested.length === 0)
    return invalid([{ field: "roleIds", message: LIMIT_MESSAGES.roleIds }]);
  if (requested.some((id) => !idSchema.safeParse(id).success))
    return invalid([{ field: "roleIds", message: LIMIT_MESSAGES.unknownRole }]);
  const errors: MenuFieldError[] = [];
  const fresh: string[] = [];
  for (const roleId of requested) {
    const found = findOption(menu, roleId);
    if (!found) fresh.push(roleId);
    else if (found.category.id !== category.id)
      errors.push({ field: "roleIds", message: LIMIT_MESSAGES.otherCategory(roleId) });
  }
  if (category.options.length + fresh.length > MENU_LIMITS.optionsPerCategory)
    errors.push({ field: "roleIds", message: LIMIT_MESSAGES.optionsPerCategory });
  else if (menuRoleIds(menu).length + fresh.length > MENU_LIMITS.options)
    errors.push({ field: "roleIds", message: LIMIT_MESSAGES.options });
  if (errors.length > 0) return invalid(errors);
  const options = [
    ...category.options,
    ...fresh.map((roleId) => ({ roleId, description: "", removalOnly: false })),
  ];
  return withCategories(
    menu.categories.map((candidate, at) => (at === index ? { ...category, options } : candidate)),
  );
}

/**
 * options.edit: every row's description, place and state in one form. A row names an option by
 * its role; an option the form didn't name (added since it was rendered) keeps its place and
 * values, so the equal-state rule still recognises a repeat, and the revision check refuses a stale
 * change.
 *
 * Order: by typed position. A row the officer typed a new position for always ties with the row
 * left showing that position, so a tie goes to the moved row: ahead when it moved up (typed less
 * than the place the form showed it at, its index + 1), behind when it moved down. Typing 1 for the
 * third of three puts it first, and 3 for the first puts it last. Remaining ties keep the form's
 * order. The tie-break reads the form, never the current menu, so the result depends on the rows
 * alone, and the same form applied twice gives the same menu (the equal-state rule). An option the
 * form didn't name sorts as left in place at its current place; that mixes the two orders only on
 * a stale form, which the revision check refuses anyway.
 */
function editOptions(
  menu: SelfRoleMenu,
  index: number,
  category: SelfRoleCategory,
  rows: readonly OptionRow[],
): MenuEdit {
  const byRole = new Map(rows.map((row, shown) => [row.roleId, { row, shown }]));
  if (byRole.size !== rows.length)
    return invalid([{ field: "rows", message: LIMIT_MESSAGES.rows }]);
  // A row for a role the category no longer holds: already done when the row removes it (a
  // repeated submit), otherwise another officer removed what this form edits.
  const held = new Set(category.options.map((option) => option.roleId));
  if (rows.some((row) => row.state !== "remove" && !held.has(row.roleId))) return { kind: "gone" };
  const errors: MenuFieldError[] = [];
  /** key: the position; moved: 0 up, 1 left in place, 2 down; at: the last tie-break. */
  const placed: { option: SelfRoleOption; key: number; moved: number; at: number }[] = [];
  category.options.forEach((option, at) => {
    const named = byRole.get(option.roleId);
    if (!named) {
      placed.push({ option, key: at + 1, moved: 1, at });
      return;
    }
    const { row, shown } = named;
    const description = cleanText(row.description);
    const problem = textProblem(description, MENU_LIMITS.optionDescription, false);
    if (problem) errors.push({ field: `description:${row.roleId}`, message: problem });
    if (!Number.isSafeInteger(row.position) || row.position < 1)
      errors.push({ field: `position:${row.roleId}`, message: LIMIT_MESSAGES.position });
    if (row.state === "remove") return;
    placed.push({
      option: { roleId: option.roleId, description, removalOnly: row.state === "removal_only" },
      key: row.position,
      moved: Math.sign(row.position - (shown + 1)) + 1,
      at: shown,
    });
  });
  if (errors.length > 0) return invalid(errors);
  placed.sort(
    (left, right) => left.key - right.key || left.moved - right.moved || left.at - right.at,
  );
  const options = placed.map((entry) => entry.option);
  return withCategories(
    menu.categories.map((candidate, at) => (at === index ? { ...category, options } : candidate)),
  );
}

// ---------------------------------------------------------------------------------------------
// Permission names

/** discord.js's permission flag names. */
type FlagName = keyof typeof P;
/**
 * Discord's names for the permissions the shared catalog (permissions.ts) doesn't label. Typed over
 * every discord.js flag, so a discord.js upgrade that adds one fails typecheck until it is named
 * here; a bit discord.js doesn't know yet reads as "a permission TaruBot can't name".
 */
const OTHER_NAMES: Readonly<Record<Exclude<FlagName, PermissionKey>, string>> = {
  AddReactions: "Add Reactions",
  ViewAuditLog: "View Audit Log",
  PrioritySpeaker: "Priority Speaker",
  Stream: "Video",
  SendTTSMessages: "Send Text-to-Speech Messages",
  UseExternalEmojis: "Use External Emoji",
  ViewGuildInsights: "View Server Insights",
  Speak: "Speak",
  MuteMembers: "Mute Members",
  DeafenMembers: "Deafen Members",
  MoveMembers: "Move Members",
  UseVAD: "Use Voice Activity",
  ChangeNickname: "Change Nickname",
  ManageEmojisAndStickers: "Manage Expressions",
  ManageGuildExpressions: "Manage Expressions",
  RequestToSpeak: "Request to Speak",
  ManageEvents: "Manage Events",
  ManageThreads: "Manage Threads",
  UseExternalStickers: "Use External Stickers",
  SendMessagesInThreads: "Send Messages in Threads",
  UseEmbeddedActivities: "Use Activities",
  ViewCreatorMonetizationAnalytics: "View Server Subscription Insights",
  UseSoundboard: "Use Soundboard",
  CreateGuildExpressions: "Create Expressions",
  CreateEvents: "Create Events",
  UseExternalSounds: "Use External Sounds",
  SendVoiceMessages: "Send Voice Messages",
  SetVoiceChannelStatus: "Set Voice Channel Status",
  SendPolls: "Create Polls",
  UseExternalApps: "Use External Apps",
  PinMessages: "Pin Messages",
  BypassSlowmode: "Bypass Slowmode",
};

/** The phrase for bits nobody can name yet. */
export const UNNAMED_PERMISSION = "a permission TaruBot can't name";

/** One flag's name where it is set (Manage Roles reads Manage Permissions in a channel). */
function flagName(flag: FlagName, context: "server" | "channel"): string {
  return Object.hasOwn(LABELLED_PERMISSIONS, flag)
    ? permissionLabel(flag as PermissionKey, context)
    : OTHER_NAMES[flag as Exclude<FlagName, PermissionKey>];
}

/** The names of `bits`, lowest bit first, with one phrase for any bit no flag names. */
export function permissionNames(bits: bigint, context: "server" | "channel"): string[] {
  const names: string[] = [];
  let rest = bits;
  for (const flag of Object.keys(P) as FlagName[]) {
    const bit = P[flag];
    if ((rest & bit) === 0n) continue;
    rest &= ~bit;
    names.push(flagName(flag, context));
  }
  return rest === 0n ? names : [...names, UNNAMED_PERMISSION];
}

/** "a", "a and b", "a, b and c"; `last` "or" gives "a, b or c". */
function andList(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// What may be self-assigned

/** The guild row's settings the rules read: a structural Pick that GuildRecord satisfies. */
export interface SelfRoleGuildConfig {
  readonly member_role_id: string | null;
  readonly guest_role_id: string | null;
  readonly officer_role_id: string | null;
  readonly leader_role_id: string | null;
  readonly officer_channel_id: string | null;
  readonly officer_notifications_channel_id: string | null;
  readonly guest_application_channel_id: string | null;
}

/** What the rules need beyond the Discord snapshot. */
export interface SelfRoleSettings {
  /** The four access roles TaruBot binds; null when unset. */
  readonly boundRoles: {
    readonly member: string | null;
    readonly guest: string | null;
    readonly officer: string | null;
    readonly leader: string | null;
  };
  /** retired_roles: former access roles, which reconciliation still removes. */
  readonly retiredRoles: readonly string[];
  /**
   * Channels TaruBot knows are for officers: the officer room, officer notifications, guest
   * reviews, and every channel onboarding classified staff-only (channel_access_policies).
   */
  readonly staffChannels: readonly string[];
}

/** The settings from the guild row, its retired roles and its staff-only channel policies. */
export function selfRoleSettings(
  guild: SelfRoleGuildConfig,
  retiredRoles: readonly string[],
  staffOnly: readonly string[],
): SelfRoleSettings {
  return {
    boundRoles: {
      member: guild.member_role_id,
      guest: guild.guest_role_id,
      officer: guild.officer_role_id,
      leader: guild.leader_role_id,
    },
    retiredRoles: [...new Set(retiredRoles)],
    staffChannels: [
      ...new Set(
        [
          guild.officer_channel_id,
          guild.officer_notifications_channel_id,
          guild.guest_application_channel_id,
          ...staffOnly,
        ].filter((id): id is string => id !== null),
      ),
    ],
  };
}

/** A stable reason a role can't be self-assigned. */
export type SelfRoleProblemCode =
  | "missing"
  | "everyone"
  | "managed"
  | "bot_role"
  | "access_role"
  | "retired_role"
  | "staff_permissions"
  | "permissions"
  | "above_bot"
  | "bot_cannot_manage"
  | "above_staff"
  | "visible_channel"
  | "channel_permissions"
  | "channel_deny"
  | "restricts"
  | "staff_channel";

export interface SelfRoleProblem {
  readonly code: SelfRoleProblemCode;
  /** Plain words; roles and channels as Discord mentions (see the module comment). */
  readonly message: string;
  /** The channels a channel problem concerns, in display order: all of them, past the message's. */
  readonly channels?: readonly string[];
}

/** One role's verdict: why it can't be self-assigned (none: it can), and the channels it opens. */
export interface RoleCheck {
  readonly roleId: string;
  /** Most fundamental first; empty when the role may be self-assigned. */
  readonly problems: readonly SelfRoleProblem[];
  /**
   * Readable channels the role makes visible to someone with no other way in (the editor's
   * "Opens:"), in display order. A role that passes every rule changes nothing in any other
   * readable channel: its allows there carry only @everyone's server-wide bits, which its holders
   * already hold, and lift no deny, View Channel's included (`channel_deny`); and it takes nothing
   * away there (`restricts`).
   */
  readonly opens: readonly string[];
}

/** Server-wide powers that make a role a staff role in the officer-facing heuristic. */
const STAFF_POWERS =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageMessages |
  P.KickMembers |
  P.BanMembers |
  P.ModerateMembers;
/** What a self-service role can never hold, whatever @everyone holds. */
const NEVER_SELF_SERVICE = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels;
/**
 * The powers Discord's role hierarchy limits: whoever holds one can use it only on people whose
 * highest role is lower than theirs. A role below TaruBot holding one is a moderation role, which
 * a self-service role must sit below (`above_staff`).
 */
const MODERATION =
  P.KickMembers | P.BanMembers | P.ModerateMembers | P.ManageNicknames | P.Administrator;
/** What each moderation power does to someone, for the above_staff message, in its order. */
const MODERATION_VERBS: readonly (readonly [bigint, string])[] = [
  [P.KickMembers, "kick"],
  [P.BanMembers, "ban"],
  [P.ModerateMembers, "time out"],
  [P.ManageNicknames, "rename"],
];
/**
 * What a role's holders could do to someone below them: one verb per moderation power it holds.
 * Administrator holds them all, and the hierarchy limits its holders as it does anyone's.
 */
function moderationVerbs(permissions: bigint): string[] {
  const held = (permissions & P.Administrator) !== 0n ? MODERATION : permissions;
  return MODERATION_VERBS.filter(([bit]) => (held & bit) !== 0n).map(([, verb]) => verb);
}
/** A member ID no overwrite names, so channelPermissions' member step never applies. */
const NOBODY = "0";
/** How many channels a message names before counting the rest. */
const NAMED_CHANNELS = 5;

/** Channel bits as their holder sees them: a channel without View Channel grants nothing. */
const seen = (bits: bigint): bigint => ((bits & P.ViewChannel) === 0n ? 0n : bits);

const isCategory = (channel: VisibilityChannel): boolean =>
  channel.type === ChannelType.GuildCategory;
/** (position, id), IDs compared as numbers. */
function byPosition(left: VisibilityChannel, right: VisibilityChannel): number {
  if (left.position !== right.position) return left.position - right.position;
  const [a, b] = [BigInt(left.id), BigInt(right.id)];
  return a === b ? 0 : a < b ? -1 : 1;
}
/**
 * Discord's display order, as src/domain/visibility.ts shows channels: top-level channels (and any
 * whose category isn't cached), then each category followed by its children.
 */
function displayOrder(channels: readonly VisibilityChannel[]): VisibilityChannel[] {
  const categories = channels.filter(isCategory).sort(byPosition);
  const known = new Set(categories.map((category) => category.id));
  const ordered = channels
    .filter((channel) => !isCategory(channel) && !(channel.parentId && known.has(channel.parentId)))
    .sort(byPosition);
  for (const category of categories)
    ordered.push(
      category,
      ...channels
        .filter((channel) => !isCategory(channel) && channel.parentId === category.id)
        .sort(byPosition),
    );
  return ordered;
}

/** How many channels TaruBot can't read (src/domain/visibility.ts's unreadable). */
export function unreadableChannels(guild: VisibilityGuild): number {
  return guild.channels.filter((channel) => unreadable(guild, channel)).length;
}

/** Whether TaruBot holds Administrator in the snapshot (through any role, or @everyone). */
export function holdsAdministrator(guild: VisibilityGuild): boolean {
  const held = new Set([guild.guildId, ...guild.bot.roles]);
  return guild.roles.some(
    (role) => held.has(role.id) && (BigInt(role.permissions) & P.Administrator) !== 0n,
  );
}

/** "<#a> (Send Messages), <#b> (…) and 2 more channels". */
function channelList(entries: readonly { id: string; bits?: bigint }[]): string {
  const shown = entries
    .slice(0, NAMED_CHANNELS)
    .map((entry) =>
      entry.bits === undefined
        ? `<#${entry.id}>`
        : `<#${entry.id}> (${andList(permissionNames(entry.bits, "channel"))})`,
    );
  const more = entries.length - shown.length;
  return andList(
    more > 0 ? [...shown, `${more} more ${more === 1 ? "channel" : "channels"}`] : shown,
  );
}

/** A channel problem naming its channels. */
const channelProblem = (
  code: SelfRoleProblemCode,
  message: string,
  entries: readonly { id: string }[],
): SelfRoleProblem => ({ code, message, channels: entries.map((entry) => entry.id) });

/** The access role labels, for the access_role message. */
const ACCESS_LABELS = {
  member: "Member",
  guest: "Guest",
  officer: "Officer",
  leader: "FC Leader",
} as const;

/**
 * The rule set over one snapshot (see the module comment), prepared once and applied per role: the
 * editor checks every role in the server, and the per-channel baselines don't depend on the role.
 *
 * Channels: for every channel TaruBot can read and each audience, @everyone alone, @everyone with
 * the Member role, and @everyone with the Guest role (each bound role that exists), `before` is
 * what that audience sees there and `now` what it sees with this role too (seen: nothing without
 * View Channel). A gain where the audience already sees the channel is `visible_channel`; seeing a
 * channel it didn't is opening it, where `now` may carry only what the audience holds server-wide
 * anyway (`channel_permissions`; @everyone's bits for @everyone alone) and the channel must not be
 * officer-facing (`staff_channel`). Separately, the role's own allow in any channel may carry only
 * @everyone's server-wide bits, since its holders may see that channel through a role this check
 * doesn't know about. View Channel is the exception in both ceilings: seeing a channel is judged by
 * `opens` and `staff_channel` alone, so a role may open a channel in a server where @everyone lacks
 * View Channel server-wide (a server private by default, with a lobby); the server-level
 * `permissions` rule still refuses a role that holds View Channel server-wide there.
 *
 * Denies (`channel_deny`): Discord applies @everyone's overwrite, then every role's denies, then
 * every role's allows, so a role's allow beats any deny but a member's own overwrite. Its allow in
 * a channel may not lift a deny another role's overwrite sets there (a mute role's Send Messages, a
 * jail or quarantine role's View Channel, or Member's Send Messages in a read-only channel), and,
 * in a channel it doesn't open, not @everyone's either: there the allow can only matter to people
 * who see the channel through some other role, such as a read-only #raid-news that an
 * officer-assigned Raiders role opens. View Channel counts like any other bit here: in a channel
 * everyone, members or guests already see, a View Channel allow gives them nothing except a way
 * past another role's deny. In a channel it opens, two lifts are what opening means and stay
 * allowed: @everyone's deny, which is how an opt-in channel lets its people in and post (owner
 * decision Q2 B), and the View Channel bit of the Member and Guest roles' deny, which is how one
 * works in a server private by default. Any other role's View Channel deny there, such as a jail
 * role's, still refuses the role: whoever that role shuts out would see the channel again. One
 * problem per channel: a visible gain first, then bits beyond @everyone's, then a lifted deny.
 *
 * Restrictions (`restricts`): a role's own deny in a channel it doesn't open, or anything an
 * audience that already sees a channel would lose there (a deny in a channel the role opens for
 * guests while members already see it). A self-service role's holders can remove it, so a role
 * that takes something away (a mute, jail or quarantine role) would be lifted by the very people
 * it restricts. A deny in a channel the role opens only shapes what it opens, so it stays allowed.
 *
 * Position (`above_staff`): a role must sit below the bound Officer and FC Leader roles and below
 * every role under TaruBot holding a MODERATION power, managed bot roles included. The message
 * names the lowest of those roles, since sitting below it means sitting below them all. Tied raw
 * positions follow Discord's order (the lower ID ranks higher), as `above_bot` does.
 *
 * The channel rules judge the role's channel overwrites alone: `now` starts from what the audience
 * holds server-wide, without the role's own server bits. Those are judged once, server-wide
 * (`permissions`, `staff_permissions`), and anything beyond @everyone's is refused there, so a
 * role carrying Manage Channels isn't also reported in every channel, and one carrying View
 * Channel where @everyone lacks it doesn't "open" every channel.
 */
export function selfRoleChecker(
  guild: VisibilityGuild,
  settings: SelfRoleSettings,
): (roleId: string) => RoleCheck {
  const g = guild.guildId;
  const byId = new Map(guild.roles.map((role) => [role.id, role]));
  // @everyone's server-wide bits: the ceiling for everything a self-service role carries.
  const everyone = BigInt(byId.get(g)?.permissions ?? "0") & ~P.Administrator;
  const rank = new Map(ascendingRoles(guild.roles).map((role, at) => [role.id, at]));
  // TaruBot's real roles, as Discord's hierarchy and validateRole judge them today.
  const botTop = Math.max(rank.get(g) ?? -1, ...guild.bot.roles.map((id) => rank.get(id) ?? -1));
  const botManages = (guildPermissions(g, guild.roles, guild.bot.roles) & P.ManageRoles) !== 0n;
  const bound = settings.boundRoles;
  const accessRoles = new Map(
    (Object.keys(ACCESS_LABELS) as (keyof typeof ACCESS_LABELS)[]).flatMap((key) => {
      const id = bound[key];
      return id === null ? [] : [[id, ACCESS_LABELS[key]] as const];
    }),
  );
  const audiences: readonly (readonly string[])[] = [
    [],
    ...[bound.member, bound.guest]
      .filter((id): id is string => id !== null && byId.has(id))
      .map((id) => [id]),
  ];
  /** What each audience holds server-wide: the ceiling in a channel the role opens for it. */
  const holds = audiences.map((roles) =>
    guildPermissions(g, guild.roles, roles, { ignoreAdministrator: true }),
  );
  const staffRole = (id: string): boolean => {
    if (id === bound.officer || id === bound.leader) return true;
    const role = byId.get(id);
    return role !== undefined && (BigInt(role.permissions) & STAFF_POWERS) !== 0n;
  };
  const rankOf = (id: string): number => rank.get(id) ?? -1;
  // The roles a self-service role must sit below, lowest first: the bound Officer and FC Leader
  // roles wherever they are, and every role below TaruBot (not @everyone) with a moderation power.
  // TaruBot's own managed role is left out: TaruBot is its only holder, and TaruBot's reach comes
  // from its highest role (`above_bot`). Any other role TaruBot holds still counts, since people
  // and other bots can hold it too.
  const moderators = guild.roles
    .filter(
      (candidate) =>
        candidate.id !== g &&
        candidate.id !== guild.bot.botRoleId &&
        (candidate.id === bound.officer ||
          candidate.id === bound.leader ||
          (rankOf(candidate.id) < botTop && (BigInt(candidate.permissions) & MODERATION) !== 0n)),
    )
    .sort((left, right) => rankOf(left.id) - rankOf(right.id));
  /**
   * The above_staff message for a role above `role`: what that role is, and what its holders could
   * no longer do, from the powers it actually holds. A bound Officer or FC Leader role without any
   * makes no claim about powers, only about rank.
   */
  const aboveStaff = (role: ApiRole): string => {
    const bits = BigInt(role.permissions);
    const verbs = moderationVerbs(bits);
    const label =
      role.id === bound.officer
        ? "TaruBot's Officer role"
        : role.id === bound.leader
          ? "TaruBot's FC Leader role"
          : `which has ${andList(permissionNames(bits & MODERATION, "server"))}`;
    const reach =
      verbs.length > 0
        ? `people with that role couldn't ${andList(verbs, "or")} anyone who picks it`
        : `it would rank above your ${role.id === bound.officer ? "officers" : "FC Leader"}`;
    return `It's above <@&${role.id}>, ${label}, so ${reach}. Move it below <@&${role.id}>.`;
  };
  /** What someone holding `roles`, with `base` server-wide, sees in a channel. */
  const sees = (channel: VisibilityChannel, base: bigint, roles: readonly string[]): bigint =>
    seen(
      channelPermissions(
        g,
        base,
        channel.overwrites,
        { id: NOBODY, roles },
        {
          ignoreAdministrator: true,
        },
      ),
    );
  const views = displayOrder(guild.channels)
    .filter((channel) => !unreadable(guild, channel))
    .map((channel) => {
      const before = audiences.map((roles, at) => sees(channel, holds[at] ?? everyone, roles));
      // Officer-facing (a heuristic, and documented as one): a channel a setting names for
      // officers, or one none of the audiences can see whose explicit View Channel allows include
      // the Officer or FC Leader role or a role with a staff power. Two shapes aren't detected: a
      // private channel that only Administrators see, with no allow at all, and one opened to
      // officers through per-member entries rather than a role (an officer room built from each
      // officer's own entry, or a ticket-style channel). Hence the "Opens:" list.
      const officerFacing =
        settings.staffChannels.includes(channel.id) ||
        (before.every((bits) => bits === 0n) &&
          channel.overwrites.some(
            (entry) =>
              entry.type === 0 &&
              (BigInt(entry.allow) & P.ViewChannel) !== 0n &&
              staffRole(entry.id),
          ));
      return { channel, before, officerFacing };
    });

  return (roleId) => {
    const role: ApiRole | undefined = byId.get(roleId);
    const fail = (code: SelfRoleProblemCode, message: string): RoleCheck => ({
      roleId,
      problems: [{ code, message }],
      opens: [],
    });
    if (!role) return fail("missing", "This role no longer exists in this server.");
    if (roleId === g) return fail("everyone", "@everyone can't be on the role menu.");
    if (roleId === guild.bot.botRoleId) return fail("bot_role", "This is TaruBot's own role.");
    if (role.managed)
      return fail(
        "managed",
        "An integration, a bot or Server Boosting manages this role, so nobody can assign it.",
      );
    const problems: SelfRoleProblem[] = [];
    const access = accessRoles.get(roleId);
    if (access)
      problems.push({
        code: "access_role",
        message: `It's TaruBot's ${access} role. Access roles can't be on the role menu.`,
      });
    if (settings.retiredRoles.includes(roleId))
      problems.push({
        code: "retired_role",
        message:
          "It used to be one of TaruBot's access roles, and TaruBot still removes it from people, so it can't be on the role menu.",
      });
    const own = BigInt(role.permissions);
    const staff = own & NEVER_SELF_SERVICE;
    if (staff !== 0n)
      problems.push({
        code: "staff_permissions",
        message: `It has ${andList(permissionNames(staff, "server"))}. A self-service role can never have Administrator, Manage Server, Manage Roles or Manage Channels.`,
      });
    // Bits Discord adds later aren't in @everyone's set either, so they fail closed here too.
    const extra = own & ~everyone & ~NEVER_SELF_SERVICE;
    if (extra !== 0n) {
      const names = permissionNames(extra, "server");
      problems.push({
        code: "permissions",
        message: `It has ${andList(names)}, which @everyone doesn't have in this server. A self-service role can't give server permissions.${names.includes(UNNAMED_PERMISSION) ? " Compare this role's permissions with @everyone's." : ""}`,
      });
    }
    if (!botManages)
      problems.push({
        code: "bot_cannot_manage",
        message: "TaruBot doesn't have Manage Roles here, so it can't assign any role.",
      });
    else if ((rank.get(roleId) ?? 0) >= botTop)
      problems.push({
        code: "above_bot",
        message:
          "It's at or above TaruBot's highest role, so TaruBot can't assign it. Move it below TaruBot's role.",
      });
    // Its own rank aside: an access or moderation role isn't above itself.
    const lowest = moderators.find((candidate) => candidate.id !== roleId);
    if (lowest && rankOf(roleId) > rankOf(lowest.id))
      problems.push({ code: "above_staff", message: aboveStaff(lowest) });

    const visible: { id: string; bits: bigint }[] = [];
    const ceiling: { id: string; bits: bigint }[] = [];
    const lifted: { id: string; bits: bigint }[] = [];
    const restricted: { id: string; bits: bigint }[] = [];
    const officer: { id: string }[] = [];
    const opens: string[] = [];
    for (const { channel, before, officerFacing } of views) {
      const entry = channel.overwrites.find((item) => item.type === 0 && item.id === roleId);
      // Exact, not a shortcut: without an entry of its own the role changes nothing here. Its
      // server bits are left out of `now` (see above) and no overwrite names it, so `now` equals
      // `before` for every audience, and nothing is gained, carried, opened, lifted or taken
      // away. Skipping keeps the editor's check of every role over every channel cheap.
      if (!entry) continue;
      const allow = BigInt(entry.allow);
      // View Channel aside in the ceiling (see above): what a channel lets someone see is opening.
      let over = allow & ~P.ViewChannel & ~everyone;
      let gained = 0n;
      let lost = 0n;
      let opened = false;
      audiences.forEach((roles, at) => {
        const base = holds[at] ?? everyone;
        const was = before[at] ?? 0n;
        const now = sees(channel, base, [...roles, roleId]);
        if (was !== 0n) {
          gained |= now & ~was;
          lost |= was & ~now;
        } else if (now !== 0n) {
          opened = true;
          over |= now & ~(base | P.ViewChannel);
        }
      });
      // The denies its allow would lift (see above): every other role's, View Channel included,
      // and @everyone's where it opens nothing. Where it opens the channel, @everyone's deny and
      // the View Channel bit of the Member and Guest roles' deny are what opening it lifts.
      let denied = 0n;
      for (const other of channel.overwrites) {
        if (other.type !== 0 || other.id === roleId) continue;
        const deny = BigInt(other.deny);
        if (!opened) denied |= deny;
        else if (other.id === bound.member || other.id === bound.guest)
          denied |= deny & ~P.ViewChannel;
        else if (other.id !== g) denied |= deny;
      }
      const lifts = allow & denied;
      // What its holders lose: its own deny where it opens nothing, and in any channel what an
      // audience that already sees it no longer has.
      const takes = (opened ? 0n : BigInt(entry.deny)) | lost;
      if (gained !== 0n) visible.push({ id: channel.id, bits: gained });
      else if (over !== 0n) ceiling.push({ id: channel.id, bits: over });
      else if (lifts !== 0n) lifted.push({ id: channel.id, bits: lifts });
      // Without View Channel nothing else in a channel counts, so the message names that alone.
      if (takes !== 0n)
        restricted.push({
          id: channel.id,
          bits: (takes & P.ViewChannel) !== 0n ? P.ViewChannel : takes,
        });
      if (opened) {
        opens.push(channel.id);
        if (officerFacing) officer.push({ id: channel.id });
      }
    }
    if (visible.length > 0)
      problems.push(
        channelProblem(
          "visible_channel",
          `It gives extra permissions in ${channelList(visible)}. A self-service role can't change channels that everyone, members or guests can already see.`,
          visible,
        ),
      );
    if (ceiling.length > 0)
      problems.push(
        channelProblem(
          "channel_permissions",
          `It gives permissions @everyone doesn't have in this server: ${channelList(ceiling)}. A self-service role can only carry @everyone's own permissions in a channel.`,
          ceiling,
        ),
      );
    if (lifted.length > 0)
      problems.push(
        channelProblem(
          "channel_deny",
          `It overrides what @everyone or another role is denied in ${channelList(lifted)}. A self-service role can't lift a channel's restrictions, such as a read-only channel, a mute role or a jail role, apart from @everyone's in a channel it opens.`,
          lifted,
        ),
      );
    if (restricted.length > 0)
      problems.push(
        channelProblem(
          "restricts",
          `It takes permissions away in ${channelList(restricted)}. A self-service role can't take anything away from the people who have it, so a mute, jail or quarantine role can't be on the role menu: the people it restricts could remove it.`,
          restricted,
        ),
      );
    if (officer.length > 0)
      problems.push(
        channelProblem(
          "staff_channel",
          `It opens ${channelList(officer)}, which ${officer.length === 1 ? "looks like an officer channel" : "look like officer channels"}. A self-service role can't open officer channels.`,
          officer,
        ),
      );
    return { roleId, problems, opens };
  };
}

/** Why one role can't be self-assigned (none: it can), over one snapshot. */
export function selfRoleProblems(
  guild: VisibilityGuild,
  roleId: string,
  settings: SelfRoleSettings,
): readonly SelfRoleProblem[] {
  return selfRoleChecker(guild, settings)(roleId).problems;
}

/**
 * Every role but @everyone, highest first as Discord lists them, each with its verdict, followed by
 * any of `also` the server doesn't have (a menu role deleted in Discord, which reads `missing`):
 * what the editor shows for the menu's options and the add form.
 */
export function checkRoles(
  guild: VisibilityGuild,
  settings: SelfRoleSettings,
  also: readonly string[] = [],
): RoleCheck[] {
  const check = selfRoleChecker(guild, settings);
  const ids = ascendingRoles(guild.roles)
    .reverse()
    .filter((role) => role.id !== guild.guildId)
    .map((role) => role.id);
  const known = new Set(ids);
  return [...ids, ...also.filter((id) => !known.has(id))].map(check);
}

/**
 * The problems that stop a role being taken away; the others only stop it being given. Taking a
 * role away can't escalate anything, so `above_staff` stays out: whoever holds a menu role later
 * moved above a moderation role can still remove it. `restricts` is in: taking away a role that
 * restricts its holders (a mute or jail role) would lift that restriction, so the people it
 * restricts never get to remove it, even under Not offered or Stop offering.
 */
const BLOCKS_REMOVAL: ReadonlySet<SelfRoleProblemCode> = new Set<SelfRoleProblemCode>([
  "missing",
  "everyone",
  "bot_role",
  "managed",
  "access_role",
  "retired_role",
  "above_bot",
  "bot_cannot_manage",
  "restricts",
]);

/** Whether a role with this verdict can still be taken away (see removable). */
export const removableBy = (check: RoleCheck): boolean =>
  !check.problems.some((problem) => BLOCKS_REMOVAL.has(problem.code));

/**
 * The weaker rule for taking a role away, which can't escalate anything: it exists, is an ordinary
 * role below TaruBot's highest, TaruBot has Manage Roles, it isn't bound or retired, and it takes
 * nothing away from its holders (BLOCKS_REMOVAL). So a held role that later failed selfRoleChecker
 * for what it gives can still be removed by whoever holds it.
 */
export function removable(
  guild: VisibilityGuild,
  roleId: string,
  settings: SelfRoleSettings,
): boolean {
  return removableBy(selfRoleChecker(guild, settings)(roleId));
}

/**
 * Listed menu roles that open at least one channel. From 2.40.0 reconciliation removes these,
 * never cosmetic ones, from people who hold no access role (owner decision, 2026-10-09), so an
 * opt-in channel stays behind Member or Guest as well as the role.
 */
export function channelOpeningRoles(
  menu: SelfRoleMenu,
  guild: VisibilityGuild,
  settings: SelfRoleSettings,
): string[] {
  const check = selfRoleChecker(guild, settings);
  return menuRoleIds(menu).filter(
    (roleId) => listed(menu, roleId) && check(roleId).opens.length > 0,
  );
}

/** The "Role menu" health check (/config validate, its Re-check and the Configuration page). */
export interface SelfRoleHealth {
  /** Roles in published or Not offered categories: what members and guests see. */
  readonly listed: number;
  /**
   * Of those, how many fail their check: an offered role selfRoleChecker refuses, or one no longer
   * offered that holders can't remove. Null when TaruBot's view couldn't be read.
   */
  readonly problems: number | null;
  /** Channels TaruBot can't read, so it can't check menu roles there; 0 when unknown. */
  readonly unreadableChannels: number;
  /** The saved menu was written by a different TaruBot version, or is damaged. */
  readonly unreadableMenu: boolean;
}

/** The health check over the saved menu (null: unreadable) and TaruBot's view (null: unknown). */
export function selfRoleHealth(
  menu: SelfRoleMenu | null,
  guild: VisibilityGuild | null,
  settings: SelfRoleSettings,
): SelfRoleHealth {
  if (!menu) return { listed: 0, problems: null, unreadableChannels: 0, unreadableMenu: true };
  const shown = menuRoleIds(menu).filter((roleId) => listed(menu, roleId));
  if (!guild)
    return { listed: shown.length, problems: null, unreadableChannels: 0, unreadableMenu: false };
  const check = selfRoleChecker(guild, settings);
  const failing = shown.filter((roleId) => {
    const verdict = check(roleId);
    return addable(menu, roleId) ? verdict.problems.length > 0 : !removableBy(verdict);
  });
  return {
    listed: shown.length,
    problems: failing.length,
    unreadableChannels: unreadableChannels(guild),
    unreadableMenu: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Approved wording the application layer and the Role menu page share

export const SELF_ROLE_MESSAGES = {
  /**
   * A stale form that would change something, or one naming a category or role another officer
   * removed (409). It says what to do next (WCAG 3.3.3): the re-rendered form keeps what was
   * changed, at the current revision, so sending it again applies it.
   */
  changed:
    "Another officer changed the role menu while you were editing, so your change wasn't saved. Check the menu as it is now, then try again if it's still needed.",
  /** Any edit but a reset of a stored menu this build can't read (409). */
  unreadable:
    "The saved role menu was written by a different TaruBot version, or is damaged, so it can't be changed here.",
  /**
   * An add without the officer's confirmation while TaruBot can't read some channels (422). The
   * action alone, since the field's hint says why; self-contained, since the error summary at the
   * top of the page repeats it. It covers any permission, not only opening: a role's own entry in
   * such a channel is invisible to every channel rule (see the module comment).
   */
  acknowledge: (channels: number) =>
    channels === 1
      ? "Confirm you've checked that these roles don't open the channel TaruBot can't see or give any permission in it."
      : `Confirm you've checked that these roles don't open the ${channels} channels TaruBot can't see or give any permission in them.`,
  /** A role an add refused, with its first problem (422). */
  refusedRole: (roleId: string, problem: SelfRoleProblem) =>
    `<@&${roleId}> can't be added. ${problem.message}`,
} as const;
