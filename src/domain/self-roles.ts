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

/**
 * Whether TaruBot holds Manage Roles server-wide in the snapshot (through any of its roles or
 * @everyone, Administrator included), as Discord judges any role write. Without it every role
 * fails with `bot_cannot_manage`, so it can be neither given nor taken away.
 */
export function botManagesRoles(guild: VisibilityGuild): boolean {
  return (guildPermissions(guild.guildId, guild.roles, guild.bot.roles) & P.ManageRoles) !== 0n;
}

/**
 * The role-free diagnostic of a self-service role write TaruBot can't make anywhere in the server
 * because it lacks Manage Roles: a `blocked` Failure's message, from the roles.self job's own check
 * and from the gateway's 50013 re-read alike, so the work waits (and retries) as blocked.
 */
export const NO_MANAGE_ROLES =
  "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.";

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
  const botManages = botManagesRoles(guild);
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
// Members' choices (2.40.0): My roles and the roles.self job
//
// A member's save is a desired state over the roles of the categories they changed, never the
// whole menu, so a stale tab, Dyno or an officer's hand edit is never undone in a category the
// member didn't touch. "Changed" compares what came back with what the form showed ticked, not
// with what the member holds now: someone else's change since the page rendered is left alone
// unless the member changed that category too. The roles.self job then re-derives what it may do
// from the menu as it is when it runs, and checks every role again just before the write.

/** A waiting change is closed this long after the member's last save (owner decision Q4 A). */
export const ROLE_CHOICE_EXPIRY_DAYS = 7;

/** The dedupe key of a member's role choices in a server: saves coalesce into one active job. */
export const roleChoiceKey = (guildId: string, userId: string): string =>
  `self-roles:${guildId}:${userId}`;

/** A desired state over `offered`: the roles in `chosen` wanted, every other one not. */
export interface RoleChoice {
  readonly chosen: readonly string[];
  readonly offered: readonly string[];
}

/** Roles as a set; every comparison here ignores order and repeats. */
const setOf = (ids: readonly string[]): Set<string> => new Set(ids);
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((id) => right.has(id));
const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

/**
 * A roles.self job's payload (payload_version 1). `offered` is what the member could change in the
 * categories they changed, `chosen` the part of it they want, and `savedAt` the database clock at
 * their latest save, which the 7-day expiry reads (created_at stays at the first save, since
 * enqueue()'s conflict update never moves it). Role IDs only, never names (D19), and only while
 * the job waits: migration 012's trigger clears the payload whenever the job ends.
 */
