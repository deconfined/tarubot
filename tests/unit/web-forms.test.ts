/**
 * The form view kit (src/web/views/forms.ts), rendered with invented wording and
 * hostile values and parsed by linkedom: every POST form carries the form token first and posts to
 * this origin; every control has a `<label for>` or a `<legend>`, a unique id, and hints and errors
 * tied to it; a re-render keeps the submitted values, escaped; the error summary links to each
 * problem; a destructive button sits only inside a disclosure; and a notice shows only sentences
 * from the page's own table.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { html, type SafeHtml } from "../../src/web/html.js";
import { FORM_TOKEN_FIELD } from "../../src/web/http.js";
import { safeReturnPath } from "../../src/web/return-path.js";
import {
  choiceGroup,
  context,
  disclosure,
  errorSummary,
  hidden,
  NOTICE_ID,
  NOTICE_PARAM,
  notice,
  noticeLocation,
  numberField,
  postForm,
  selectField,
  submitButton,
  textField,
  tokenField,
} from "../../src/web/views/forms.js";
import { HOSTILE_INPUT, KIT_DEFAULTS, KIT_ERRORS, kitForm } from "../fixtures/web-forms.js";

const ACTION = "/g/100000000000000001/role-menu";
const TOKEN = Buffer.from("form-token-for-tests-00000000000").toString("base64url");

/** A fragment rendered and parsed as a page body. */
async function body(value: SafeHtml): Promise<{ markup: string; document: Document }> {
  const markup = String(await value);
  const { document } = parseHTML(`<!doctype html><html lang="en"><body>${markup}</body></html>`);
  return { markup, document };
}

/** Every element id on the page, in order. */
const ids = (document: Document): string[] =>
  [...document.querySelectorAll("[id]")].map((element) => element.getAttribute("id") ?? "");

describe("postForm and hidden fields", () => {
  test("a form posts to its same-origin action, with the token first and no browser bubbles", async () => {
    const { document } = await body(postForm({ action: ACTION, token: TOKEN }, hidden("op", "x")));
    const form = document.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe(ACTION);
    expect(form?.getAttribute("class")).toBe("form");
    expect(form?.hasAttribute("novalidate")).toBe(true);
    const fields = [...(form?.querySelectorAll("input") ?? [])].map((input) => [
      input.getAttribute("type"),
      input.getAttribute("name"),
      input.getAttribute("value"),
    ]);
    expect(fields).toEqual([
      ["hidden", FORM_TOKEN_FIELD, TOKEN],
      ["hidden", "op", "x"],
    ]);
    const extra = await body(postForm({ action: ACTION, token: TOKEN, className: "move" }, html``));
    expect(extra.document.querySelector("form")?.getAttribute("class")).toBe("form move");
    expect(String(await tokenField(TOKEN))).toBe(
      `<input type="hidden" name="${FORM_TOKEN_FIELD}" value="${TOKEN}">`,
    );
  });

  test("an action off this origin, and a page's own token field, are page bugs", () => {
    for (const action of [
      "//evil.example/",
      "/\\evil.example",
      "https://example.org/g/1/x",
      "javascript:alert(1)",
      "relative",
      "",
      "/a b",
    ])
      expect(() => postForm({ action, token: TOKEN }, html``)).toThrow(
        "A form must post to a same-origin path.",
      );
    expect(() => hidden(FORM_TOKEN_FIELD, "x")).toThrow("postForm()'s alone");
  });

  test("hidden values are escaped attribute text", async () => {
    const { markup, document } = await body(hidden("id", HOSTILE_INPUT));
    expect(document.querySelector("input")?.getAttribute("value")).toBe(HOSTILE_INPUT);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(markup).not.toContain("<img");
  });
});

