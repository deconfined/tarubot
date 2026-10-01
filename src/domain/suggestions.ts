/**
 * Public feature suggestions (2.28.0, issue #32; REQUIREMENTS.md "Approved public-suggestion
 * amendments"), pure so every rule can be unit-tested. `/suggest` posts a member's idea as an issue
 * in TaruBot's public repository, so the text is the only thing that goes public, and only after:
 *
 * 1. `normalise`: compatibility forms folded (NFKC) and every invisible or control character
 *    removed, so a disguised ID, link or mention becomes visible to the rules below;
 * 2. `clean`: the shared PUBLIC_PATTERNS list (Discord markup, links and IP addresses, email
 *    addresses, credential shapes, long ID numbers and every `@`), applied until nothing changes;
 * 3. `suggestionTitle` and `suggestionBody`: the fixed public format, with the text fenced;
 * 4. `assertPublic`: a final check over all three, which fails only if the steps above have a bug.
 *
 * Some things can't be recognised; the option's description warns members, and the owner
 * moderates after posting:
 * - names typed freely, and IDs deliberately split with visible separators;
 * - a host whose `。` sits next to a Chinese or Japanese label or TLD, which reads as the end of a
 *   sentence (`例え。jp/パス`, `discord。コム/…`, `ディスコード。gg/…`, `abc.例え。jp/…`), whatever
 *   follows it;
 * - look-alike dots, slashes and colons that have no compatibility form (`discord·gg`,
 *   `discordꓸgg`, `discord.gg∕x`, `2001∶db8∶∶1`). Browsers send these to a different host, so they
 *   aren't links, and several are real punctuation or digits in their own scripts (`·` in Catalan,
 *   `։` in Armenian, `٠`);
 * - IPv4 addresses written as one to three decimal numbers (`127.1`, `192.168.1`, `2130706433`),
 *   which can't be told apart from ratings, times, version ranges and counts (`3.5/5`, `10.30:00`,
 *   `2.26.0/2.27.0`, `24/7`);
 * - non-global IPv6 addresses (link-local `fe80::1`, unique-local `fd00::1`, loopback `::1`), which
 *   don't identify a connection publicly; a global one inside a longer run of letters, digits or
 *   colons (`ip2001:db8::1`, `2001:db8::1x`, `2001:db8::1::`), which reads as part of it; and the
 *   start of one, fewer than eight groups with no `::` (`2001:db8:1234`), which can't be told apart
 *   from dates, scores and slices (`2025:09:25`, `2000:1500:1200`, `data[2000:3000:10]`).
 */
import type { Actor } from "./policy.js";
import { BODY_LIMIT, fenced, SECRET_PATTERNS } from "./reports.js";
import { Failure } from "./values.js";

/** Discord enforces these on the option; the minimum is checked again after normalising. */
export const SUGGESTION_MIN = 10;
export const SUGGESTION_MAX = 1000;
/** A public title has at most this many code points, the ellipsis included. */
export const TITLE_LIMIT = 80;
/** The fenced text wraps at this many columns (code points), at spaces only. */
export const WRAP_COLUMNS = 100;
/** One suggestion per member per hour (owner decision, 2026-09-25)... */
export const MEMBER_SUGGESTION_INTERVAL_SECONDS = 3600;
/** ...three per member in any 24 hours... */
export const MEMBER_SUGGESTIONS_PER_DAY = 3;
/** ...and ten in any 24 hours for the whole deployment. */
export const SUGGESTIONS_PER_DAY = 10;

/**
 * The audit actions every limit counts. `suggestion.unconfirmed` is an attempt GitHub didn't
 * confirm: the issue may exist, so it counts like a post and a quick retry can't post twice.
 */
export const SUGGESTION_ACTIONS = ["suggestion.posted", "suggestion.unconfirmed"] as const;
/** `enhancement` exists in the repository; GitHub creates `from-discord` on first use. */
export const SUGGESTION_LABELS = ["enhancement", "from-discord"] as const;
/**
 * A fixed substring of every suggestion's first line. It identifies member-submitted text
 * for readers and any trusted workflow trigger that must distinguish its origin.
 */