export const roleChoicePayload = z
  .strictObject({
    chosen: z.array(idSchema).max(MENU_LIMITS.options),
    offered: z.array(idSchema).max(MENU_LIMITS.options),
    savedAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    (payload) =>
      unique(payload.chosen) &&
      unique(payload.offered) &&
      payload.chosen.every((roleId) => payload.offered.includes(roleId)),
  );
export type RoleChoicePayload = z.infer<typeof roleChoicePayload>;

/** A stored payload, or null when it isn't one (the trigger's cleared `{}` among them). */
export function readRoleChoice(value: unknown): RoleChoicePayload | null {
  const parsed = roleChoicePayload.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One role's verdict over the snapshot the caller read (selfRoleChecker's). */
export type RoleChecker = (roleId: string) => RoleCheck;

/**
 * Whether the person may tick or untick a role on My roles now, which the page and the save share:
 * it is offered and passes every rule now, or they hold it, it is listed, and it can still be taken
 * away (removableBy). Without TaruBot's view of the server (`check` null) nothing is changeable.
 */
export function changeable(
  menu: SelfRoleMenu,
  roleId: string,
  held: boolean,
  check: RoleChecker | null,
): boolean {
  if (!check) return false;
  const verdict = check(roleId);
  if (addable(menu, roleId) && verdict.problems.length === 0) return true;
  return held && listed(menu, roleId) && removableBy(verdict);
}

/** A role as My roles shows it to one person. */
export interface ChoiceOption {
  readonly roleId: string;
  readonly description: string;
  /** They hold it in Discord now. */
  readonly held: boolean;
  /** Ticked when the form renders: held, overlaid with their waiting change. */
  readonly ticked: boolean;
  /**
   * An input they may tick or untick (changeable). False: a held role shown as a line of text
   * ("You have @X; it can't be changed here right now."), or any row of a draft category.
   */
  readonly changeable: boolean;
  /** No longer offered (Not offered, or Stop offering): holders may remove it; nobody may add it. */
  readonly notOffered: boolean;
  /**
   * It may be added now: offered (addable) and passing every rule. A held, changeable row that
   * isn't (one that failed a rule since, say moved above a moderation role) can still be unticked,
   * but not picked again once it's gone, so the page warns before that one-way removal. False for
   * every row of a draft, and without TaruBot's view of the server.
   */
  readonly addable: boolean;
}

/** A category as My roles shows it to one person. */
export interface ChoiceCategory {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly max: number | null;
  /** A draft reaches officers only, as a disabled preview that is never submitted. */
  readonly state: CategoryState;
  /**
   * "one": radios starting with "No role from this category" (a published pick-one category);
   * "many": checkboxes (everything else, Stop offering categories included).
   */
  readonly input: "one" | "many";
  /** The rows to show, in menu order: changeable roles, and held ones as text. Never empty. */
  readonly options: readonly ChoiceOption[];
  /**
   * How many changeable roles are ticked. Over 1 in a pick-one category (Dyno leftovers), no
   * radio is preselected and the page says to pick one; over `max`, the page says the limit was
   * lowered. Either way the category counts as unchanged until the person changes it.
   */
  readonly ticked: number;
}

/** What My roles needs to know about one person, beyond the menu. */
export interface ChoiceContext {
  /** The roles they hold in Discord now. */
  readonly held: readonly string[];
  /** Their newest waiting change, if any: its `offered` roles show as it asks. */
  readonly waiting: RoleChoice | null;
  /** The rule set over TaruBot's view of the server; null when that view can't be read. */
  readonly check: RoleChecker | null;
  /** Officers also see drafts, disabled, with their own roles ticked (owner decision Q6). */
  readonly officer: boolean;
}

/**
 * The menu as one person sees it on My roles, in menu order:
 * - a published category, with each role they may change and each listed role they hold but
 *   can't change (as text); an option no longer offered shows only to its holders;
 * - a Stop offering category, only when they can remove one of its roles;
 * - a draft, for officers only, with every option, nothing changeable.
 * A category with nothing to show is left out. Tick marks follow the waiting change, so a second
 * save builds on the first instead of undoing it.
 */
export function choiceMenu(menu: SelfRoleMenu, context: ChoiceContext): ChoiceCategory[] {
  const holds = setOf(context.held);
  const waitingOn = setOf(context.waiting?.offered ?? []);
  const wanted = setOf(context.waiting?.chosen ?? []);
  const categories: ChoiceCategory[] = [];
  for (const category of menu.categories) {
    if (category.state === "draft" && !context.officer) continue;
    const options: ChoiceOption[] = [];
    for (const option of category.options) {
      const held = holds.has(option.roleId);
      const notOffered = category.state === "removal_only" || option.removalOnly;
      const can =
        category.state !== "draft" && changeable(menu, option.roleId, held, context.check);
      // A draft shows every option; otherwise a role shows when it can be changed, or when it is
      // held (as text). A role neither held nor addable now (it fails a rule) isn't shown.
      if (category.state !== "draft" && !can && !held) continue;
      const ticked = can && waitingOn.has(option.roleId) ? wanted.has(option.roleId) : held;
      options.push({
        roleId: option.roleId,
        description: option.description,
        held,
        ticked,
        changeable: can,
        notOffered,
        addable:
          context.check !== null &&
          addable(menu, option.roleId) &&
          context.check(option.roleId).problems.length === 0,
      });
    }
    if (options.length === 0) continue;
    if (category.state === "removal_only" && !options.some((option) => option.changeable)) continue;
    categories.push({
      id: category.id,
      name: category.name,
      description: category.description,
      max: category.max,
      state: category.state,
      input: category.state === "published" && category.max === 1 ? "one" : "many",
      options,
      ticked: options.filter((option) => option.changeable && option.ticked).length,
    });
  }
  return categories;
}

/**
 * One category of a My roles submission. The form renders `seen` from what it showed ticked and
 * `picked` from what came back, both as values: a role ID, or "" for the "No role from this
 * category" radio. A pick-one category in the multiple-roles odd state shows nothing ticked, so
 * its `seen` is empty, and so is `picked` when the person leaves it alone (a browser sends nothing
 * for a radio group with nothing selected).
 */
export interface CategoryChoice {
  readonly categoryId: string;
  readonly seen: readonly string[];
  readonly picked: readonly string[];
}

/**
 * A refused category: `roleId` when one role is the problem, `max` when more were picked than the
 * category allows (CHOICE_MESSAGES.max), so the page's error summary can name the category with
 * the limit. Messages never quote typed text.
 */
export interface ChoiceError {
  readonly categoryId: string;
  readonly roleId?: string;
  readonly max?: number;
  readonly message: string;
}

/**
 * What a submission asks:
 * - choice: the desired state over the roles of the categories the person changed (both empty
 *   when they changed nothing);
 * - conflict (409): the form names a role, or a "None", the menu no longer lets this person pick
 *   there (officers changed the menu, or the form was tampered with): re-render with the current
 *   state;
 * - invalid (422): too many picked in a changed category, or a role being added that fails a rule
 *   now.
 */
export type ChoiceChange =
  | { readonly kind: "choice"; readonly choice: RoleChoice }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly errors: readonly ChoiceError[] };

