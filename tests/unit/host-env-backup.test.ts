/**
 * The host `.env` backup tool (2.23.0): argument parsing, setting names without values, the
 * required settings, file naming and the recipients file. The SSH read and age encryption are
 * exercised on the operator machine (verification evidence remains in Git history).
 */
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  backupName,
  checkSettings,
  MISSING_HOST,
  parseArgs,
  type Runner,
  recipients,
  settingNames,
  writeBackup,
} from "../../scripts/host-env-backup.js";

test("arguments need the host and default to the operator's backup folder", () => {
  expect(parseArgs(["--host", "tarubot@prod"], "/home/op")).toEqual({
    host: "tarubot@prod",
    out: "/home/op/tarubot-cutover/env-backups",
    identity: null,
  });
  expect(parseArgs(["--host", "tarubot@new", "--identity", "/k/key.txt"], "/h")).toMatchObject({
    host: "tarubot@new",
    identity: "/k/key.txt",
  });
  // There is no default host: without --host the run stops before any SSH read or file write,
  // with a message naming the flag.
  expect(() => parseArgs([], "/home/op")).toThrow(MISSING_HOST);
  expect(() => parseArgs(["--identity", "/k/key.txt"])).toThrow("--host USER@HOST");
  expect(() => parseArgs(["--host"])).toThrow("--host needs a value");
  expect(() => parseArgs(["--hots", "x"])).toThrow("Unknown argument --hots");
  expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
  expect(() => parseArgs(["--out", "--host"])).toThrow("--out needs a value");
});

test("setting names are read without values, skipping every line of a quoted value", () => {
  const env = [
    "LOG_LEVEL=info",
    'DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----',
    // A base64 line inside the value that looks like a setting must not be reported.
    "MIIDSECRETLOOKINGLINE=",
    '-----END CERTIFICATE-----"',
    "DISCORD_TOKEN=abc.def.ghi",
    "SINGLE='first line",
    "LEAKED_TOO=still inside the single-quoted value",
    "last line'",
    'ESCAPED="a \\" quote, still open',
    "HIDDEN=inside",
    '"',
    'ONE_LINE="closed on its own line"',
    "# a comment",
    "lowercase=ignored",
    "DATABASE_URL=postgresql://x",
  ].join("\n");
  expect(settingNames(env)).toEqual([
    "LOG_LEVEL",
    "DATABASE_CA_CERT",
    "DISCORD_TOKEN",
    "SINGLE",
    "ESCAPED",
    "ONE_LINE",
    "DATABASE_URL",
  ]);
});

test("a .env missing a setting production needs is refused by name", () => {
  const complete = ["DISCORD_APPLICATION_ID", "DATABASE_URL", "DATABASE_CA_CERT", "DISCORD_TOKEN"];
  const expected = [
    "GITHUB_REPORTS_TOKEN",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "HEALTHCHECKS_PING_URL",
    "BACKUP_STORAGE_ENDPOINT",
    "BACKUP_STORAGE_ACCESS_KEY",
    "BACKUP_STORAGE_SECRET_KEY",
    "BACKUP_STORAGE_REGION",
    "HEALTHCHECKS_BACKUP_URL",
  ];
  // Absent expected settings are reported, not refused.
  expect(checkSettings(complete)).toEqual(expected);
  expect(checkSettings([...complete, ...expected])).toEqual([]);
  expect(() => checkSettings(["DISCORD_APPLICATION_ID", "DATABASE_URL"])).toThrow(
    "lacks DATABASE_CA_CERT, DISCORD_TOKEN",
  );
});

test("copies are named by UTC time, so they sort in order", () => {
  expect(backupName(new Date("2026-09-25T12:34:56.789Z"))).toBe("tarubot-env-20260925T123456Z.age");
});

test("the recipients file must hold age public keys, with comments allowed", () => {
  const key = `age1${"q".repeat(58)}`;
  expect(recipients(`# the operator's key\n${key}\n\n`)).toEqual([key]);
  expect(() => recipients("# nothing yet\n")).toThrow("age public keys");
  expect(() => recipients("AGE-SECRET-KEY-1ABC\n")).toThrow("age public keys");
});

test("the committed recipients file holds a valid age public key", async () => {
  const text = await Bun.file(new URL("../../ops/age-recipients.txt", import.meta.url)).text();
  expect(recipients(text).length).toBeGreaterThan(0);
  // A private key must never be committed.
  expect(text).not.toContain("AGE-SECRET-KEY");
});

/** A scripted age: encryption writes `ciphertext` to --output, decryption returns `decrypts`. */
function fakeAge(decrypts: Uint8Array | Error, ciphertext = "age-encryption.org/v1 …"): Runner {
  return async (command) => {
    if (command.includes("--encrypt")) {
      const output = command[command.indexOf("--output") + 1] ?? "";
      await Bun.write(output, ciphertext);
      return new Uint8Array();
    }
    if (decrypts instanceof Error) throw decrypts;
    return decrypts;
  };
}

test("a copy gets its final name only after it decrypts to what was read", async () => {
  const directory = await mkdtemp(`${tmpdir()}/env-backup-test-`);
  const plain = new TextEncoder().encode("LOG_LEVEL=info\n");
  const base = { plain, recipientsFile: "/r.txt" };
  try {
    // Verified: the final file exists, and the temporary one is gone.
    const good = `${directory}/tarubot-env-20260925T000001Z.age`;
    expect(
      await writeBackup({ ...base, file: good, identity: "/k", runner: fakeAge(plain) }),
    ).toMatchObject({ verified: true });
    expect(await readdir(directory)).toEqual(["tarubot-env-20260925T000001Z.age"]);
    // Decrypting to something else, or not at all: nothing new is left behind for a restore to pick.
    const mismatch = `${directory}/tarubot-env-20260925T000002Z.age`;
    await expect(
      writeBackup({
        ...base,
        file: mismatch,
        identity: "/k",
        runner: fakeAge(new TextEncoder().encode("other")),
      }),
    ).rejects.toThrow("did not decrypt");
    const failed = `${directory}/tarubot-env-20260925T000003Z.age`;
    await expect(
      writeBackup({
        ...base,
        file: failed,
        identity: "/stale",
        runner: fakeAge(new Error("age failed (1).")),
      }),
    ).rejects.toThrow("age failed");
    expect(await readdir(directory)).toEqual(["tarubot-env-20260925T000001Z.age"]);
    // Without an identity the copy is kept unverified.
    const unverified = `${directory}/tarubot-env-20260925T000004Z.age`;
    expect(
      await writeBackup({ ...base, file: unverified, identity: null, runner: fakeAge(plain) }),
    ).toMatchObject({ verified: null });
    expect((await readdir(directory)).sort()).toEqual([
      "tarubot-env-20260925T000001Z.age",
      "tarubot-env-20260925T000004Z.age",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