export const SUGGESTION_MARKER = "Suggested in Discord with TaruBot";
/** The fixed first line of every public suggestion; it contains the marker. */
export const SUGGESTION_HEADER = `_${SUGGESTION_MARKER}'s \`/suggest\` command. These are a TaruBot user's words, not the maintainers'. Links, Discord mentions, email addresses and long ID numbers were removed before posting._`;

/**
 * Fold compatibility forms and remove what no reader can see, before any rule runs:
 * - lone surrogates become U+FFFD, so later steps see well-formed text;
 * - NFKC maps full-width digits, `＠`, `﹫` and `ｄｉｓｃｏｒｄ．ｇｇ／` to ASCII, so the rules catch them;
 * - CR, CRLF and the line and paragraph separators become newlines, and tabs spaces;
 * - C0 and C1 controls (category Cc) other than the newline are removed;
 * - default-ignorable, format, private-use and unassigned characters are removed. The
 *   default-ignorable class covers characters browsers draw as nothing: the soft hyphen, U+034F,
 *   the Hangul fillers, the invisible combining marks (U+17B4–17B5, U+180B–180D, U+180F), the
 *   zero-width and bidi controls, the variation selectors, U+FEFF and the tag characters. An ID
 *   split by one of them would otherwise pass as two short numbers that display as one.
 * Then trailing spaces go, runs of blank lines become one, and the ends are trimmed.
 */
