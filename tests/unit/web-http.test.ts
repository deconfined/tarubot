/**
 * The web's HTTP building blocks (#43, E1, E10) through a small Hono app wired the way server.ts
 * wires them: the exact header set on every response (pages, redirects, 404, 405, 415, thrown
 * errors), the same-origin and form-type checks, Failure categories as statuses, the two cookies
 * with and without the __Host- prefix, and the response helpers. No listener and no network.
 */
import { describe, expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  FAILURE_CATEGORY,
  FAILURE_LEVEL,
  type FailureCode,
  type ReportLevel,
} from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";
import { html } from "../../src/web/html.js";
import {
  CONTENT_SECURITY_POLICY,
  clearCookie,
  cookieOptions,
  FAILURE_STATUS,
  formOnly,
  HSTS,
  isSameOrigin,
  LOGIN_COOKIE,
  LOGIN_COOKIE_MAX_AGE,
  newRef,
  page,
  problem,
  problemOf,
  type RequestContext,
  readCookie,
  redirect,
  SESSION_COOKIE,
  sameOrigin,
  securityHeaderRecord,
  securityHeaders,
  type WebEnv,
  writeCookie,
} from "../../src/web/http.js";
import { errorPage, layout } from "../../src/web/layout.js";

const ORIGIN = "https://example.org";
const REF = "00000000-0000-4000-8000-000000000000";
const SECRET = "secret detail that must never reach a page";

/** Headers that belong to one response rather than to the shared set. */
const PER_RESPONSE = new Set([
  "allow",
  "cache-control",
  "content-length",
  "content-type",
  "location",
  "retry-after",
  "set-cookie",
]);

