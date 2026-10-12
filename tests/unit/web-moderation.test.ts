/**
 * The Moderation page end to end (2.45.0): the real web server through the development harness on
 * loopback, its invented accounts signing in through the fake authorize page, and the harness's
 * in-memory Moderation with the real rules (tests/fixtures/web-dev.ts). Plain form posts with the
 * session's token, as a browser without script sends them: the lists, the finder, pausing and
 * lifting, every refusal the form shows again, the pages a pause changes for the person it
 * pauses (My roles, Mod mail), and who is turned away. The recent-sign-in gate itself is in
 * web-server.test.ts, on a clock the test controls. Credential-free: invented IDs, nothing beyond
 * loopback.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { pino } from "pino";
import { type PauseDuration, PAUSE_DURATIONS } from "../../src/domain/moderation.js";
import { actorOf } from "../fixtures/actors.js";
import { HARNESS_FORMER_MEMBER, HARNESS_SECOND_OFFICER } from "../fixtures/modmail.js";
import {
  HARNESS_ACCOUNTS,
  HARNESS_GUILDS,
  type HarnessAccount,
  type HarnessStates,
  harnessModerationFor,
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
const PAGE = `/g/${GUILD}/moderation`;
const MY_ROLES = `/g/${GUILD}/my-roles`;
const MODMAIL = `/g/${GUILD}/modmail`;
const OFFICER = HARNESS_ACCOUNTS.officer.id;
const MEMBER = HARNESS_ACCOUNTS.member.id;
const GUEST = HARNESS_ACCOUNTS.guest.id;
const TIMED_OUT = HARNESS_ACCOUNTS.timedOut.id;
const MANAGER = HARNESS_ACCOUNTS.manager.id;
const BOT = HARNESS_ACCOUNTS.bot.id;
/** A well-formed ID of nobody TaruBot has ever seen. */
const STRANGER = "200000000000000099";

/** One response: its status, where it points, its page and its text. */
interface Answer {
  readonly status: number;
  readonly location: string | null;
  readonly page: Page;
  readonly text: string;
}