/**
 * Which categories a submission changes, and to what (see ChoiceChange). Per category:
 * - every picked role must be one of the category's options that the menu offers, or that the
 *   person holds and the menu lists; "" only in a pick-one category. Anything else is a conflict;
 * - a held role that can't be changed now is ignored: keeping it ticked changes nothing;
 * - the category is unchanged when what came back equals what the form showed ticked, both taken
 *   over the roles the person may change now (and "" in a pick-one category);
 * - otherwise it changed: a role being added must pass every rule now, and a published category
 *   allows at most `max` (a Stop offering category only ever loses roles, so it has no limit
 *   here). The limit counts what they picked plus the listed roles they hold there that can't be
 *   changed now (above TaruBot, say): those stay whatever the save says, so without them a
 *   pick-one category could end with two. `offered` gains every role the person may change in
 *   it, `chosen` what they picked.
 * An unchanged category is never refused for its limit, as for a lowered one: it is left as it
 * is. `held` is what the person holds in Discord now, and `check` the rule set over the snapshot
 * the save reads (a save without one is refused before this runs).
 */
export function changedCategories(
  menu: SelfRoleMenu,
  held: readonly string[],
  check: RoleChecker,
  submitted: readonly CategoryChoice[],
): ChoiceChange {
  const holds = setOf(held);
  const ids = submitted.map((entry) => entry.categoryId);
  if (!unique(ids)) return { kind: "conflict" };
  const offered: string[] = [];
  const chosen: string[] = [];
  const errors: ChoiceError[] = [];
  for (const entry of submitted) {
    const category = menu.categories.find((candidate) => candidate.id === entry.categoryId);
    const pickOne = category?.state === "published" && category.max === 1;
    const roles = (category?.options ?? []).map((option) => option.roleId);
    // What the person may pick here at all, and what they may change now (the page's inputs).
    const accepted = setOf(
      roles.filter((id) => addable(menu, id) || (holds.has(id) && listed(menu, id))),
    );
    const can = setOf(roles.filter((id) => changeable(menu, id, holds.has(id), check)));
    if (pickOne) can.add("");
    for (const value of entry.picked)
      if (value === "" ? !pickOne : !accepted.has(value)) return { kind: "conflict" };
    // Roles being added that fail a rule now: kept in the comparison, so they count as a change.
    const failing = [...setOf(entry.picked)].filter(
      (id) => id !== "" && !can.has(id) && !holds.has(id),
    );
    const now = new Set([...entry.picked.filter((value) => can.has(value)), ...failing]);
    const before = setOf(entry.seen.filter((value) => can.has(value)));
    if (!category || sameSet(now, before)) continue;
    for (const roleId of failing)
      errors.push({
        categoryId: category.id,
        roleId,
        message: CHOICE_MESSAGES.unavailableRole(roleId),
      });
    const picks = roles.filter((id) => now.has(id) && can.has(id));
    // Held, listed roles the person can't change now: they keep them, so they count too.
    const fixed = roles.filter((id) => holds.has(id) && listed(menu, id) && !can.has(id));
    if (category.state === "published" && category.max !== null) {
      if (picks.length > category.max)
        errors.push({
          categoryId: category.id,
          max: category.max,
          message: CHOICE_MESSAGES.max(category.max),
        });
      else if (picks.length + fixed.length > category.max)
        errors.push({
          categoryId: category.id,
          message: CHOICE_MESSAGES.fixedMax(fixed, category.max),
        });
    }
    offered.push(...roles.filter((id) => can.has(id)));
    chosen.push(...picks);
  }
  if (errors.length > 0) return { kind: "invalid", errors };
  return { kind: "choice", choice: { chosen, offered } };
}

