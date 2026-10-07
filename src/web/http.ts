/**
 * HTTP building blocks for the web pages (#43): the request reference, the one header set every
 * response carries, the same-origin and form-type checks of the POST pipeline (E1), Failure
 * categories as HTTP statuses (E10), the two cookies, and response helpers. Middleware here refuses
 * by throwing Hono's HTTPException with a bare status; server.ts's error handler renders every
 * refusal through the same error page, so no response leaves without the headers.
 */
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { CookieOptions } from "hono/utils/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  classifyFailure,
  type FailureCategory,
  type FailureCode,
  type ReportLevel,
} from "../domain/failures.js";
import type { SafeHtml } from "./html.js";
import { safeReturnPath, RETURN_PARAM } from "./return-path.js";
import type { Session } from "./sessions.js";

/** Per-request values that server.ts sets before any route handler runs. */
export interface WebVariables {
  /** The request reference: the report's operation in logs, and "Ref" on error pages. */
  ref: string;
  /** The signed-in session, or null when the request carries no valid session cookie. */
  session: Session | null;
}

/** The Hono environment of the web app. */
export type WebEnv = { Variables: WebVariables };

/** A Hono request context in the web app. */
export type RequestContext = Context<WebEnv>;

/** The fixed routes server.ts serves itself; pages live under /g/:guild/ (page.ts). */
export const PATHS = {
  home: "/",
  login: "/login",
  callback: "/auth/callback",
  logout: "/logout",
  /** "Sign out everywhere": deletes every session of the signed-in user. */
  logoutAll: "/logout/all",
  ready: "/health/ready",
} as const;

/** A new request reference: a random UUID, never derived from the request. */
export function newRef(): string {
  return randomUUID();
}

/**
 * The Content-Security-Policy on every response. No script source. The two design fonts use
 * Google's stylesheet/font hosts; all other styles and images stay on this origin. Forms post
 * only here and pages cannot be framed.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** Strict-Transport-Security on an https origin only; no includeSubDomains, no preload. */
export const HSTS = "max-age=31536000";

/** Pages are for signed-in officers, never for search engines. */
const X_ROBOTS_TAG = "noindex";

/**
 * The exact headers every app response carries: pages, redirects, assets, 404, 405 and errors. The
 * Referrer-Policy is same-origin, not Hono's default no-referrer, because no-referrer makes
 * browsers send `Origin: null`, which the same-origin check would then refuse. securityHeaders()
 * must emit exactly these (plus HSTS on https); tests pin the two together.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": X_ROBOTS_TAG,
};

/** SECURITY_HEADERS plus HSTS when `secure` (an https origin), for responses built outside Hono. */
export function securityHeaderRecord(secure: boolean): Record<string, string> {
  return secure
    ? { ...SECURITY_HEADERS, "Strict-Transport-Security": HSTS }
    : { ...SECURITY_HEADERS };
}

/**
 * hono/secure-headers spelled out option by option, so a Hono upgrade that changes a default can't
 * change our headers. Hono's other defaults are switched off: Origin-Agent-Cluster,
 * X-DNS-Prefetch-Control, X-Download-Options (old IE), X-Permitted-Cross-Domain-Policies (Flash and
 * PDF plug-ins) and X-XSS-Protection (a removed browser filter) add nothing to a script-free CSP,
 * and COEP stays off because nothing here embeds cross-origin resources. The CSP is written as
 * Hono's directive object; tests prove it serializes to CONTENT_SECURITY_POLICY.
 */
const SECURE_HEADER_OPTIONS = {
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    styleSrc: ["'self'", "https://fonts.googleapis.com"],
    fontSrc: ["https://fonts.gstatic.com"],
    imgSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  originAgentCluster: false,
  referrerPolicy: "same-origin",
  xContentTypeOptions: "nosniff",
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xFrameOptions: "DENY",
  xPermittedCrossDomainPolicies: false,
  xXssProtection: false,
  removePoweredBy: true,
  permissionsPolicy: { camera: [], geolocation: [], microphone: [], payment: [], usb: [] },
} satisfies Parameters<typeof secureHeaders>[0];

/**
 * Middleware that sets the header set on every response, built on hono/secure-headers with
 * explicit options (and no COEP), plus X-Robots-Tag. Installed first, so it also covers the
 * not-found, 405 and error responses: Hono's compose catches a thrown Error at the layer that threw
 * and renders it through onError there, so this layer's `await next()` returns normally and the
 * headers land on the error page too (tests/unit/web-http.test.ts pins it).
 */
