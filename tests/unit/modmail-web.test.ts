/**
 * Mod mail's pages end to end (2.43.0): the real web server through the development harness on
 * loopback, its invented accounts signing in through the fake authorize page, and the harness's
 * in-memory ModMail with the real rules (tests/fixtures/modmail.ts). Plain form posts with the
 * session's token, as a browser without script sends them: the switch, replies, Close and its 409,
 * a member's 404 for someone else's case, what each audience sees, the navigation's on/off rule,
 * and no plaintext in the web's logs. Credential-free: invented IDs, nothing beyond loopback.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { pino } from "pino";
import { modmailKey } from "../../src/application/keys.js";
import { Services } from "../../src/bot/services.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { AccessResolver } from "../../src/web/access.js";
import { html } from "../../src/web/html.js";
import { DiscordSignIn } from "../../src/web/oauth.js";
import { formToken } from "../../src/web/sessions.js";
import { definePage, type Page as WebPage } from "../../src/web/page.js";
import { loadPages } from "../../src/web/pages.js";
import { createWebApp } from "../../src/web/server.js";
import { webSettings } from "../../src/web/settings.js";
import { MemorySessions } from "../fixtures/web-sessions.js";
import { UNREADABLE_TEXT, VISIBILITY_NOTICE } from "../../src/domain/modmail.js";
import {
  OPEN_CONFLICT,
  openedAlready,
  REPLY_RESENT,
  STATE_CONFLICT,
  WEB_OPEN_REFUSALS,
} from "../../src/web/views/modmail.js";
import {
  HARNESS_ACCOUNTS,
  HARNESS_GUILDS,
  type HarnessAccount,
  type HarnessStates,
  harnessModMailFor,
  startHarness,
} from "../fixtures/web-dev.js";

type Page = ReturnType<typeof parseHTML>["document"];

/** Whether this host can bind the IPv6 loopback, the harness's default interface. */
const ipv6Loopback = await (async () => {
  try {
    const probe = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
    try {
      return (await fetch(`http://[::1]:${probe.port}/`)).ok;
    } finally {
      await probe.stop(true);
    }
  } catch {
    return false;
  }
})();

const GUILD = HARNESS_GUILDS.example.id;
const INBOX = `/g/${GUILD}/modmail`;
const CASE = (number: number) => `${INBOX}/${number}`;
const CANARY = "canary-plaintext-modmail-5e2b";

/** A signed-in browser: a cookie jar, GETs, and form posts carrying the session's token. */
interface Browser {
  get(path: string): Promise<{ status: number; location: string | null; page: Page; text: string }>;
  post(
    path: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; location: string | null; page: Page; text: string }>;
}

/** Start the harness in `states` and run `body` with a browser per account it asks for. */
async function withHarness(
  states: HarnessStates,
  body: (signIn: (account: HarnessAccount) => Promise<Browser>, logs: string[]) => Promise<void>,
): Promise<void> {
  const logs: string[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void logs.push(line) });
  const harness = await startHarness({ states }, log);
  try {
    const signIn = async (account: HarnessAccount): Promise<Browser> => {
      const jar = new Map<string, string>();
      let token = "";
      const send = async (url: string | URL, init: RequestInit = {}) => {
        const response = await fetch(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
          },
          redirect: "manual",
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [pair = ""] = cookie.split(";");
          const [name = "", value = ""] = pair.split("=");
          jar.set(name, value);
        }
        return response;
      };
      const login = await send(new URL("/login", harness.url));
      const authorize = login.headers.get("location") ?? "";
      const choice = await (await send(authorize)).text();
      const approve = new RegExp(`href="(/oauth2/approve/[0-9a-f-]+/${account})"`, "u").exec(
        choice,
      )?.[1];
      const approved = await send(new URL(approve ?? "", authorize));
      const callback = await send(approved.headers.get("location") ?? "");
      expect(callback.status).toBe(303);
      const read = async (response: Response) => {
        const text = await response.text();
        const page = parseHTML(text).document;
        token = page.querySelector('input[name="form_token"]')?.getAttribute("value") ?? token;
        return { status: response.status, location: response.headers.get("location"), page, text };
      };
      return {
        get: async (path) => read(await send(new URL(path, harness.url))),
        post: async (path, fields) =>
          read(
            await send(new URL(path, harness.url), {
              method: "POST",
              headers: {
                origin: harness.url.origin,
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ form_token: token, ...fields }),
            }),
          ),
      };
    };
    await body(signIn, logs);
  } finally {
    await harness.stop();
  }
}