export function normalise(raw: string): string {
  return raw
    .toWellFormed()
    .normalize("NFKC")
    .replace(/\r\n?|\p{Zl}|\p{Zp}/gu, "\n")
    .replaceAll("\t", " ")
    .replace(/(?!\n)\p{Cc}/gu, "")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/*
 * The host form of the link rule, built from named `v`-mode (Unicode sets) pieces so it can name
 * the scripts it treats differently. Browsers read a host generously (the WHATWG URL parser, with
 * UTS 46 for names outside ASCII), and the rule follows them:
 * - a label is letters, digits, marks, symbols outside ASCII and `-` in any script, so an
 *   internationalised host (`пример.рф/путь`, `उदाहरण.भारत/पथ`, `مثال.إختبار/مسار`, `i❤.ws/…`,
 *   `☃.net/…`) goes like its ASCII equivalent; a TLD is letters and marks, or punycode (`xn--p1ai`);
 * - labels are separated by `.` or by `。`, which browsers treat as a dot (`normalise` has already
 *   folded `．` into `.` and `｡` into `。`), and a host may end in one more of them, as a fully
 *   qualified name does (`discord.gg./…`, `discord.gg。/…`);
 * - browsers decode percent-escapes in a host, so an escape counts as the character it encodes
 *   would: `%2E` (and the escaped `。`, `．` and `｡`) separates labels, and any other escape is a
 *   label character (`discord%2Egg/…`, `disc%6Frd.gg/…`);
 * - a path may start with `\`, which browsers read as `/`, and a port may be empty
 *   (`discord.gg\…`, `discord.gg:/…`).
 *
 * Han, Hiragana and Katakana are written without spaces, and their sentences end in `。`, `．` or
 * `？`, so three rules keep ordinary Chinese and Japanese text from reading as a host:
 * - a label never mixes their letters with other scripts' letters, and in a host their labels come
 *   after any others (`blog.例え.jp`), so text running straight into a link stays
 *   (`招待はこちらdiscord.gg/x` and `…ます.discord.gg/x` keep `招待はこちら` and `…ます.`). A mark
 *   is never a letter, so their sound marks count in other labels too (`discord.gg゙/…` goes);
 * - `。` separates labels only where neither side is in those scripts, so `…です。できますか？…`
 *   and `…しました。ON/OFF…` stay, and so does `例え。jp/パス`, which can't be told apart from them;
 * - a TLD in those scripts (`.中国`, `.みんな`) needs a `.` before it and a port or a path after
 *   it, so `好的.可以吗?谢谢` stays.
 * A host's labels can start matching only where a run of them begins (not inside a label or an
 * escape, and not after a label that could have led the run), so the labels need no length bound
 * and a run is scanned about once: the slowest 1,000-character shapes tried take under 1 ms a pass.
 */
/** Han, Hiragana and Katakana, by script extension, so `々` and `ー` count. */
const CJK = String.raw`[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]`;
/** A label character of any script: a letter, digit, mark, symbol outside ASCII, or `-`. */
const HOST_CHAR = String.raw`[\p{L}\p{N}\p{M}\-[\p{S}--\p{ASCII}]]`;
/** A label character outside those scripts, or a mark of any script. */
const WORD = String.raw`[[${HOST_CHAR}--${CJK}]\p{M}]`;
/**
 * A digit or `-` outside those scripts, or a mark of any script (a mark is never a letter), which
 * may sit in a label of any script and lead one in those scripts (`1日`).
 */
const NEUTRAL = String.raw`[[[\p{N}\-]--${CJK}]\p{M}]`;
/** A Han, Hiragana or Katakana letter or digit (not their punctuation, such as `。`). */
const CJK_CHAR = String.raw`[[\p{L}\p{N}]&&${CJK}]`;
/** `.`, or an escaped `.`, `。`, `．` or `｡`, which a browser decodes into one. */
const DOT = String.raw`(?:\.|%2e|%e3%80%82|%ef%bc%8e|%ef%bd%a1)`;
/** Any other percent-escape: a label character once decoded. */
const ESCAPE = String.raw`%(?!2e|e3%80%82|ef%bc%8e|ef%bd%a1)[\da-f]{2}`;
/** A label of other scripts, then a dot, or `。` unless a Han, Hiragana or Katakana label follows. */
const WORD_LABEL = `(?:${WORD}|${ESCAPE})+(?:${DOT}|。(?!${NEUTRAL}*${CJK_CHAR}))`;
/** A Han, Hiragana or Katakana label, which may carry digits, marks and `-`, then a dot. */
const CJK_LABEL = `${NEUTRAL}*${CJK_CHAR}[${CJK_CHAR}${NEUTRAL}]*${DOT}`;
/**
 * Han, Hiragana or Katakana labels, with labels of only digits, marks and `-` among them after the
 * first (`例.1.jp`).
 */
const CJK_LABELS = `${CJK_LABEL}(?:${CJK_LABEL}|${NEUTRAL}+${DOT})*`;
/** A separator: `。` or a dot. */
const SEP = `(?:。|${DOT})`;
/**
 * Where a run of labels of other scripts may start: not inside a label or an escape, and not just
 * after a label (or an escape) and its separator, which a run starting there would have covered.
 * An escape's hex digits don't count as a label there, so a run can start after a leading `%2E`.
 */
const RUN_START = String.raw`(?<!(?<!%[\da-f]?)${WORD}${SEP}?|${ESCAPE}${SEP}?)(?!(?<=%)[\da-f]{2}|(?<=%[\da-f])[\da-f])`;
/**
 * Just after a Han, Hiragana or Katakana letter (and a separator), a run starts only where a letter
 * or symbol of other scripts, or an escape, comes before their next letter (`例1abc.com/…`,
 * `例.1.discord.gg/…`): digits alone there belong to their label, which CJK_RUN reads, so a chain
 * of them isn't scanned again from every label. The two branches exclude each other, so the
 * lookahead runs only there.
 */
const AFTER_CJK = `(?:(?<!${CJK_CHAR}${SEP}?)|(?<=${CJK_CHAR}${SEP}?)(?=(?:${NEUTRAL}|${SEP})*(?:[${WORD}--${NEUTRAL}]|${ESCAPE})))`;
/** Labels of other scripts, then any Han, Hiragana or Katakana ones. */
const WORD_RUN = `${RUN_START}${AFTER_CJK}(?:${WORD_LABEL})+(?:${CJK_LABELS})?`;
/**
 * Han, Hiragana or Katakana labels alone, after any labels of only digits, marks and `-`
 * (`1.例.jp`), starting where such a run begins: not inside a label, and not just after any label
 * and a `.`.
 */
const CJK_RUN = String.raw`(?<![${CJK_CHAR}${NEUTRAL}]|${HOST_CHAR}\.)(?:${NEUTRAL}+${DOT})*${CJK_LABELS}`;
/** A TLD outside those scripts (a mark of any script counts), or punycode. */
const TLD = String.raw`(?:xn--[a-z\d\-]{1,59}|(?:[[\p{L}--${CJK}]\p{M}]|${ESCAPE}){2,63})`;
/** A Han, Hiragana or Katakana TLD. */
const CJK_TLD = String.raw`[[\p{L}\p{M}]&&${CJK}]{2,63}`;
/** A path (`/`, or `\`, which browsers read as `/`) after an optional port, which may be empty. */
const PATH = String.raw`(?::\d{0,5})?[\/\\]`;
/** What makes a host a link: a port, a path, or a query or fragment. */
const AFTER_HOST = String.raw`(?:${PATH}|(?::\d{0,5})?[?#]\S|:\d{1,5})`;
/**
 * A TLD, an optional final dot, and what follows; a Han, Hiragana or Katakana TLD takes only a
 * port or a path, and a final `.` (a `。` after it reads as the end of a sentence).
 */
const HOST_END = String.raw`(?:${TLD}(?:${DOT}|。)?${AFTER_HOST}|${CJK_TLD}${DOT}?(?:${PATH}|:\d{1,5}))`;
/** A character of a URL's user part: anything but a space, `/`, `\`, `?`, `#` and brackets. */
const USER_CHAR = String.raw`[^\s\/\\?#\(\)<>\[\]\{\}]`;
/**
 * A `user@` or `user:password@` in front of a linked host, up to its last `@` as browsers read it.
 * It starts only where a word does (not just after another user character), so it is scanned once
 * per word; a bracket ends it, so it can't take a replacement token's bracket with it.
 */
const USER = `(?:(?<!${USER_CHAR})${USER_CHAR}{1,256}@)?`;
/** One part of an IPv4 address as browsers read it: decimal, octal (`0177`) or hexadecimal. */
const IP_PART = String.raw`(?:0x[\da-f]{0,8}|0\d{0,11}|[1-9]\d{0,2})`;
/** A dot between IPv4 parts: any of the host's dots. */
const IP_DOT = `(?:${DOT}|。)`;
/**
 * An IPv4 address: four parts (`192.168.1.10`, `0177.0.0.1`), or one to three with a hexadecimal
 * part (`0x7f.1`), which no number in prose has, before a port, path, query or fragment. It may
 * touch letters on either side (`ip192.168.1.10`, `192.168.1.10x`), but not an ASCII digit, so
 * `1.2.3.4567` stays, and not a lone `v` before it, so a version (`v1.2.3.4`) stays too.
 */
const IPV4 = String.raw`(?<!\d|\bv)(?:${IP_PART}(?:${IP_DOT}${IP_PART}){3}|(?:${IP_PART}${IP_DOT}){0,2}0x[\da-f]{0,8}(?:${IP_DOT}${IP_PART}){0,2}(?=${AFTER_HOST}))(?!\d)`;
/**
 * Scripts whose words run straight into a number: Han, Hiragana, Katakana, Thai, Lao, Khmer and
 * Myanmar are written without spaces between words, and Korean attaches its particles and copula
 * to the word before them (`주소는 2001:db8::1입니다`).
 */
const RUNS_ON = String.raw`[${CJK}\p{scx=Hang}\p{scx=Thai}\p{scx=Laoo}\p{scx=Khmr}\p{scx=Mymr}]`;
/**
 * A letter or digit that an IPv6 address can't touch: any script's but those (RUNS_ON), so
 * `サーバーは2001:db8::1です`, `서버2001:db8::1번` and `ไอพีคือ2001:db8::1ครับ` keep their words.
 */
const V6_EDGE = String.raw`[[\p{L}\p{N}]--${RUNS_ON}]`;
/** A group of an IPv6 address after the first: one to four hex digits. */
const V6_GROUP = String.raw`[\da-f]{1,4}`;
/** An IPv4 address in place of an IPv6 address's last two groups (`::ffff:192.0.2.1`). */
const V6_TAIL = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
/**
 * A global unicast IPv6 address (2000::/3), by @deconfined's rule: the first group is exactly four
 * hex digits and starts with 2 or 3, and the address has at least two colons. Those are true of
 * every global address but not only of addresses (a photo's date `2025:09:25`, a score
 * `2000:1500:1200`, a slice `data[2000:3000:10]`), so the rest must have an address's shape too:
 * after the first group comes either one `::`, with any groups on either side of it (`2001::`,
 * `2001:db8::1`), or all seven other groups (`2001:db8:0:0:0:0:0:1`); an IPv4 tail may replace the
 * last two groups (`2001:db8::192.0.2.1`, `2001:db8:0:0:0:0:192.0.2.1`). Times (`10:30:00`), ratios
 * (`16:9`), one-colon forms (`2024:01`), scopes (`std::vector`) and non-global addresses
 * (`fe80::1`, `fd00::1`, `::1`, `1234:5678::1`) don't fit, and stay.
 * The address must be a whole run of groups and colons: it doesn't touch a letter or digit
 * (V6_EDGE), follow a group and a colon (`fe80:0:2001:db8::1`) or `::` (`fe80::2001:db8:1`), or run
 * on into another group; a word before a colon (`IPv6:`, `ip:`) is a label, not a group, and a
 * colon with no group after it is punctuation. Each colon starts at most one group and a run can
 * start only at its beginning, so a run is scanned about once.
 */
const IPV6 = String.raw`(?<!${V6_EDGE}|(?<!${V6_EDGE})[\da-f]{1,4}:|::)[23][\da-f]{3}(?:(?::${V6_GROUP})*::(?:(?:${V6_GROUP}:)*(?:${V6_TAIL}|${V6_GROUP}))?|(?::${V6_GROUP}){7}|(?::${V6_GROUP}){5}:${V6_TAIL})(?!${V6_EDGE}|:[\da-f:])`;
/** Rule f, as PUBLIC_PATTERNS describes it. */
const LINK = new RegExp(
  [
    String.raw`[a-z][a-z\d+.\-]{0,31}:[\/\\]{2}\S*`,
    String.raw`\b(?:https?|wss?|ftp|file):[\/\\]*(?=${HOST_CHAR}|[%\[])\S*`,
    String.raw`www(?:\.(?=\S)|。(?=${WORD}))\S*`,
    String.raw`${USER}(?:(?:${WORD_RUN}|${CJK_RUN})${HOST_END}|\blocalhost(?:${DOT}|。)?${AFTER_HOST})\S*`,
    String.raw`${USER}(?:${IPV4}|\[${IPV6}\]|${IPV6})(?:${AFTER_HOST}\S*)?`,
  ].join("|"),
  "giv",
);
/** A label of an email address's domain: a host's label characters, or `_`. */
const MAIL_LABEL = String.raw`[\p{L}\p{N}\p{M}_\-[\p{S}--\p{ASCII}]]{1,63}`;
/** An email address: a quoted or plain local part (any of RFC 5322's characters), then a domain. */
const EMAIL = new RegExp(
  String.raw`(?:"[^"\n]{1,64}"|[\p{L}\p{N}\p{M}._%+\-!#$&'*\/=?^\`\{\|\}~]{1,64})@${MAIL_LABEL}(?:[.。]${MAIL_LABEL})+`,
  "gv",
);

/**
 * What must never reach the public text, in the order `clean` applies it, and what replaces it.
 * One list drives both `clean` and `assertPublic`, so the check can't be stricter than the cleaner.
 * - Discord markup: member, role and channel mentions become words; custom emoji keep their name
 *   and command mentions their path, without the IDs.
 * - Links (rule f): any URL with `//` or `\\` after its scheme, and a word `http:`, `https:`,
 *   `ws:`, `wss:`, `ftp:` or `file:` before a host with any number of slashes, as browsers read
 *   them (`https:example/x`, but not `profile:x`); `www.` before anything but a space ("Awww.
 *   That…" stays), and `www。…` when a label outside Han, Hiragana and Katakana follows (so
 *   `面白いwww。次は…` stays); a host in any script (see above) or `localhost` followed by a port, a
 *   path, or a query or fragment (`?x`, `#x`), scheme or not, so `discord.gg/…`, `discord.gg?…`,
 *   `discord。gg/…`, `discord.gg./…`, `discord.com/channels/…`, `example.com:8080`,
 *   `пример.рф/путь`, `例子.中国/路径` and Lodestone character pages all go; and any IPv4 address
 *   (see IPV4) or global IPv6 address, bare or in brackets (see IPV6; `2001:db8::1`,
 *   `[2001:db8::1]:8080`), with whatever port, path, query or fragment follows it. A `user@` or
 *   `user:password@` in front goes with the link, so an email address or credentials followed by a
 *   path or query can't leave a name or password behind. A bare domain (`discord.gg`) or
 *   `localhost` carries no ID and stays, and so does a word before a colon or a question mark
 *   ("Node.js: …", "Node.js?"). Links run before the credential shapes, so a ping URL or a URL
 *   with credentials goes whole.
 * - Email addresses in any script, with a quoted local part or any of the characters RFC 5322
 *   allows unquoted (`"john doe"@…`, `hunt!er2@…`), and `.` or `。` between the domain's labels;
 *   then the issue reporter's credential shapes (never the deployment's own secret values); then
 *   runs of 17 or more digits or other number characters in any script (Discord and Lodestone
 *   IDs), with any marks on them (keycaps `1⃣`, `1̇`), so `➀➁…` and `1⃣2⃣…` go too.
 * - Every `@` last: a GitHub @mention notifies that account and can invoke installed automation.
 * The quantifiers are bounded (or, for a host's labels, start only where a run begins) and Discord
 * caps the option at 1,000 characters, so backtracking stays small. No replacement equals its own
 * match, so a pass that changes nothing proves that no pattern matches.
 */
export const PUBLIC_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/<@!?\d+>/gu, "[member]"],
  [/<@&\d+>/gu, "[role]"],
  [/<#\d+>/gu, "[channel]"],
  [/<a?:(\w{1,32}):\d+>/gu, ":$1:"],
  [/<\/([-\w ]{1,100}):\d+>/gu, "/$1"],
  [LINK, "[link removed]"],
  [EMAIL, "[email removed]"],
  ...SECRET_PATTERNS,
  [/\p{N}(?:\p{M}*\p{N}){16,}\p{M}*/gu, "[ID removed]"],
  [/@/gu, "＠"],
];