export function securityHeaders(secure: boolean): MiddlewareHandler<WebEnv> {
  const headers = secureHeaders({
    ...SECURE_HEADER_OPTIONS,
    strictTransportSecurity: secure ? HSTS : false,
  });
  return async (c, next) => {
    await headers(c, next);
    // hono/secure-headers has no option for it.
    c.res.headers.set("X-Robots-Tag", X_ROBOTS_TAG);
  };
}

/** Methods that never change state; everything else goes through E1. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * E1 step 1 as a pure predicate. GET and HEAD always pass. Any other method passes only with
 * `Sec-Fetch-Site: same-origin`, or, when that header is absent, `Origin` equal to `origin`
 * (WEB_PUBLIC_ORIGIN). A request with neither, or with any other Sec-Fetch-Site value, fails.
 * Fetch Metadata wins when a browser sends it: `cross-site` fails even beside a matching Origin.
 * The Origin fallback covers older browsers only, and needs Referrer-Policy: same-origin (above),
 * since no-referrer would make them send `Origin: null`.
 */
export function isSameOrigin(method: string, headers: Headers, origin: string): boolean {
  if (SAFE_METHODS.has(method)) return true;
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return headers.get("origin") === origin;
}

/**
 * E1 step 1 as middleware: a failing request gets HTTPException(403). It stands in for hono/csrf,
 * which skips non-form content types and passes a matching Origin beside `Sec-Fetch-Site:
 * cross-site` (tests/unit/web-http.test.ts records both): this checks every content type and lets a
 * matching Origin through only when Sec-Fetch-Site is absent.
 */
export function sameOrigin(origin: string): MiddlewareHandler<WebEnv> {
  return async (c, next) => {
    if (!isSameOrigin(c.req.method, c.req.raw.headers, origin)) throw new HTTPException(403);
    await next();
  };
}

/** The only body the web accepts: what an HTML form without file inputs sends. */
const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * E1 step 2: a POST body must be application/x-www-form-urlencoded, else HTTPException(415).
 * server.ts mounts it after sameOrigin() on each POST route, POST being the only unsafe method any
 * route serves; every other method meets 404 or 405 before a handler runs, and a route for another
 * unsafe method must mount both too. Parameters (`; charset=UTF-8`) and letter case don't matter.
 */
