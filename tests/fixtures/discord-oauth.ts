/**
 * A fake Discord for the web sign-in (#43): the authorize step, the token endpoint and /users/@me,
 * answering through an injected fetch so no request leaves the process. It checks what real Discord
 * checks (the client credentials in the form body, a single-use code bound to its redirect URI, the PKCE
 * verifier) and answers in Discord's shapes: a token response with `token_type` "Bearer", a scope
 * string and no `iss`, and a user object with more fields than TaruBot reads. Invented data only.
 */
import { createHash, randomBytes } from "node:crypto";
import { DISCORD_SCOPE, DISCORD_TOKEN_URL, DISCORD_USER_URL } from "../../src/web/oauth.js";

/** One request the fake received, as Discord would see it. */
export interface DiscordRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The form body of a token request; null for /users/@me. */
  readonly form: URLSearchParams | null;
}

/** Who signs in at the fake authorize step. */
export interface DiscordAccount {
  readonly id: string;
  readonly bot?: boolean;
}

/** What a code was issued for, and whether it was spent. */
interface Grant {
  readonly account: DiscordAccount;
  readonly redirectUri: string;
  readonly challenge: string;
  spent: boolean;
}

/** Discord's token answer: "Bearer", a seven-day lifetime, a refresh token and a scope string. */
export function discordTokenResponse(accessToken: string): Response {
  return Response.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: 604800,
    refresh_token: randomBytes(15).toString("base64url"),
    scope: DISCORD_SCOPE,
  });
}

/** Discord's OAuth error body, e.g. invalid_grant with its description. */
export function discordOAuthError(status: number, error: string, description?: string): Response {
  return Response.json(
    { error, ...(description !== undefined && { error_description: description }) },
    { status },
  );
}

/** /users/@me for the identify scope: more than id and bot, all of it invented. */
export function discordUser(account: DiscordAccount): Record<string, unknown> {
  return {
    id: account.id,
    username: "invented_user",
    avatar: null,
    discriminator: "0",
    public_flags: 0,
    flags: 0,
    banner: null,
    accent_color: null,
    global_name: "Invented <b>User</b>",
    avatar_decoration_data: null,
    collectibles: null,
    banner_color: null,
    clan: null,
    primary_guild: null,
    mfa_enabled: false,
    locale: "en-US",
    premium_type: 0,
    ...(account.bot !== undefined && { bot: account.bot }),
  };
}

/** S256: the base64url SHA-256 of the verifier. */
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export class FakeDiscord {
  /** Every request, in order. */
  readonly requests: DiscordRequest[] = [];
  /** Every access token handed out, so tests can prove none is kept. */
  readonly issuedTokens: string[] = [];
  /** Replaces the token endpoint's next answers when set; the request is still recorded. */
  tokenAnswer: ((request: DiscordRequest) => Response) | undefined;
  /** Replaces /users/@me's answers when set. */
  userAnswer: ((request: DiscordRequest) => Response) | undefined;
  /** Makes every request fail the way a refused connection does. */
  unreachable = false;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, DiscordAccount>();

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  /**
   * The authorize page: checks the request as Discord would for a registered client, issues a
   * single-use code for `account`, and returns the callback URL the browser is sent to.
   */
  authorize(authorizeUrl: URL, account: DiscordAccount): URL {
    const query = authorizeUrl.searchParams;
    const redirectUri = query.get("redirect_uri") ?? "";
    if (
      query.get("client_id") !== this.clientId ||
      query.get("response_type") !== "code" ||
      query.get("scope") !== DISCORD_SCOPE ||
      query.get("code_challenge_method") !== "S256" ||
      !query.get("code_challenge") ||
      !redirectUri
    )
      throw new Error("The fake authorize page refused the request");
    const code = randomBytes(15).toString("base64url");
    this.grants.set(code, {
      account,
      redirectUri,
      challenge: query.get("code_challenge") ?? "",
      spent: false,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    const state = query.get("state");
    if (state !== null) callback.searchParams.set("state", state);
    return callback;
  }

  /** The callback after the user pressed Cancel on the authorize page. */
  cancel(authorizeUrl: URL): URL {
    const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set(
      "error_description",
      "The resource owner or authorization server denied the request",
    );
    const state = authorizeUrl.searchParams.get("state");
    if (state !== null) callback.searchParams.set("state", state);
    return callback;
  }

  /** The injected fetch: answers Discord's token and user endpoints, nothing else. */
  readonly fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const form = request.method === "POST" ? new URLSearchParams(await request.text()) : null;
      const recorded: DiscordRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        form,
      };
      this.requests.push(recorded);
      if (this.unreachable) throw new TypeError("fetch failed: connection refused (fake)");
      if (request.url === DISCORD_TOKEN_URL && request.method === "POST")
        return this.tokenAnswer ? this.tokenAnswer(recorded) : this.token(recorded);
      if (request.url === DISCORD_USER_URL && request.method === "GET")
        return this.userAnswer ? this.userAnswer(recorded) : this.user(recorded);
      return Response.json({ message: "404: Not Found", code: 0 }, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );

  /** The token endpoint: client credentials, then a code bound to its redirect URI and verifier. */
  private token(request: DiscordRequest): Response {
    const form = request.form ?? new URLSearchParams();
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret)
      return discordOAuthError(401, "invalid_client");
    if (form.get("grant_type") !== "authorization_code")
      return discordOAuthError(400, "unsupported_grant_type");
    const grant = this.grants.get(form.get("code") ?? "");
    if (!grant || grant.spent)
      return discordOAuthError(400, "invalid_grant", 'Invalid "code" in request.');
    grant.spent = true;
    if (form.get("redirect_uri") !== grant.redirectUri)
      return discordOAuthError(400, "invalid_grant", 'Invalid "redirect_uri" in request.');
    if (challengeOf(form.get("code_verifier") ?? "") !== grant.challenge)
      return discordOAuthError(400, "invalid_grant", 'Invalid "code_verifier" in request.');
    const accessToken = randomBytes(22).toString("base64url");
    this.tokens.set(accessToken, grant.account);
    this.issuedTokens.push(accessToken);
    return discordTokenResponse(accessToken);
  }

  /** /users/@me for a token this fake issued. */
  private user(request: DiscordRequest): Response {
    const account = this.tokens.get(
      request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "",
    );
    if (!account) return Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 });
    return Response.json(discordUser(account));
  }
}
