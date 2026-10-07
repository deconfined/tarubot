/**
 * The web's settings (#43, ADR D13): an empty WEB_PUBLIC_ORIGIN keeps the web off; an https origin
 * without a path, or http://localhost / http://[::1] for development, turns it on with the client
 * secret; anything else is a list of problems that name settings and never their values.
 */
import { describe, expect, test } from "bun:test";
import { PATHS } from "../../src/web/http.js";
import {
  DEFAULT_WEB_PORT,
  type WebSettingsInput,
  type WebSettingsResult,
  webSettings,
} from "../../src/web/settings.js";

/** Invented values; the secret is a sentinel no problem text may ever contain. */
const SECRET = "sentinel-Secret_0123456789abcdefgh";
const APPLICATION = "1400000000000000001";
const valid: WebSettingsInput = {
  WEB_PUBLIC_ORIGIN: "https://tarubot.example.org",
  WEB_PORT: "",
  DISCORD_CLIENT_SECRET: SECRET,
  DISCORD_APPLICATION_ID: APPLICATION,
};
const settings = (overrides: Partial<WebSettingsInput>) => webSettings({ ...valid, ...overrides });

/** The problems of an invalid result; any other status fails the test. */
function problems(result: WebSettingsResult): readonly string[] {
  if (result.status !== "invalid")
    throw new Error(`Expected invalid settings, got ${result.status}`);
  return result.problems;
}

/** Each problem names its setting first and contains none of the configured values. */
function namesOnly(found: readonly string[], values: readonly string[]) {
  for (const problem of found) {
    expect(problem).toMatch(/^(WEB_PUBLIC_ORIGIN|WEB_PORT|DISCORD_CLIENT_SECRET): /u);
    for (const value of values) if (value.length > 3) expect(problem).not.toContain(value);
  }
}

describe("off", () => {
  test("an unset or empty origin keeps the web off, whatever else is set", () => {
    for (const origin of [undefined, ""])
      for (const rest of [
        {},
        { DISCORD_CLIENT_SECRET: undefined },
        { WEB_PORT: "not a port" },
        { DISCORD_CLIENT_SECRET: "has spaces in it" },
      ])
        expect(settings({ WEB_PUBLIC_ORIGIN: origin, ...rest })).toEqual({ status: "off" });
  });
});

describe("on", () => {
  test("an https origin gives secure settings and the exact redirect URI", () => {
    expect(webSettings(valid)).toEqual({
      status: "on",
      settings: {
        origin: "https://tarubot.example.org",
        secure: true,
        port: DEFAULT_WEB_PORT,
        clientId: APPLICATION,
        clientSecret: SECRET,
        redirectUri: `https://tarubot.example.org${PATHS.callback}`,
      },
    });
    expect(DEFAULT_WEB_PORT).toBe(8080);
  });

  test("the origin is serialized as browsers send it in Origin, without a trailing slash", () => {
    for (const [input, origin] of [
      ["https://tarubot.example.org/", "https://tarubot.example.org"],
      ["https://tarubot.example.org:8443/", "https://tarubot.example.org:8443"],
      ["https://[2001:db8::1]", "https://[2001:db8::1]"],
    ] as const) {
      const result = settings({ WEB_PUBLIC_ORIGIN: input });
      if (result.status !== "on") throw new Error(`${input} was refused`);
      expect(result.settings.origin).toBe(origin);
      expect(result.settings.redirectUri).toBe(`${origin}/auth/callback`);
      expect(result.settings.secure).toBe(true);
    }
  });

  test("http is only for the loopback development origins, which drop Secure", () => {
    for (const [input, origin] of [
      ["http://localhost", "http://localhost"],
      ["http://localhost:8080", "http://localhost:8080"],
      ["http://localhost:3001/", "http://localhost:3001"],
      ["http://[::1]", "http://[::1]"],
      ["http://[::1]:8080", "http://[::1]:8080"],
    ] as const) {
      const result = settings({ WEB_PUBLIC_ORIGIN: input });
      if (result.status !== "on") throw new Error(`${input} was refused`);
      expect(result.settings).toMatchObject({ origin, secure: false });
    }
  });

  test("WEB_PORT is a whole number from 1 to 65535, 8080 when unset or empty", () => {
    for (const [input, port] of [
      [undefined, 8080],
      ["", 8080],
      ["1", 1],
      ["8081", 8081],
      ["65535", 65535],
    ] as const) {
      const result = settings({ WEB_PORT: input });
      if (result.status !== "on") throw new Error(`${input} was refused`);
      expect(result.settings.port).toBe(port);
    }
  });
});

