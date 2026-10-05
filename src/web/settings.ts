/**
 * The web's settings (#43, ADR D13), parsed when the web starts rather than in configuration(), so
 * a bad web value turns the web off with a report and never stops the bot. The precedent is
 * GITHUB_APP_PRIVATE_KEY, which only /suggest parses. Problems name settings, never their values.
 */
import type { Configuration } from "../config/env.js";
import { PATHS } from "./http.js";

/** WEB_PORT when unset or empty. A clash with HEALTH_PORT surfaces as a bind failure. */
export const DEFAULT_WEB_PORT = 8080;

/** The settings startWeb reads; DISCORD_APPLICATION_ID doubles as the OAuth client ID. */
export type WebSettingsInput = Pick<
  Configuration,
  "WEB_PUBLIC_ORIGIN" | "WEB_PORT" | "DISCORD_CLIENT_SECRET" | "DISCORD_APPLICATION_ID"
>;

/** Validated web settings. */
export interface WebSettings {
  /**
   * WEB_PUBLIC_ORIGIN, serialized without a trailing slash: an `https://` origin with no path,
   * query or credentials, or `http://localhost[:port]` / `http://[::1][:port]` for development. It
   * is the only source of absolute URLs, the redirect URI and the Origin check.
   */
  readonly origin: string;
  /** True for an https origin: `__Host-` cookies, Secure and HSTS. False only in development. */
  readonly secure: boolean;
  /** WEB_PORT: an integer from 1 to 65535, DEFAULT_WEB_PORT when unset. */
  readonly port: number;
  /** DISCORD_APPLICATION_ID, already checked against the logged-in application. */
  readonly clientId: string;
  /** DISCORD_CLIENT_SECRET; required when the origin is set. Never logged or reported. */
  readonly clientSecret: string;
  /** Exactly `${origin}/auth/callback`. */
  readonly redirectUri: string;
}

/**
 * The parse result. `off`: WEB_PUBLIC_ORIGIN is unset or empty, so nothing listens. `invalid`: the
 * web stays off and startWeb reports `problems`, each "SETTING: what it must be" and never a value.
 */
export type WebSettingsResult =
  | { readonly status: "off" }
  | { readonly status: "invalid"; readonly problems: readonly string[] }
  | { readonly status: "on"; readonly settings: WebSettings };

/** Visible ASCII: no space, control or line break, which a pasted value may carry. */
const VISIBLE = /^[\x21-\x7e]+$/u;
/**
 * The only hosts served over plain http, so cookies can drop Secure and `__Host-` in development:
 * the loopback name and the IPv6 loopback (as URL.hostname spells it, in brackets). Never a
 * routable address: a session cookie without Secure must not cross a network.
 */
const DEVELOPMENT_HOSTS: ReadonlySet<string> = new Set(["localhost", "[::1]"]);
/** A decimal port without sign, leading zero or spaces; the range is checked after. */
const PORT = /^[1-9][0-9]{0,4}$/u;

const PROBLEM = {
  origin:
    "WEB_PUBLIC_ORIGIN: must be exactly an https:// origin such as https://example.org (lower case, with no default port, path, query or credentials), or http://localhost or http://[::1] (each with an optional port) for development",
  secretMissing: "DISCORD_CLIENT_SECRET: required when WEB_PUBLIC_ORIGIN is set",
  secretShape:
    "DISCORD_CLIENT_SECRET: must be the application's OAuth client secret, without spaces or line breaks",
  port: "WEB_PORT: must be a whole number from 1 to 65535",
} as const;

/** An empty string, which Compose's ${VAR:-} passes for an unset variable, means unset. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The origin and whether it is https, or null when the value isn't an allowed origin. */
function parseOrigin(value: string): { origin: string; secure: boolean } | null {
  const url = URL.parse(value);
  // The value must already be the serialized origin, the form browsers send in the Origin header
  // that the POST check compares against, with at most a trailing "/". Anything else differs from
  // url.origin: credentials, a path, query or fragment, spaces, upper case or a default port.
  if (!url || value.replace(/\/$/u, "") !== url.origin) return null;
  if (url.protocol === "https:") return { origin: url.origin, secure: true };
  if (url.protocol === "http:" && DEVELOPMENT_HOSTS.has(url.hostname))
    return { origin: url.origin, secure: false };
  return null;
}

/** WEB_PORT as a number, DEFAULT_WEB_PORT when unset, or null when it isn't a valid port. */
function parsePort(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_WEB_PORT;
  if (!PORT.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

/** Parse the web settings. Empty strings mean unset. Never throws. */
export function webSettings(config: WebSettingsInput): WebSettingsResult {
  const originValue = present(config.WEB_PUBLIC_ORIGIN);
  // No origin means the web is off, whatever else is set: nothing listens, nothing is reported.
  if (originValue === undefined) return { status: "off" };
  // Every problem is collected, so one report names everything to fix.
  const problems: string[] = [];
  const origin = parseOrigin(originValue);
  if (!origin) problems.push(PROBLEM.origin);
  const clientSecret = present(config.DISCORD_CLIENT_SECRET);
  if (clientSecret === undefined) problems.push(PROBLEM.secretMissing);
  else if (!VISIBLE.test(clientSecret)) problems.push(PROBLEM.secretShape);
  const port = parsePort(present(config.WEB_PORT));
  if (port === null) problems.push(PROBLEM.port);
  if (problems.length || !origin || clientSecret === undefined || port === null)
    return { status: "invalid", problems };
  return {
    status: "on",
    settings: {
      origin: origin.origin,
      secure: origin.secure,
      port,
      // configuration() has already checked it with idSchema; a bad value stops the bot's start.
      clientId: config.DISCORD_APPLICATION_ID,
      clientSecret,
      redirectUri: `${origin.origin}${PATHS.callback}`,
    },
  };
}
