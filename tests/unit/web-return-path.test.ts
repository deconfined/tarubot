/**
 * Sign-in return paths (#43, E12): only same-origin paths survive, every percent-decoded form is
 * checked, and the result is always the value itself or "/", so a redirect built from it can never
 * leave the origin. Also the /login location that carries a return path there.
 */
import { describe, expect, test } from "bun:test";
import { loginLocation } from "../../src/web/http.js";
import { RETURN_PARAM, RETURN_PATH_MAX, safeReturnPath } from "../../src/web/return-path.js";

const ORIGIN = "https://example.org";

/** Where a browser would go after `Location: <path>` on a page of ORIGIN. */
const target = (path: string): URL => new URL(path, `${ORIGIN}/g/1/status`);

describe("safeReturnPath keeps", () => {
  test("same-origin paths with a query and fragment", () => {
    for (const value of [
      "/",
      "/g/123456789012345678/status",
      "/g/1/status?x=1#y",
      "/a%20b",
      "/g/1/status?next=%2F%2Fevil",
      "/g/1/status#..",
      "/g/1/status?x=..",
      "/@evil.example",
      "/javascript:alert(1)",
    ])
      expect({ value, kept: safeReturnPath(value) }).toEqual({ value, kept: value });
  });

  test("a value of exactly the maximum length", () => {
    const longest = `/${"a".repeat(RETURN_PATH_MAX - 1)}`;
    expect(safeReturnPath(longest)).toBe(longest);
  });
});

describe("safeReturnPath refuses, returning /", () => {
  test("protocol-relative and backslash forms, raw or percent-encoded", () => {
    for (const value of [
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\/evil.example",
      "/%2F%2Fevil.example",
      "/%2f%2fevil.example",
      "/%2F/evil.example",
      "/%252F%252Fevil.example",
      "/%25252F%25252Fevil.example",
      "/%5Cevil.example",
      "/%5cevil.example",
      "/%255Cevil.example",
      "/g/1?x=%5C",
    ])
      expect({ value, kept: safeReturnPath(value) }).toEqual({ value, kept: "/" });
  });

  test("dot segments, raw or percent-encoded", () => {
    for (const value of [
      "/g/../..",
      "/..",
      "/.",
      "/g/./x",
      "/g/%2e%2e/x",
      "/g/%2E%2E/x",
      "/g/.%2e/x",
      "/g/%252e%252e/x",
      "/g/..?x=1",
    ])
      expect({ value, kept: safeReturnPath(value) }).toEqual({ value, kept: "/" });
  });

  test("control characters, raw or percent-encoded, and anything but visible ASCII", () => {
    for (const value of [
      "/%00",
      "/a%0d%0aSet-Cookie:%20x=1",
      "/%09/evil.example",
      "/%7F",
      "/%C2%85",
      "/a\tb",
      "/a\nb",
      "/a b",
      "/é",
      "/‮",
    ])
      expect({ value, kept: safeReturnPath(value) }).toEqual({ value, kept: "/" });
  });

  test("absolute URLs, relative paths, malformed escapes and endless encodings", () => {
    for (const value of [
      "https://evil.example/",
      "http:/evil.example",
      "javascript:alert(1)",
      "evil.example",
      "g/1/status",
      "",
      "/%E0%A4%A",
      "/%",
      "/%zz",
      // Still changing after three rounds of decoding.
      "/%2525252Fx",
    ])
      expect({ value, kept: safeReturnPath(value) }).toEqual({ value, kept: "/" });
  });

  test("over-length values and non-strings", () => {
    expect(safeReturnPath(`/${"a".repeat(RETURN_PATH_MAX)}`)).toBe("/");
    for (const value of [undefined, null, 42, ["/g/1"], { toString: () => "/g/1" }, true])
      expect(safeReturnPath(value)).toBe("/");
  });
});

/** A small deterministic generator, so a failing case reproduces. */
function* candidates(count: number): Generator<string> {
  const pieces = ["/", "\\", "%", "2", "5", "F", "f", "C", "c", ".", "e", "a", "?", "#", ":", "@"];
  let seed = 0x2b5bdb;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let index = 0; index < count; index++) {
    let value = next() % 4 === 0 ? "" : "/";
    const length = 1 + (next() % 12);
    for (let piece = 0; piece < length; piece++) value += pieces[next() % pieces.length];
    yield value;
  }
}

test("whatever the input, the result is the input or /, and a redirect to it stays on the origin", () => {
  let kept = 0;
  for (const value of candidates(5000)) {
    const result = safeReturnPath(value);
    expect([value, "/"]).toContain(result);
    const url = target(result);
    expect({ value, origin: url.origin }).toEqual({ value, origin: ORIGIN });
    // Browsers also resolve a backslash like a slash; the resolved path must stay under "/".
    expect(url.pathname.startsWith("//")).toBe(false);
    if (result === value) kept++;
  }
  // The generator must reach accepted values too, or the property above would hold trivially.
  expect(kept).toBeGreaterThan(100);
});

describe("loginLocation", () => {
  test("carries a safe return path in the query, encoded", () => {
    const location = loginLocation("/g/1/status?x=1&y=2#z");
    expect(location).toBe("/login?to=%2Fg%2F1%2Fstatus%3Fx%3D1%26y%3D2%23z");
    expect(new URL(location, ORIGIN).searchParams.get(RETURN_PARAM)).toBe("/g/1/status?x=1&y=2#z");
  });

  test("replaces an unsafe return path with /", () => {
    for (const value of ["//evil.example", "/%2F%2Fevil.example", "https://evil.example/"])
      expect(loginLocation(value)).toBe("/login?to=%2F");
  });
});
