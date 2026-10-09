/**
 * Discord sign-in (#43, ADR D4): the authorize URL, the stateless login cookie, and every refusal
 * the callback decides before calling Discord, against the fake in tests/fixtures/discord-oauth.ts;
 * and (2.40.0) that every exchange, and only an exchange, passes D16's gate. The wire format and
 * Discord's answers are in tests/contract/discord-oauth.test.ts; the gate's own rules are in
 * web-limits.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyFailure } from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";
import {
  DISCORD_AUTHORIZE_URL,
  DISCORD_SCOPE,
  DiscordSignIn,
  type SignInStart,
} from "../../src/web/oauth.js";
import { ExchangeGate } from "../../src/web/limits.js";
import { FakeDiscord } from "../fixtures/discord-oauth.js";

/** Invented application and users. */
const CLIENT = "1400000000000000001";
const SECRET = "invented-Client_Secret-0123456789";
const ORIGIN = "https://tarubot.example.org";
const REDIRECT = `${ORIGIN}/auth/callback`;
const MEMBER = { id: "940000000000000001" };

function signIn(options: { authorizeUrl?: string; gate?: ExchangeGate } = {}) {
  const discord = new FakeDiscord(CLIENT, SECRET);
  const client = new DiscordSignIn({
    clientId: CLIENT,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetch: discord.fetch,
    ...options,
  });
  return { discord, client };
}

/** The handshake fields a login cookie carries, decoded the way the server never needs to. */
function cookieParts(start: SignInStart) {
  const [state = "", verifier = "", path = ""] = start.loginCookie.split(".");
  return { state, verifier, returnPath: Buffer.from(path, "base64url").toString() };
}

/** The Failure finish() refused with; anything else fails the test. */
async function refusal(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
  }
  throw new Error("finish() succeeded");
}

describe("start", () => {
  test("the authorize URL carries exactly the client, redirect URI, scope, state, S256 challenge and prompt", async () => {
    const { client } = signIn();
    const start = await client.start("/g/1/status");
    const url = start.authorizeUrl;
    expect(`${url.origin}${url.pathname}`).toBe(DISCORD_AUTHORIZE_URL);
    const { state, verifier } = cookieParts(start);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "prompt",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: DISCORD_SCOPE,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "none",
    });
    expect(DISCORD_SCOPE).toBe("identify");
    // 32 random bytes each, as unpadded base64url.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("every start has its own state and verifier; the cookie is cookie-safe", async () => {
    const { client } = signIn();
    const starts = await Promise.all([client.start("/"), client.start("/")]);
    const [a, b] = starts.map(cookieParts);
    expect(a?.state).not.toBe(b?.state);
    expect(a?.verifier).not.toBe(b?.verifier);
    expect(a?.state).not.toBe(a?.verifier);
    for (const { loginCookie } of starts) expect(loginCookie).toMatch(/^[A-Za-z0-9_.-]+$/u);
    // The longest return path still fits one cookie comfortably.
    const long = await client.start(`/${"a".repeat(511)}`);
    expect(cookieParts(long).returnPath).toHaveLength(512);
    expect(long.loginCookie.length).toBeLessThan(800);
  });

  test("the return path is validated before it enters the cookie", async () => {
    const { client } = signIn();
    for (const [input, kept] of [
      ["/g/1/status?x=1#y", "/g/1/status?x=1#y"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["/%2F%2Fevil.example", "/"],
      ["https://evil.example/", "/"],
      ["/g/../..", "/"],
      ["", "/"],
    ] as const)
      expect(cookieParts(await client.start(input)).returnPath).toBe(kept);
  });

  test("only the harness swaps the authorize page", async () => {
    const { client } = signIn({ authorizeUrl: "http://[::1]:5555/oauth2/authorize" });
    const { authorizeUrl } = await client.start("/");
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "http://[::1]:5555/oauth2/authorize",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });
});

