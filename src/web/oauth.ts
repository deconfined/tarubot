/**
 * Discord sign-in (#43, ADR D4) with oauth4webapi against fixed Discord endpoints: the bot's own
 * application, scope `identify`, a 32-byte `state` plus PKCE S256 (`state` stays mandatory because
 * Discord doesn't document PKCE). The handshake is stateless: one short-lived login cookie carries
 * the state, the verifier and the return path, so anonymous visitors cost no server memory. The
 * access token is used for one GET /users/@me and then dropped: never stored, logged or revoked
 * (revoking would end the user's authorization and bring back the consent screen). With
 * `prompt=none`, a returning user skips Discord's authorization screen.
 *
 * oauth4webapi's strictness suits Discord's answers (tests/contract/discord-oauth.test.ts): the
 * authorization response carries no `iss`, which the library accepts because this metadata doesn't
 * claim support for it; `token_type` "Bearer" is compared case-insensitively; `scope` is a string.
 * The client credentials go in the form body (the library's ClientSecretPost), which Discord's OAuth2
 * documentation accepts alongside HTTP Basic.
 *
 * Every exchange goes through D16's gate (limits.ts's ExchangeGate, 2.40.0): a pause after
 * Discord's 429, a global rate and a concurrency cap, each refusing before any Discord request.
 */
import { timingSafeEqual } from "node:crypto";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { project } from "../config/project.js";
import type { FailureDetail } from "../domain/failures.js";
import { Failure, idSchema } from "../domain/values.js";
import { ExchangeGate } from "./limits.js";
import { safeReturnPath } from "./return-path.js";

/** Discord's issuer and endpoints, fixed in code; only tests can swap the authorize URL. */
export const DISCORD_ISSUER = "https://discord.com";
export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";
/** The only scope requested: the user's ID. Never `guilds`, which lists every server they're in. */
export const DISCORD_SCOPE = "identify";
/**
 * Skip Discord's authorization screen for a user who already authorized this application with
 * DISCORD_SCOPE (owner's choice, #43, 2026-10-05; discord-api-docs#264). The authorization persists
 * because the access token is never revoked. Discord documents `none` only for such returning users;
 * what it does for a first-time user is undocumented, so staging's first sign-in checks it before
 * the web is turned on. Any `error=` it might send ends on the sign-in error page, never in a loop.
 */
export const DISCORD_PROMPT = "none";

/** How long one Discord request (token exchange or /users/@me) may take, body included. */
export const DISCORD_TIMEOUT_MS = 10_000;
/** Retry-After for a 429 that names no usable delay, so the 503 page still tells browsers when. */
export const DISCORD_RETRY_FALLBACK_SECONDS = 60;

/** The start of a sign-in: where to send the browser, and the login cookie to set first. */
export interface SignInStart {
  /**
   * The authorize URL: client_id, redirect_uri, response_type=code, scope, state, the S256
   * code_challenge and prompt=none.
   */
  readonly authorizeUrl: URL;
  /** The login cookie's value (state, verifier, return path), for LOGIN_COOKIE_MAX_AGE seconds. */
  readonly loginCookie: string;
}

/** A finished sign-in: who signed in, and the validated same-origin path to return to. */
export interface SignInResult {
  readonly userId: string;
  readonly returnPath: string;
}

/** What DiscordSignIn needs. */
export interface DiscordSignInOptions {
  /** DISCORD_APPLICATION_ID. */
  readonly clientId: string;
  /** DISCORD_CLIENT_SECRET. */
  readonly clientSecret: string;
  /** WebSettings.redirectUri, exactly `${WEB_PUBLIC_ORIGIN}/auth/callback`. */
  readonly redirectUri: string;
  /**
   * Answers the token and /users/@me requests, which stay https://discord.com URLs; tests and the
   * harness inject a fake (oauth4webapi's customFetch). Defaults to the global fetch.
   */
  readonly fetch?: typeof fetch;
  /** The harness's fake authorize page. Defaults to DISCORD_AUTHORIZE_URL; never a setting. */
  readonly authorizeUrl?: string;
  /**
   * The gate every token exchange passes (D16). Defaults to a new ExchangeGate with production's
   * limits; tests pass one on their own clock. One DiscordSignIn serves the whole web, so one gate
   * covers every sign-in.
   */
  readonly gate?: ExchangeGate;
}

