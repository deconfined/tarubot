/**
 * Where sign-in returns to (#43, E12). The target travels from a signed-out page to /login in the
 * query, then in the login cookie, and is never reflected into a page. Every hop runs it through
 * safeReturnPath, so an open redirect needs a value that passes these rules, and none can leave the
 * origin: Location resolves a value starting with a single "/" against the page's own origin.
 */

/** The longest return path kept; anything longer becomes "/". */
export const RETURN_PATH_MAX = 512;

/** The /login query parameter that carries the return path. */
export const RETURN_PARAM = "to";

/** Visible ASCII only: no space, control or raw non-ASCII character (browsers encode those). */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

/** Rounds of percent-decoding inspected; a value still changing after that is refused. */
const DECODE_ROUNDS = 3;

/**
 * A same-origin path for a redirect, or "/". The value must start with exactly one "/", be at most
 * RETURN_PATH_MAX characters of visible ASCII, and contain no backslash. Each percent-decoded form
 * must also keep a single leading "/" (so "/%2F%2Fevil" is refused), contain no backslash or
 * control character, and have no "." or ".." segment before its query or fragment.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > RETURN_PATH_MAX || !VISIBLE_ASCII.test(value))
    return "/";
  let current = value;
  for (let round = 0; round <= DECODE_ROUNDS; round++) {
    if (!acceptable(current)) return "/";
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // A malformed escape (for example "%E0%A4%A") can't be a path this app produced.
      return "/";
    }
    if (decoded === current) return value;
    current = decoded;
  }
  return "/";
}

/** One form of the candidate: a single leading "/", no backslash or control, no dot segment. */
function acceptable(candidate: string): boolean {
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return false;
  // Browsers treat "\" like "/" in URLs, so "/\evil" would be protocol-relative.
  if (candidate.includes("\\")) return false;
  // Decoded forms can contain controls that the raw value only spelled as escapes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding controls is the point.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(candidate)) return false;
  const path = candidate.split(/[?#]/u, 1)[0] ?? "";
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}
