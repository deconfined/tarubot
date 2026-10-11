/**
 * Mod mail's encryption (2.43.0, owner decision 1): AES-256-GCM through node:crypto, with the key
 * from MODMAIL_KEY, which lives in host settings and never in the database. Database dumps, the
 * provider's point-in-time recovery and read access to the database see only what this produces;
 * losing the key loses every case, which the owner accepted. (The host's encrypted settings copies
 * carry the key, so whoever can decrypt the backup set can read cases: see docs/THREAT_MODEL.md.)
 *
 * Each encrypted field (a case's topic, a message's body) gets:
 * - padding before encryption (ISO/IEC 7816-4: a 0x80 byte, then zeros), so a ciphertext's length
 *   says little about the text's: every topic pads to TOPIC_PADDED bytes, and a body to a multiple
 *   of MESSAGE_BLOCK bytes;
 * - a fresh random 96-bit nonce, so two equal texts never share a ciphertext;
 * - an AAD naming everything the row's meaning depends on: for a topic its server, case and
 *   opener; for a body its server, case, opener, message ID, author, side, signing and kind. A
 *   ciphertext only decrypts in the row it was written for: copied to another case, message or
 *   server, or re-inserted under another opener or author, side or signing (by a bug, an
 *   operator's SQL or someone who can write to the database), it fails the tag check instead of
 *   showing up where it doesn't belong. Every part is a decimal ID, a lowercase UUID or a fixed
 *   word, checked here, so the "|" separator can't appear inside one;
 * - storage as one bytea, nonce ‖ ciphertext ‖ tag, beside the key ID: the first 16 hex characters
 *   of HMAC-SHA256(key, "tarubot modmail key id"). The ID names a key without revealing it, so a
 *   later release can keep previous keys for reading (rotation isn't in 2.43.0) and a wrong key is
 *   told from tampering in a report.
 *
 * After readModMailKey decodes the key, its bytes live only in the private KeyObject (the decoded
 * buffer is wiped); toJSON and inspection show only the key ID, and nothing here logs. main.ts
 * reads MODMAIL_KEY once, deletes it from process.env and keeps it out of the configuration it
 * passes around; the original string itself can't be wiped (JavaScript strings are immutable) and
 * stays in memory until it is garbage collected. Plaintext goes in and comes out only through
 * encrypt and decrypt. A failed decryption (another key, an altered or moved row, bad padding)
 * returns null rather than throwing, so a page can say the text can't be read instead of failing.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  type KeyObject,
  randomBytes,
} from "node:crypto";

/** AES-256 takes exactly 32 bytes of key. */
export const MODMAIL_KEY_BYTES = 32;
/** GCM's standard 96-bit nonce. */
const NONCE_BYTES = 12;
/** GCM's full 128-bit tag; shorter tags are never accepted. */
const TAG_BYTES = 16;
/** The AAD's first field: changing the format means a new version, never a reinterpretation. */
const AAD_VERSION = "tarubot-modmail-v1";
/** The HMAC message the key ID is derived from. */
const KEY_ID_LABEL = "tarubot modmail key id";

/**
 * Standard base64 for exactly 32 bytes, as `openssl rand -base64 32` prints it: 43 characters and
 * one `=`. Nothing else is accepted (no URL-safe alphabet, no whitespace), so a value pasted with a
 * stray character is reported as invalid rather than quietly decoded into another key.
 */
const KEY_FORMAT = /^[A-Za-z0-9+/]{43}=$/u;

/** A key ID as stored: 16 lowercase hex characters (the migration's CHECK). */
export const KEY_ID_FORMAT = /^[0-9a-f]{16}$/u;

/** What an encrypted field becomes: the bytes to store and the key that wrote them. */
export interface Sealed {
  readonly data: Buffer;
  readonly keyId: string;
}

/** The case a field belongs to: bound into every field's AAD. */
export interface CaseBinding {
  readonly guildId: string;
  readonly caseId: string;
  readonly openerId: string;
}