describe("finish", () => {
  test("a member signs in and returns to the validated path", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/g/1/status?tab=runs");
    const callback = discord.authorize(start.authorizeUrl, MEMBER);
    expect(await client.finish(callback, start.loginCookie)).toEqual({
      userId: MEMBER.id,
      returnPath: "/g/1/status?tab=runs",
    });
    expect(discord.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://discord.com/api/oauth2/token",
      "GET https://discord.com/api/v10/users/@me",
    ]);
  });

  test("refusals about the callback itself make no request to Discord", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/g/1/status");
    const other = await client.start("/");
    const callback = discord.authorize(start.authorizeUrl, MEMBER);
    const code = callback.searchParams.get("code") ?? "";
    const { state } = cookieParts(start);
    /** The callback URL with these query parameters. */
    const at = (query: string) => new URL(`${REDIRECT}?${query}`);
    const cases: [string, URL, string | undefined][] = [
      ["no login cookie", callback, undefined],
      ["an empty login cookie", callback, ""],
      ["a malformed login cookie", callback, "not.a.cookie"],
      ["a login cookie with a short state", callback, start.loginCookie.slice(1)],
      ["another sign-in's cookie", callback, other.loginCookie],
      ["no state", at(`code=${code}`), start.loginCookie],
      ["an empty state", at(`code=${code}&state=`), start.loginCookie],
      ["a wrong state", at(`code=${code}&state=${"A".repeat(43)}`), start.loginCookie],
      ["a repeated state", at(`code=${code}&state=${state}&state=${state}`), start.loginCookie],
      ["no code", at(`state=${state}`), start.loginCookie],
      ["an empty code", at(`code=&state=${state}`), start.loginCookie],
      ["a repeated code", at(`code=${code}&code=${code}&state=${state}`), start.loginCookie],
      [
        "a foreign issuer",
        at(`code=${code}&state=${state}&iss=https://evil.example`),
        start.loginCookie,
      ],
      ["an implicit-flow token", at(`code=${code}&state=${state}&token=x`), start.loginCookie],
      ["Cancel on Discord", discord.cancel(start.authorizeUrl), start.loginCookie],
      [
        "an error with a wrong state",
        at(`error=access_denied&state=${"B".repeat(43)}`),
        start.loginCookie,
      ],
    ];
    for (const [name, url, cookie] of cases) {
      const failure = await refusal(client.finish(url, cookie));
      expect({ name, code: failure.code }).toEqual({ name, code: "expired" });
    }
    expect(discord.requests).toEqual([]);
    // The real callback still works afterwards: nothing above spent the code.
    expect((await client.finish(callback, start.loginCookie)).userId).toBe(MEMBER.id);
  });

  test("Discord's own issuer in the callback is accepted", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/");
    const callback = discord.authorize(start.authorizeUrl, MEMBER);
    callback.searchParams.set("iss", "https://discord.com");
    expect((await client.finish(callback, start.loginCookie)).userId).toBe(MEMBER.id);
  });

  test("cancelling says so, and a stale callback says to sign in again", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/");
    const cancelled = await refusal(
      client.finish(discord.cancel(start.authorizeUrl), start.loginCookie),
    );
    const stale = await refusal(
      client.finish(discord.authorize(start.authorizeUrl, MEMBER), undefined),
    );
    expect(cancelled.message).toContain("didn't complete the sign-in");
    expect(stale.message).toContain("Sign in again");
    for (const failure of [cancelled, stale]) {
      // Nothing Discord or the URL said is echoed.
      expect(failure.message).not.toContain("denied");
      expect(classifyFailure(failure).category).toBe("stale");
    }
  });

  test("a code works once: a replayed callback is refused by Discord as expired", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/");
    const callback = discord.authorize(start.authorizeUrl, MEMBER);
    await client.finish(callback, start.loginCookie);
    const replay = await refusal(client.finish(callback, start.loginCookie));
    expect(replay.code).toBe("expired");
    expect(replay.message).toContain("Sign in again");
  });

  test("a bot account is refused as forbidden (human only)", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/");
    const callback = discord.authorize(start.authorizeUrl, { id: "940000000000000009", bot: true });
    const failure = await refusal(client.finish(callback, start.loginCookie));
    expect(failure.code).toBe("forbidden");
    expect(failure.detail).toEqual({ kind: "scope", scope: "human" });
    // bot: false is an ordinary user.
    const human = await client.start("/");
    const ok = discord.authorize(human.authorizeUrl, { id: "940000000000000010", bot: false });
    expect((await client.finish(ok, human.loginCookie)).userId).toBe("940000000000000010");
  });

  test("the access token is used once and kept nowhere", async () => {
    const { discord, client } = signIn();
    const start = await client.start("/");
    const result = await client.finish(
      discord.authorize(start.authorizeUrl, MEMBER),
      start.loginCookie,
    );
    const [token] = discord.issuedTokens;
    if (!token) throw new Error("No token issued");
    // Sent as a Bearer token to /users/@me exactly once, and never revoked.
    expect(
      discord.requests.filter((request) => request.headers.get("authorization")?.includes(token)),
    ).toHaveLength(1);
    expect(discord.requests.some((request) => request.url.includes("revoke"))).toBe(false);
    // Neither the result nor the sign-in object holds it.
    expect(JSON.stringify(result)).not.toContain(token);
    expect(Bun.inspect(client, { depth: 10 })).not.toContain(token);
    expect(Object.keys(result).sort()).toEqual(["returnPath", "userId"]);
  });
});