export function formOnly(): MiddlewareHandler<WebEnv> {
  return async (c, next) => {
    const media = (c.req.header("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (media !== FORM_TYPE) throw new HTTPException(415);
    await next();
  };
}

/**
 * Failure category → HTTP status (E10). Input re-rendering a form uses 422 instead of 400; a wait
 * or an upstream failure with a retryAfter also sends Retry-After.
 */
export const FAILURE_STATUS = {
  input: 400,
  forbidden: 403,
  setup: 409,
  not_found: 404,
  ambiguous: 400,
  conflict: 409,
  stale: 409,
  wait: 429,
  eligible: 409,
  upstream: 503,
  blocked: 503,
  paused: 503,
  unexpected: 500,
} as const satisfies Record<FailureCategory, ContentfulStatusCode>;

/** What an error page shows and how it is answered and logged. */
export interface Problem {
  readonly status: ContentfulStatusCode;
  /** The catalog code shown as "Code"; HTTP refusals use forbidden, not_found or input. */
  readonly code: FailureCode;
  /** The request reference shown as "Ref". */
  readonly ref: string;
  /**
   * The approved Failure message to show as escaped text, or null: always null for the unexpected
   * category and for anything that isn't a Failure, whose text is never shown or logged.
   */
  readonly message: string | null;
  /** Seconds for Retry-After; 0 sends none. */
  readonly retryAfter: number;
  /** The reporter level: 5xx problems go through report() at this level, others are logged. */
  readonly level: ReportLevel;
}

/** The catalog code an HTTP refusal (an HTTPException from middleware or a route) is shown with. */
const HTTP_CODE: Readonly<Partial<Record<number, FailureCode>>> = {
  403: "forbidden",
  404: "not_found",
  405: "input",
  413: "input",
  415: "input",
};

/**
 * Classify any caught error once: a Failure or a mapped Discord error by its category
 * (classifyFailure, then FAILURE_STATUS), an HTTPException by its own status, and anything else as
 * 500 unexpected. An HTTPException's own message and response are ignored: hono/body-limit
 * attaches a bare "Payload Too Large" response without our headers.
 * Its level is info, the level of a routine refusal, except a 5xx, which is a fault (error).
 */
export function problemOf(error: unknown, ref: string): Problem {
  if (error instanceof HTTPException)
    return {
      status: error.status,
      code: HTTP_CODE[error.status] ?? "unexpected",
      ref,
      message: null,
      retryAfter: 0,
      level: error.status >= 500 ? "error" : "info",
    };
  const { code, category, level, failure } = classifyFailure(error);
  return {
    status: FAILURE_STATUS[category],
    code,
    ref,
    // Only approved Failure text is ever shown; an unexpected Failure's text is for logs alone.
    message: category === "unexpected" ? null : (failure?.message ?? null),
    // Retry-After must be a whole number of seconds; round up so the client never retries early.
    retryAfter: failure && failure.retryAfter > 0 ? Math.ceil(failure.retryAfter) : 0,
    level,
  };
}

/** The session cookie's base name: `__Host-tarubot` on https, `tarubot` in development. */
export const SESSION_COOKIE = "tarubot";
/** The sign-in handshake cookie's base name: `__Host-tarubot-login` on https. */
export const LOGIN_COOKIE = "tarubot-login";
/** The handshake must finish within ten minutes. */
export const LOGIN_COOKIE_MAX_AGE = 600;
/** One of the web's two cookies. */
export type WebCookie = typeof SESSION_COOKIE | typeof LOGIN_COOKIE;

/**
 * hono/cookie options. Always HttpOnly, `Path=/`, `SameSite=Lax` (the OAuth return is a cross-site
 * redirect chain) and no Domain. With `secure` (an https origin) also `prefix: "host"`, which names
 * the cookie `__Host-…` and adds Secure; without it (http://localhost or http://[::1] development
 * only) a plain name and no Secure. The `__Host-` prefix is what makes the session cookie
 * unforgeable from a sibling subdomain (cookie tossing), so production never reads a plain name.
 */
export function cookieOptions(secure: boolean, maxAge?: number): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    ...(maxAge !== undefined && { maxAge }),
  };
  return secure ? { ...options, secure: true, prefix: "host" } : options;
}

/** Read one of the web's cookies under the prefix `secure` selects. */
export function readCookie(
  c: RequestContext,
  name: WebCookie,
  secure: boolean,
): string | undefined {
  return getCookie(c, name, secure ? "host" : undefined);
}

/** Set one of the web's cookies with cookieOptions; no maxAge makes a browser-session cookie. */
export function writeCookie(
  c: RequestContext,
  name: WebCookie,
  value: string,
  secure: boolean,
  maxAge?: number,
): void {
  setCookie(c, name, value, cookieOptions(secure, maxAge));
}

/** Expire one of the web's cookies (Max-Age=0, same attributes). */
export function clearCookie(c: RequestContext, name: WebCookie, secure: boolean): void {
  setCookie(c, name, "", cookieOptions(secure, 0));
}

/** `/login?to=…` for a signed-out request, with the return path passed through safeReturnPath. */
export function loginLocation(returnPath: string): string {
  return `${PATHS.login}?${RETURN_PARAM}=${encodeURIComponent(safeReturnPath(returnPath))}`;
}

/** No cache, shared or private, may keep a page: every one is personal or about to change. */
const NO_STORE = "no-store";

/** An HTML page (a layout() result) with `Cache-Control: no-store`. */
export function page(
  c: RequestContext,
  body: SafeHtml,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  return c.html(body, status, { "Cache-Control": NO_STORE });
}

/**
 * 303 See Other (post-redirect-get) with `Cache-Control: no-store`. `location` must already be a
 * same-origin path: a PATHS value, a page href, or a safeReturnPath result.
 */
export function redirect(c: RequestContext, location: string): Response {
  c.header("Cache-Control", NO_STORE);
  return c.redirect(location, 303);
}

/**
 * An error page (an errorPage() result) at the problem's status with `Cache-Control: no-store`,
 * Retry-After when the problem has one, and any extra headers (Allow on a 405). The extras can't
 * override no-store or Retry-After.
 */
export function problem(
  c: RequestContext,
  details: Problem,
  body: SafeHtml,
  headers: Readonly<Record<string, string>> = {},
): Response | Promise<Response> {
  return c.html(body, details.status, {
    ...headers,
    "Cache-Control": NO_STORE,
    ...(details.retryAfter > 0 && { "Retry-After": String(details.retryAfter) }),
  });
}