/**
 * Apply PUBLIC_PATTERNS until a pass changes nothing. One pass isn't enough: `replace` doesn't
 * rescan what it just replaced, so removing an inner piece of nested markup can complete an outer
 * one (`<a<:b:1>1>` becomes `<a:b:1>` after one pass). Each further pass unwraps one level and
 * shortens the text, so the text's length bounds the passes; real inputs stop within a few.
 */
export function clean(text: string): string {
  let current = text;
  for (let pass = 0; pass <= text.length; pass++) {
    const next = PUBLIC_PATTERNS.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      current,
    );
    if (next === current) return current;
    current = next;
  }
  // Not reached for any input clean can shorten; assertPublic would report it as a bug.
  return current;
}

/**
 * The public title: the start of the cleaned text on one line, with GitHub references (`#12`,
 * `owner/repo#1`, `GH-3`) neutralised by look-alike characters. Over 80 code points, it is cut
 * at the last space between code points 40 and 79 (or hard-cut at 79) and ends with `…`. Cutting
 * by code point never splits a surrogate pair.
 */
export function suggestionTitle(text: string): string {
  const flat = text
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("#", "＃")
    .replace(/\bGH-(?=\d)/giu, (match) => `${match.slice(0, 2)}‑`);
  const points = [...flat];
  if (points.length <= TITLE_LIMIT) return flat;
  let cut = TITLE_LIMIT - 1;
  for (let index = TITLE_LIMIT - 1; index >= 40; index--)
    if (points[index] === " ") {
      cut = index;
      break;
    }
  return `${points.slice(0, cut).join("")}…`;
}