/**
 * The authorization server, fixed rather than discovered: Discord publishes no OAuth metadata
 * document. No `authorization_response_iss_parameter_supported`, because Discord sends no `iss`;
 * one that does arrive must still equal the issuer (validateAuthResponse).
 */
const DISCORD: oauth.AuthorizationServer = {
  issuer: DISCORD_ISSUER,
  authorization_endpoint: DISCORD_AUTHORIZE_URL,
  token_endpoint: DISCORD_TOKEN_URL,
};

/** Discord's API asks every client to name itself this way (DiscordBot (url, version)). */
const USER_AGENT = `DiscordBot (${project.url}, ${project.version})`;

/** A state or PKCE verifier as oauth4webapi makes them: 32 random bytes, unpadded base64url. */
const RANDOM = "[A-Za-z0-9_-]{43}";
/**
 * The login cookie's value: `state.verifier.returnPath`, the path as unpadded base64url. Only
 * cookie-safe characters, so hono/cookie's encoding leaves it as it is.
 */
const LOGIN_VALUE = new RegExp(`^(${RANDOM})\\.(${RANDOM})\\.([A-Za-z0-9_-]+)$`, "u");

/** What the login cookie carries from /login to the callback. */
interface Handshake {
  readonly state: string;
  readonly verifier: string;
  readonly returnPath: string;
}

function encodeHandshake(handshake: Handshake): string {
  const path = Buffer.from(handshake.returnPath).toString("base64url");
  return `${handshake.state}.${handshake.verifier}.${path}`;
}

/**
 * The handshake in a login cookie, or null when it is missing or malformed. The cookie is not
 * signed: it is HttpOnly and set only by this origin (`__Host-` on https), and nothing in it is
 * trusted beyond this sign-in. A forged state can only match a forged callback in the same browser,
 * and the return path is validated again here.
 */
function decodeHandshake(value: string | undefined): Handshake | null {
  const match = value === undefined ? null : LOGIN_VALUE.exec(value);
  if (!match) return null;
  const [, state = "", verifier = "", path = ""] = match;
  return {
    state,
    verifier,
    returnPath: safeReturnPath(Buffer.from(path, "base64url").toString("utf8")),
  };
}

/**
 * Compare the callback's state with the cookie's in constant time, so response timing reveals
 * nothing about the expected value. Lengths differ only for a malformed state, which is no secret.
 */
function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** /users/@me, of which only the ID and the bot flag are read; everything else is dropped. */
const DISCORD_USER = z.object({ id: idSchema, bot: z.boolean().optional() });

/** Upstream failures concern Discord's API, so the page never blames the Lodestone. */
const DISCORD_API: FailureDetail = { kind: "discord", what: "api" };

/** The approved texts the error page shows; none of them echoes anything Discord sent. */
const MESSAGE = {
  stale: "This sign-in expired or didn't start on this page. Sign in again.",
  cancelled: "Discord didn't complete the sign-in, so you aren't signed in. Sign in again.",
  code: "That sign-in code expired or was already used. Sign in again.",
  limited: "Discord is limiting sign-ins right now. Try again in a little while.",
  unavailable: "Discord's sign-in isn't answering right now. Try again in a few minutes.",
  invalid: "Discord's sign-in answered with something TaruBot can't read. Try again later.",
  bot: "Bot accounts can't sign in to TaruBot's pages.",
  // Shown to no one (the unexpected category); it reaches the operator's report.
  client:
    "Discord refused the web sign-in's client credentials: check DISCORD_CLIENT_SECRET against the application's OAuth2 page.",
} as const;

const stale = () => new Failure("expired", MESSAGE.stale);
const unavailable = () => new Failure("unavailable", MESSAGE.unavailable, 0, DISCORD_API);
const invalid = () => new Failure("invalid_response", MESSAGE.invalid, 0, DISCORD_API);

/** Whole seconds from a Retry-After header (delta seconds or an HTTP date), else the fallback. */
function retryAfter(response: Response): number {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = /^\d+(?:\.\d+)?$/u.test(header)
    ? Number(header)
    : (Date.parse(header) - Date.now()) / 1000;
  // A day at most: a longer pause is better reported again than promised.
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), 86_400)
    : DISCORD_RETRY_FALLBACK_SECONDS;
}