/** A signed-in browser: a cookie jar, GETs, and form posts carrying the session's token. */
interface Browser {
  get(path: string): Promise<Answer>;
  /** A field's value may be several (the features ticked). */
  post(path: string, fields: Record<string, string | string[]>): Promise<Answer>;
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
      const read = async (response: Response): Promise<Answer> => {
        const text = await response.text();
        const page = parseHTML(text).document;
        token = page.querySelector('input[name="form_token"]')?.getAttribute("value") ?? token;
        return { status: response.status, location: response.headers.get("location"), page, text };
      };
      // Any page carries the session's form token (the account menu's forms): read one now, so a
      // first POST has it, as it would from a browser that opened a page first.
      await read(await send(new URL(`/g/${GUILD}/my-roles`, harness.url)));
      return {
        get: async (path) => read(await send(new URL(path, harness.url))),
        post: async (path, fields) => {
          const body = new URLSearchParams({ form_token: token });
          for (const [name, value] of Object.entries(fields))
            for (const one of Array.isArray(value) ? value : [value]) body.append(name, one);
          return read(
            await send(new URL(path, harness.url), {
              method: "POST",
              headers: {
                origin: harness.url.origin,
                "content-type": "application/x-www-form-urlencoded",
              },
              body,
            }),
          );
        },
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

/** The ids a page holds more than once: none, or a label's `for` could name the wrong control. */
const duplicateIds = (page: Page): (string | null)[] => {
  const ids = [...page.querySelectorAll("[id]")].map((element) => element.getAttribute("id"));
  return ids.filter((id, at) => ids.indexOf(id) !== at);
};

/** An element's text with the whitespace between template lines collapsed. */
const words = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
const wordsOf = (page: Page, selector: string): string[] =>
  [...page.querySelectorAll(selector)].map(words);

/** The people the page lists as paused, in order, with the features of each. */
const paused = (page: Page): [string, string[]][] =>
  [...page.querySelectorAll(".mod-people > .mod-person")].map((card) => [
    words(card.querySelector(".mod-person__name")),
    wordsOf(card as unknown as Page, ".mod-pause__feature"),
  ]);

/** A pause form's fields for `member`: the features ticked, a week or `duration`, a reason. */
const block = (
  member: string,
  features: string[],
  reason = "Because.",
  duration = "1w",
): Record<string, string | string[]> => ({
  op: "block",
  member,
  feature: features,
  duration,
  reason,
});

const lift = (member: string, feature: string, reason = "Sorted out."): Record<string, string> => ({
  op: "lift",
  member,
  feature,
  reason,
});

describe.skipIf(!ipv6Loopback)("Moderation, end to end", () => {
  test("an officer sees the pauses by person, newest first, and the ended ones with their ending", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const answer = await officer.get(PAGE);
      expect(answer.status).toBe(200);
      expect(answer.page.title).toBe("Moderation · TaruBot");
      expect(nav(answer.page)).toContain("Moderation");
      // The member's two (the newest first), the former member's, and the guest's.
      expect(paused(answer.page)).toEqual([
        [
          `${HARNESS_ACCOUNTS.member.label} ${MEMBER}`,
          ["Reporting problems (/issue)", "Suggesting features (/suggest)"],
        ],
        [`${HARNESS_FORMER_MEMBER} Left the server`, ["Recording ledger deposits"]],
        [`${HARNESS_ACCOUNTS.guest.label} ${GUEST}`, ["Opening mod mail cases"]],
      ]);
      // Who set each, by level; the guest's was a server manager's.
      expect(
        wordsOf(answer.page, ".mod-pause__by").map((line) => line.replace(/ on .*/u, "")),
      ).toEqual([
        `Set by ${HARNESS_ACCOUNTS.officer.label} (officer)`,
        `Set by ${HARNESS_ACCOUNTS.officer.label} (officer)`,
        `Set by ${HARNESS_ACCOUNTS.manager.label} (server manager)`,
        `Set by ${HARNESS_ACCOUNTS.manager.label} (server manager)`,
      ]);
      // One ran out, one was lifted with a reason.
      expect(
        [...answer.page.querySelectorAll(".mod-dones > .mod-done")].map((entry) => [
          words(entry.querySelector(".mod-done__feature")),
          words(entry.querySelector(".mod-done__how")).replace(/ \d{4}-.*/u, ""),
          words(entry.querySelector(".mod-done__why")),
        ]),
      ).toEqual([
        [
          "Suggesting features (/suggest)",
          `Lifted by ${HARNESS_ACCOUNTS.officer.label} on`,
          "They apologised in a mod mail case.",
        ],
        ["Roster checks (/refresh)", "Ran out", ""],
      ]);
      // Without them, an empty page.
    });
    await withHarness({}, async (signIn) => {
      const answer = await (await signIn("officer")).get(PAGE);
      expect(answer.status).toBe(200);
      expect(wordsOf(answer.page, ".empty-state p")[0]).toBe("Nobody is paused.");
      expect(answer.page.querySelectorAll(".mod-person")).toHaveLength(0);
    });
  });