/** The navigation's labels on a page. */
const nav = (page: Page) =>
  [...page.querySelectorAll(".side-nav .nav-item")].map((link) => link.textContent?.trim());

/** A hidden field's value in the form whose op is `op`. */
const field = (page: Page, op: string, name: string) =>
  page
    .querySelector(`form:has(input[name="op"][value="${op}"]) input[name="${name}"]`)
    ?.getAttribute("value") ?? "";

describe.skipIf(!ipv6Loopback)("mod mail's pages, end to end", () => {
  test("off by default: officers see it and turn it on; members see it in their navigation only then", async () => {
    await withHarness({}, async (signIn) => {
      const member = await signIn("member");
      expect(nav((await member.get(`/g/${GUILD}/my-roles`)).page)).not.toContain("Mod mail");
      // The page itself still opens for them: their cases (none) and why they can't open one.
      const mine = await member.get(INBOX);
      expect(mine.status).toBe(200);
      expect(mine.page.body.textContent).toContain("Mod mail is turned off in this server");
      const officer = await signIn("officer");
      const inbox = await officer.get(INBOX);
      expect(nav(inbox.page)).toContain("Mod mail");
      expect(inbox.page.querySelector("#modmail-settings-title")?.textContent).toBe(
        "Mod mail is off",
      );
      const saved = await officer.post(INBOX, {
        op: "settings",
        enabled: "on",
        revision: field(inbox.page, "settings", "revision"),
      });
      expect(saved.status).toBe(303);
      expect(saved.location).toBe(`${INBOX}?notice=enabled#status`);
      const after = await officer.get(saved.location ?? "");
      expect(after.page.querySelector("#status")?.textContent).toContain("Mod mail turned on");
      // A repeat of the same form is "unchanged"; a members' POST to the switch is refused.
      const again = await officer.post(INBOX, { op: "settings", enabled: "on", revision: "1" });
      expect(again.location).toBe(`${INBOX}?notice=unchanged#status`);
      expect(
        (await member.post(INBOX, { op: "settings", enabled: "off", revision: "2" })).status,
      ).toBe(403);
      expect(nav((await member.get(`/g/${GUILD}/my-roles`)).page)).toContain("Mod mail");
    });
  });

  test("another member's case is the same plain 404 as a case that doesn't exist", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const member = await signIn("member");
      const own = await member.get(CASE(2));
      expect(own.status).toBe(200);
      const someoneElses = await member.get(CASE(3));
      const missing = await member.get(CASE(99));
      expect([someoneElses.status, missing.status]).toEqual([404, 404]);
      // Identical apart from the request's own Ref.
      const strip = (text: string) => text.replace(/Ref <code>[0-9a-f-]+<\/code>/gu, "");
      expect(strip(someoneElses.text)).toBe(strip(missing.text));
      expect(someoneElses.text).not.toContain("Can I join");
      // POSTs to it are refused the same way, and write nothing.
      const reply = await member.post(CASE(3), {
        op: "reply",
        id: "00000000-0000-4000-8000-000000000001",
        body: "Let me in",
      });
      expect(reply.status).toBe(404);
      // A malformed number is no page at all.
      expect((await member.get(`${INBOX}/0`)).status).toBe(404);
      expect((await member.get(`${INBOX}/x1`)).status).toBe(404);
    });
  });

  test("each audience's thread: the guest sees The officers; officers see who and the badge, and the read log", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const guest = await signIn("guest");
      const view = await guest.get(CASE(3));
      const authors = [...view.page.querySelectorAll(".modmail-message__by")].map((node) =>
        node.textContent?.trim(),
      );
      expect(authors).toEqual(["You", "The officers"]);
      expect(view.text).not.toContain(HARNESS_ACCOUNTS.officer.label);
      expect(view.text).not.toContain(HARNESS_ACCOUNTS.officer.id);
      expect(view.page.querySelector(".modmail-reads")).toBeNull();
      expect(view.page.querySelectorAll('input[name="signed"]')).toHaveLength(0);
      const officer = await signIn("officer");
      const officerView = await officer.get(CASE(3));
      const officerAuthors = [...officerView.page.querySelectorAll(".modmail-message__by")].map(
        (node) => node.textContent?.trim(),
      );
      expect(officerAuthors).toEqual([
        `${HARNESS_ACCOUNTS.guest.label} Member`,
        `${HARNESS_ACCOUNTS.officer.label} Signed as the officers`,
      ]);
      const log = officerView.page.querySelector(".modmail-reads")?.textContent ?? "";
      expect(log).toContain(HARNESS_ACCOUNTS.guest.label);
      // A topic that looks like markup is text.
      const inbox = await officer.get(INBOX);
      expect(inbox.page.querySelector(".modmail-topic b")).toBeNull();
      expect(inbox.text).toContain("&lt;b&gt;Raid night&lt;/b&gt;");
      // Someone who left reads as "A former member".
      expect(inbox.page.body.textContent).toContain("A former member");
    });
  });

  test("replies post to the new message's fragment; Close checks the revision (409 on a race)", async () => {
    await withHarness({ modmail: "cases" }, async (signIn, logs) => {
      const member = await signIn("member");
      const page = await member.get(CASE(2));
      const id = field(page.page, "reply", "id");
      const sent = await member.post(CASE(2), { op: "reply", id, body: `More detail ${CANARY}` });
      expect(sent.status).toBe(303);
      expect(sent.location).toBe(`${CASE(2)}#message-${id}`);
      // The same form again lands on the same message.
      const repeat = await member.post(CASE(2), { op: "reply", id, body: `More detail ${CANARY}` });
      expect(repeat.location).toBe(`${CASE(2)}#message-${id}`);
      const after = await member.get(CASE(2));
      expect(after.page.querySelector(`#message-${id}`)?.textContent).toContain(CANARY);
      // Empty text: 422 with the summary, and the form drawn again.
      const empty = await member.post(CASE(2), {
        op: "reply",
        id: field(after.page, "reply", "id"),
        body: "   ",
      });
      expect(empty.status).toBe(422);
      expect(empty.page.querySelector(".error-summary")?.textContent).toContain("Write a message.");
      const officer = await signIn("officer");
      const drawn = await officer.get(CASE(2));
      const revision = field(drawn.page, "close", "revision");
      // The member writes again before the officer presses Close.
      await member.post(CASE(2), {
        op: "reply",
        id: field((await member.get(CASE(2))).page, "reply", "id"),
        body: "One more thing",
      });
      const stale = await officer.post(CASE(2), { op: "close", revision });
      expect(stale.status).toBe(409);
      expect(stale.page.querySelector(".error-summary")?.textContent).toContain(STATE_CONFLICT);
      const closed = await officer.post(CASE(2), {
        op: "close",
        revision: field(stale.page, "close", "revision"),
      });
      expect(closed.location).toBe(`${CASE(2)}?notice=closed#status`);
      const memberView = await member.get(CASE(2));
      // The officer never replied here, so their close is signed as the officers for the member;
      // officers still see who it was.
      expect(memberView.page.querySelector(".modmail-line:last-child")?.textContent).toContain(
        "Closed by the officers",
      );
      expect(
        (await officer.get(CASE(2))).page.querySelector(".modmail-line:last-child")?.textContent,
      ).toContain(`Closed by ${HARNESS_ACCOUNTS.officer.label} Signed as the officers`);
      expect(memberView.page.querySelector("label[for='modmail-body']")?.textContent).toBe(
        "Reply to reopen this case",
      );
      // A forged signing value is refused whole; members can't Reopen.
      expect(
        (
          await member.post(CASE(2), {
            op: "reply",
            id: field(memberView.page, "reply", "id"),
            body: "x",
            signed: "admin",
          })
        ).status,
      ).toBe(400);
      expect((await member.post(CASE(2), { op: "reopen", revision: "1" })).status).toBe(403);
      // Plaintext never reaches the logs.
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) expect(line).not.toContain(CANARY);
    });
  });

  test("a member in a time-out can still read and answer their case", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const timedOut = await signIn("timedOut");
      const page = await timedOut.get(CASE(4));
      expect(page.status).toBe(200);
      const sent = await timedOut.post(CASE(4), {
        op: "reply",
        id: field(page.page, "reply", "id"),
        body: "Thank you for hearing me out.",
      });
      expect(sent.status).toBe(303);
    });
  });

  test("turned off: no navigation link for members, but their cases stay readable and repliable", async () => {
    await withHarness({ modmail: "off" }, async (signIn) => {
      const member = await signIn("member");
      expect(nav((await member.get(INBOX)).page)).not.toContain("Mod mail");
      const page = await member.get(CASE(2));
      expect(page.status).toBe(200);
      const sent = await member.post(CASE(2), {
        op: "reply",
        id: field(page.page, "reply", "id"),
        body: "Still there?",
      });
      expect(sent.status).toBe(303);
    });
  });

  test("an unreadable field and a missing key say so instead of failing", async () => {
    await withHarness({ modmail: "unreadable" }, async (signIn) => {
      const officer = await signIn("officer");
      const inbox = await officer.get(INBOX);
      expect(inbox.page.body.textContent).toContain(UNREADABLE_TEXT);
      expect((await officer.get(CASE(3))).page.body.textContent).toContain(UNREADABLE_TEXT);
    });
    await withHarness({ modmail: "nokey" }, async (signIn) => {
      const officer = await signIn("officer");
      const inbox = await officer.get(INBOX);
      expect(inbox.page.querySelector(".modmail-checks")?.textContent).toContain(
        "Encryption key isn't set",
      );
      expect(inbox.page.querySelector("button[disabled]")?.textContent).toBe("Turn mod mail on");
      const view = await officer.get(CASE(2));
      expect(view.page.body.textContent).toContain("can't be read or answered right now");
      expect(view.page.querySelector("textarea")).toBeNull();
    });
  });
});