describe("invalid", () => {
  test("an origin that isn't an allowed origin is refused by name only", () => {
    for (const origin of [
      "tarubot.example.org",
      "https://",
      "https:///tarubot.example.org",
      "https://tarubot.example.org/web",
      "https://tarubot.example.org//",
      "https://tarubot.example.org/?",
      "https://tarubot.example.org?x=1",
      "https://tarubot.example.org#top",
      "https://user:pass@tarubot.example.org",
      "https://user@tarubot.example.org",
      "https://tarubot.example.org\\",
      " https://tarubot.example.org",
      "https://tarubot.example.org\n",
      "https://tarubot.exa mple.org",
      "http://tarubot.example.org",
      "http://127.0.0.1:8080",
      "http://localhost.:8080",
      "http://[::2]:8080",
      "http://192.0.2.10",
      "ftp://tarubot.example.org",
      "javascript:alert(1)",
      "https://tarubot.example.org:99999",
      // Other spellings of an allowed origin: the value must be the form browsers send.
      "HTTPS://TaruBot.Example.ORG",
      "https://tarubot.example.org:443",
      "http://LOCALHOST:3001/",
      "http://[0:0:0:0:0:0:0:1]:8080",
    ]) {
      const found = problems(settings({ WEB_PUBLIC_ORIGIN: origin }));
      expect(found).toHaveLength(1);
      expect(found[0]).toStartWith("WEB_PUBLIC_ORIGIN: ");
      // "https://" alone is also part of the rule's own wording.
      namesOnly(found, origin === "https://" ? [] : [origin.trim(), "tarubot.example"]);
    }
  });

  test("the client secret is required with an origin, and must be one visible token", () => {
    for (const secret of [undefined, ""])
      expect(problems(settings({ DISCORD_CLIENT_SECRET: secret }))).toEqual([
        "DISCORD_CLIENT_SECRET: required when WEB_PUBLIC_ORIGIN is set",
      ]);
    for (const secret of [` ${SECRET}`, `${SECRET}\n`, "sentinel secret value", "sentinelé"]) {
      const found = problems(settings({ DISCORD_CLIENT_SECRET: secret }));
      expect(found).toHaveLength(1);
      expect(found[0]).toStartWith("DISCORD_CLIENT_SECRET: ");
      namesOnly(found, [secret.trim(), "sentinel"]);
    }
  });

  test("a port outside 1-65535, or not plain decimal, is refused by name only", () => {
    for (const port of [
      "0",
      "65536",
      "99999",
      "080",
      "-1",
      "+80",
      "80.0",
      "8e3",
      " 80",
      "0x50",
      "port",
    ]) {
      const found = problems(settings({ WEB_PORT: port }));
      expect(found).toEqual(["WEB_PORT: must be a whole number from 1 to 65535"]);
    }
  });

  test("every problem is reported at once, naming settings and never values", () => {
    const origin = "http://sentinel-host.example.org/sentinel-path";
    const found = problems(
      webSettings({
        WEB_PUBLIC_ORIGIN: origin,
        WEB_PORT: "70000",
        DISCORD_CLIENT_SECRET: "sentinel secret",
        DISCORD_APPLICATION_ID: APPLICATION,
      }),
    );
    expect(found.map((problem) => problem.split(":")[0])).toEqual([
      "WEB_PUBLIC_ORIGIN",
      "DISCORD_CLIENT_SECRET",
      "WEB_PORT",
    ]);
    namesOnly(found, [origin, "sentinel", "70000"]);
  });

  test("parsing never throws, whatever the strings", () => {
    for (const value of [
      "%",
      "\u0000",
      "https://[",
      "https://a:b:c",
      "https://%zz",
      "x".repeat(10_000),
    ])
      expect(() =>
        webSettings({
          WEB_PUBLIC_ORIGIN: value,
          WEB_PORT: value,
          DISCORD_CLIENT_SECRET: value,
          DISCORD_APPLICATION_ID: value,
        }),
      ).not.toThrow();
  });
});