/** A message row's authorship, as stored: bound into its body's AAD. */
export interface MessageBinding {
  readonly id: string;
  readonly authorId: string;
  readonly side: "member" | "officer";
  readonly signedAs: "name" | "officers" | null;
  readonly kind: "message" | "closed" | "reopened";
}

/** Which field of a case a ciphertext belongs to: its topic, or one message's body. */
export type CipherField = { readonly topic: true } | { readonly message: MessageBinding };

/** A Discord or Lodestone snowflake as stored (the external_id domain). */
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/u;
/** A UUID in PostgreSQL's canonical spelling: lowercase, hyphenated. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** One AAD part, checked to be what it claims, so no part can carry the separator. */
function part(value: string, kind: "snowflake" | "uuid" | readonly string[]): string {
  // A UUID is bound in PostgreSQL's spelling whatever case it arrived in, so a row written from
  // a client's uppercase spelling still decrypts once it is read back lowercase.
  const canonical = kind === "uuid" ? value.toLowerCase() : value;
  const ok =
    kind === "snowflake"
      ? SNOWFLAKE.test(canonical)
      : kind === "uuid"
        ? UUID.test(canonical)
        : kind.includes(canonical);
  if (!ok) throw new Error("A mod mail AAD part isn't an ID or a known word.");
  return canonical;
}

/**
 * The AAD for one field of one case: `tarubot-modmail-v1|topic|<guild>|<case>|<opener>`, or
 * `tarubot-modmail-v1|message|<guild>|<case>|<opener>|<message>|<author>|<side>|<signed_as or
 * none>|<kind>`. A part that isn't an ID or a known word throws: that is a bug, never data.
 */
export function fieldAad(binding: CaseBinding, field: CipherField): Buffer {
  const caseParts = [
    part(binding.guildId, "snowflake"),
    part(binding.caseId, "uuid"),
    part(binding.openerId, "snowflake"),
  ];
  const parts =
    "topic" in field
      ? [AAD_VERSION, "topic", ...caseParts]
      : [
          AAD_VERSION,
          "message",
          ...caseParts,
          part(field.message.id, "uuid"),
          part(field.message.authorId, "snowflake"),
          part(field.message.side, ["member", "officer"]),
          // "none" stands for null only: a stored "none" is no signing and is refused.
          field.message.signedAs === null
            ? "none"
            : part(field.message.signedAs, ["name", "officers"]),
          part(field.message.kind, ["message", "closed", "reopened"]),
        ];
  return Buffer.from(parts.join("|"), "utf8");
}

/** How a field's plaintext is padded: a topic to exactly TOPIC_PADDED bytes, a body in blocks. */
export type Padding = "topic" | "message";

/**
 * A topic's padded size: its 100 characters are at most 400 UTF-8 bytes, plus the 0x80 marker,
 * so every topic stores at the same length.
 */
export const TOPIC_PADDED = 512;
/** A body pads to a multiple of this; 4,000 characters fit in at most 63 blocks. */
export const MESSAGE_BLOCK = 256;
/** Bytes a ciphertext adds to its padded plaintext: the nonce and the tag. */
export const SEAL_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** ISO/IEC 7816-4 padding: the text's UTF-8, a 0x80 byte, then zeros to the padded size. */
function pad(text: string, padding: Padding): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const size =
    padding === "topic"
      ? TOPIC_PADDED
      : Math.ceil((bytes.length + 1) / MESSAGE_BLOCK) * MESSAGE_BLOCK;
  if (bytes.length + 1 > size) throw new Error("A mod mail topic is longer than its padded size.");
  const padded = Buffer.alloc(size);
  bytes.copy(padded);
  padded[bytes.length] = 0x80;
  return padded;
}

/** Strict UTF-8: invalid bytes are a failed decryption, never replacement characters. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The text inside 7816-4 padding, or null when the padding or the UTF-8 isn't valid. */
function unpad(padded: Buffer): string | null {
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || padded[end] !== 0x80) return null;
  try {
    return UTF8.decode(padded.subarray(0, end));
  } catch {
    return null;
  }
}