describe("fields and groups", () => {
  test("every control has a label or legend, a unique id, and its hint and error tied to it", async () => {
    const { document } = await body(kitForm(ACTION, TOKEN, KIT_DEFAULTS, KIT_ERRORS));
    const all = ids(document);
    expect(new Set(all).size).toBe(all.length);
    const controls = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')];
    expect(controls.length).toBe(9);
    for (const control of controls) {
      const id = control.getAttribute("id") ?? "";
      expect(id).not.toBe("");
      expect(control.getAttribute("name") ?? "").not.toBe("");
      const labels = document.querySelectorAll(`label[for="${id}"]`);
      expect({ id, labels: labels.length }).toEqual({ id, labels: 1 });
      expect((labels[0]?.textContent ?? "").trim()).not.toBe("");
      for (const described of (control.getAttribute("aria-describedby") ?? "").split(" "))
        if (described !== "")
          expect({ id, described, found: document.getElementById(described) !== null }).toEqual({
            id,
            described,
            found: true,
          });
    }
    // Checkboxes and radios sit in fieldsets with a visible legend; the group carries its hint
    // and error.
    const groups = [...document.querySelectorAll("fieldset")];
    expect(groups.map((group) => group.getAttribute("id"))).toEqual(["kit-roles", "kit-state"]);
    for (const group of groups) {
      expect((group.querySelector("legend")?.textContent ?? "").trim()).not.toBe("");
      expect(group.firstElementChild?.tagName.toLowerCase()).toBe("legend");
    }
    expect(document.querySelector("#kit-roles")?.getAttribute("aria-describedby")).toBe(
      "kit-roles-hint kit-roles-error",
    );
    for (const choice of document.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      expect(choice.closest("fieldset")).not.toBeNull();
    // Only the field with a problem is invalid, and its error is announced as one.
    expect(
      [...document.querySelectorAll('[aria-invalid="true"]')].map((element) => element.id),
    ).toEqual(["kit-name"]);
    expect(document.querySelector("#kit-name")?.getAttribute("aria-describedby")).toBe(
      "kit-name-hint kit-name-error",
    );
    expect(document.querySelector("#kit-name-error")?.textContent).toBe(
      "Error: Enter a name of at most 40 characters.",
    );
    expect(document.querySelector("#kit-name-error .visually-hidden")?.textContent).toBe("Error: ");
    // A choice's own hint describes it without becoming part of its name.
    expect(document.querySelector("#kit-roles-1")?.getAttribute("aria-describedby")).toBe(
      "kit-roles-1-hint",
    );
    expect(document.querySelector('label[for="kit-roles-1"]')?.textContent).toBe("He/Him");
  });

  test("a re-render keeps every submitted value, escaped, and never as markup", async () => {
    const values = {
      name: HOSTILE_INPUT,
      description: `\n${HOSTILE_INPUT}\n</textarea><b>x</b>`,
      position: "not a number",
      max: "2",
      roles: ["300000000000000001", "300000000000000003"],
      state: "removal_only",
    };
    const { markup, document } = await body(kitForm(ACTION, TOKEN, values, KIT_ERRORS));
    expect(document.querySelectorAll("img, b")).toHaveLength(0);
    expect(markup).not.toContain("<img");
    expect(document.querySelector("#kit-name")?.getAttribute("value")).toBe(HOSTILE_INPUT);
    // The textarea's value survives whole and escaped, so it can't close the element early. A
    // browser drops the one newline after the start tag (linkedom keeps it, and the escapes), so
    // one is written there and the value's own leading newline stays.
    const escaped = values.description
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    expect(markup).toContain(`autocomplete="off" maxlength="200">\n${escaped}</textarea>`);
    expect(markup.match(/<\/textarea>/gu)).toHaveLength(1);
    expect(document.querySelector("#kit-position")?.getAttribute("value")).toBe("not a number");
    expect(
      [...document.querySelectorAll("#kit-max option")].map((option) => [
        option.getAttribute("value"),
        option.hasAttribute("selected"),
      ]),
    ).toEqual([
      ["", false],
      ["1", false],
      ["2", true],
    ]);
    const checked = (selector: string) =>
      [...document.querySelectorAll(selector)]
        .filter((input) => input.hasAttribute("checked"))
        .map((input) => input.getAttribute("value"));
    expect(checked('input[name="roles"]')).toEqual(["300000000000000001", "300000000000000003"]);
    expect(checked('input[name="state"]')).toEqual(["removal_only"]);
    // A disabled choice stays disabled whatever was submitted.
    expect(document.querySelector("#kit-roles-3")?.hasAttribute("disabled")).toBe(true);
  });

  test("single fields render their constraints and states", async () => {
    const { document } = await body(
      html`${textField({ id: "a", name: "a", label: "A", required: true, disabled: true, maxLength: 9 })}${numberField({ id: "b", name: "b", label: "B", value: 3, min: 1, max: 25 })}${selectField({ id: "c", name: "c", label: "C", value: "zz", options: [{ value: "x", label: "X" }] })}`,
    );
    const a = document.querySelector("#a");
    expect([a?.hasAttribute("required"), a?.hasAttribute("disabled")]).toEqual([true, true]);
    expect(a?.getAttribute("maxlength")).toBe("9");
    expect(a?.getAttribute("autocomplete")).toBe("off");
    expect(a?.hasAttribute("aria-describedby")).toBe(false);
    expect(a?.hasAttribute("aria-invalid")).toBe(false);
    const b = document.querySelector("#b");
    expect([
      b?.getAttribute("type"),
      b?.getAttribute("inputmode"),
      b?.getAttribute("value"),
    ]).toEqual(["number", "numeric", "3"]);
    expect([b?.getAttribute("min"), b?.getAttribute("max"), b?.getAttribute("step")]).toEqual([
      "1",
      "25",
      "1",
    ]);
    // An unknown value selects nothing, so the browser shows the first option.
    expect(document.querySelectorAll("#c option[selected]")).toHaveLength(0);
    for (const control of document.querySelectorAll("input, select"))
      expect(control.getAttribute("class")).toBe("orr-input");
    // Nothing takes focus unless asked: only an editor's first choice, as its dialog opens.
    expect(document.querySelectorAll("[autofocus]")).toHaveLength(0);
  });

  test("autofocus marks one control: a group's first choice that can take focus", async () => {
    const { document } = await body(
      html`${choiceGroup({
        id: "g",
        name: "g",
        type: "checkbox",
        legend: "G",
        autofocus: true,
        choices: [
          { value: "x", label: "X", disabled: true },
          { value: "y", label: "Y" },
          { value: "z", label: "Z" },
        ],
      })}${choiceGroup({
        id: "h",
        name: "h",
        type: "radio",
        legend: "H",
        choices: [{ value: "x", label: "X" }],
      })}`,
    );
    expect([...document.querySelectorAll("[autofocus]")].map((element) => element.id)).toEqual([
      "g-2",
    ]);
  });

  test("an id the kit would link to must be a plain identifier", () => {
    for (const id of ["", "1abc", "a b", 'a"b', "a#b", "a.b"]) {
      expect(() => textField({ id, name: "x", label: "X" })).toThrow("A form control id must be");
      expect(() => choiceGroup({ id, name: "x", type: "radio", legend: "X", choices: [] })).toThrow(
        "A form control id must be",
      );
      expect(() => errorSummary([{ id, message: "X" }])).toThrow("A form control id must be");
    }
  });
});

describe("the error summary", () => {
  test("takes focus, is announced, and links to each problem in page order", async () => {
    const { document } = await body(kitForm(ACTION, TOKEN, KIT_DEFAULTS, KIT_ERRORS));
    const summary = document.querySelector(".error-summary");
    expect(summary).toBe(document.body.firstElementChild);
    expect(summary?.getAttribute("role")).toBe("alert");
    expect(summary?.getAttribute("tabindex")).toBe("-1");
    expect(summary?.hasAttribute("autofocus")).toBe(true);
    expect(summary?.getAttribute("aria-labelledby")).toBe("error-summary-title");
    expect(document.querySelector("#error-summary-title")?.textContent).toBe("There's a problem");
    const links = [...(summary?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual(
      KIT_ERRORS.map((error) => [`#${error.id}`, error.message]),
    );
    for (const link of links)
      expect(document.getElementById((link.getAttribute("href") ?? "").slice(1))).not.toBeNull();
  });

  test("no errors, no summary", async () => {
    expect(String(await errorSummary([]))).toBe("");
    const { document } = await body(kitForm(ACTION, TOKEN));
    expect(document.querySelectorAll(".error-summary, [aria-invalid]")).toHaveLength(0);
  });
});

describe("buttons, disclosures and repeated names", () => {
  test("buttons have visible text; the destructive one sits inside a disclosure", async () => {
    const { document } = await body(kitForm(ACTION, TOKEN));
    for (const button of document.querySelectorAll("button")) {
      expect(button.getAttribute("type")).toBe("submit");
      expect((button.textContent ?? "").trim()).not.toBe("");
    }
    const danger = [...document.querySelectorAll(".orr-btn--danger")];
    expect(danger).toHaveLength(1);
    for (const button of danger) expect(button.closest("details.disclosure")).not.toBeNull();
    // The disclosure states the consequence before its button, and opens without script.
    const details = document.querySelector("details.disclosure");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Delete category: Pronouns");
    expect(details?.querySelector(".disclosure__body p")?.textContent).toContain(
      "People keep these roles",
    );
    const publish = document.querySelector(".orr-btn--primary");
    expect([publish?.getAttribute("name"), publish?.getAttribute("value")]).toEqual([
      "after",
      "publish",
    ]);
    expect(document.querySelector("button:not([name])")?.getAttribute("class")).toBe(
      "orr-btn orr-btn--secondary",
    );
    const open = await body(disclosure("Edit", html`<p>x</p>`, { open: true }));
    expect(open.document.querySelector("details")?.hasAttribute("open")).toBe(true);
    const disabled = await body(submitButton("Save", { disabled: true }));
    expect(disabled.document.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("context() names a repeated control's subject for assistive technology only", async () => {
    const hostile = "‮evil‬ <b>Role</b>";
    const { document } = await body(
      html`<button type="submit">Move up${context(hostile)}</button>`,
    );
    const button = document.querySelector("button");
    // The accessible name is unique per subject; the visible label stays "Move up".
    expect(button?.textContent).toBe(`Move up: ${hostile}`);
    const suffix = button?.querySelector(".visually-hidden");
    expect(suffix?.textContent).toBe(`: ${hostile}`);
    expect(suffix?.querySelector('[dir="auto"]')?.textContent).toBe(hostile);
    expect(document.querySelectorAll("b")).toHaveLength(0);
  });
});

describe("notices after post-redirect-get", () => {
  const NOTICES = { saved: "Saved.", published: "Published. Members can pick these roles now." };

  test("the redirect target carries the token and the notice's fragment, and stays same-origin", () => {
    const location = noticeLocation(ACTION, "saved");
    expect(location).toBe(`${ACTION}?${NOTICE_PARAM}=saved#${NOTICE_ID}`);
    expect(safeReturnPath(location)).toBe(location);
  });

  test("only a token in the page's table shows, as its sentence; nothing else is reflected", async () => {
    const shown = await body(
      notice(new URL(`https://example.org${noticeLocation(ACTION, "published")}`), NOTICES),
    );
    const paragraph = shown.document.querySelector(`#${NOTICE_ID}`);
    expect(paragraph?.textContent).toBe(NOTICES.published);
    expect(paragraph?.getAttribute("role")).toBe("status");
    expect(paragraph?.getAttribute("class")).toBe("notice notice--success");
    for (const query of [
      "",
      "?notice=",
      "?notice=unknown",
      "?notice=%3Cimg%20src%3Dx%3E",
      "?notice=__proto__",
      "?notice=toString",
      "?notice=constructor",
      "?other=saved",
    ])
      expect({
        query,
        markup: String(await notice(new URL(`https://example.org${ACTION}${query}`), NOTICES)),
      }).toEqual({ query, markup: "" });
  });
});