/**
 * A new save merged into the change still waiting, category by category: every category the new
 * save changed replaces everything the waiting change asked in that category, and the rest of it
 * stands, so a second save builds on the first. The changed categories are those of `next.offered`
 * (changedCategories puts every changeable role of a changed category there, so none is missed).
 *
 * Replacing by category, not by role, matters when a role the waiting change names has become
 * unchangeable since (Stop offering, or it now fails a rule): the page hid it, or showed it as text,
 * so the person couldn't untick it, and keeping it beside their new pick could put two picks in a
 * pick-one category, which the job then skips whole. A category the form showed but the person
 * left alone isn't in `next.offered`: its rows were ticked from the waiting change, so what that
 * change asked there stands. Roles the waiting change named that are no longer on the menu at all
 * are dropped (the job would skip them anyway), which also keeps a merged payload within the
 * menu's 50-role cap.
 */
export function mergeChoice(
  waiting: RoleChoice | null,
  next: RoleChoice,
  menu: SelfRoleMenu | null,
): RoleChoice {
  const categoryOf = (roleId: string): string | undefined =>
    menu ? findOption(menu, roleId)?.category.id : undefined;
  const changed = new Set(next.offered.map(categoryOf));
  const kept = (waiting?.offered ?? []).filter((id) => {
    const category = categoryOf(id);
    return category !== undefined && !changed.has(category);
  });
  const keep = setOf(kept);
  return {
    chosen: [...(waiting?.chosen ?? []).filter((id) => keep.has(id)), ...next.chosen],
    offered: [...kept, ...next.offered],
  };
}

/** The same desired state (the equal-state rule for a repeated save). */
export const sameChoice = (left: RoleChoice, right: RoleChoice): boolean =>
  sameSet(setOf(left.chosen), setOf(right.chosen)) &&
  sameSet(setOf(left.offered), setOf(right.offered));

/** The person already holds exactly what the choice asks over its roles: nothing to do. */
export function choiceHeld(choice: RoleChoice, held: readonly string[]): boolean {
  const holds = setOf(held);
  const wanted = setOf(choice.chosen);
  return choice.offered.every((roleId) => wanted.has(roleId) === holds.has(roleId));
}

/** What the roles.self job will do, before its per-role checks. Counts only ever leave it. */
export interface SelfRolePlan {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /**
   * Roles in `offered` whose wanted state differs from the held one that this plan leaves alone:
   * no longer listed, no longer offered (for an add), in a category now over its limit, or an
   * access role. The job adds its own per-role refusals, so the member is never told "updated"
   * when a choice was dropped.
   */
  readonly skipped: number;
}

/**
 * The roles.self job's plan from the choice, the menu as it is now (null: unreadable, so nothing is
 * listed and nothing changes) and the member's roles now:
 * - only roles in `offered` that the menu lists now are touched, so a role added to the menu after
 *   the save, a draft and a category the member didn't change are never touched;
 * - a wanted role is added only while it is offered; an unwanted held role is removed while it is
 *   listed (Stop offering keeps removal);
 * - a published category whose roles would exceed its limit is skipped whole: the chosen roles in
 *   it, plus the roles the member holds there that the choice doesn't cover (outside `offered`,
 *   so this job never touches them: ones that couldn't be changed at the save, as changedCategories
 *   counts them). That is conservative for a role officers added to the category after the save,
 *   which also counts and so can skip the category; the member saves again. A category the member
 *   didn't change has no role in `offered`, so skipping it changes nothing;
 * - the bound and retired access roles (`untouchable`) are never touched, whatever the menu says.
 * Everything else that differs is counted in `skipped`.
 */