/** The Open a case form's fields as its page drew them, with `topic` and `body` filled in. */
const openFields = (page: Page, topic: string, body: string) => ({
  op: "open",
  case: field(page, "open", "case"),
  topic,
  body,
});

/**
 * Open a case on the web (owner decision of 2026-10-11): Discord takes Use Application Commands
 * away during a time-out, so the Mod mail page opens cases too, through the same ModMail.open as
 * /modmail. Each test drives the real server through the harness's in-memory ModMail.
 */
describe.skipIf(!ipv6Loopback)("opening a case on the web, end to end", () => {
  test("a member opens a case: 303 to it with the notice, and the same form again lands on it", async () => {
    await withHarness({ modmail: "empty" }, async (signIn, logs) => {
      const member = await signIn("member");
      const page = await member.get(INBOX);
      const dialog = page.page.querySelector("dialog#modmail-open");
      expect(dialog?.querySelector("#modmail-open-note")?.textContent).toBe(VISIBILITY_NOTICE);
      const fields = openFields(page.page, "Raid times", `Can we move it? ${CANARY}`);
      const opened = await member.post(INBOX, fields);
      expect(opened.status).toBe(303);
      expect(opened.location).toBe(`${CASE(1)}?notice=opened#status`);
      // A double submit finds the case it made; it never opens a second one.
      const again = await member.post(INBOX, fields);
      expect(again.location).toBe(`${CASE(1)}?notice=opened#status`);
      const view = await member.get(opened.location ?? "");
      expect(view.page.querySelector("#status")?.textContent).toContain("Case opened.");
      expect(view.page.querySelector(".modmail-message__body")?.textContent).toContain(CANARY);
      const officer = await signIn("officer");
      const inbox = await officer.get(INBOX);
      expect(inbox.page.querySelectorAll(".modmail-inbox tbody tr")).toHaveLength(1);
      expect(inbox.page.querySelector(".modmail-topic")?.textContent).toContain("Raid times");
      expect((await member.get(CASE(2))).status).toBe(404);
      for (const line of logs) expect(line).not.toContain(CANARY);
    });
  });

  test("refused text is 422 with the form drawn open over an inert page, what was typed kept", async () => {
    await withHarness({ modmail: "empty" }, async (signIn) => {
      const member = await signIn("member");
      const page = await member.get(INBOX);
      const refused = await member.post(INBOX, openFields(page.page, "   ", "Kept <b>text</b>"));
      expect(refused.status).toBe(422);
      expect(refused.page.title.startsWith("Error: ")).toBe(true);
      const panel = refused.page.querySelector(".overlay--open");
      expect(panel?.getAttribute("aria-modal")).toBe("true");
      expect(panel?.querySelector(".error-summary")?.textContent).toContain("Add a topic.");
      // Kept, and escaped: linkedom reads a textarea's source, where a browser shows the text.
      expect(panel?.querySelector("textarea")?.textContent).toContain(
        "Kept &lt;b&gt;text&lt;/b&gt;",
      );
      expect(refused.text).not.toContain("Kept <b>text</b>");
      // The shell and the page under the panel are inert; only the panel takes focus.
      for (const selector of [".skip", ".sidebar", ".page-header", ".site-footer", ".lead"])
        expect(refused.page.querySelector(selector)?.hasAttribute("inert")).toBe(true);
      // The same minted ID comes back, so the corrected resend is still the one form.
      const fixed = await member.post(INBOX, {
        ...openFields(refused.page, "Raid times", "Kept text"),
      });
      expect(fixed.location).toBe(`${CASE(1)}?notice=opened#status`);
      expect(field(refused.page, "open", "case")).toBe(field(page.page, "open", "case"));
      // Too long counts characters, as Discord does: 100 emoji are a valid topic.
      const emoji = await member.post(
        INBOX,
        openFields((await member.get(INBOX)).page, "🙂".repeat(100), "x"),
      );
      expect(emoji.status).toBe(303);
      const long = await member.post(
        INBOX,
        openFields((await member.get(INBOX)).page, "x".repeat(101), "x"),
      );
      expect(long.status).toBe(422);
      expect(long.page.querySelector(".error-summary")?.textContent).toContain(
        "Keep the topic to 100 characters.",
      );
    });
  });

  test("at the limit the button says why; a form sent anyway is 409, drawn open with the reason", async () => {
    await withHarness({ modmail: "limit" }, async (signIn) => {
      const member = await signIn("member");
      const page = await member.get(INBOX);
      const button = page.page.querySelector("button.modmail-opener");
      expect(button?.hasAttribute("disabled")).toBe(true);
      expect(page.page.querySelector("#modmail-open-why")?.textContent).toBe(
        WEB_OPEN_REFUSALS.open_limit,
      );
      expect(page.page.querySelector("dialog")).toBeNull();
      // A form drawn before the limit was reached (from /modmail, say) is refused in its panel.
      // (The page has no form now, so the session's token comes from a case page's reply form.)
      await member.get(CASE(2));
      const stale = await member.post(INBOX, {
        op: "open",
        case: "00000000-0000-4000-8000-000000000000",
        topic: "One more",
        body: "Please",
      });
      expect(stale.status).toBe(409);
      expect(stale.page.querySelector(".overlay--open #modmail-open-error")?.textContent).toContain(
        WEB_OPEN_REFUSALS.open_limit,
      );
      expect(
        stale.page.querySelector('.overlay--open button[type="submit"]')?.hasAttribute("disabled"),
      ).toBe(true);
    });
    await withHarness({ modmail: "off" }, async (signIn) => {
      const member = await signIn("member");
      await member.get(CASE(2));
      const off = await member.post(INBOX, {
        op: "open",
        case: "00000000-0000-4000-8000-000000000000",
        topic: "Hello",
        body: "Anyone?",
      });
      expect(off.status).toBe(409);
      expect(off.page.querySelector("#modmail-open-error")?.textContent).toContain(
        WEB_OPEN_REFUSALS.off,
      );
    });
    await withHarness({ modmail: "nokey" }, async (signIn) => {
      const member = await signIn("member");
      expect((await member.get(INBOX)).page.querySelector("#modmail-open-why")?.textContent).toBe(
        WEB_OPEN_REFUSALS.key,
      );
    });
  });

  test("a member in a time-out opens a case on the web, where /modmail can't reach them", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const timedOut = await signIn("timedOut");
      const page = await timedOut.get(INBOX);
      expect(page.page.querySelector("button.modmail-opener")?.hasAttribute("disabled")).toBe(
        false,
      );
      const opened = await timedOut.post(INBOX, openFields(page.page, "Second appeal", "Please"));
      expect(opened.status).toBe(303);
      expect(opened.location).toBe(`${CASE(6)}?notice=opened#status`);
    });
  });

  test("text the browser's maxlength allows always gets the 422 with the text kept, never a 413", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const member = await signIn("member");
      const page = await member.get(INBOX);
      expect(page.page.querySelector("#modmail-open-body")?.getAttribute("maxlength")).toBe("8000");
      // The delta review's case: 7,300 CJK characters (about 66 KB urlencoded, over 64 KiB), and
      // the most the maxlength lets through, 8,000 (about 72 KB).
      for (const count of [7300, 8000]) {
        const body = "日".repeat(count);
        const refused = await member.post(INBOX, openFields(page.page, "Raid", body));
        expect({ count, status: refused.status }).toEqual({ count, status: 422 });
        expect(refused.page.querySelector("#modmail-open-body")?.textContent).toContain(body);
        expect(refused.page.querySelector(".error-summary")?.textContent).toContain(
          "Keep the message to 4,000 characters.",
        );
      }
      // The reply form too.
      const thread = await member.get(CASE(2));
      const reply = await member.post(CASE(2), {
        op: "reply",
        id: field(thread.page, "reply", "id"),
        body: "日".repeat(8000),
      });
      expect(reply.status).toBe(422);
      expect(reply.page.querySelector("#modmail-body")?.textContent).toContain("日".repeat(8000));
    });
  });

  test("the same form sent again with other text: 409 with the text kept, never a silent drop", async () => {
    await withHarness({ modmail: "empty" }, async (signIn) => {
      const member = await signIn("member");
      const page = await member.get(INBOX);
      const first = openFields(page.page, "Raid times", "First version");
      expect((await member.post(INBOX, first)).location).toBe(`${CASE(1)}?notice=opened#status`);
      // Edited, then sent again with the same minted ID (back, change, resend).
      const edited = await member.post(INBOX, { ...first, body: "Second version" });
      expect(edited.status).toBe(409);
      const error = edited.page.querySelector(".overlay--open #modmail-open-error");
      expect(error?.textContent).toContain(openedAlready(1n));
      expect(error?.querySelector("a")?.getAttribute("href")).toBe(CASE(1));
      expect(edited.page.querySelector("#modmail-open-body")?.textContent).toContain(
        "Second version",
      );
      // A fresh ID, so sending it as it is opens a second case; nothing was added to the first.
      expect(field(edited.page, "open", "case")).not.toBe(first.case);
      const thread = await member.get(CASE(1));
      expect(thread.page.querySelectorAll(".modmail-message")).toHaveLength(1);
      // A reply form resent with other text: 409, the first send in the thread, the new text kept.
      const id = field(thread.page, "reply", "id");
      expect((await member.post(CASE(1), { op: "reply", id, body: "Reply one" })).status).toBe(303);
      const resent = await member.post(CASE(1), { op: "reply", id, body: "Reply two" });
      expect(resent.status).toBe(409);
      expect(resent.page.querySelector(".error-summary")?.textContent).toContain(REPLY_RESENT);
      expect(resent.page.querySelector("#modmail-body")?.textContent).toContain("Reply two");
      expect(field(resent.page, "reply", "id")).not.toBe(id);
      expect(resent.page.querySelectorAll(".modmail-message")).toHaveLength(2);
      // The same reply sent again unchanged still lands on its message.
      expect((await member.post(CASE(1), { op: "reply", id, body: "Reply one" })).location).toBe(
        `${CASE(1)}#message-${id}`,
      );
    });
  });

  test("officers keep the inbox: no open form, and a forged one is refused whole", async () => {
    await withHarness({ modmail: "cases" }, async (signIn) => {
      const officer = await signIn("officer");
      const inbox = await officer.get(INBOX);
      expect(inbox.page.querySelector("#modmail-open, .modmail-opener")).toBeNull();
      const forged = await officer.post(INBOX, {
        op: "open",
        case: "00000000-0000-4000-8000-000000000000",
        topic: "Officer",
        body: "Case",
      });
      expect(forged.status).toBe(400);
      // A malformed minted ID is a form the page never drew.
      const member = await signIn("member");
      await member.get(INBOX);
      const bad = await member.post(INBOX, {
        op: "open",
        case: "not-a-uuid",
        topic: "t",
        body: "b",
      });
      expect(bad.status).toBe(400);
      // Someone else's case ID: 409, and the resend gets a fresh minted ID.
      const guest = await signIn("guest");
      const taken = (await guest.get(INBOX)).page;
      await guest.post(INBOX, openFields(taken, "Guest topic", "Guest body"));
      const copied = await member.post(INBOX, {
        op: "open",
        case: field(taken, "open", "case"),
        topic: "Copied",
        body: "Form",
      });
      expect(copied.status).toBe(409);
      expect(copied.page.querySelector("#modmail-open-error")?.textContent).toContain(
        OPEN_CONFLICT,
      );
      expect(field(copied.page, "open", "case")).not.toBe(field(taken, "open", "case"));
    });
  });
});