/**
 * Refuse Discord's throttling and outages before oauth4webapi reads the answer, so a 429 keeps
 * its Retry-After and a 5xx reads as unavailable rather than malformed.
 */
function triage(response: Response): void {
  if (response.status === 429)
    throw new Failure("unavailable", MESSAGE.limited, retryAfter(response), DISCORD_API);
  if (response.status >= 500) throw unavailable();
}

/**
 * oauth4webapi's errors as catalog Failures. Each carries the raw response or body as its cause
 * (a token response's cause holds the access token), so none is ever passed on: only the new
 * Failure leaves, without a cause. Anything else, such as a TypeError from a misused argument, is
 * a defect and propagates as unexpected. A 401 challenge here can only be the token endpoint's,
 * refusing the client credentials: exchange() maps /users/@me's challenges itself.
 */
function oauthFailure(error: unknown): unknown {
  if (error instanceof Failure) return error;
  if (error instanceof oauth.ResponseBodyError) {
    if (error.error === "invalid_grant") return new Failure("expired", MESSAGE.code);
    if (error.error === "invalid_client") return new Failure("configuration", MESSAGE.client);
    return invalid();
  }
  if (error instanceof oauth.WWWAuthenticateChallengeError)
    return error.status === 401 ? new Failure("configuration", MESSAGE.client) : invalid();
  if (error instanceof oauth.OperationProcessingError) return invalid();
  if (error instanceof oauth.UnsupportedOperationError) return invalid();
  return error;
}

/**
 * Discord's code flow through oauth4webapi (tests/contract/discord-oauth.test.ts). Both methods
 * throw only catalog Failures, which the error page maps by category (E10):
 * - a missing or malformed login cookie, a missing or mismatched `state`, or a callback without a
 *   code: `expired` (stale, 409), decided before any fetch;
 * - `error=` on the callback (the user cancelled, say): `expired`, with no fetch;
 * - `invalid_grant` from the token endpoint: `expired`, with friendly wording to sign in again;
 * - HTTP 429 from Discord: `unavailable` with retryAfter from Retry-After (503 + Retry-After), which
 *   also pauses every sign-in's exchange until it has passed;
 * - an exchange the gate holds back (that pause, too many running, or too many this minute):
 *   `unavailable` with a Retry-After, before any request to Discord (503);
 * - another error status, malformed JSON or an unexpected shape: `invalid_response` or
 *   `unavailable` (upstream, 503);
 * - a bot account: `forbidden` with scope `human` (403);
 * - Discord refusing the client credentials (`invalid_client`, a wrong DISCORD_CLIENT_SECRET):
 *   `configuration` (unexpected, 500), so the operator gets an error-level report.
 */
export class DiscordSignIn {
  private readonly client: oauth.Client;
  private readonly authentication: oauth.ClientAuth;
  private readonly gate: ExchangeGate;

  constructor(private readonly options: DiscordSignInOptions) {
    this.client = { client_id: options.clientId };
    this.authentication = oauth.ClientSecretPost(options.clientSecret);
    this.gate = options.gate ?? new ExchangeGate();
  }

  /**
   * Begin a sign-in that returns to `returnPath` (passed through safeReturnPath again here). Async
   * because the PKCE challenge is a digest.
   */
  async start(returnPath: string): Promise<SignInStart> {
    const handshake: Handshake = {
      state: oauth.generateRandomState(),
      verifier: oauth.generateRandomCodeVerifier(),
      returnPath: safeReturnPath(returnPath),
    };
    const authorizeUrl = new URL(this.options.authorizeUrl ?? DISCORD_AUTHORIZE_URL);
    for (const [name, value] of [
      ["client_id", this.options.clientId],
      ["redirect_uri", this.options.redirectUri],
      ["response_type", "code"],
      ["scope", DISCORD_SCOPE],
      ["state", handshake.state],
      ["code_challenge", await oauth.calculatePKCECodeChallenge(handshake.verifier)],
      ["code_challenge_method", "S256"],
      ["prompt", DISCORD_PROMPT],
    ] as const)
      authorizeUrl.searchParams.set(name, value);
    return { authorizeUrl, loginCookie: encodeHandshake(handshake) };
  }

