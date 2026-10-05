/**
 * The Discord sign-in's wire contract (#43, ADR D10 spike), against a fake Discord answering through
 * the injected fetch: what the token exchange and /users/@me send, how oauth4webapi 3.8.8's
 * strictness meets Discord-shaped answers (no `iss`, `token_type` "Bearer", a scope string), and
 * how each of Discord's failures becomes a catalog Failure and, through E10, an HTTP status.
 *
 * Spike result: oauth4webapi works with Discord unchanged. The client credentials go in the form
 * body (ClientSecretPost), which Discord's OAuth2 documentation accepts alongside HTTP Basic, so no
 * client-authentication encoding question arises. No fetch fallback.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { project } from "../../src/config/project.js";
import { classifyFailure } from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";
import { FAILURE_STATUS } from "../../src/web/http.js";
import {
  DISCORD_RETRY_FALLBACK_SECONDS,
  DISCORD_TIMEOUT_MS,
  DISCORD_TOKEN_URL,
  DISCORD_USER_URL,
  DiscordSignIn,
  type SignInResult,
} from "../../src/web/oauth.js";
import {
  type DiscordRequest,
  discordOAuthError,
  discordTokenResponse,
  discordUser,
  FakeDiscord,
} from "../fixtures/discord-oauth.js";

/** Invented application credentials; the secret has the "-" and "_" Discord secrets can have. */
const CLIENT = "1400000000000000001";
const SECRET = "Inv3nted-Client_Secret-x9Z_0123456";
const REDIRECT = "https://tarubot.example.org/auth/callback";
const MEMBER = { id: "940000000000000001" };
/** A stand-in access token for answers built by hand; it must never surface anywhere. */
const PLANTED = "planted-access-token-0123456789";

type Answer = (request: DiscordRequest) => Response;

/** One full sign-in against the fake, with optional replacement answers. */
async function attempt(answers: { token?: Answer; user?: Answer } = {}) {
  const discord = new FakeDiscord(CLIENT, SECRET);
  discord.tokenAnswer = answers.token;
  discord.userAnswer = answers.user;
  const client = new DiscordSignIn({
    clientId: CLIENT,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetch: discord.fetch,
  });
  const start = await client.start("/g/1/status");
  const callback = discord.authorize(start.authorizeUrl, MEMBER);
  let result: SignInResult | undefined;
  let error: unknown;
  try {
    result = await client.finish(callback, start.loginCookie);
  } catch (caught) {
    error = caught;
  }
  return { discord, start, callback, result, error };
}

/** The Failure a sign-in ended with, checked for leaks; anything else fails the test. */
async function failure(answers: { token?: Answer; user?: Answer }): Promise<Failure> {
  const { error, discord, callback } = await attempt(answers);
  if (!(error instanceof Failure)) throw new Error(`Expected a Failure, got ${String(error)}`);
  // Only the approved text leaves: no cause, and nothing Discord or the browser sent.
  expect(error.cause).toBeUndefined();
  const shown = `${error.message} ${JSON.stringify(error)} ${Bun.inspect(error)}`;
  for (const secret of [
    SECRET,
    PLANTED,
    ...discord.issuedTokens,
    callback.searchParams.get("code") ?? "",
    "Invalid",
    "rate limited",
  ])
    expect(shown).not.toContain(secret);
  return error;
}

/** The status the error page answers with (E10). */
const status = (error: Failure) => FAILURE_STATUS[classifyFailure(error).category];