  test("the finder reads an ID, a mention or a suggestion's number, and says plainly when there is no record", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const find = (text: string) => officer.get(`${PAGE}?find=${encodeURIComponent(text)}`);
      // A suggestion: its sender, who has two pauses.
      const sent = await find("#7");
      expect(sent.status).toBe(200);
      expect(words(sent.page.querySelector(".mod-found__line"))).toBe(
        `Suggestion #7 was sent by ${HARNESS_ACCOUNTS.member.label} ${MEMBER}.`,
      );
      expect(wordsOf(sent.page, ".mod-found .mod-pause__feature")).toEqual([
        "Reporting problems (/issue)",
        "Suggesting features (/suggest)",
      ]);
      // The sender is also in the list below, so the same Lift panels are on the page twice.
      expect(sent.page.querySelectorAll("dialog[id^=mod-lift-]").length).toBeGreaterThan(2);
      expect(duplicateIds(sent.page)).toEqual([]);
      expect(wordsOf(sent.page, ".mod-found .mod-done__feature")).toEqual([
        "Roster checks (/refresh)",
      ]);
      // The sender has left: named by ID.
      expect(words((await find("#9")).page.querySelector(".mod-found__line"))).toBe(
        `Suggestion #9 was sent by ${HARNESS_FORMER_MEMBER} Left the server.`,
      );
      // No record, and a number that can't be one.
      for (const text of ["#999", "#1"]) {
        const lost = await find(text);
        expect(lost.page.querySelector(".mod-found")).toBeNull();
        expect(lost.page.querySelector(".empty-state p")?.textContent).toBe(
          `There is no record of who sent suggestion ${text} in this server.`,
        );
      }
      // An ID and a mention find the same person; the field keeps what was typed.
      for (const text of [GUEST, `<@${GUEST}>`, `<@!${GUEST}>`]) {
        const guest = await find(text);
        expect(words(guest.page.querySelector(".mod-found__name"))).toBe(
          `${HARNESS_ACCOUNTS.guest.label} ${GUEST}`,
        );
        expect(guest.page.querySelector("#mod-find")?.getAttribute("value")).toBe(text);
      }
      // Someone with no pauses and no history is "Not paused", and can still be paused from here.
      const nobody = await find(TIMED_OUT);
      expect(words(nobody.page.querySelector(".mod-found__none"))).toBe("Not paused.");
      expect(nobody.page.querySelector(".mod-found button.mod-opener")?.textContent).toBe("Pause");
      // Yourself: no Pause.
      const self = await find(OFFICER);
      expect(self.page.querySelector(".mod-found button")).toBeNull();
      // Text it can't read: the field says so, with the page still there.
      const unreadable = await find("hello");
      expect(unreadable.status).toBe(200);
      expect(words(unreadable.page.querySelector("#mod-find-error"))).toContain(
        "Enter a member's ID or mention, or a suggestion number such as #123.",
      );
      expect(unreadable.page.querySelector(".mod-found")).toBeNull();
      expect(unreadable.page.querySelectorAll(".mod-person")).toHaveLength(3);
      // Empty text is no lookup at all.
      expect((await find("")).page.querySelector("#mod-find-error")).toBeNull();
    });
  });

  test("pausing sets the pause, shows it at once, and the person sees it on My roles without the issuer", async () => {
    await withHarness({}, async (signIn) => {
      const officer = await signIn("officer");
      const done = await officer.post(
        PAGE,
        block(MEMBER, ["selfroles.use"], "Too many role changes.", "1d"),
      );
      expect(done.status).toBe(303);
      expect(done.location).toBe(`${PAGE}?notice=paused&find=${MEMBER}#status`);
      // Back on the page: the fixed notice, and the person with the new chip and its end.
      const after = await officer.get(done.location ?? "");
      expect(words(after.page.querySelector("#status"))).toContain("Pause set.");
      expect(paused(after.page)).toEqual([
        [`${HARNESS_ACCOUNTS.member.label} ${MEMBER}`, ["Picking roles on My roles"]],
      ]);
      const end = after.page.querySelector(".mod-found .mod-until time")?.getAttribute("datetime");
      const seconds = ((Date.parse(end ?? "") - Date.now()) / 1000) | 0;
      expect(seconds).toBeGreaterThan(PAUSE_DURATIONS["1d"].seconds - 60);
      expect(seconds).toBeLessThanOrEqual(PAUSE_DURATIONS["1d"].seconds);
      expect(words(after.page.querySelector(".mod-found .mod-pause__reason"))).toBe(
        "Too many role changes.",
      );
      // The paused person's page: the pause, its end and the reason; no form to save with. (A
      // plain GET page may lag up to a minute behind a pause, from the actor memo, as it does
      // behind any role change; they sign in after it, which resolves them afresh, and a save is
      // always judged on a fresh actor.)
      const member = await signIn("member");
      const theirs = await member.get(MY_ROLES);
      expect(theirs.status).toBe(200);
      const callout = words(theirs.page.querySelector(".my-roles-callouts .notice"));
      expect(callout).toMatch(
        /^Your use of My roles is paused until \d{4}-\d\d-\d\d \d\d:\d\d UTC: Too many role changes\.$/u,
      );
      expect(theirs.page.querySelectorAll("main form, main button")).toHaveLength(0);
      for (const text of [HARNESS_ACCOUNTS.officer.label, OFFICER, "Set by", "paused by"])
        expect({ text, shown: theirs.text.includes(text) }).toEqual({ text, shown: false });
      // A save sent anyway is refused as a pause, not as a missing role.
      const forged = await member.post(MY_ROLES, { shown: "00000000-0000-4000-8000-000000000001" });
      expect(forged.status).toBe(403);
      // The pause is deny-only: the page, their roles and the rest of TaruBot are untouched.
      expect(nav(theirs.page)).toContain("My roles");
    });
  });

  test("lifting ends it, says who did and why, and a second lift finds nothing to lift", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const done = await officer.post(PAGE, lift(MEMBER, "suggest.use", "They stopped."));
      expect(done.status).toBe(303);
      expect(done.location).toBe(`${PAGE}?notice=lifted&find=${MEMBER}#status`);
      const after = await officer.get(done.location ?? "");
      expect(words(after.page.querySelector("#status"))).toBe("Pause lifted.");
      expect(paused(after.page)[0]).toEqual([
        `${HARNESS_ACCOUNTS.member.label} ${MEMBER}`,
        ["Reporting problems (/issue)"],
      ]);
      // The ended list now begins with it, and says who and why.
      const first = after.page.querySelector(".mod-dones > .mod-done");
      expect(words(first?.querySelector(".mod-done__feature"))).toBe(
        "Suggesting features (/suggest)",
      );
      expect(words(first?.querySelector(".mod-done__how"))).toMatch(
        new RegExp(`^Lifted by ${HARNESS_ACCOUNTS.officer.label} on \\d{4}-`, "u"),
      );
      expect(words(first?.querySelector(".mod-done__why"))).toBe("They stopped.");
      // Nothing left to lift on that feature.
      const again = await officer.post(PAGE, lift(MEMBER, "suggest.use"));
      expect(again.location).toBe(`${PAGE}?notice=not-paused&find=${MEMBER}#status`);
      expect(words((await officer.get(again.location ?? "")).page.querySelector("#status"))).toBe(
        "Nothing to lift. That pause had already ended.",
      );
    });
  });

  test("a refused pause comes back open with what was typed; nothing is written", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const before = (await officer.get(PAGE)).page.querySelectorAll(".mod-pause").length;
      /** The refused page: its open panel, its summary links, and the first error line. */
      const refused = async (fields: Record<string, string | string[]>) => {
        const answer = await officer.post(PAGE, fields);
        expect(answer.status).toBe(422);
        expect(answer.page.title.startsWith("Error: ")).toBe(true);
        const open = answer.page.querySelector(".overlay.overlay--open");
        expect(open).not.toBeNull();
        expect(
          answer.page.querySelectorAll(".mod-toolbar[inert], .mod-section[inert]").length,
        ).toBeGreaterThan(0);
        return { answer, open, summary: wordsOf(answer.page, ".error-summary a") };
      };
      // Yourself, a server manager, a bot, staff, and someone nobody has seen.
      const self = await refused(block(OFFICER, ["suggest.use", "issue.use"], "Typed reason"));
      expect(self.summary).toEqual(["You can't pause yourself."]);
      expect(self.open?.querySelector('input[name="member"]')?.getAttribute("value")).toBe(OFFICER);
      expect(
        [...(self.open?.querySelectorAll('input[name="feature"][checked]') ?? [])].map((box) =>
          box.getAttribute("value"),
        ),
      ).toEqual(["suggest.use", "issue.use"]);
      expect(self.open?.querySelector("textarea")?.textContent?.trim()).toBe("Typed reason");
      expect((await refused(block(MANAGER, ["suggest.use"]))).summary).toEqual([
        "Server managers can't be paused.",
      ]);
      expect((await refused(block(BOT, ["suggest.use"]))).summary).toEqual([
        "Bots can't be paused.",
      ]);
      expect((await refused(block(HARNESS_SECOND_OFFICER, ["suggest.use"]))).summary).toEqual([
        "Only a server manager can pause someone with officer permissions.",
      ]);
      expect((await refused(block(MEMBER, ["modmail.open"]))).summary).toEqual([
        "Only a server manager can pause mod mail.",
      ]);
      expect((await refused(block(STRANGER, ["suggest.use"]))).summary).toEqual([
        "That user isn't a current or former member of this server.",
      ]);
      // A pause a server manager set can't be changed by an officer, by pausing the feature again.
      expect((await refused(block(HARNESS_FORMER_MEMBER, ["ledger.deposit"]))).summary).toEqual([
        "A server manager paused that, so only a server manager can change it.",
      ]);
      // Everything wrong with the form is said at once, each linking to its control; the typed
      // text (an unreadable member, a missing reason) comes back as typed.
      const bad = await refused({ op: "block", member: "Kupo", duration: "1w", reason: "  " });
      expect(bad.summary).toEqual([
        "Enter the member's ID, or paste a mention.",
        "Pick at least one feature.",
        "Add a reason of 1–1,000 characters.",
      ]);
      expect(
        [...bad.answer.page.querySelectorAll(".error-summary a")].map((link) =>
          link.getAttribute("href"),
        ),
      ).toEqual(["#mod-pause-member", "#mod-pause-feature", "#mod-pause-reason"]);
      expect(bad.open?.querySelector('input[name="member"]')?.getAttribute("value")).toBe("Kupo");
      // None of it wrote anything.
      expect((await officer.get(PAGE)).page.querySelectorAll(".mod-pause")).toHaveLength(before);
    });
  });

  test("lifting what an officer may not comes back as a refused Lift, naming the feature", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      // The guest's mod mail pause is a server manager's.
      const answer = await officer.post(PAGE, lift(GUEST, "modmail.open", "Let them back in."));
      expect(answer.status).toBe(422);
      const open = answer.page.querySelector(".overlay.overlay--open");
      expect(open?.id).toBe("mod-lift-open");
      expect(words(open?.querySelector(".overlay__title"))).toBe(
        `Lift pause: Opening mod mail cases for ${HARNESS_ACCOUNTS.guest.label}`,
      );
      expect(wordsOf(answer.page, ".error-summary a")).toEqual([
        "A server manager paused that, so only a server manager can lift it.",
      ]);
      expect(open?.querySelector("textarea")?.textContent?.trim()).toBe("Let them back in.");
      // Your own, a missing reason, and someone with nothing paused at all.
      const own = await officer.post(PAGE, lift(OFFICER, "suggest.use"));
      expect(wordsOf(own.page, ".error-summary a")).toEqual(["You can't lift your own pause."]);
      const empty = await officer.post(PAGE, lift(MEMBER, "suggest.use", " "));
      expect(empty.status).toBe(422);
      expect(wordsOf(empty.page, ".error-summary a")).toEqual([
        "Add a reason of 1–1,000 characters.",
      ]);
      const missing = await officer.post(PAGE, lift(TIMED_OUT, "issue.use"));
      expect(missing.location).toBe(`${PAGE}?notice=not-paused&find=${TIMED_OUT}#status`);
      // The pauses are all still there.
      expect((await officer.get(PAGE)).page.querySelectorAll(".mod-pause")).toHaveLength(4);
    });
  });

  test("a server manager may pause mod mail and lift a manager's pause; the paused person sees it there", async () => {
    await withHarness({ moderation: "pauses", modmail: "empty" }, async (signIn) => {
      const manager = await signIn("manager");
      const page = await manager.get(PAGE);
      expect(page.status).toBe(200);
      expect(
        page.page.querySelectorAll('#mod-pause input[name="feature"]:not([disabled])'),
      ).toHaveLength(9);
      expect(page.page.querySelector(".mod-limits")).toBeNull();
      // Every pause has a Lift for a manager: four on the page.
      expect(page.page.querySelectorAll(".mod-person button.mod-opener")).toHaveLength(4);
      const member = await signIn("member");
      const open = await member.get(MODMAIL);
      expect(open.page.querySelector(".modmail-opener")?.hasAttribute("disabled")).toBe(false);
      // Pausing mod mail for the member: their Open a case turns off, with the reason why.
      const done = await manager.post(
        PAGE,
        block(MEMBER, ["modmail.open"], "Use the form once.", "forever"),
      );
      expect(done.location).toBe(`${PAGE}?notice=paused&find=${MEMBER}#status`);
      const closed = await member.get(MODMAIL);
      expect(closed.status).toBe(200);
      expect(closed.page.querySelector(".modmail-opener")?.hasAttribute("disabled")).toBe(true);
      expect(words(closed.page.querySelector(".modmail-open-bar__note"))).toContain(
        "Opening new cases is paused for you here.",
      );
      // And the manager's lift of the guest's pause, which an officer could not, goes through.
      const lifted = await manager.post(PAGE, lift(GUEST, "modmail.open", "Settled."));
      expect(lifted.location).toBe(`${PAGE}?notice=lifted&find=${GUEST}#status`);
      // A manager is never paused, by anyone: their own page, and a manager pausing a manager.
      const self = await manager.post(PAGE, block(MANAGER, ["suggest.use"]));
      expect(wordsOf(self.page, ".error-summary a")).toEqual(["You can't pause yourself."]);
    });
  });

  test("forms this page never rendered are refused whole, and only moderators get in", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const forged: Record<string, string | string[]>[] = [
        { op: "erase" },
        {},
        { ...block(MEMBER, ["suggest.use"]), duration: "5y" },
        { ...block(MEMBER, ["suggest.use"]), duration: "toString" },
        block(MEMBER, ["suggest.use", "no.such.permission"]),
        block(
          MEMBER,
          Array.from({ length: 40 }, () => "suggest.use"),
        ),
        lift("Kupo", "suggest.use"),
        lift(MEMBER, "no.such.permission"),
        lift(MEMBER, ""),
      ];
      for (const fields of forged) {
        const answer = await officer.post(PAGE, fields);
        expect({ fields, status: answer.status }).toEqual({ fields, status: 400 });
        expect(answer.page.title.startsWith("Error: ")).toBe(false);
      }
      // A feature that exists but can't be paused is the form's own 422, not a forgery.
      const staff = await officer.post(PAGE, block(MEMBER, ["ledger.audit"]));
      expect(staff.status).toBe(422);
      expect(wordsOf(staff.page, ".error-summary a")).toEqual(["That feature can't be paused."]);
      // Members and guests (and the member in a time-out) never reach the page or its forms.
      for (const account of ["member", "guest", "timedOut"] as const) {
        const person = await signIn(account);
        expect({ account, status: (await person.get(PAGE)).status }).toEqual({
          account,
          status: 403,
        });
        expect({
          account,
          status: (await person.post(PAGE, block(GUEST, ["suggest.use"]))).status,
        }).toEqual({
          account,
          status: 403,
        });
        expect(nav((await person.get(MY_ROLES)).page)).not.toContain("Moderation");
      }
      // The refused attempts changed nothing.
      expect((await officer.get(PAGE)).page.querySelectorAll(".mod-pause")).toHaveLength(4);
    });
  });

  test("a pause that ran out is shown ending where it ran out, even after a later pause for the same person closed it", async () => {
    await withHarness({ moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      /** The ended entries: the feature, how it ended, when (machine-readable) and the lift's reason. */
      const entries = (page: Page, list = ".mod-dones") =>
        [...page.querySelectorAll(`${list} > .mod-done`)].map((entry) => [
          words(entry.querySelector(".mod-done__feature")),
          words(entry.querySelector(".mod-done__how")).replace(/ \d{4}-.*/u, ""),
          entry.querySelector(".mod-done__how time")?.getAttribute("datetime") ?? "",
          words(entry.querySelector(".mod-done__why")),
        ]);
      const before = entries((await officer.get(PAGE)).page);
      const ranOut = before.find(([feature]) => feature === "Roster checks (/refresh)");
      // The member's roster pause ran out eight days ago, and nobody lifted it.
      expect(ranOut?.[1]).toBe("Ran out");
      expect(ranOut?.[3]).toBe("");
      const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
      expect(Math.abs(Date.parse(ranOut?.[2] ?? "") - eightDays)).toBeLessThan(5 * 60 * 1000);
      // Pausing the member again closes it (the service closes what ran out when it next writes for
      // them): nothing about how it shows changes, not its time, and not its place in the list,
      // which stays behind the officer's lift three days ago.
      expect((await officer.post(PAGE, block(MEMBER, ["selfroles.use"]))).status).toBe(303);
      const after = await officer.get(PAGE);
      expect(entries(after.page)).toEqual(before);
      expect(before.map(([feature]) => feature)).toEqual([
        "Suggesting features (/suggest)",
        "Roster checks (/refresh)",
      ]);
      // And the finder's history for the person shows the same end.
      const found = await officer.get(`${PAGE}?find=${MEMBER}`);
      expect(ranOut).toBeDefined();
      expect(entries(found.page, ".mod-found .mod-dones")).toEqual([ranOut ?? []]);
    });
  });

  test("a hostile reason or name is text everywhere it shows: the page, the finder, and the paused person's own page", async () => {
    const reason = '<img src=x onerror=alert(1)> "quoted" & \u202eevil\u202c';
    await withHarness({ hostileNames: true, moderation: "pauses" }, async (signIn) => {
      const officer = await signIn("officer");
      const done = await officer.post(PAGE, block(MEMBER, ["selfroles.use", "issue.use"], reason));
      expect(done.status).toBe(303);
      for (const path of [
        PAGE,
        done.location ?? "",
        `${PAGE}?find=${encodeURIComponent(FORMER)}`,
      ]) {
        const shown = await officer.get(path);
        expect(shown.status).toBe(200);
        expect(shown.text).not.toContain("<img src=x");
        expect(shown.page.querySelectorAll("main img")).toHaveLength(0);
      }
      const texts = [...(await officer.get(PAGE)).page.querySelectorAll('[dir="auto"]')].map(
        (element) => element.textContent,
      );
      // The reason, and the hostile names (the seeded reason on the former member's pause too).
      expect(texts).toContain(reason);
      expect(texts).toContain("كوبو <Kupo> 🐾");
      expect(texts.some((text) => text?.includes("<img src=x onerror=alert(1)>"))).toBe(true);
      // The paused person sees the reason as text on My roles.
      const member = await signIn("member");
      const theirs = await member.get(MY_ROLES);
      expect(theirs.text).not.toContain("<img src=x");
      expect(theirs.page.querySelectorAll("main img")).toHaveLength(0);
      expect(
        [...theirs.page.querySelectorAll('.my-roles-callouts [dir="auto"]')].map(
          (element) => element.textContent,
        ),
      ).toEqual([reason]);
    });
  });
});

/** The former member's ID, for the finder. */
const FORMER = HARNESS_FORMER_MEMBER;

describe("the harness's Moderation keeps in step with the service", () => {
  test("an unknown length is an input refusal naming the duration, and nothing is written", async () => {
    const pauses = harnessModerationFor({ moderation: "pauses" });
    const officer = actorOf({
      guildId: GUILD,
      userId: OFFICER,
      officer: true,
      manageRoles: false,
      member: true,
      botAdministrator: false,
    });
    const before = (await pauses.overview(officer)).active.length;
    const refused = await pauses
      .block(officer, MEMBER, ["selfroles.use"], "5y" as PauseDuration, "Because.")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toMatchObject({
      code: "input",
      message: "Pick one of the listed durations.",
      detail: { kind: "option", option: "duration" },
    });
    // Nothing was written; a listed length is accepted for the same person and feature.
    expect((await pauses.overview(officer)).active).toHaveLength(before);
    expect(
      (await pauses.block(officer, MEMBER, ["selfroles.use"], "1d", "Because.")).duration,
    ).toBe("1d");
    expect((await pauses.overview(officer)).active).toHaveLength(before + 1);
  });
});