/** Exactly the shared set, nothing missing and nothing extra (no X-Powered-By, COEP, …). */
function expectSecurityHeaders(response: Response, secure: boolean): void {
  const actual = Object.fromEntries(
    [...response.headers].filter(([name]) => !PER_RESPONSE.has(name)),
  );
  const expected = Object.fromEntries(
    Object.entries(securityHeaderRecord(secure)).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  expect(actual).toEqual(expected);
}

/** Render a caught error the way server.ts's onError and notFound do. */
function refuse(
  c: RequestContext,
  error: unknown,
  headers?: Readonly<Record<string, string>>,
): Response | Promise<Response> {
  const details = problemOf(error, c.get("ref"));
  return problem(c, details, errorPage(details, false), headers);
}

/** The server.ts pipeline in miniature: headers, ref, the body cap, then routes, E1 on the POST. */
function app(secure: boolean, origin = ORIGIN): Hono<WebEnv> {
  const web = new Hono<WebEnv>();
  web.use(securityHeaders(secure));
  web.use(async (c, next) => {
    c.set("ref", REF);
    c.set("session", null);
    await next();
  });
  web.use(bodyLimit({ maxSize: 64 }));
  web.get("/page", (c) => page(c, layout({ title: "Page", signedIn: false }, html`<p>ok</p>`)));
  web.get("/async", (c) => page(c, html`<p>${Promise.resolve("<b>")}</p>`, 201));
  web.post("/form", sameOrigin(origin), formOnly(), (c) => redirect(c, "/page"));
  web.all("/form", (c) => refuse(c, new HTTPException(405), { Allow: "POST" }));
  web.get("/boom", () => {
    throw new Error(SECRET);
  });
  web.get("/wait", () => {
    throw new Failure("cooldown", "Wait a little before trying again.", 12.2);
  });
  web.notFound((c) => refuse(c, new HTTPException(404)));
  web.onError((error, c) => refuse(c, error));
  return web;
}

/** A browser's same-origin form post. */
const FORM_POST: RequestInit = {
  method: "POST",
  headers: {
    "Sec-Fetch-Site": "same-origin",
    Origin: ORIGIN,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "a=1",
};

describe("the header set", () => {
  test("is the documented CSP and record, with HSTS only for https", () => {
    // Written out, not read from http.ts, so deleting a header there fails here. Referrer-Policy
    // is never Hono's default no-referrer, which makes browsers send Origin: null; no COEP.
    const SPEC = {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex",
    };
    expect(CONTENT_SECURITY_POLICY).toBe(SPEC["Content-Security-Policy"]);
    expect(securityHeaderRecord(false)).toEqual(SPEC);
    expect(securityHeaderRecord(true)).toEqual({
      ...SPEC,
      "Strict-Transport-Security": "max-age=31536000",
    });
    expect(HSTS).not.toContain("includeSubDomains");
  });

  for (const secure of [false, true])
    test(`covers pages, redirects and every refusal (${secure ? "https" : "development"})`, async () => {
      const web = app(secure);
      const responses: [string, Response, number][] = [
        ["page", await web.request("/page"), 200],
        ["head", await web.request("/page", { method: "HEAD" }), 200],
        ["async page", await web.request("/async"), 201],
        ["redirect", await web.request("/form", FORM_POST), 303],
        ["cross-site", await web.request("/form", { ...FORM_POST, headers: {} }), 403],
        [
          "json",
          await web.request("/form", {
            ...FORM_POST,
            headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
          }),
          415,
        ],
        ["too large", await web.request("/form", { ...FORM_POST, body: "a".repeat(65) }), 413],
        ["not found", await web.request("/nowhere"), 404],
        ["not found, head", await web.request("/nowhere", { method: "HEAD" }), 404],
        ["wrong method", await web.request("/form"), 405],
        ["thrown error", await web.request("/boom"), 500],
        ["failure", await web.request("/wait"), 429],
      ];
      for (const [name, response, status] of responses) {
        expect({ name, status: response.status }).toEqual({ name, status });
        expectSecurityHeaders(response, secure);
        expect({ name, cache: response.headers.get("cache-control") }).toEqual({
          name,
          cache: "no-store",
        });
      }
    });

  test("error pages show Code and Ref, never the error's text or Hono's bare response", async () => {
    const web = app(true);
    const thrown = await web.request("/boom");
    const body = await thrown.text();
    expect(body).not.toContain(SECRET);
    expect(body).toContain(`Code <code>unexpected</code> · Ref <code>${REF}</code>`);
    expect(thrown.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    // body-limit attaches a bare text response to its HTTPException; it is never used.
    const large = await web.request("/form", { ...FORM_POST, body: "a".repeat(65) });
    expect(await large.text()).toContain("Code <code>input</code>");
    const wrong = await web.request("/form");
    expect(wrong.headers.get("allow")).toBe("POST");
    expect(await wrong.text()).toContain("Code <code>input</code>");
  });

  test("a wait or upstream failure answers Retry-After in whole seconds", async () => {
    const response = await app(false).request("/wait");
    expect(response.headers.get("retry-after")).toBe("13");
    expect(await response.text()).toContain("Wait a little before trying again.");
    // Everything else sends none.
    expect((await app(false).request("/boom")).headers.get("retry-after")).toBeNull();
  });
});

describe("the same-origin check (E1 step 1)", () => {
  const check = (method: string, headers: Record<string, string>): boolean =>
    isSameOrigin(method, new Headers(headers), ORIGIN);

  test("GET and HEAD always pass", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(check(method, {})).toBe(true);
      expect(
        check(method, { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" }),
      ).toBe(true);
    }
  });

  test("other methods need Sec-Fetch-Site: same-origin, or a matching Origin without it", () => {
    const cases: [Record<string, string>, boolean][] = [
      [{ "Sec-Fetch-Site": "same-origin" }, true],
      [{ "Sec-Fetch-Site": "same-origin", Origin: ORIGIN }, true],
      [{ Origin: ORIGIN }, true],
      // Fetch Metadata wins: a matching Origin can't rescue another site's request.
      [{ "Sec-Fetch-Site": "cross-site", Origin: ORIGIN }, false],
      [{ "Sec-Fetch-Site": "same-site", Origin: ORIGIN }, false],
      [{ "Sec-Fetch-Site": "none", Origin: ORIGIN }, false],
      [{ "Sec-Fetch-Site": "", Origin: ORIGIN }, false],
      [{ "Sec-Fetch-Site": "SAME-ORIGIN" }, false],
      [{ Origin: "https://evil.example" }, false],
      [{ Origin: "null" }, false],
      [{ Origin: `${ORIGIN}/` }, false],
      [{ Origin: `${ORIGIN}:8443` }, false],
      [{ Origin: "http://example.org" }, false],
      // Neither header: refused.
      [{}, false],
    ];
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      for (const [headers, allowed] of cases)
        expect({ method, headers, allowed: check(method, headers) }).toEqual({
          method,
          headers,
          allowed,
        });
  });

  test("hono/csrf alone lets requests through that E1 refuses, so sameOrigin is the check", async () => {
    const requests: RequestInit[] = [
      // A non-form content type isn't checked by hono/csrf at all.
      {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
        body: "{}",
      },
      // Either a Sec-Fetch-Site or an Origin match is enough for hono/csrf.
      {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "cross-site",
          Origin: ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "a=1",
      },
    ];
    const csrfOnly = new Hono().use(csrf({ origin: ORIGIN, secFetchSite: "same-origin" }));
    csrfOnly.post("/form", (c) => c.body(null, 204));
    const e1 = new Hono<WebEnv>().use(sameOrigin(ORIGIN));
    e1.post("/form", (c) => c.body(null, 204));
    for (const init of requests) {
      expect((await csrfOnly.request("/form", init)).status).toBe(204);
      expect((await e1.request("/form", init)).status).toBe(403);
    }
    // The refusal is an HTTPException(403), which the app's error page renders.
    const refused = await app(false).request("/form", requests[1]);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Code <code>forbidden</code>");
  });
});

describe("the form-type check (E1 step 2)", () => {
  test("only an urlencoded body passes, whatever its parameters or case", async () => {
    const web = app(false);
    const post = (type: string | null) =>
      web.request("/form", {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          ...(type === null ? {} : { "Content-Type": type }),
        },
        body: "a=1",
      });
    for (const type of [
      "application/x-www-form-urlencoded",
      "application/x-www-form-urlencoded; charset=UTF-8",
      "Application/X-WWW-Form-Urlencoded",
    ])
      expect({ type, status: (await post(type)).status }).toEqual({ type, status: 303 });
    for (const type of [
      "multipart/form-data; boundary=x",
      "text/plain",
      "application/json",
      "application/x-www-form-urlencoded-extra",
      "",
    ])
      expect({ type, status: (await post(type)).status }).toEqual({ type, status: 415 });
    // Bun's Request supplies text/plain for a string body that names no type.
    expect((await post(null)).status).toBe(415);
  });

  test("a body with no type at all is refused, whatever the method it is mounted on", async () => {
    const checked = new Hono<WebEnv>().use(formOnly());
    checked.all("/", (c) => c.body(null, 204));
    checked.onError((error, c) => c.body(null, problemOf(error, "r").status));
    expect((await checked.request("/", { method: "POST" })).status).toBe(415);
    expect((await checked.request("/", { method: "DELETE" })).status).toBe(415);
  });
});

describe("problemOf (E10)", () => {
  test("every catalog code maps through its category, with its level and approved text", () => {
    for (const [code, category] of Object.entries(FAILURE_CATEGORY) as [
      FailureCode,
      keyof typeof FAILURE_STATUS,
    ][]) {
      const details = problemOf(new Failure(code, "Approved text."), REF);
      expect({ code, details }).toEqual({
        code,
        details: {
          status: FAILURE_STATUS[category],
          code,
          ref: REF,
          // Unexpected-category text is for logs alone.
          message: category === "unexpected" ? null : "Approved text.",
          retryAfter: 0,
          level: FAILURE_LEVEL[category],
        },
      });
    }
  });

  test("the category table is E10's", () => {
    expect(FAILURE_STATUS).toEqual({
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
    });
  });

  test("retryAfter comes from the Failure, rounded up, and only when positive", () => {
    expect(problemOf(new Failure("rate_limited", "x", 30), REF).retryAfter).toBe(30);
    expect(problemOf(new Failure("unavailable", "x", 0.2), REF)).toMatchObject({
      status: 503,
      retryAfter: 1,
      level: "warn",
    });
    expect(problemOf(new Failure("busy", "x", -5), REF).retryAfter).toBe(0);
  });

  test("raw Discord errors map by code, with no text", () => {
    const discord = (code: number, status: number) =>
      new DiscordAPIError({ code, message: SECRET }, code, status, "GET", "/x", {
        body: undefined,
        files: undefined,
      });
    expect(problemOf(discord(50013, 403), REF)).toEqual({
      status: 503,
      code: "blocked",
      ref: REF,
      message: null,
      retryAfter: 0,
      level: "warn",
    });
    expect(problemOf(discord(10007, 404), REF)).toMatchObject({
      status: 403,
      code: "forbidden",
      message: null,
    });
  });

  test("anything that isn't a Failure is 500 unexpected with no message", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    for (const error of [
      new Error(SECRET),
      new TypeError(SECRET),
      parsed.success ? null : parsed.error,
      SECRET,
      undefined,
      { message: SECRET },
      // A cast past the catalog type must not reach a page either.
      new Failure("not_a_code" as FailureCode, SECRET),
    ])
      expect(problemOf(error, REF)).toEqual({
        status: 500,
        code: "unexpected",
        ref: REF,
        message: null,
        retryAfter: 0,
        level: "error",
      });
  });

  test("an HTTPException keeps its status with a fixed code, never its message", () => {
    const cases: [ConstructorParameters<typeof HTTPException>[0], FailureCode, ReportLevel][] = [
      [403, "forbidden", "info"],
      [404, "not_found", "info"],
      [405, "input", "info"],
      [413, "input", "info"],
      [415, "input", "info"],
      [418, "unexpected", "info"],
      [500, "unexpected", "error"],
      [503, "unexpected", "error"],
    ];
    for (const [status, code, level] of cases)
      expect(
        problemOf(new HTTPException(status, { message: SECRET, res: new Response(SECRET) }), REF),
      ).toEqual({ status: status ?? 500, code, ref: REF, message: null, retryAfter: 0, level });
  });
});

describe("cookies", () => {
  /** Routes that write, clear and read the two cookies. */
  function cookieApp(secure: boolean): Hono<WebEnv> {
    const web = new Hono<WebEnv>();
    web.get("/write", (c) => {
      writeCookie(c, SESSION_COOKIE, "session-token", secure, 2_592_000);
      writeCookie(c, LOGIN_COOKIE, "handshake", secure, LOGIN_COOKIE_MAX_AGE);
      return c.body(null, 204);
    });
    web.get("/browser-session", (c) => {
      writeCookie(c, SESSION_COOKIE, "v", secure);
      return c.body(null, 204);
    });
    web.get("/clear", (c) => {
      clearCookie(c, SESSION_COOKIE, secure);
      return c.body(null, 204);
    });
    web.get("/read", (c) =>
      c.json({
        session: readCookie(c, SESSION_COOKIE, secure) ?? null,
        login: readCookie(c, LOGIN_COOKIE, secure) ?? null,
      }),
    );
    return web;
  }

  test("on https: __Host- names, Secure, HttpOnly, Path=/, SameSite=Lax and no Domain", async () => {
    const web = cookieApp(true);
    expect((await web.request("/write")).headers.getSetCookie()).toEqual([
      "__Host-tarubot=session-token; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Host-tarubot-login=handshake; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect((await web.request("/clear")).headers.getSetCookie()).toEqual([
      "__Host-tarubot=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect((await web.request("/browser-session")).headers.getSetCookie()).toEqual([
      "__Host-tarubot=v; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  test("in development: plain names and no Secure, the other attributes unchanged", async () => {
    const web = cookieApp(false);
    expect((await web.request("/write")).headers.getSetCookie()).toEqual([
      "tarubot=session-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
      "tarubot-login=handshake; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
    ]);
    expect((await web.request("/clear")).headers.getSetCookie()).toEqual([
      "tarubot=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });

  test("on https only the __Host- cookie is read, so a tossed plain cookie is ignored", async () => {
    const read = async (secure: boolean, cookie: string) =>
      (await cookieApp(secure).request("/read", { headers: { Cookie: cookie } })).json();
    expect(
      await read(true, "tarubot=tossed; __Host-tarubot=real; __Host-tarubot-login=handshake"),
    ).toEqual({ session: "real", login: "handshake" });
    expect(await read(true, "tarubot=tossed; tarubot-login=tossed")).toEqual({
      session: null,
      login: null,
    });
    expect(await read(false, "__Host-tarubot=other; tarubot=plain")).toEqual({
      session: "plain",
      login: null,
    });
  });

  test("the options never carry a Domain", () => {
    expect(cookieOptions(true, 600)).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: 600,
      secure: true,
      prefix: "host",
    });
    expect(cookieOptions(false)).toEqual({ httpOnly: true, path: "/", sameSite: "Lax" });
  });
});

describe("response helpers", () => {
  test("page() answers HTML with no-store at the given status", async () => {
    const response = await app(false).request("/async");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await response.text()).toBe("<p>&lt;b&gt;</p>");
  });

  test("redirect() answers 303 See Other to the given path with no-store", async () => {
    const response = await app(false).request("/form", FORM_POST);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/page");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("problem() extra headers can't override no-store or Retry-After", async () => {
    const web = new Hono<WebEnv>();
    web.get("/", (c) =>
      problem(
        c,
        { status: 503, code: "unavailable", ref: REF, message: null, retryAfter: 7, level: "warn" },
        html`<p>x</p>`,
        { "Cache-Control": "public", "Retry-After": "0", Allow: "GET" },
      ),
    );
    const response = await web.request("/");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("allow")).toBe("GET");
  });

  test("newRef() is a random UUID, never repeated", () => {
    const refs = Array.from({ length: 100 }, () => newRef());
    for (const ref of refs)
      expect(ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(new Set(refs).size).toBe(100);
  });
});