  /**
   * Finish at the callback. Only `callback`'s query is read; `loginCookie` is the login cookie's
   * value, if any. Exchanges the code (client credentials in the form body), reads /users/@me,
   * and keeps only `id` and `bot` (parsed with zod).
   */
  async finish(callback: URL, loginCookie: string | undefined): Promise<SignInResult> {
    // Everything up to the exchange is decided locally: a cross-site, cancelled or stale callback
    // (no login cookie with a matching state) costs Discord no request, and doesn't count against
    // the gate. Any client can still get a matching state from /login, or write the cookie itself,
    // and then costs one token request per callback; the gate bounds those for the bot's shared
    // egress address (D16's pause, rate and concurrency cap).
    const handshake = decodeHandshake(loginCookie);
    const parameters = callback.searchParams;
    const states = parameters.getAll("state");
    if (!handshake || states.length !== 1 || !sameState(states[0] ?? "", handshake.state))
      throw stale();
    if (parameters.has("error")) throw new Failure("expired", MESSAGE.cancelled);
    let validated: URLSearchParams;
    try {
      // Rejects a repeated parameter, a foreign `iss`, and implicit or JARM responses.
      validated = oauth.validateAuthResponse(DISCORD, this.client, parameters, handshake.state);
    } catch {
      throw stale();
    }
    const codes = validated.getAll("code");
    if (codes.length !== 1 || !codes[0]) throw stale();
    const userId = await this.gate.run(() => this.exchange(validated, handshake.verifier));
    return { userId, returnPath: handshake.returnPath };
  }

  /**
   * Trade the code for an access token, use it once for /users/@me, and drop it. The token lives
   * only in this call's locals: it is never stored, logged, returned or revoked.
   */
  private async exchange(callback: URLSearchParams, verifier: string): Promise<string> {
    try {
      const answer = await oauth.authorizationCodeGrantRequest(
        DISCORD,
        this.client,
        this.authentication,
        callback,
        this.options.redirectUri,
        verifier,
        this.http(),
      );
      triage(answer);
      const tokens = await oauth.processAuthorizationCodeResponse(DISCORD, this.client, answer);
      let response: Response;
      try {
        response = await oauth.protectedResourceRequest(
          tokens.access_token,
          "GET",
          new URL(DISCORD_USER_URL),
          new Headers({ accept: "application/json", "user-agent": USER_AGENT }),
          null,
          this.http(),
        );
      } catch (error) {
        // oauth4webapi throws on any answer with a WWW-Authenticate challenge, before triage sees
        // it. Here a 401 refuses the access token, not the client credentials the exchange just
        // used, so it is unreadable rather than oauthFailure's `configuration`; a 429 or 5xx keeps
        // its meaning. Only a new Failure leaves: the library error holds the raw answer.
        if (!(error instanceof oauth.WWWAuthenticateChallengeError)) throw error;
        triage(error.response);
        throw invalid();
      }
      triage(response);
      if (response.status !== 200) throw invalid();
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw invalid();
      }
      const user = DISCORD_USER.safeParse(body);
      if (!user.success) throw invalid();
      if (user.data.bot === true)
        throw new Failure("forbidden", MESSAGE.bot, 0, { kind: "scope", scope: "human" });
      return user.data.id;
    } catch (error) {
      throw oauthFailure(error);
    }
  }

  /** Transport options for oauth4webapi: the injected fetch, a deadline and the user agent. */
  private http() {
    return {
      [oauth.customFetch]: this.transport,
      signal: () => AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT },
    };
  }

  /**
   * The injected (or global) fetch, with every transport failure (a refused connection, DNS, TLS
   * or the deadline) as `unavailable`, never the error's own text.
   */
  private readonly transport = async (
    url: string,
    init: oauth.CustomFetchOptions<string, oauth.ProtectedResourceRequestBody>,
  ): Promise<Response> => {
    const { body, signal, ...rest } = init;
    try {
      return await (this.options.fetch ?? fetch)(url, {
        ...rest,
        // The token exchange sends a form and /users/@me no body; nothing else is ever sent.
        body: body instanceof URLSearchParams ? body : null,
        ...(signal && { signal }),
      });
    } catch {
      throw unavailable();
    }
  };
}
