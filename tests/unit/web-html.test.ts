/**
 * Escaping proofs for the web templates (#43) against the pinned hono/html: every interpolation is
 * escaped (in text and in attributes), arrays and promises included, nested template results
 * compose without double escaping, and raw() is the only way markup gets through. Also the two
 * helpers built on it: href(), which lets only same-origin paths and https URLs into a link, and
 * untrusted(), which isolates stored text in a dir="auto" element.
 */
import { describe, expect, test } from "bun:test";
import { href, html, raw, type SafeHtml, untrusted } from "../../src/web/html.js";

/** The markup a template produced, awaiting it when an interpolation was a promise. */
const render = async (value: SafeHtml): Promise<string> => String(await value);

const HOSTILE = `<script>alert("x")</script> & 'quoted'`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;";

test("the pinned Hono version is the one these proofs were written against", async () => {
  const manifest = await Bun.file(new URL("../../node_modules/hono/package.json", import.meta.url))
    .json()
    .then((value: { version: string }) => value.version);
  // A Hono upgrade must re-read helper/html and utils/html before this pin moves.
  expect(manifest).toBe("4.13.12");
});

describe("html escapes", () => {
  test("a string's <script>, quotes and & in text", async () => {
    expect(await render(html`<p>${HOSTILE}</p>`)).toBe(`<p>${ESCAPED}</p>`);
  });

  test("an attribute value can't be closed or extended", async () => {
    const attribute = `x" onmouseover="alert(1)`;
    const single = `x' autofocus onfocus='alert(1)`;
    expect(await render(html`<a title="${attribute}" data-x='${single}'>a</a>`)).toBe(
      `<a title="x&quot; onmouseover=&quot;alert(1)" data-x='x&#39; autofocus onfocus=&#39;alert(1)'>a</a>`,
    );
  });

  test("every item of an array, nested arrays flattened", async () => {
    expect(await render(html`<p>${["<b>", ["&", ["<i>"]]]}</p>`)).toBe(
      "<p>&lt;b&gt;&amp;&lt;i&gt;</p>",
    );
    const items = ["<li>", "a & b"].map((item) => html`<li>${item}</li>`);
    expect(await render(html`<ul>${items}</ul>`)).toBe(
      "<ul><li>&lt;li&gt;</li><li>a &amp; b</li></ul>",
    );
  });

  test("a promise's resolved string, and the result becomes a promise", async () => {
    const result = html`<p>${Promise.resolve(HOSTILE)}</p>`;
    expect(result).toBeInstanceOf(Promise);
    expect(await render(result)).toBe(`<p>${ESCAPED}</p>`);
    // Arrays of promises too.
    expect(await render(html`<p>${[Promise.resolve("<b>"), "&"]}</p>`)).toBe(
      "<p>&lt;b&gt;&amp;</p>",
    );
  });

  test("objects through their text, including String objects and Dates", async () => {
    const object = { toString: () => "<b>bold</b>" };
    expect(await render(html`<p>${object}</p>`)).toBe("<p>&lt;b&gt;bold&lt;/b&gt;</p>");
    // A boxed string is not a template result: only the brand Hono sets lets text through.
    expect(await render(html`<p>${new String("<b>")}</p>`)).toBe("<p>&lt;b&gt;</p>");
    expect(await render(html`<p>${new URL("https://example.org/?a=<b>&c")}</p>`)).toBe(
      "<p>https://example.org/?a=%3Cb%3E&amp;c</p>",
    );
  });

  test("numbers as written; booleans, null and undefined as nothing", async () => {
    expect(await render(html`<p>${42}|${true}|${false}|${null}|${undefined}</p>`)).toBe(
      "<p>42||||</p>",
    );
  });
});