/**
 * The web framework's review fixes (2.43.0): mod mail's pages resolve the actor afresh on every
 * request (an officer removed or demoted loses them at once, not a minute later), and a page whose
 * navWhen throws synchronously only loses its own link.
 */
describe("fresh actors and safe navigation checks", () => {
  const GUILD_ID = HARNESS_GUILDS.example.id;
  const USER = HARNESS_ACCOUNTS.officer.id;

  /** A web app over `pages`, signed in as USER, whose resolver answers `facts()` each time. */
  async function app(pages: readonly WebPage[], facts: () => Partial<Actor>) {
    const parsed = webSettings({
      WEB_PUBLIC_ORIGIN: "http://localhost:8080",
      DISCORD_CLIENT_SECRET: "invented-client-secret",
      DISCORD_APPLICATION_ID: "300000000000000001",
    });
    if (parsed.status !== "on") throw new Error("Invalid test settings");
    let calls = 0;
    const resolve = async (guildId: string, userId: string): Promise<Actor> => {
      calls += 1;
      return {
        guildId,
        userId,
        officer: false,
        manageRoles: false,
        member: false,
        guest: false,
        botAdministrator: false,
        ...facts(),
      };
    };
    const sessions = new MemorySessions();
    const web = createWebApp({
      settings: parsed.settings,
      context: {
        services: new Services().provide(modmailKey, harnessModMailFor({ modmail: "cases" })),
        allowsGuild: () => true,
        isStopping: () => false,
        resolveActor: resolve,
        report: () => {},
        guilds: () => [{ id: GUILD_ID, name: "Example FC" }],
      },
      pages: new Map(pages.map((page) => [page.path, page])),
      sessions,
      signIn: new DiscordSignIn({
        clientId: parsed.settings.clientId,
        clientSecret: parsed.settings.clientSecret,
        redirectUri: parsed.settings.redirectUri,
      }),
      access: new AccessResolver(resolve),
      log: pino({ level: "silent" }),
    });
    const { token } = await sessions.create(USER);
    const get = async (path: string) => {
      const response = await web.request(`http://localhost:8080${path}`, {
        headers: { cookie: `tarubot=${token}` },
      });
      return { status: response.status, text: await response.text() };
    };
    // A form post as a browser sends it: same origin, with the session's form token.
    const post = async (path: string, fields: Record<string, string>) => {
      const response = await web.request(`http://localhost:8080${path}`, {
        method: "POST",
        headers: {
          cookie: `tarubot=${token}`,
          origin: "http://localhost:8080",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ form_token: formToken(token), ...fields }),
      });
      return {
        status: response.status,
        location: response.headers.get("location"),
        text: await response.text(),
      };
    };
    return { get, post, calls: () => calls };
  }

  test("only a member or guest now, with no Administrator for TaruBot, can open a case on the web", async () => {
    const all = await loadPages();
    const modmailPages = [...all.values()].filter((page) => page.path.includes("/modmail"));
    /** One form post by a user resolving to `facts` (null: removed from the server). */
    const open = async (facts: Partial<Actor> | null) => {
      // A web app each, so no answer memoized for an earlier post decides this one.
      const web = await app(modmailPages, () => {
        if (facts === null)
          throw new Failure("forbidden", "Not a member.", 0, {
            kind: "scope",
            scope: "current_member",
          });
        return facts;
      });
      return web.post(`/g/${GUILD_ID}/modmail`, {
        op: "open",
        case: "00000000-0000-4000-8000-000000000000",
        topic: "Please",
        body: "Read this",
      });
    };
    // Removed from the server: 404, as for any server they aren't in.
    expect((await open(null)).status).toBe(404);
    // A lobby newcomer (neither Member nor Guest) is refused by the page itself: 403.
    expect((await open({ member: false, guest: false })).status).toBe(403);
    // A2: a member or guest while TaruBot holds Administrator.
    expect((await open({ member: true, botAdministrator: true })).status).toBe(403);
    expect((await open({ guest: true, botAdministrator: true })).status).toBe(403);
    // A guest or member now, with no Administrator, in a time-out or not: opened, as case 6.
    for (const facts of [{ guest: true }, { member: true, timedOut: true }]) {
      const opened = await open(facts);
      expect(opened.status).toBe(303);
      expect(opened.location).toBe(`/g/${GUILD_ID}/modmail/6?notice=opened#status`);
    }
  });

  test("an officer demoted or removed loses mod mail's pages on the very next request", async () => {
    const all = await loadPages();
    const modmailPages = [...all.values()].filter((page) => page.path.includes("/modmail"));
    expect(modmailPages.map((page) => page.freshActor)).toEqual([true, true]);
    const control = definePage({
      path: "/g/:guild/control",
      title: "Control",
      access: ["officer"],
      requires: [],
      get: () => html`<p>control</p>`,
    });
    let officer = true;
    let removed = false;
    const web = await app([...modmailPages, control], () => {
      if (removed)
        throw new Failure("forbidden", "Not a member.", 0, {
          kind: "scope",
          scope: "current_member",
        });
      return { officer };
    });
    expect((await web.get(`/g/${GUILD_ID}/modmail`)).status).toBe(200);
    expect((await web.get(`/g/${GUILD_ID}/modmail/3`)).status).toBe(200);
    expect((await web.get(`/g/${GUILD_ID}/control`)).status).toBe(200);
    officer = false;
    // A page without freshActor still answers from the minute-long memo...
    expect((await web.get(`/g/${GUILD_ID}/control`)).status).toBe(200);
    // ...but mod mail's resolve afresh: the demoted officer is refused at once.
    expect((await web.get(`/g/${GUILD_ID}/modmail`)).status).toBe(403);
    expect((await web.get(`/g/${GUILD_ID}/modmail/3`)).status).toBe(403);
    // Removed from the server: not a member any more, so 404, as for any server they aren't in.
    removed = true;
    const gone = await web.get(`/g/${GUILD_ID}/modmail/3`);
    expect(gone.status).toBe(404);
    expect(gone.text).not.toContain("Can I join");
  });

  test("a navWhen that throws synchronously hides only its own link", async () => {
    const plain = definePage({
      path: "/g/:guild/plain",
      title: "Plain",
      access: ["officer"],
      requires: [],
      nav: "Plain",
      get: () => html`<p>plain page</p>`,
    });
    const flaky = definePage({
      path: "/g/:guild/flaky",
      title: "Flaky",
      access: ["officer"],
      requires: [],
      nav: "Flaky",
      navWhen: () => {
        throw new Error("sync failure in navWhen");
      },
      get: () => html`<p>flaky</p>`,
    });
    const web = await app([plain, flaky], () => ({ officer: true }));
    const page = await web.get(`/g/${GUILD_ID}/plain`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(">Plain<");
    expect(page.text).not.toContain(">Flaky<");
    // The page itself still opens: navWhen only ever hides a link.
    expect((await web.get(`/g/${GUILD_ID}/flaky`)).status).toBe(200);
    expect((await web.get("/?servers")).status).toBe(200);
  });
});
