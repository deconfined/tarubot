/** Lossless boundary values shared by application policy, persistence, and presentation. */
import { z } from "zod";
// Type-only: failures.ts imports Failure at runtime, and this erased import avoids a cycle.
import type { FailureCode, FailureDetail } from "./failures.js";

/** External IDs may exceed signed bigint; their application/storage representation is text. */
export const MAX_ID = 18_446_744_073_709_551_615n;
/** Money uses PostgreSQL's signed bigint range, with nonnegative account balances. */
export const MAX_GIL = 9_223_372_036_854_775_807n;
/** Decimal shape of an external ID: no leading zeroes, signs, or whitespace. */
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/**
 * Reject malformed values and values outside unsigned 64-bit IDs. Zod 4 still runs a refinement
 * after a failed regex check, so the range check re-tests the shape before calling BigInt, which
 * would otherwise throw a raw SyntaxError for input such as a typed name or "@name".
 */
export const idSchema = z
  .string()
  .regex(ID_PATTERN)
  .refine((v) => ID_PATTERN.test(v) && BigInt(v) <= MAX_ID);
export type Id = string;

/**
 * Deliberately user-safe diagnostics; raw transport/database exceptions stay out of replies. The
 * code must be catalogued in failures.ts, which gives it a presentation category and log level.
 * The optional detail carries structured, presentation-safe context for the reply presenter.
 */
export class Failure extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly retryAfter = 0,
    public readonly detail?: FailureDetail,
  ) {
    super(message);
    this.name = "Failure";
  }
}

/**
 * Seconds a client is asked to wait after a shutdown refusal: long enough for the restart to bring
 * the web back, short enough that a retry soon after lands.
 */
export const STOPPING_RETRY_AFTER = 30;

/**
 * The refusal of a write once shutdown has begun (a 429 with Retry-After on the web). The web
 * answers it before a POST costs anything (src/web/limits.ts re-exports it), and an application
 * operation that commits a page's write throws the same failure from its pre-commit check, so a
 * write that started just before shutdown rolls back and its form gets the same answer. The error
 * page says how long to wait, from Retry-After, so the message doesn't.
 */
export function stoppingRefusal(): Failure {
  return new Failure(
    "stopping",
    "TaruBot is restarting, so nothing was saved.",
    STOPPING_RETRY_AFTER,
  );
}

/** The input failure's option detail, which lets the reply show that option's example. */
const option = (name: string): FailureDetail => ({ kind: "option", option: name });

/**
 * Numeric IDs are accepted only before any precision has been lost. `name` is the command option
 * the value came from, when it came from one; job payloads and upstream data pass none.
 */
export function id(value: unknown, name?: string): Id {
  const candidate =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  const result = idSchema.safeParse(candidate);
  if (!result.success)
    throw new Failure(
      "invalid_data",
      "That ID isn't valid. Pick a suggestion, or paste the numeric ID (for example 123456789012345678).",
      0,
      name === undefined ? undefined : option(name),
    );
  return result.data;
}

/** Approved example links per profile kind, shown when an ID or link is malformed. */
const PROFILE_EXAMPLE = {
  character: "https://na.finalfantasyxiv.com/lodestone/character/99000001/",
  freecompany: "https://na.finalfantasyxiv.com/lodestone/freecompany/9230000000000000001/",
} as const;

/**
 * Accept canonical IDs or exact regional profile URLs, preventing arbitrary URL acquisition.
 * `name` is the command option for the input failure's detail; it defaults to the kind's usual
 * option (character: or fc_id:).
 */
export function lodestoneId(
  value: string,
  kind: "character" | "freecompany",
  name: string = kind === "character" ? "character" : "fc_id",
): Id {
  const malformed = () =>
    new Failure(
      "input",
      `Paste the numeric ID or a Lodestone profile link such as ${PROFILE_EXAMPLE[kind]}.`,
      0,
      option(name),
    );
  if (/^[0-9]+$/.test(value)) {
    // A digits-only value that is still not a lossless ID gets the same approved wording.
    if (!idSchema.safeParse(value).success) throw malformed();
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed();
  }
  const match = new RegExp(`^/lodestone/${kind}/([1-9][0-9]*)/?$`).exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !/^(na|eu|fr|de|jp)\.finalfantasyxiv\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match?.[1] ||
    !idSchema.safeParse(match[1]).success
  ) {
    throw malformed();
  }
  return match[1];
}

/** Parse large monetary input directly into bigint rather than through JavaScript numbers. */
export function gil(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new Failure(
      "input",
      "Enter the balance in whole gil, digits only, for example 10005000.",
      0,
      option("balance"),
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_GIL)
    throw new Failure(
      "input",
      "That balance is larger than the ledger can store (9,223,372,036,854,775,807 gil).",
      0,
      option("balance"),
    );
  return parsed;
}

/**
 * Ledger history cursor for newest-first pages: an entry number from a previous page, 1 to
 * MAX_GIL. It has its own parser so a malformed cursor never reports a balance error.
 */
export function sequenceCursor(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > MAX_GIL)
    throw new Failure(
      "input",
      "Use an entry number from a previous page, such as 34.",
      0,
      option("before"),
    );
  return BigInt(value);
}

/**
 * A ledger entry an officer names in /ledger adjust: its entry number in the current FC account
 * (the '#5' history, receipts and posts show), or its UUID.
 */
export type EntryRef = { readonly sequence: bigint } | { readonly id: string };

/**
 * Enforce accepted UTF-16 length and PostgreSQL-compatible Unicode before a mutation. The label
 * names the option being checked (a ledger note, an officer's reason, or a rank name), so the
 * approved message reads correctly for each caller, and it doubles as the option detail.
 */
export function note(value: string, label: "note" | "reason" | "rank" = "note"): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000)
    throw new Failure("input", `Add a ${label} of 1–1,000 characters.`, 0, option(label));
  if (!trimmed.isWellFormed() || trimmed.includes("\0"))
    throw new Failure(
      "input",
      `The ${label} contains characters that can't be saved. Retype it and try again.`,
      0,
      option(label),
    );
  return trimmed;
}

/** Comparison normalization is separate from the canonical display text stored in the DB. */
export const normalized = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
/** Jobs and replies encode exact monetary values as decimal strings. */
export const json = (value: unknown, indent = 0): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    indent,
  );
/** Fit Discord's UTF-16 limit without splitting emoji, combining marks, or other graphemes. */
export function nickname(name: string): string {
  let result = "";
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name)) {
    if ((result + segment).length > 32) break;
    result += segment;
  }
  return result;
}
