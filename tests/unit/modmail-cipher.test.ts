/**
 * Mod mail's encryption (2.43.0): AES-256-GCM with a fresh nonce per field, 7816-4 padding to
 * fixed buckets, the AAD binding each ciphertext to its server, case, opener and (for a body) its
 * authorship, the key ID, and MODMAIL_KEY's format. Keys are
 * computed from readable text (sha256 of a phrase), never written as random-looking literals.
 */
import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { inspect } from "node:util";
import {
  type CaseBinding,
  fieldAad,
  INVALID_KEY_PROBLEM,
  KEY_ID_FORMAT,
  MESSAGE_BLOCK,
  type MessageBinding,
  type ModMailCipher,
  readModMailKey,
  SEAL_OVERHEAD,
  TOPIC_PADDED,
} from "../../src/infrastructure/modmail/cipher.js";

/** A valid MODMAIL_KEY value derived from a phrase. */
const keyText = (phrase: string): string =>
  createHash("sha256").update(phrase).digest().toString("base64");

/**
 * The same 32 bytes spelled with the last base64 character's two spare bits set: Node decodes it
 * to the same key, so only a canonical-spelling check refuses it.
 */
function nonCanonical(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = value.at(-2) ?? "A";
  return `${value.slice(0, -2)}${alphabet[alphabet.indexOf(last) | 1]}=`;
}

/** The cipher for a phrase's key. */
function cipherFor(phrase: string): ModMailCipher {
  const key = readModMailKey(keyText(phrase));
  if (key.status !== "on") throw new Error("expected a valid key");
  return key.cipher;
}

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const CASE = "00000000-0000-4000-8000-000000000001";
const OTHER_CASE = "00000000-0000-4000-8000-000000000002";
const MESSAGE = "00000000-0000-4000-8000-000000000011";
const OTHER_MESSAGE = "00000000-0000-4000-8000-000000000012";
const OPENER = "200000000000000002";
const OTHER_OPENER = "200000000000000003";
const OFFICER = "200000000000000001";
const OTHER_OFFICER = "200000000000000011";