/** A JSON answer with any status and headers. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

describe("requests", () => {
  test("the token exchange: exactly the six form fields, credentials included", async () => {
    const { discord, start, callback, result } = await attempt();
    expect(result).toEqual({ userId: MEMBER.id, returnPath: "/g/1/status" });
    const [exchange] = discord.requests;
    if (!exchange) throw new Error("No token request");
    expect(exchange.method).toBe("POST");
    expect(exchange.url).toBe(DISCORD_TOKEN_URL);
    expect(exchange.headers.get("authorization")).toBeNull();
    expect(exchange.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(exchange.headers.get("accept")).toBe("application/json");
    expect(exchange.headers.get("user-agent")).toBe(
      `DiscordBot (${project.url}, ${project.version})`,
    );
    const verifier = start.loginCookie.split(".")[1] ?? "";
    expect(Object.fromEntries(exchange.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CLIENT,
      client_secret: SECRET,
    });
  });

  test("/users/@me: one Bearer GET with the fresh token and no body", async () => {
    const { discord } = await attempt();
    const [, me] = discord.requests;
    expect(me?.method).toBe("GET");
    expect(me?.url).toBe(DISCORD_USER_URL);
    expect(me?.headers.get("authorization")).toBe(`Bearer ${discord.issuedTokens[0]}`);
    expect(me?.headers.get("accept")).toBe("application/json");
    expect(me?.headers.get("user-agent")).toStartWith("DiscordBot (");
    expect(me?.form).toBeNull();
    expect(discord.requests).toHaveLength(2);
  });

  test("a client secret reaches Discord intact whatever its characters", async () => {
    // The form body is URL-encoded and decoded unambiguously, unlike Basic credentials.
    const odd = "a-b_c.d*e~f g+h:i%j";
    const discord = new FakeDiscord(CLIENT, odd);
    const client = new DiscordSignIn({
      clientId: CLIENT,
      clientSecret: odd,
      redirectUri: REDIRECT,
      fetch: discord.fetch,
    });
    const start = await client.start("/");
    const result = await client.finish(
      discord.authorize(start.authorizeUrl, MEMBER),
      start.loginCookie,
    );
    expect(result.userId).toBe(MEMBER.id);
  });

  test("every request carries a deadline", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const discord = new FakeDiscord(CLIENT, SECRET);
    const client = new DiscordSignIn({
      clientId: CLIENT,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      fetch: Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          signals.push(init?.signal);
          return discord.fetch(input, init);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const start = await client.start("/");
    // A signal that never fires would pass the instanceof check, so pin the deadline itself.
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await client.finish(discord.authorize(start.authorizeUrl, MEMBER), start.loginCookie);
      expect(timeout.mock.calls).toEqual([[DISCORD_TIMEOUT_MS], [DISCORD_TIMEOUT_MS]]);
    } finally {
      timeout.mockRestore();
    }
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("oauth4webapi meets Discord's shapes", () => {
  test("no iss, token_type Bearer in any case, a scope string and extra fields are accepted", async () => {
    for (const tokenType of ["Bearer", "bearer", "BEARER"]) {
      const { result } = await attempt({
        token: () =>
          json({
            token_type: tokenType,
            access_token: PLANTED,
            expires_in: 604800,
            refresh_token: "planted-refresh",
            scope: "identify",
            webhook: null,
          }),
        user: () => json(discordUser(MEMBER)),
      });
      expect(result?.userId).toBe(MEMBER.id);
    }
    // The minimum: no expiry, refresh token or scope at all.
    const { result } = await attempt({
      token: () => json({ token_type: "Bearer", access_token: PLANTED }),
      user: () => json(discordUser(MEMBER)),
    });
    expect(result?.userId).toBe(MEMBER.id);
  });

  test("answers that break the token response's rules are refused as invalid", async () => {
    for (const body of [
      { token_type: "mac", access_token: PLANTED },
      { access_token: PLANTED },
      { token_type: "Bearer", access_token: "" },
      { token_type: "Bearer", access_token: 12345 },
      { token_type: "Bearer", access_token: PLANTED, scope: ["identify"] },
      { token_type: "Bearer", access_token: PLANTED, expires_in: -1 },
      { token_type: "Bearer", access_token: PLANTED, refresh_token: 7 },
      [{ token_type: "Bearer", access_token: PLANTED }],
      "just a string",
    ]) {
      const error = await failure({ token: () => json(body) });
      expect({ body, code: error.code }).toEqual({ body, code: "invalid_response" });
      expect(status(error)).toBe(503);
    }
  });

  test("malformed JSON from either endpoint is refused", async () => {
    const broken = (type: string) => () =>
      new Response("{not json", { headers: { "content-type": type } });
    for (const answers of [
      { token: broken("application/json") },
      { token: broken("text/html") },
      { user: broken("application/json") },
      { user: broken("text/html") },
    ]) {
      const error = await failure(answers);
      expect(error.code).toBe("invalid_response");
      expect(status(error)).toBe(503);
    }
  });

  test("/users/@me is read for a valid ID and the bot flag only", async () => {
    for (const body of [
      {},
      { id: 94000001 },
      { id: "0" },
      { id: "abc" },
      { id: "18446744073709551616" },
      { id: MEMBER.id, bot: "true" },
      [discordUser(MEMBER)],
      null,
    ]) {
      const error = await failure({ user: () => json(body) });
      expect({ body, code: error.code }).toEqual({ body, code: "invalid_response" });
    }
    // Everything else Discord sends (names, avatar, locale) is dropped.
    const { result } = await attempt({
      user: () => json({ ...discordUser(MEMBER), email: "invented@example.org" }),
    });
    expect(result).toEqual({ userId: MEMBER.id, returnPath: "/g/1/status" });
  });
});

describe("Discord's failures", () => {
  test("invalid_grant asks the user to sign in again (409), without Discord's text", async () => {
    for (const description of ['Invalid "code" in request.', undefined]) {
      const error = await failure({
        token: () => discordOAuthError(400, "invalid_grant", description),
      });
      expect(error.code).toBe("expired");
      expect(error.message).toBe("That sign-in code expired or was already used. Sign in again.");
      expect(status(error)).toBe(409);
    }
  });

  test("refused client credentials are a configuration fault reported to the operator (500)", async () => {
    for (const answer of [
      () => discordOAuthError(401, "invalid_client"),
      () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Basic realm="discord"',
          },
        }),
    ]) {
      const error = await failure({ token: answer });
      expect(error.code).toBe("configuration");
      expect(error.message).toContain("DISCORD_CLIENT_SECRET");
      expect(classifyFailure(error)).toMatchObject({ category: "unexpected", level: "error" });
      expect(status(error)).toBe(500);
    }
  });

  test("other OAuth errors and odd statuses are invalid answers (503)", async () => {
    for (const answer of [
      () => discordOAuthError(400, "invalid_request", "Missing code"),
      () => discordOAuthError(400, "unsupported_grant_type"),
      () => json({ message: "400: Bad Request", code: 0 }, 400),
      () =>
        new Response("<html>Bad request</html>", {
          status: 400,
          headers: { "content-type": "text/html" },
        }),
      () => new Response(null, { status: 302, headers: { location: "https://discord.com/login" } }),
      () => new Response(null, { status: 204 }),
    ]) {
      const error = await failure({ token: answer });
      expect(error.code).toBe("invalid_response");
      expect(status(error)).toBe(503);
    }
    // On /users/@me a 401 refuses the access token, not the client credentials the exchange just
    // used: the same answer with or without a challenge header, never `configuration`.
    for (const headers of [{}, { "www-authenticate": 'Bearer error="invalid_token"' }]) {
      const unauthorized = await failure({
        user: () => json({ message: "401: Unauthorized", code: 0 }, 401, headers),
      });
      expect({ headers, code: unauthorized.code, status: status(unauthorized) }).toEqual({
        headers,
        code: "invalid_response",
        status: 503,
      });
    }
  });

  test("429 from either endpoint is 503 with Retry-After from Discord's header", async () => {
    const limited = (retry?: string) => () =>
      json(
        { message: "You are being rate limited.", retry_after: 7.25, global: false },
        429,
        retry === undefined ? {} : { "retry-after": retry },
      );
    for (const [retry, seconds] of [
      ["7", 7],
      ["1.5", 2],
      ["0", DISCORD_RETRY_FALLBACK_SECONDS],
      ["soon", DISCORD_RETRY_FALLBACK_SECONDS],
      [undefined, DISCORD_RETRY_FALLBACK_SECONDS],
      ["9999999", 86_400],
    ] as const)
      for (const endpoint of ["token", "user"] as const) {
        const error = await failure({ [endpoint]: limited(retry) });
        expect({ retry, endpoint, code: error.code, after: error.retryAfter }).toEqual({
          retry,
          endpoint,
          code: "unavailable",
          after: seconds,
        });
        expect(status(error)).toBe(503);
        expect(error.retryAfter).toBeGreaterThan(0);
      }
    // oauth4webapi throws on a /users/@me challenge before reading the status; the 429 still wins.
    const challenged = await failure({
      user: () =>
        json({ message: "You are being rate limited." }, 429, {
          "retry-after": "7",
          "www-authenticate": 'Bearer error="invalid_token"',
        }),
    });
    expect({ code: challenged.code, after: challenged.retryAfter }).toEqual({
      code: "unavailable",
      after: 7,
    });
    // An HTTP date counts down from now.
    const date = new Date(Date.now() + 30_000).toUTCString();
    const dated = await failure({ token: limited(date) });
    expect(dated.retryAfter).toBeGreaterThanOrEqual(28);
    expect(dated.retryAfter).toBeLessThanOrEqual(31);
    expect(DISCORD_RETRY_FALLBACK_SECONDS).toBe(60);
  });

  test("Discord's outages and an unreachable Discord are unavailable (503), with no Retry-After", async () => {
    for (const answer of [
      () => json({ message: "500: Internal Server Error", code: 0 }, 500),
      () =>
        new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      () => new Response(null, { status: 503 }),
    ])
      for (const endpoint of ["token", "user"] as const) {
        const error = await failure({ [endpoint]: answer });
        expect(error.code).toBe("unavailable");
        expect(error.retryAfter).toBe(0);
        expect(status(error)).toBe(503);
      }
    const discord = new FakeDiscord(CLIENT, SECRET);
    discord.unreachable = true;
    const client = new DiscordSignIn({
      clientId: CLIENT,
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      fetch: discord.fetch,
    });
    const start = await client.start("/");
    const error = await client
      .finish(discord.authorize(start.authorizeUrl, MEMBER), start.loginCookie)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Failure);
    expect(error).toMatchObject({ code: "unavailable" });
    // The transport's own text ("connection refused") never reaches the page.
    expect((error as Failure).message).not.toContain("refused");
  });

  test("a bot account is refused (403) after Discord answered", async () => {
    const error = await failure({
      user: () => json(discordUser({ id: "940000000000000009", bot: true })),
    });
    expect(error.code).toBe("forbidden");
    expect(error.detail).toEqual({ kind: "scope", scope: "human" });
    expect(status(error)).toBe(403);
  });

  test("a token response carrying the token in an error never leaks it", async () => {
    // oauth4webapi's own errors hold the whole body as their cause, token included.
    const error = await failure({
      token: () => json({ token_type: "unknown", access_token: PLANTED }),
    });
    expect(error.code).toBe("invalid_response");
    // A token Discord's /users/@me doesn't know is refused the same way, and stays unshown.
    const unknown = await failure({ token: () => discordTokenResponse(PLANTED) });
    expect(unknown.code).toBe("invalid_response");
  });
});