export function planSelfRoles(
  choice: RoleChoice,
  menu: SelfRoleMenu | null,
  held: readonly string[],
  untouchable: ReadonlySet<string>,
): SelfRolePlan {
  const holds = setOf(held);
  const wanted = setOf(choice.chosen);
  const targets = setOf(choice.offered);
  const differs = [...targets].filter((id) => wanted.has(id) !== holds.has(id));
  const add: string[] = [];
  const remove: string[] = [];
  if (menu) {
    // What the member would hold in each category afterwards, at most: what they chose, and what
    // they hold there that this job leaves alone.
    const after = (category: SelfRoleCategory) =>
      category.options.filter(
        (option) =>
          wanted.has(option.roleId) || (holds.has(option.roleId) && !targets.has(option.roleId)),
      ).length;
    const overLimit = setOf(
      menu.categories
        .filter(
          (category) =>
            category.state === "published" &&
            category.max !== null &&
            after(category) > category.max,
        )
        .map((category) => category.id),
    );
    for (const roleId of differs) {
      const found = findOption(menu, roleId);
      if (!found || untouchable.has(roleId) || !listed(menu, roleId)) continue;
      if (overLimit.has(found.category.id)) continue;
      if (!wanted.has(roleId)) remove.push(roleId);
      else if (addable(menu, roleId)) add.push(roleId);
    }
  }
  return { add, remove, skipped: differs.length - add.length - remove.length };
}

/**
 * The listed menu roles reconciliation takes from someone left with none of TaruBot's access roles
 * (owner decision Q3 B, 2026-10-09): those they hold that open a channel (the editor's "Opens:"
 * test) and that TaruBot can still take away. Discord adds up role grants, so without this an
 * opt-in channel would stay open to someone who lost Member and Guest; with it, the channel stays
 * behind Member or Guest as well as the role. Purely cosmetic roles (pronouns, identity, anything
 * that opens nothing) are kept, drafts are never acted on (only published and Stop offering
 * categories list a role), and a role TaruBot can't remove (above it, say) is left alone, so it
 * can never block the access change it accompanies. Only held, listed roles are checked, so
 * someone holding no menu role costs no rule check.
 */
export function accessLossRemovals(
  menu: SelfRoleMenu,
  guild: VisibilityGuild,
  settings: SelfRoleSettings,
  held: readonly string[],
): string[] {
  const holds = setOf(held);
  const candidates = menuRoleIds(menu).filter((id) => holds.has(id) && listed(menu, id));
  if (candidates.length === 0) return [];
  const check = selfRoleChecker(guild, settings);
  return candidates.filter((roleId) => {
    const verdict = check(roleId);
    return verdict.opens.length > 0 && removableBy(verdict);
  });
}

/** My roles' approved sentences that the application layer returns or throws. */
export const CHOICE_MESSAGES = {
  /** A form naming a role or a "None" the menu no longer offers this person there (409). */
  conflict:
    "Officers changed the roles on offer while you were choosing. Check your choices and save again.",
  /** Too many picked in a changed category (422); the page shows it on the category. */
  max: (max: number) =>
    max === 1 ? "Pick only one role here." : `Pick at most ${max} roles here.`,
  /**
   * Too many in a changed category once the roles the person holds there that can't be changed
   * now are counted (422). It names those roles with Discord's mention grammar, as
   * unavailableRole does: they already show on the person's own page, and nowhere else.
   */
  fixedMax: (roleIds: readonly string[], max: number) => {
    const mentions = roleIds.map((roleId) => `<@&${roleId}>`);
    const named =
      mentions.length === 1
        ? (mentions[0] ?? "")
        : `${mentions.slice(0, -1).join(", ")} and ${mentions.at(-1) ?? ""}`;
    const counts = mentions.length === 1 ? "counts" : "count";
    const limit = max === 1 ? "one role" : `${max} roles`;
    const room = max - roleIds.length;
    const next =
      room > 0
        ? `pick at most ${room} other ${room === 1 ? "role" : "roles"} here`
        : "you can't pick another role here";
    return `${named} can't be changed here right now and ${counts} toward this category's limit of ${limit}, so ${next}.`;
  },
  /** A role being added that fails a rule now (422), named with Discord's mention grammar. */
  unavailableRole: (roleId: string) =>
    `<@&${roleId}> can't be picked right now. Choose something else, then save again.`,
  /** A save while Discord changes are paused here (503); the page shows the form disabled. */
  paused: "Role changes are paused in this server right now. Try again later.",
  /** A save during a Discord time-out (403); the page shows the form disabled. */
  timedOut: "You can change your roles here when your Discord time-out ends.",
  /** A save without TaruBot's view of the server's roles (503). */
  unavailable: "TaruBot can't read this server's roles right now. Try again in a minute.",
  /** Someone neither an officer nor holding Member or Guest, or TaruBot has Administrator (403). */
  noAccess:
    "My roles is for people with this server's Member or Guest role while TaruBot doesn't have Administrator here.",
} as const;

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
