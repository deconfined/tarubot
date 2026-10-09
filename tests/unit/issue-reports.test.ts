/**
 * Issue-report helpers (2.18.0): credentials never reach a report, fingerprints group the same
 * trouble, stacks keep first-party frames, and bodies stay within GitHub's limits and Markdown.
 */
import { describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import {
  IssueReports,
  stackWithoutParams,
  withoutParams,
} from "../../src/application/issue-reports.js";
import { RecentLogs } from "../../src/application/recent-logs.js";
import { configuration } from "../../src/config/env.js";
import {
  BODY_LIMIT,
  bounded,
  details,
  duration,
  fenced,
  fields,
  fingerprint,
  firstPartyFrames,
  logLines,
  redact,
  table,
  when,
  yesNo,
} from "../../src/domain/reports.js";
import type { Database } from "../../src/infrastructure/postgres/database.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";

describe("redact", () => {
  test("removes every credential shape a report could carry", () => {
    // Token-shaped samples are assembled at runtime, so secret scanners never see a literal one.
    const discord = ["MTA0MDM3OTM3MDE1OTc0MzEzOQ", "GaBcDe", "a".repeat(38)].join(".");
    const fineGrained = ["github", "pat", "11TESTONLY0000000000000", "notARealTokenForTests"].join(
      "_",
    );
    const classic = ["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_");
    const text = [
      `token ${discord}`,
      fineGrained,
      classic,
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "postgresql://tarubot:s3cr3t-pass@db.example:27520/tarubot",
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
    ].join("\n");
    const clean = redact(text);
    for (const secret of [
      discord,
      fineGrained,
      classic,
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "s3cr3t-pass",
      "MIIBszCCAVmgAwIBAgIU",
    ])
      expect(clean).not.toContain(secret);
    // What surrounds a secret stays readable.
    expect(clean).toContain("@db.example:27520/tarubot");
  });

  test("removes this deployment's own secret values in any shape", () => {
    expect(redact("the value was hunter2hunter2 all along", ["hunter2hunter2"])).toBe(
      "the value was [secret redacted] all along",
    );
    // Short values would erase ordinary words, so they are left to the patterns.
    expect(redact("ok", ["ok"])).toBe("ok");
  });

  test("the web sign-in's client secret is one of this deployment's secrets (#43)", () => {
    // Assembled at runtime, like the token samples above; an invented value.
    const secret = ["invented", "Client", "Secret", "0123456789"].join("_");
    /** The secret values a reporter built from these settings removes. */
    const secrets = (extra: Record<string, string | undefined>) => {
      const reports = new IssueReports(
        configuration({
          DATABASE_URL: "postgresql://tarubot:invented-password@db.example:5432/tarubot",
          DISCORD_TOKEN: "invented-discord-token-value",
          DISCORD_APPLICATION_ID: "1400000000000000001",
          ...extra,
        }),
        // The constructor reads only the configuration.
        null as unknown as Database,
        null as unknown as Lodestone,
        new RecentLogs(),
        null,
      );
      return (reports as unknown as { secrets: string[] }).secrets;
    };
    const configured = secrets({ DISCORD_CLIENT_SECRET: secret });
    expect(configured).toContain(secret);
    // Its shape matches no pattern, so only the configured value removes it.
    expect(redact(`Discord refused ${secret} today`)).toContain(secret);
    expect(redact(`Discord refused ${secret} today`, configured)).toBe(
      "Discord refused [secret redacted] today",
    );
    // Unset or empty (the web off) adds no value.
    for (const value of [undefined, ""])
      expect(secrets({ DISCORD_CLIENT_SECRET: value })).toEqual(secrets({}));
  });
});

test("fingerprints are stable, and differ when any part differs", () => {
  expect(fingerprint("job", "profile", "unavailable")).toBe(
    fingerprint("job", "profile", "unavailable"),
  );
  expect(fingerprint("job", "profile", "unavailable")).not.toBe(
    fingerprint("job", "roster", "unavailable"),
  );
  // Parts are separated, so shifting text between them changes the fingerprint.
  expect(fingerprint("ab", "c")).not.toBe(fingerprint("a", "bc"));
  expect(fingerprint("x")).toMatch(/^[0-9a-f]{16}$/u);
});

test("stacks keep first-party frames with repository-relative paths", () => {
  const stack = [
    "TypeError: boom",
    "    at handler (/app/dist/src/jobs/dispatch.js:88:11)",
    "    at wrap (/app/node_modules/pg/lib/client.js:10:2)",
    "    at run (/home/someone/src/tarubot/src/application/service.ts:120:5)",
    "    at native",
  ].join("\n");
  expect(firstPartyFrames(stack)).toEqual([
    "at handler (dist/src/jobs/dispatch.js:88:11)",
    "at run (src/application/service.ts:120:5)",
  ]);
  expect(firstPartyFrames(undefined)).toEqual([]);
});

test("bodies are bounded, fenced text can't close its block, and tables escape cells", () => {
  const long = "x".repeat(BODY_LIMIT + 5);
  expect(bounded(long)).toContain("5 more characters cut");
  expect(bounded("short")).toBe("short");
  expect(fenced("a ``` b", "text")).toBe("```text\na ʼʼʼ b\n```");
  expect(details("Logs", "line")).toBe("<details><summary>Logs</summary>\n\nline\n\n</details>");
  expect(table(["A", "B"], [["x|y", null]])).toBe("| A | B |\n| --- | --- |\n| x\\|y | — |");
});

test("recent logs keep the newest records within their capacity", () => {
  const logs = new RecentLogs(3);
  for (const line of ["1\n", "2\n", "3\n", "4\n"]) logs.write(line);
  expect(logs.recent()).toEqual(["2", "3", "4"]);
  expect(logs.recent(2)).toEqual(["3", "4"]);
});

test("single records are two-column tables with readable times, durations and yes/no (2.18.1)", () => {
  expect(
    fields([
      ["Ready", "yes"],
      ["Skipped", undefined],
    ]),
  ).toBe("| Field | Value |\n| --- | --- |\n| Ready | yes |");
  expect(fields([["A", 1]], ["Server", "Value"])).toStartWith("| Server | Value |");
  expect(when(new Date("2026-09-25T03:07:37.378Z"))).toBe("2026-09-25 03:07:37 UTC");
  expect(when(null)).toBe("—");
  expect([yesNo(true), yesNo(false), yesNo(undefined)]).toEqual(["yes", "no", "—"]);
  expect([
    duration(45),
    duration(720),
    duration(13203.6),
    duration(200000),
    duration(Number.NaN),
  ]).toEqual(["45 s", "12 min", "3.7 h", "2.3 d", "—"]);
});

test("log records become readable lines without routine or per-process noise (2.18.1)", () => {
  expect(
    logLines([
      '{"level":30,"time":1790305657380,"pid":1,"hostname":"h","commands":20,"msg":"Modules loaded"}',
      '{"level":30,"time":1790305688189,"pid":1,"hostname":"h","metrics":{"pending":0},"msg":"Capability status"}',
      '{"level":40,"time":1790305690000,"pid":1,"hostname":"h","detail":{"code":"x"},"msg":"Retrying"}',
      "not json",
    ]),
  ).toEqual([
    "03:07:37 INFO Modules loaded · commands=20",
    '03:08:10 WARN Retrying · detail={"code":"x"}',
    "not json",
  ]);
});

test("the recent-log buffer keeps useful records through a long quiet stretch (2.18.1 review)", () => {
  // Two hours of 30-second Capability status records must not push out the one useful record.
  const logs = new RecentLogs(60);
  logs.write('{"level":40,"time":1790305690000,"msg":"Retrying"}');
  for (let index = 0; index < 240; index++)
    logs.write(`{"level":30,"time":${1790305700000 + index * 30000},"msg":"Capability status"}`);
  expect(logs.recent()).toEqual(['{"level":40,"time":1790305690000,"msg":"Retrying"}']);
});

test("a failed query's bound values never reach a report, only its SQL (2.39.0)", () => {
  // A self-service role choice's payload: role IDs that can reveal pronouns or gender identity.
  const params = [
    '{"chosen":["523456789012345601"],"offered":["523456789012345601"]}',
    "roles.self",
  ];
  const error = new DrizzleQueryError(
    'insert into "jobs" ("payload", "kind") values ($1, $2)',
    params,
    new Error("connection terminated"),
  );
  const message = withoutParams(error.message);
  expect(message).toBe(
    'Failed query: insert into "jobs" ("payload", "kind") values ($1, $2)\nparams: (left out of reports)',
  );
  expect(message).not.toContain("523456789012345601");
  // The stack repeats the message before its frames: the frames stay, the values go.
  const stack = stackWithoutParams(error.stack ?? "", error.message);
  expect(stack).not.toContain("523456789012345601");
  expect(stack).toContain("params: (left out of reports)");
  expect(stack.split("\n").some((line) => /^\s+at\s/u.test(line))).toBeTrue();
  // A value that spans lines is removed whole.
  expect(withoutParams("Failed query: select $1\nparams: a\nb")).toBe(
    "Failed query: select $1\nparams: (left out of reports)",
  );
  // A stack that no longer holds its message keeps only the lines indented like frames.
  expect(
    stackWithoutParams(
      "Failed query: select $1\nparams: a\nb\n    at run (src/x.ts:1:1)",
      "changed since",
    ),
  ).toBe("Failed query: select $1\nparams: (left out of reports)\n    at run (src/x.ts:1:1)");
  // Text without parameters is unchanged.
  expect(withoutParams("TypeError: boom")).toBe("TypeError: boom");
  expect(stackWithoutParams("TypeError: boom\n    at run (src/x.ts:1:1)", "TypeError: boom")).toBe(
    "TypeError: boom\n    at run (src/x.ts:1:1)",
  );
});

test("a bound value that looks like a stack frame reaches neither the message nor the stack (2.39.0)", () => {
  // Typed text, as /suggest, /issue and guest answers bind it: a line shaped like a real frame.
  const error = new DrizzleQueryError(
    'insert into "suggestions" ("text") values ($1)',
    ["x\n    at y (/src/z.ts:1:1)\nsecret"],
    new Error("connection terminated"),
  );
  const message = withoutParams(error.message);
  expect(message).toBe(
    'Failed query: insert into "suggestions" ("text") values ($1)\nparams: (left out of reports)',
  );
  const stack = stackWithoutParams(error.stack ?? "", error.message);
  for (const text of [message, stack, ...firstPartyFrames(stack)]) {
    expect(text).not.toContain("secret");
    expect(text).not.toContain("z.ts");
  }
  // The real frames are still there.
  expect(stack).toMatch(/^\s{4}at .*issue-reports\.test\.ts/mu);
  // A "$&" in a value is text, never a replacement pattern.
  const dollar = new DrizzleQueryError("select $1", ["$&$`$'"], new Error("x"));
  expect(stackWithoutParams(dollar.stack ?? "", dollar.message)).not.toContain("$&");
});