describe("MODMAIL_KEY", () => {
  test("unset and empty are off", () => {
    expect(readModMailKey(undefined)).toEqual({ status: "off" });
    expect(readModMailKey("")).toEqual({ status: "off" });
  });

  test("openssl rand -base64 32's shape is accepted", () => {
    const value = keyText("test modmail key");
    expect(value).toHaveLength(44);
    expect(readModMailKey(value).status).toBe("on");
  });

  test("anything but standard base64 for exactly 32 bytes is invalid", () => {
    const good = keyText("test modmail key");
    const bad = [
      good.slice(0, -1), // no padding
      `${good}\n`, // a trailing newline
      ` ${good}`, // a leading space
      good.replace(/\+/gu, "-").replace(/\//gu, "_"), // URL-safe alphabet (when it differs)
      createHash("sha256").update("short").digest().subarray(0, 16).toString("base64"), // 16 bytes
      createHash("sha512").update("long").digest().toString("base64"), // 64 bytes
      "not a key at all",
      "=".repeat(44),
      // A non-canonical spelling of the same key: the last character's spare bits set.
      nonCanonical(good),
    ].filter((value) => value !== good);
    for (const value of bad)
      expect({ value, status: readModMailKey(value).status }).toEqual({ value, status: "invalid" });
  });

  test("the invalid-key problem names the setting and never a value", () => {
    expect(INVALID_KEY_PROBLEM).toContain("MODMAIL_KEY");
    expect(INVALID_KEY_PROBLEM).not.toContain(keyText("test modmail key"));
  });

  test("the key ID is 16 hex characters of an HMAC of the key, stable and key-specific", () => {
    const one = cipherFor("test modmail key");
    expect(one.keyId).toMatch(KEY_ID_FORMAT);
    expect(cipherFor("test modmail key").keyId).toBe(one.keyId);
    expect(cipherFor("another modmail key").keyId).not.toBe(one.keyId);
    const raw = createHash("sha256").update("test modmail key").digest();
    const expected = createHash("sha256"); // not the HMAC: the ID must not be a plain hash
    expect(one.keyId).not.toBe(expected.update(raw).digest("hex").slice(0, 16));
  });

  test("the cipher never shows its key when serialized or inspected", () => {
    const value = keyText("test modmail key");
    const cipher = cipherFor("test modmail key");
    const raw = createHash("sha256").update("test modmail key").digest();
    for (const shown of [JSON.stringify(cipher), inspect(cipher), String(Bun.inspect(cipher))]) {
      expect(shown).toContain(cipher.keyId);
      expect(shown).not.toContain(value);
      expect(shown).not.toContain(raw.toString("hex"));
    }
  });
});

describe("encryption", () => {
  const cipher = cipherFor("test modmail key");
  const binding: CaseBinding = { guildId: GUILD, caseId: CASE, openerId: OPENER };
  const author: MessageBinding = {
    id: MESSAGE,
    authorId: OFFICER,
    side: "officer",
    signedAs: "officers",
    kind: "message",
  };
  const topic = fieldAad(binding, { topic: true });
  const message = fieldAad(binding, { message: author });

  test("the AAD names the version, field, server, case, opener and, for a body, its authorship", () => {
    expect(topic.toString()).toBe(`tarubot-modmail-v1|topic|${GUILD}|${CASE}|${OPENER}`);
    expect(message.toString()).toBe(
      `tarubot-modmail-v1|message|${GUILD}|${CASE}|${OPENER}|${MESSAGE}|${OFFICER}|officer|officers|message`,
    );
    expect(
      fieldAad(binding, { message: { ...author, side: "member", signedAs: null } }).toString(),
    ).toEndWith("|member|none|message");
  });

  test("UUIDs bind in PostgreSQL's lowercase spelling, whatever case they arrive in", () => {
    const upper = { ...binding, caseId: CASE.toUpperCase() };
    expect(fieldAad(upper, { message: { ...author, id: MESSAGE.toUpperCase() } })).toEqual(message);
    // So text sealed from a client's uppercase spelling opens once read back lowercase.
    const sealed = cipher.encrypt(
      "spelled in capitals",
      fieldAad(upper, { message: { ...author, id: MESSAGE.toUpperCase() } }),
      "message",
    );
    expect(cipher.decrypt(sealed.data, sealed.keyId, message)).toBe("spelled in capitals");
  });

  test("a part that isn't an ID or a known word can't reach the AAD, so no part holds the separator", () => {
    for (const bad of [
      { ...binding, guildId: "1|2" },
      { ...binding, caseId: "not-a-uuid" },
      { ...binding, openerId: "" },
      { ...binding, openerId: "0123" },
    ])
      expect(() => fieldAad(bad, { topic: true })).toThrow();
    for (const bad of [
      { ...author, id: `${MESSAGE}|x` },
      { ...author, authorId: "x" },
      { ...author, side: "system" as "member" },
      { ...author, signedAs: "none" as "name" },
      { ...author, kind: "edited" as "message" },
    ])
      expect(() => fieldAad(binding, { message: bad })).toThrow();
  });

  test("round trip, with Unicode, line breaks and the full 4,000 characters", () => {
    for (const text of [
      "Hello officers",
      "Línea 1\nLínea 2 — 🙂 ありがとう",
      "x".repeat(4000),
      "🙂".repeat(4000),
    ]) {
      const sealed = cipher.encrypt(text, message, "message");
      expect(sealed.keyId).toBe(cipher.keyId);
      expect(cipher.decrypt(sealed.data, sealed.keyId, message)).toBe(text);
    }
    const longest = "🙂".repeat(100);
    const sealedTopic = cipher.encrypt(longest, topic, "topic");
    expect(cipher.decrypt(sealedTopic.data, sealedTopic.keyId, topic)).toBe(longest);
  });

  test("padding: every topic stores at one length, bodies in 256-byte blocks; no plaintext in the bytes", () => {
    const text = "canary-plaintext-7c1e";
    for (const short of ["a", text, "🙂".repeat(100)])
      expect(cipher.encrypt(short, topic, "topic").data.length).toBe(SEAL_OVERHEAD + TOPIC_PADDED);
    const lengths = ["a", "b".repeat(200), "c".repeat(255)].map(
      (body) => cipher.encrypt(body, message, "message").data.length,
    );
    expect(lengths).toEqual([SEAL_OVERHEAD + 256, SEAL_OVERHEAD + 256, SEAL_OVERHEAD + 256]);
    // 256 bytes of text need the marker in a second block.
    expect(cipher.encrypt("d".repeat(256), message, "message").data.length).toBe(
      SEAL_OVERHEAD + 512,
    );
    expect(cipher.encrypt("🙂".repeat(4000), message, "message").data.length).toBe(
      SEAL_OVERHEAD + 63 * MESSAGE_BLOCK,
    );
    expect(TOPIC_PADDED % MESSAGE_BLOCK).toBe(0);
    expect(cipher.encrypt(text, message, "message").data.includes(Buffer.from(text))).toBe(false);
    // A topic longer than its padded size is a bug, refused rather than stored at another length.
    expect(() => cipher.encrypt("e".repeat(TOPIC_PADDED), topic, "topic")).toThrow();
  });

  test("bad padding or bad UTF-8 inside a valid ciphertext reads as unreadable, never a throw", () => {
    // Seal raw plaintext with the same key and AAD, bypassing the padding, through node:crypto.
    const raw = createHash("sha256").update("test modmail key").digest();
    const sealRaw = (plain: Buffer): Buffer => {
      const nonce = Buffer.alloc(12, 7);
      const gcm = createCipheriv("aes-256-gcm", raw, nonce, { authTagLength: 16 });
      gcm.setAAD(message);
      const body = Buffer.concat([gcm.update(plain), gcm.final()]);
      return Buffer.concat([nonce, body, gcm.getAuthTag()]);
    };
    const block = (bytes: number[]) => {
      const padded = Buffer.alloc(256);
      Buffer.from(bytes).copy(padded);
      return padded;
    };
    for (const plain of [
      Buffer.alloc(256), // all zeros: no marker
      block([0x68, 0x69, 0x01]), // ends in 0x01, not 0x80
      block([0xff, 0xfe, 0x80]), // a valid marker after bytes that aren't UTF-8
    ])
      expect(cipher.decrypt(sealRaw(plain), cipher.keyId, message)).toBeNull();
    // The same path accepts well-formed padding, so the checks above test the padding alone.
    expect(cipher.decrypt(sealRaw(block([0x68, 0x69, 0x80])), cipher.keyId, message)).toBe("hi");
  });

  test("a fresh nonce per field: the same text never gives the same bytes", () => {
    const first = cipher.encrypt("same text", message, "message");
    const second = cipher.encrypt("same text", message, "message");
    expect(first.data.equals(second.data)).toBe(false);
    expect(first.data.subarray(0, 12).equals(second.data.subarray(0, 12))).toBe(false);
  });

  test("AAD binding: moved to another field, message, case, server or opener, it doesn't decrypt", () => {
    const sealed = cipher.encrypt("bound text", message, "message");
    for (const moved of [
      topic,
      fieldAad(binding, { message: { ...author, id: OTHER_MESSAGE } }),
      fieldAad({ ...binding, caseId: OTHER_CASE }, { message: author }),
      fieldAad({ ...binding, guildId: OTHER_GUILD }, { message: author }),
      fieldAad({ ...binding, openerId: OTHER_OPENER }, { message: author }),
    ])
      expect(cipher.decrypt(sealed.data, sealed.keyId, moved)).toBeNull();
    // A topic copied over a message body is refused the same way, and a topic moved to another
    // opener's case too.
    const sealedTopic = cipher.encrypt("a topic", topic, "topic");
    expect(cipher.decrypt(sealedTopic.data, sealedTopic.keyId, message)).toBeNull();
    expect(
      cipher.decrypt(
        sealedTopic.data,
        sealedTopic.keyId,
        fieldAad({ ...binding, openerId: OTHER_OPENER }, { topic: true }),
      ),
    ).toBeNull();
  });

  test("AAD binding: re-attributing a body's author, side, signing or kind makes it unreadable", () => {
    const sealed = cipher.encrypt("written by the officer", message, "message");
    for (const flipped of [
      { ...author, authorId: OTHER_OFFICER },
      { ...author, side: "member" as const },
      { ...author, signedAs: "name" as const },
      { ...author, signedAs: null },
      { ...author, kind: "closed" as const },
    ])
      expect(
        cipher.decrypt(sealed.data, sealed.keyId, fieldAad(binding, { message: flipped })),
      ).toBeNull();
    expect(cipher.decrypt(sealed.data, sealed.keyId, message)).toBe("written by the officer");
  });

  test("another key can't read it, by key ID or by bytes", () => {
    const sealed = cipher.encrypt("secret", message, "message");
    const other = cipherFor("another modmail key");
    expect(other.decrypt(sealed.data, sealed.keyId, message)).toBeNull();
    // Even with the other key's ID claimed, the tag check fails.
    expect(other.decrypt(sealed.data, other.keyId, message)).toBeNull();
  });

  test("tampering with any byte fails the tag check, and short data is refused", () => {
    const sealed = cipher.encrypt("tamper me", message, "message");
    for (const index of [0, 11, 12, sealed.data.length - 17, sealed.data.length - 1]) {
      const altered = Buffer.from(sealed.data);
      altered[index] = (altered[index] ?? 0) ^ 1;
      expect(cipher.decrypt(altered, sealed.keyId, message)).toBeNull();
    }
    expect(cipher.decrypt(sealed.data.subarray(0, 28), sealed.keyId, message)).toBeNull();
    expect(cipher.decrypt(Buffer.alloc(0), sealed.keyId, message)).toBeNull();
    // A truncated tag is never accepted as a shorter one.
    expect(cipher.decrypt(sealed.data.subarray(0, -4), sealed.keyId, message)).toBeNull();
  });
});