describe("the exchange gate (D16)", () => {
  test("refusals decided locally don't spend it; each exchange does", async () => {
    const { discord, client } = signIn({ gate: new ExchangeGate({ now: () => 0, limit: 1 }) });
    const start = await client.start("/");
    const callback = discord.authorize(start.authorizeUrl, MEMBER);
    // Stale and cancelled callbacks, as many as anyone sends, cost the gate nothing.
    for (let index = 0; index < 5; index++) {
      expect((await refusal(client.finish(callback, undefined))).code).toBe("expired");
      expect(
        (await refusal(client.finish(discord.cancel(start.authorizeUrl), start.loginCookie))).code,
      ).toBe("expired");
    }
    expect((await client.finish(callback, start.loginCookie)).userId).toBe(MEMBER.id);
    // The one exchange this minute is spent: the next is refused before Discord is asked.
    const next = await client.start("/");
    const asked = discord.requests.length;
    const busy = await refusal(
      client.finish(discord.authorize(next.authorizeUrl, MEMBER), next.loginCookie),
    );
    expect({ code: busy.code, retryAfter: busy.retryAfter }).toEqual({
      code: "unavailable",
      retryAfter: 60,
    });
    expect(discord.requests).toHaveLength(asked);
  });

  test("a 429 from /users/@me pauses sign-ins like one from the token endpoint", async () => {
    const clock = { now: 0 };
    const { discord, client } = signIn({ gate: new ExchangeGate({ now: () => clock.now }) });
    discord.userAnswer = () =>
      Response.json({ message: "rl" }, { status: 429, headers: { "retry-after": "12" } });
    const first = await client.start("/");
    const limited = await refusal(
      client.finish(discord.authorize(first.authorizeUrl, MEMBER), first.loginCookie),
    );
    expect({ code: limited.code, retryAfter: limited.retryAfter }).toEqual({
      code: "unavailable",
      retryAfter: 12,
    });
    discord.userAnswer = undefined;
    const second = await client.start("/");
    const asked = discord.requests.length;
    const paused = await refusal(
      client.finish(discord.authorize(second.authorizeUrl, MEMBER), second.loginCookie),
    );
    expect(paused.retryAfter).toBe(12);
    expect(discord.requests).toHaveLength(asked);
    clock.now += 12_000;
    const third = await client.start("/");
    expect(
      (await client.finish(discord.authorize(third.authorizeUrl, MEMBER), third.loginCookie))
        .userId,
    ).toBe(MEMBER.id);
  });
});