describe("nested template results", () => {
  test("compose without double escaping", async () => {
    const inner = html`<b>${"&"}</b>`;
    expect(await render(html`<p>${inner}</p>`)).toBe("<p><b>&amp;</b></p>");
    expect(await render(html`<div>${html`<p>${inner}</p>`}</div>`)).toBe(
      "<div><p><b>&amp;</b></p></div>",
    );
  });

  test("compose when the inner result is a promise", async () => {
    const inner = html`<b>${Promise.resolve("<i>")}</b>`;
    expect(inner).toBeInstanceOf(Promise);
    expect(await render(html`<p>${inner}</p>`)).toBe("<p><b>&lt;i&gt;</b></p>");
    // A promise of a finished template result passes through once, unescaped.
    expect(await render(html`<p>${Promise.resolve(html`<b>x</b>`)}</p>`)).toBe("<p><b>x</b></p>");
  });
});

describe("raw is the only bypass", () => {
  test("raw markup passes as written", async () => {
    expect(await render(html`<p>${raw("<b>constant</b>")}</p>`)).toBe("<p><b>constant</b></p>");
  });

  test("values shaped like stored data can't forge the brand raw sets", async () => {
    // JSON can carry an isEscaped flag but never a toString method, so the forged value renders as
    // Object.prototype's text, not as markup.
    const forged: unknown = JSON.parse('{"isEscaped":true,"text":"<b>x</b>"}');
    expect(await render(html`<p>${forged}</p>`)).toBe("<p>[object Object]</p>");
    // A JSON string field named toString makes rendering fail loudly rather than inject.
    const broken: unknown = JSON.parse('{"isEscaped":true,"toString":"<b>x</b>"}');
    expect(() => html`<p>${broken}</p>`).toThrow(TypeError);
    // Text that merely names the brand is still text.
    expect(await render(html`<p>${'{"isEscaped":true}<b>'}</p>`)).toBe(
      "<p>{&quot;isEscaped&quot;:true}&lt;b&gt;</p>",
    );
  });

  test("a plain string is never markup, whatever it contains", async () => {
    for (const value of ["<b>x</b>", "&lt;b&gt;", "<!--", "]]>", "\u0000<"])
      expect(await render(html`${value}`)).not.toContain("<");
  });
});

describe("untrusted", () => {
  test("escapes inside a dir=auto span", async () => {
    expect(await render(untrusted(HOSTILE))).toBe(`<span dir="auto">${ESCAPED}</span>`);
  });

  test("keeps bidirectional controls inside the isolating element instead of stripping them", async () => {
    // U+202E (right-to-left override) would reorder the text after it; dir=auto isolates it.
    const name = "‮gnp.exe‬";
    expect(await render(html`<p>Server ${untrusted(name)} status</p>`)).toBe(
      `<p>Server <span dir="auto">${name}</span> status</p>`,
    );
  });
});

describe("href", () => {
  test("keeps same-origin paths and https URLs", () => {
    for (const value of ["/", "/g/123/status", "/login?to=%2Fg%2F1", "/a/b#c", "/%2F%2Fevil"])
      expect(href(value)).toBe(value);
    expect(href("https://github.com/deconfined/tarubot")).toBe(
      "https://github.com/deconfined/tarubot",
    );
    // The parsed form, so the browser and this check agree on the target.
    expect(href("https://EXAMPLE.org")).toBe("https://example.org/");
    expect(href("https://example.org/a?b=c#d")).toBe("https://example.org/a?b=c#d");
  });

  test("turns every other scheme, protocol-relative and malformed target into #", () => {
    for (const value of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "http://example.org/",
      "ftp://example.org/",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/ /evil.example",
      "/é",
      "g/1/status",
      "",
      "#",
      "https://user:secret@example.org/",
      "https://discord.com@evil.example/",
      "https://",
    ])
      expect({ value, href: href(value) }).toEqual({ value, href: "#" });
  });

  test("the result is still escaped by the template", async () => {
    expect(await render(html`<a href="${href('/a?b="c"&d')}">x</a>`)).toBe(
      '<a href="/a?b=&quot;c&quot;&amp;d">x</a>',
    );
  });
});