/** The key ID for 32 bytes of key. */
function keyIdOf(key: Buffer): string {
  return createHmac("sha256", key).update(KEY_ID_LABEL, "utf8").digest("hex").slice(0, 16);
}

/**
 * The working cipher for one valid key. Built only by readModMailKey(), which checked the format; the
 * raw bytes are wiped once the KeyObject holds its own copy.
 */
export class ModMailCipher {
  readonly keyId: string;
  readonly #key: KeyObject;

  constructor(raw: Buffer) {
    if (raw.length !== MODMAIL_KEY_BYTES) throw new Error("A mod mail key is 32 bytes.");
    this.keyId = keyIdOf(raw);
    this.#key = createSecretKey(raw);
    raw.fill(0);
  }

  /** Pad `text` (UTF-8) as `padding` says and encrypt it for the field the AAD names. */
  encrypt(text: string, aad: Buffer, padding: Padding): Sealed {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const plain = pad(text, padding);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    plain.fill(0);
    return { data: Buffer.concat([nonce, body, cipher.getAuthTag()]), keyId: this.keyId };
  }

  /**
   * The text, or null when it can't be read with this key: written under another key ID, too
   * short to hold a nonce and tag, failing the tag check (altered bytes, or a row moved to another
   * field, case, server, opener or author, whose AAD differs), or with padding or UTF-8 that
   * isn't valid. Never throws for bad data.
   */
  decrypt(data: Buffer, keyId: string, aad: Buffer): string | null {
    if (keyId !== this.keyId || data.length <= NONCE_BYTES + TAG_BYTES) return null;
    try {
      const nonce = data.subarray(0, NONCE_BYTES);
      const tag = data.subarray(data.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const body = data.subarray(NONCE_BYTES, data.length - TAG_BYTES);
      const padded = Buffer.concat([decipher.update(body), decipher.final()]);
      const text = unpad(padded);
      padded.fill(0);
      return text;
    } catch {
      return null;
    }
  }

  /** Only the key ID, whatever serializes this object (a log line, a report, JSON). */
  toJSON(): { keyId: string } {
    return { keyId: this.keyId };
  }

  /** The same for util.inspect, which Bun and pino use for objects. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ModMailCipher { keyId: '${this.keyId}' }`;
  }
}

/**
 * MODMAIL_KEY, checked once at startup:
 * - off: unset or empty; mod mail is unavailable and officers are told the key isn't set;
 * - invalid: set, but not base64 for exactly 32 bytes; unavailable, and startup reports the
 *   setting's name (never its value);
 * - on: the cipher.
 * Mod mail can't be turned on, /modmail refuses and pages say why unless it is on.
 */
export type ModMailKey =
  | { readonly status: "off" }
  | { readonly status: "invalid" }
  | { readonly status: "on"; readonly cipher: ModMailCipher };

/** Read MODMAIL_KEY's value into a ModMailKey; never throws and never echoes the value. */
export function readModMailKey(value: string | undefined): ModMailKey {
  if (value === undefined || value === "") return { status: "off" };
  if (!KEY_FORMAT.test(value)) return { status: "invalid" };
  const raw = Buffer.from(value, "base64");
  // Canonical spelling only: the last character's two spare bits must be zero, as openssl writes
  // them, so one key has exactly one accepted spelling.
  if (raw.length !== MODMAIL_KEY_BYTES || raw.toString("base64") !== value) {
    raw.fill(0);
    return { status: "invalid" };
  }
  return { status: "on", cipher: new ModMailCipher(raw) };
}

/** The report for an invalid key: the setting and the rule, never the value. */
export const INVALID_KEY_PROBLEM =
  "MODMAIL_KEY is set but isn't base64 for exactly 32 bytes (generate one with openssl rand -base64 32), so mod mail is unavailable.";