/**
 * Greedy wrapping at spaces, `columns` code points per line. A word is never split: one longer
 * than a line stays whole on its own line. Existing line breaks are kept.
 */
export function wrap(text: string, columns = WRAP_COLUMNS): string {
  const width = (value: string) => [...value].length;
  return text
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let current: string | null = null;
      for (const word of line.split(" ")) {
        if (current === null) current = word;
        else if (width(current) + 1 + width(word) <= columns) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      lines.push(current ?? "");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * The public issue body: the fixed header, the member's cleaned text in a `text` code block (which
 * renders no links, images or HTML; `fenced` stops the text closing it), and TaruBot's version.
 * Nothing else about the member, the server or the deployment is added.
 */
export function suggestionBody(text: string, version: string): string {
  return [SUGGESTION_HEADER, fenced(wrap(text), "text"), `Sent by TaruBot ${version}.`].join(
    "\n\n",
  );
}

/** Characters no public title or body may carry. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** C0 and C1 controls (category Cc), tab included, but not the newline. */
const CONTROL = /(?!\n)\p{Cc}/u;
const LONG_ID = /\p{Nd}{17,}/u;

/**
 * The final check before anything is posted: the text must match none of PUBLIC_PATTERNS, and the
 * title and body, which only cut, wrap and fence it, must carry no `@`, long ID, `#` in the title,
 * invisible character or control. The link rule isn't run over the title and body: a cut title
 * can end `example.com?…`, and fencing turns backticks into `ʼ` (a letter), so `discord```.gg/x`
 * reads `discordʼʼʼ.gg/x` in the body. Neither is a link GitHub renders, since titles aren't linked
 * and the body is fenced, and neither adds anything the member wrote. A failure here is a bug,
 * thrown as a plain Error so the member gets the unexpected-failure card and the owner a private
 * report. `search` ignores the global patterns' lastIndex.
 */
export function assertPublic(text: string, title: string, body: string): void {
  const safe = (part: string) =>
    !part.includes("@") &&
    part.search(LONG_ID) === -1 &&
    part.search(INVISIBLE) === -1 &&
    part.search(CONTROL) === -1 &&
    part.isWellFormed();
  const passes =
    PUBLIC_PATTERNS.every(([pattern]) => text.search(pattern) === -1) &&
    safe(title) &&
    safe(body) &&
    !title.includes("#") &&
    [...title].length <= TITLE_LIMIT &&
    body.startsWith(SUGGESTION_HEADER) &&
    body.split("```").length === 3 &&
    body.length <= BODY_LIMIT;
  if (!passes) throw new Error("A public suggestion failed its privacy check.");
}

/**
 * Who may suggest (owner decision, 2026-09-25): anyone with server access, meaning they hold the
 * server's bound Member or Guest role right now (the actor's roles are read fresh from Discord).
 * Officer access alone doesn't qualify: officers qualify through their Member role, and a server
 * manager holding neither role is refused. An unbound role qualifies nobody.
 */
export function maySuggest(
  actor: Pick<Actor, "roleIds">,
  roles: { readonly member_role_id: string | null; readonly guest_role_id: string | null },
): boolean {
  const held = actor.roleIds ?? [];
  return [roles.member_role_id, roles.guest_role_id].some(
    (role) => role !== null && held.includes(role),
  );
}

/** The refusal for someone without server access; it shows the membership card. */
export const suggestionAccessRefused = (): Failure =>
  new Failure("forbidden", "Only members and guests of this server can suggest features.", 0, {
    kind: "scope",
    scope: "membership",
  });

/** The refusal for an idea that is too short once invisible characters are removed. */
export const suggestionTooShort = (): Failure =>
  new Failure("input", "Describe your idea in at least 10 characters.", 0, {
    kind: "option",
    option: "idea",
  });
