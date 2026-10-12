/**
 * Mod mail's pure parts (2.43.0): the rules in src/domain/modmail.ts, /modmail's form and its
 * submission binding, the Discord messages (none carries the text or names the member), the
 * gateway's one role ping, the views each audience gets, the job kinds' labels and the readiness
 * flag, and the permission checks (2.44.0) on the web harness's fake. Database behavior is in
 * tests/integration/modmail.test.ts and the pages end to end in modmail-web.test.ts. Invented
 * IDs; keys from readable phrases.
 */
import { describe, expect, test } from "bun:test";
import { ButtonStyle, ComponentType, DiscordAPIError } from "discord.js";
import { parseHTML } from "linkedom";
import { modmailKey } from "../../src/application/keys.js";
import {
  type CaseView,
  type Inbox,
  ModMail,
  ModMailRetention,
  type ModMailSettings,
  RETENTION_INTERVAL_MS,
} from "../../src/application/modmail.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import modmailCommand from "../../src/commands/utility/modmail.command.js";
import modmailComponent from "../../src/components/modmail.component.js";
import type { ModMailPingView, PostMessage } from "../../src/application/records.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { configurationChecks } from "../../src/discord/presenters/configuration.js";
import { modmailModal, modmailSubmission } from "../../src/discord/modmail.js";
import { JOB_KIND } from "../../src/discord/presenters/jobs.js";
import {
  MODMAIL_REPLY_KINDS,
  type ModMailReplyKind,
  modmailDm,
  modmailInvalidReply,
  modmailOpenedReply,
  modmailPing,
  modmailRefusedReply,
} from "../../src/discord/presenters/modmail.js";
import type { Presented } from "../../src/discord/presenters/reply.js";
import type { Tone } from "../../src/discord/presenters/style.js";
import {
  afterReply,
  canEnable,
  caseUrl,
  characters,
  cleanText,
  cleanTopic,
  MODMAIL_CASE_PATH,
  MODMAIL_JOB_KINDS,
  MODMAIL_PATH,
  mayAccess,
  mayOpen,
  OPEN_REFUSALS,
  type OpenRefusal,
  shownAuthor,
  sideIn,
  textProblem,
  UNREADABLE_TEXT,
  VISIBILITY_NOTICE,
} from "../../src/domain/modmail.js";
import { type Actor, can, OFFICERS_ONLY } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import type { html } from "../../src/web/html.js";
import { navLinks } from "../../src/web/layout.js";
import { definePage, PAGE_NUMBER } from "../../src/web/page.js";
import {
  MENTION_FIX,
  OPEN_CONFLICT,
  type OpenRefused,
  renderCase,
  renderInbox,
  renderMyCases,
  WEB_OPEN_REFUSALS,
  waited,
} from "../../src/web/views/modmail.js";
import { type ActorSpec, actorOf } from "../fixtures/actors.js";
import { harnessModMail, modmailStore } from "../fixtures/modmail.js";
import { buttonsOf, expectHouseStyle, onlyEmbed } from "../fixtures/replies.js";
import { configGuild, configReport } from "../fixtures/replies/configuration.js";
import { interactionFixture } from "../fixtures/interactions.js";

const GUILD = "100000000000000001";
const OFFICER = "200000000000000001";
const SECOND = "200000000000000011";
const MEMBER = "200000000000000002";
const ORIGIN = "https://tarubot.example.org";
const CANARY = "canary-plaintext-modmail-5e2b";
const ZERO_CASE = "00000000-0000-4000-8000-000000000000";

const actor = (userId: string, facts: Partial<ActorSpec> = {}): Actor =>
  actorOf({
    guildId: GUILD,
    userId,
    manageRoles: false,
    member: false,
    guest: false,
    botAdministrator: false,
    ...facts,
  });

/** A server manager: Manage Server with Manage Roles. */
const MANAGER = { serverManager: true, manageRoles: true } as const;

/**
 * Someone who reads every case but may not answer them: the Officer role's template less
 * modmail.respond. No role carries that set in 2.44.0; stored sets (2.46.0) can, so the
 * application checks it on its own.
 */
const reader = (userId: string, facts: Partial<ActorSpec> = {}): Actor => {
  const officer = actor(userId, { ...facts, officer: true });
  const permissions = new Set(officer.access.permissions);
  permissions.delete("modmail.respond");
  return { ...officer, access: { ...officer.access, permissions } };
};

describe("the rules", () => {
  test("who may open: Member or Guest now, without Administrator for TaruBot; time-outs don't matter", () => {
    expect(mayOpen(actor(MEMBER, { member: true }))).toBe(true);
    expect(mayOpen(actor(MEMBER, { guest: true }))).toBe(true);
    expect(mayOpen(actor(MEMBER, { member: true, timedOut: true }))).toBe(true);
    expect(mayOpen(actor(MEMBER))).toBe(false);
    expect(mayOpen(actor(OFFICER, { officer: true }))).toBe(false);
    expect(mayOpen(actor(OFFICER, { officer: true, member: true }))).toBe(true);
    expect(mayOpen(actor(MEMBER, { member: true, botAdministrator: true }))).toBe(false);
    // Opening a case is member-side: a server manager opens one only through their own role.
    expect(mayOpen(actor(OFFICER, MANAGER))).toBe(false);
    expect(mayOpen(actor(OFFICER, { ...MANAGER, guest: true }))).toBe(true);
    // Unknown counts as holding Administrator (A2 fails closed).
    const { botAdministrator: _, ...unknown } = actor(MEMBER, { member: true });
    expect(mayOpen(unknown)).toBe(false);
  });

  test("who may see a case: its server's officers, or its opener while they may use member pages", () => {
    expect(mayAccess(actor(OFFICER, { officer: true }), MEMBER)).toBe(true);
    expect(mayAccess(actor(MEMBER, { member: true }), MEMBER)).toBe(true);
    expect(mayAccess(actor(SECOND, { member: true }), MEMBER)).toBe(false);
    expect(mayAccess(actor(MEMBER), MEMBER)).toBe(false);
    expect(mayAccess(actor(MEMBER, { guest: true, botAdministrator: true }), MEMBER)).toBe(false);
    // Reading every case is modmail.inbox, whoever holds it; answering is checked apart.
    expect(mayAccess(actor(OFFICER, MANAGER), MEMBER)).toBe(true);
    expect(mayAccess(reader(SECOND), MEMBER)).toBe(true);
    // Manage Server alone is no officer (Q2 A).
    expect(mayAccess(actor(OFFICER, { serverManager: true }), MEMBER)).toBe(false);
  });

  test("sides and states: the opener is the member side; a reply waits on the other side", () => {
    expect(sideIn(MEMBER, MEMBER)).toBe("member");
    expect(sideIn(MEMBER, OFFICER)).toBe("officer");
    // An officer who opened a case is its member side.
    expect(sideIn(OFFICER, OFFICER)).toBe("member");
    expect(afterReply("member")).toBe("officers");
    expect(afterReply("officer")).toBe("member");
  });

  test("text: line endings normalized and trimmed, topics on one line, code points counted", () => {
    expect(cleanText("  a\r\nb\rc  ")).toBe("a\nb\nc");
    expect(cleanTopic(" one\n two\t three ")).toBe("one two three");
    expect(characters("🙂🙂")).toBe(2);
    expect(textProblem("", 10)).toBe("empty");
    expect(textProblem("x".repeat(11), 10)).toBe("long");
    expect(textProblem("🙂".repeat(10), 10)).toBeNull();
    expect(textProblem("a\u0000b", 10)).toBe("unsavable");
    expect(textProblem("\ud800", 10)).toBe("unsavable");
  });

  test("turning it on needs a valid key, the web and the officer channel", () => {
    expect(canEnable({ key: "ok", web: true, channel: true })).toBe(true);
    for (const missing of [
      { key: "missing", web: true, channel: true },
      { key: "invalid", web: true, channel: true },
      { key: "ok", web: false, channel: true },
      { key: "ok", web: true, channel: false },
    ] as const)
      expect(canEnable(missing)).toBe(false);
  });

  test("authors: officers see the truth; the member never sees who signed as the officers", () => {
    const signed = { authorId: OFFICER, side: "officer", signedAs: "officers" } as const;
    expect(shownAuthor(signed, "officer")).toEqual({
      kind: "person",
      userId: OFFICER,
      side: "officer",
      asOfficers: true,
    });
    expect(shownAuthor(signed, "member")).toEqual({ kind: "officers" });
    expect(shownAuthor({ ...signed, signedAs: "name" }, "member")).toEqual({
      kind: "officer",
      userId: OFFICER,
    });
    expect(shownAuthor({ authorId: MEMBER, side: "member", signedAs: null }, "member")).toEqual({
      kind: "you",
    });
  });

  test("a case's link matches the case page's route", () => {
    expect(caseUrl(ORIGIN, GUILD, 12n)).toBe(`${ORIGIN}/g/${GUILD}/modmail/12`);
    expect(MODMAIL_CASE_PATH).toBe(`${MODMAIL_PATH}/:number`);
  });

  test("the job kinds have member-facing labels and carry no member in their keys", () => {
    for (const kind of MODMAIL_JOB_KINDS) expect(JOB_KIND[kind]?.label).toStartWith("Mod mail");
  });
});

describe("answering a case needs modmail.respond on the officer side only (2.44.0, the web harness's fake)", () => {
  const NOW = Date.parse("2026-10-12T12:00:00.000Z");
  const people = {
    guild: GUILD,
    officer: OFFICER,
    member: MEMBER,
    guest: "200000000000000003",
    timedOut: "200000000000000004",
  };
  /** The harness's cases state: #1 the member's, closed; #2 the member's, waiting on officers. */
  const fake = () =>
    harnessModMail(modmailStore("cases", people, NOW), {
      people,
      names: new Map(),
      administrator: () => false,
      effectsMode: "live",
      now: () => NOW,
    });
  const refusal = {
    code: "forbidden",
    message: OFFICERS_ONLY,
    detail: { kind: "scope", scope: "officer", permission: "modmail.respond" },
  };

  test("a reader without it reads every case, but is refused replying, closing and reopening", async () => {
    const service = fake();
    const someone = reader(SECOND);
    expect([can(someone, "modmail.inbox"), can(someone, "modmail.respond")]).toEqual([true, false]);
    expect((await service.inbox(someone, "open")).cases.length).toBeGreaterThan(0);
    const view = await service.caseView(someone, 2n);
    expect(view).toMatchObject({ audience: "officer", side: "officer", state: "officers" });
    const revision = view?.revision ?? 0n;
    await expect(
      service.reply(someone, 2n, { messageId: ZERO_CASE, body: "An answer", signing: "name" }),
    ).rejects.toMatchObject(refusal);
    await expect(service.close(someone, 2n, revision)).rejects.toMatchObject(refusal);
    await expect(
      service.reopen(someone, 1n, (await service.caseView(someone, 1n))?.revision ?? 0n),
    ).rejects.toMatchObject(refusal);
    // Nothing was written: the thread and the states are as they were.
    const after = await service.caseView(someone, 2n);
    expect([after?.revision, after?.state, after?.messages]).toEqual([
      revision,
      "officers",
      view?.messages,
    ]);
    expect((await service.caseView(someone, 1n))?.state).toBe("closed");
    // An officer, whose role carries it, answers the same case.
    expect(
      await service.reply(actor(OFFICER, { officer: true }), 2n, {
        messageId: ZERO_CASE,
        body: "An answer",
        signing: "name",
      }),
    ).toEqual({ status: "saved", messageId: ZERO_CASE });
  });

  test("the opener's own side needs nothing more than reading their case", async () => {
    const service = fake();
    // The member's role carries no modmail.respond, and their own case is theirs to answer.
    const member = actor(MEMBER, { member: true });
    expect(can(member, "modmail.respond")).toBe(false);
    expect(
      await service.reply(member, 2n, { messageId: ZERO_CASE, body: "More detail", signing: null }),
    ).toEqual({ status: "saved", messageId: ZERO_CASE });
    expect(
      await service.close(member, 2n, (await service.caseView(member, 2n))?.revision ?? 0n),
    ).toEqual({ status: "saved" });
    // A reader without modmail.respond who opened a case of their own answers it as its member.
    const own = reader(SECOND, { member: true });
    const opened = await service.open(own, { topic: "My own case", body: "From the member side" });
    if (opened.status !== "opened") throw new Error(`Expected opened, got ${opened.status}`);
    expect((await service.caseView(own, opened.number))?.side).toBe("member");
    expect(
      await service.reply(own, opened.number, {
        messageId: "00000000-0000-4000-8000-000000000001",
        body: "One more thing",
        signing: null,
      }),
    ).toEqual({ status: "saved", messageId: "00000000-0000-4000-8000-000000000001" });
    expect(
      await service.close(
        own,
        opened.number,
        (await service.caseView(own, opened.number))?.revision ?? 0n,
      ),
    ).toEqual({ status: "saved" });
  });
});

describe("/modmail's form", () => {
  const interaction = { guildId: GUILD, user: { id: MEMBER } } as unknown as Parameters<
    typeof modmailModal
  >[0];

  test("says plainly that all officers can read it, above a topic and a message", () => {
    const modal = modmailModal(interaction).toJSON();
    expect(modal.custom_id).toBe(`modmail:${GUILD}:${MEMBER}`);
    expect(modal.title).toBe("Message your officers");
    const [notice, topic, message] = modal.components;
    expect(notice).toMatchObject({ type: ComponentType.TextDisplay });
    expect(JSON.stringify(notice)).toContain("All of this server's officers can read it.");
    expect(VISIBILITY_NOTICE).toStartWith("All of this server's officers can read it.");
    expect(topic).toMatchObject({
      type: ComponentType.Label,
      label: "Topic",
      component: { custom_id: "topic", min_length: 1, max_length: 100, required: true },
    });
    expect(message).toMatchObject({
      type: ComponentType.Label,
      label: "Message",
      description: "All of this server's officers can read it.",
      component: { custom_id: "message", min_length: 1, max_length: 4000, required: true },
    });
  });

  test("a submission must be the opener's own form in this server", () => {
    const fields = {
      getTextInputValue: (name: string) => (name === "topic" ? "Topic" : "Body"),
    };
    const submit = (customId: string, guildId = GUILD, userId = MEMBER) =>
      ({ customId, guildId, user: { id: userId }, fields }) as unknown as Parameters<
        typeof modmailSubmission
      >[0];
    const me = actor(MEMBER, { member: true });
    expect(modmailSubmission(submit(`modmail:${GUILD}:${MEMBER}`), me)).toEqual({
      topic: "Topic",
      body: "Body",
    });
    for (const forged of [
      submit(`modmail:${GUILD}:${SECOND}`),
      submit(`modmail:100000000000000002:${MEMBER}`),
      submit(`modmail:${GUILD}:${MEMBER}`, "100000000000000002"),
      submit(`modmail:${GUILD}:${MEMBER}`, GUILD, SECOND),
      submit(`modmail:${GUILD}`),
    ])
      expect(() => modmailSubmission(forged, me)).toThrow(Failure);
  });
});

describe("Discord messages carry no text and name no member", () => {
  const url = `${ORIGIN}/g/${GUILD}/modmail/7`;

  /** Every catalogued state, with its tone and title. */
  const CASES: Readonly<
    Record<ModMailReplyKind, { tone: Tone; title: string; render: () => Presented }>
  > = {
    "modmail.opened": {
      tone: "success",
      title: "Case #7 opened",
      render: () => modmailOpenedReply(7n, url),
    },
    "modmail.opened.development": {
      tone: "success",
      title: "Case #7 opened",
      render: () => modmailOpenedReply(7n, `http://localhost:8080/g/${GUILD}/modmail/7`),
    },
    "modmail.opened.offline": {
      tone: "success",
      title: "Case #7 opened",
      render: () => modmailOpenedReply(7n, null),
    },
    "modmail.refused": {
      tone: "info",
      title: "Mod mail isn't available",
      render: () => modmailRefusedReply("off"),
    },
    "modmail.invalid": {
      tone: "info",
      title: "Nothing was sent",
      render: () => modmailInvalidReply("message", "unsavable"),
    },
    "modmail.ping.opened": {
      tone: "info",
      title: "Mod mail case #7 opened",
      render: () => modmailPing({ number: 7n, event: "opened", url, roleId: "300000000000000003" }),
    },
    "modmail.ping.reply": {
      tone: "info",
      title: "New reply on mod mail case #7",
      render: () => modmailPing({ number: 7n, event: "reply", url, roleId: null }),
    },
    "modmail.ping.offline": {
      tone: "info",
      title: "New reply on mod mail case #7",
      render: () => modmailPing({ number: 7n, event: "reply", url: null, roleId: null }),
    },
    "modmail.dm.reply": {
      tone: "info",
      title: "New reply to your mod mail",
      render: () => modmailDm({ number: 7n, event: "reply", url }, "Example *FC*"),
    },
    "modmail.dm.closed": {
      tone: "neutral",
      title: "Mod mail case closed",
      render: () => modmailDm({ number: 7n, event: "closed", url }, null),
    },
  };

  test("one catalogued case per kind, each in the house style", () => {
    expect(Object.keys(CASES).sort()).toEqual([...MODMAIL_REPLY_KINDS].sort());
    for (const [kind, entry] of Object.entries(CASES))
      expect({ kind, embed: expectHouseStyle(entry.render(), entry) }).toMatchObject({ kind });
  });

  test("links are buttons on https, text on a development origin, and nothing without the web", () => {
    expect(buttonsOf(modmailOpenedReply(7n, url))).toEqual([
      { type: ComponentType.Button, style: ButtonStyle.Link, label: "Open case #7", url },
    ]);
    const dev = modmailOpenedReply(7n, `http://[::1]:8080/g/${GUILD}/modmail/7`);
    expect(buttonsOf(dev)).toEqual([]);
    expect(onlyEmbed(dev).description).toContain("`http://[::1]:8080/g/");
    expect(
      buttonsOf(modmailPing({ number: 7n, event: "opened", url: null, roleId: null })),
    ).toEqual([]);
  });

  test("every refusal is plain words with no Code or Ref", () => {
    for (const reason of Object.keys(OPEN_REFUSALS) as OpenRefusal[]) {
      const embed = onlyEmbed(modmailRefusedReply(reason));
      expect(embed.description).toBe(OPEN_REFUSALS[reason]);
      expect(embed.footer).toBeUndefined();
    }
  });

  test("the DM names the server (escaped) and the case, and never the reply", () => {
    const embed = onlyEmbed(modmailDm({ number: 7n, event: "reply", url }, "Example *FC*"));
    expect(embed.description).toBe(
      "An officer replied to your mod mail case #7 in **Example \\*FC\\***.",
    );
    expect(onlyEmbed(modmailDm({ number: 7n, event: "closed", url }, null)).description).toContain(
      "An officer closed your mod mail case #7 in the server.",
    );
  });

  test("the gateway pings exactly the officer role, and nobody without one", () => {
    const render = (view: ModMailPingView) =>
      (
        DiscordGateway as unknown as { render(message: PostMessage): Record<string, unknown> }
      ).render({ kind: "modmail", view });
    const pinged = render({ number: 7n, event: "opened", url, roleId: "300000000000000003" });
    expect(pinged.content).toBe("<@&300000000000000003>");
    expect(pinged.allowedMentions).toEqual({ parse: [], roles: ["300000000000000003"] });
    const quiet = render({ number: 7n, event: "reply", url, roleId: null });
    expect(quiet.content).toBe("");
    expect(quiet.allowedMentions).toEqual({ parse: [] });
    expect(JSON.stringify(pinged)).not.toContain(MEMBER);
  });
});

describe("the views", () => {
  const at = new Date("2026-10-11T09:00:00.000Z");
  const now = new Date("2026-10-11T12:30:00.000Z");
  const names = new Map<string, string | null>([
    [MEMBER, "Kupo <b>Member</b>"],
    [OFFICER, "Officer Ayla"],
    [SECOND, null],
  ]);
  const inspect = async (markup: ReturnType<typeof html>) =>
    parseHTML(`<!doctype html><html><body>${String(await markup)}</body></html>`).document;

  const officerView: CaseView = {
    guildId: GUILD,
    caseId: "00000000-0000-4000-8000-000000000001",
    number: 7n,
    audience: "officer",
    side: "officer",
    openerId: MEMBER,
    topic: `<script>alert(1)</script> ${CANARY}`,
    state: "officers",
    revision: 3n,
    openedAt: at,
    stateSince: at,
    closedAt: null,
    deleteAfter: null,
    entries: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        kind: "message",
        author: { kind: "person", userId: MEMBER, side: "member", asOfficers: false },
        body: "Line one\nLine two",
        createdAt: at,
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        kind: "message",
        author: { kind: "person", userId: OFFICER, side: "officer", asOfficers: true },
        body: null,
        createdAt: at,
      },
      {
        id: "00000000-0000-4000-8000-000000000013",
        kind: "closed",
        author: { kind: "person", userId: SECOND, side: "officer", asOfficers: false },
        createdAt: at,
      },
    ],
    messages: 2,
    reads: [
      { readerId: OFFICER, side: "officer", kind: "case", readAt: at },
      { readerId: SECOND, side: "officer", kind: "list", readAt: at },
    ],
    readCount: 2,
    names,
    canReply: true,
    keyProblem: false,
    canRespond: true,
  };
  const memberView: CaseView = {
    ...officerView,
    audience: "member",
    side: "member",
    entries: [
      { ...officerView.entries[0], author: { kind: "you" } } as CaseView["entries"][number],
      { ...officerView.entries[1], author: { kind: "officers" } } as CaseView["entries"][number],
      { ...officerView.entries[2], author: { kind: "officers" } } as CaseView["entries"][number],
    ],
    reads: null,
    readCount: 0,
    names: new Map([[MEMBER, "Kupo <b>Member</b>"]]),
  };
  const model = (view: CaseView) => ({
    view,
    action: `/g/${GUILD}/modmail/7`,
    token: "form-token-for-tests",
    url: new URL(`${ORIGIN}/g/${GUILD}/modmail/7`),
    messageId: "00000000-0000-4000-8000-000000000099",
  });

  test("officers: true authors, the signed-as-officers badge, the read log and the signing radios", async () => {
    const document = await inspect(renderCase(model(officerView)));
    const authors = [...document.querySelectorAll(".modmail-message__by")].map(
      (node) => node.textContent,
    );
    expect(authors).toEqual(["Kupo <b>Member</b> Member", "Officer Ayla Signed as the officers"]);
    expect(document.querySelector(".modmail-line")?.textContent).toContain(
      "Closed by A former officer",
    );
    expect(document.querySelector(".modmail-reads summary")?.textContent).toBe(
      "Read log (2 reads)",
    );
    // Opening the case and seeing its topic in a list are told apart.
    expect(
      [...document.querySelectorAll(".modmail-reads tbody tr")].map(
        (row) => row.querySelectorAll("td")[2]?.textContent,
      ),
    ).toEqual(["Opened the case", "Saw the topic in a list"]);
    expect(document.querySelectorAll('input[name="signed"]')).toHaveLength(2);
    expect(
      document.querySelector('input[name="signed"][value="name"]')?.hasAttribute("checked"),
    ).toBe(true);
    // Untrusted text stays text, isolated; an unreadable message says so.
    expect(document.querySelector(".modmail-case__topic script")).toBeNull();
    expect(document.querySelector(".modmail-case__topic")?.textContent).toContain("<script>");
    expect(document.querySelector(".modmail-unreadable")?.textContent).toBe(UNREADABLE_TEXT);
    // Every form posts with the token, to this page; no style attribute anywhere.
    for (const form of document.querySelectorAll("form")) {
      expect(form.getAttribute("method")).toBe("post");
      expect(form.getAttribute("action")).toBe(`/g/${GUILD}/modmail/7`);
      expect(form.querySelector('input[name="form_token"]')?.getAttribute("value")).toBe(
        "form-token-for-tests",
      );
    }
    expect(document.querySelectorAll("[style]")).toHaveLength(0);
  });

  test("the member: You and The officers, no read log, no radios, no officer's ID", async () => {
    const markup = String(await renderCase(model(memberView)));
    const document = parseHTML(`<html><body>${markup}</body></html>`).document;
    const authors = [...document.querySelectorAll(".modmail-message__by")].map(
      (node) => node.textContent,
    );
    expect(authors).toEqual(["You", "The officers"]);
    expect(document.querySelector(".modmail-line")?.textContent).toContain(
      "Closed by the officers",
    );
    expect(document.querySelector(".modmail-reads")).toBeNull();
    expect(document.querySelectorAll('input[name="signed"]')).toHaveLength(0);
    expect(markup).not.toContain(OFFICER);
    expect(markup).not.toContain("Officer Ayla");
  });

  test("a closed case: the reply reopens it, officers get Reopen and members don't", async () => {
    const closed = { ...officerView, state: "closed" as const, closedAt: at, deleteAfter: now };
    const officer = await inspect(renderCase(model(closed)));
    expect(officer.querySelector("label[for='modmail-body']")?.textContent).toBe(
      "Reply to reopen this case",
    );
    expect(officer.querySelector('input[name="op"][value="reopen"]')).not.toBeNull();
    const member = await inspect(
      renderCase(model({ ...memberView, state: "closed", closedAt: at })),
    );
    expect(member.querySelector('input[name="op"][value="reopen"]')).toBeNull();
    expect(member.querySelector('input[name="op"][value="close"]')).toBeNull();
  });

  test("a refused reply keeps what was typed and says why, without echoing it in the message", async () => {
    const document = await inspect(
      renderCase({
        ...model(officerView),
        refused: {
          kind: "reply",
          reason: "case_full",
          body: `typed ${CANARY}`,
          signing: "officers",
        },
      }),
    );
    expect(document.querySelector("textarea")?.textContent).toContain(`typed ${CANARY}`);
    expect(document.querySelector(".error-summary")?.textContent).not.toContain(CANARY);
    expect(
      document.querySelector('input[name="signed"][value="officers"]')?.hasAttribute("checked"),
    ).toBe(true);
  });

  const settings: ModMailSettings = {
    guildId: GUILD,
    configured: true,
    enabled: false,
    revision: 1n,
    updatedBy: null,
    updatedAt: null,
    prerequisites: { key: "missing", web: true, channel: false },
    officerRole: false,
    officerPing: null,
    administrator: false,
    effectsMode: "live",
  };

  test("the inbox: the filter links, the openers' names, how long each has waited, the switch's checks", async () => {
    const inbox: Inbox = {
      filter: "open",
      cases: [
        {
          number: 7n,
          openerId: MEMBER,
          topic: "Raid night",
          state: "officers",
          stateSince: at,
          lastActivityAt: at,
          closedAt: null,
        },
        {
          number: 8n,
          openerId: SECOND,
          topic: null,
          state: "member",
          stateSince: at,
          lastActivityAt: at,
          closedAt: null,
        },
      ],
      more: false,
      counts: { officers: 1, member: 1, closed: 4 },
      settings,
      names,
    };
    const document = await inspect(
      renderInbox({
        inbox,
        guildId: GUILD,
        action: `/g/${GUILD}/modmail`,
        token: "form-token-for-tests",
        url: new URL(`${ORIGIN}/g/${GUILD}/modmail`),
        now,
      }),
    );
    expect(
      [...document.querySelectorAll(".modmail-filter")].map((link) => link.textContent?.trim()),
    ).toEqual(["Open 2", "Waiting on officers 1", "Waiting on member 1", "Closed 4"]);
    expect(document.querySelector(".modmail-filter[aria-current]")?.textContent).toContain("Open");
    const rows = [...document.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Kupo <b>Member</b>");
    expect(rows[0]).toContain("3 hours");
    expect(rows[1]).toContain("A former member");
    expect(rows[1]).toContain(UNREADABLE_TEXT);
    const checks = [...document.querySelectorAll(".modmail-checks .check-row")].map(
      (row) => row.textContent,
    );
    expect(checks.map((row) => row?.slice(0, 6))).toEqual(["[FAIL]", "[OK]Da", "[FAIL]"]);
    // Turning on is disabled while a check fails.
    expect(document.querySelector("button[disabled]")?.textContent).toBe("Turn mod mail on");
  });

  test("the settings card warns when pings won't notify officers, with the fix, but still lets it turn on", async () => {
    const card = async (officerPing: ModMailSettings["officerPing"], enabled = false) => {
      const ready: ModMailSettings = {
        ...settings,
        enabled,
        prerequisites: { key: "ok", web: true, channel: true },
        officerRole: true,
        officerPing,
      };
      const document = await inspect(
        renderInbox({
          inbox: {
            filter: "open",
            cases: [],
            more: false,
            counts: { officers: 0, member: 0, closed: 0 },
            settings: ready,
            names,
          },
          guildId: GUILD,
          action: `/g/${GUILD}/modmail`,
          token: "form-token-for-tests",
          url: new URL(`${ORIGIN}/g/${GUILD}/modmail`),
          now,
        }),
      );
      return {
        rows: [...document.querySelectorAll(".modmail-checks .check-row")].map(
          (row) => row.textContent ?? "",
        ),
        turnOn: document.querySelector(".modmail-switch button"),
      };
    };
    const silent = await card("silent");
    expect(silent.rows.at(-1)).toBe(
      `[WARN]Pings will post but notify nobody: TaruBot can't mention the Officer role there. ${MENTION_FIX}`,
    );
    expect(MENTION_FIX).toContain("Mention @everyone, @here and All Roles");
    // A warning, not a prerequisite: Turn mod mail on stays enabled.
    expect(silent.turnOn?.textContent).toBe("Turn mod mail on");
    expect(silent.turnOn?.hasAttribute("disabled")).toBe(false);
    expect((await card("administrator", true)).rows.at(-1)).toBe(
      `[WARN]Pings reach officers only while TaruBot has Administrator. Before removing it, fix what /config validate lists for that channel, and allow the mention: ${MENTION_FIX}`,
    );
    expect((await card("server_wide", true)).rows.at(-1)).toBe(
      `[WARN]Pings notify officers only through Mention Everyone granted server-wide, which TaruBot shouldn't keep. Before it's removed: ${MENTION_FIX}`,
    );
    // Nowhere to post: the channel row no longer promises pings, and the ping row warns.
    const cannot = await card("cannot_post", true);
    expect(cannot.rows.at(-2)).toBe("[OK]Officer notifications channel is set");
    expect(cannot.rows.at(-1)).toBe(
      "[WARN]Pings can't be posted: TaruBot can't see or post in the officer notifications channel. In Discord, give TaruBot View Channel, Send Messages, Embed Links and Read Message History there; /config validate says which are missing.",
    );
    expect((await card("missing", true)).rows.at(-1)).toBe(
      "[WARN]Pings can't be posted: TaruBot can't find the officer notifications channel, which may have been deleted. Choose it again with /config officer_notifications.",
    );
    for (const fine of ["allowed", "mentionable"] as const)
      expect((await card(fine)).rows.at(-1)).toBe(
        "[OK]Pings notify officers: TaruBot can mention the Officer role there",
      );
    // Can't tell (no view of the server): no row.
    expect((await card(null)).rows).toHaveLength(3);
    expect(MENTION_FIX).toContain("add the TaruBot role");
  });

  /** A member's page view: no cases, `openRefusal` as given, and an optional refused form. */
  const mineView = (
    openRefusal: OpenRefusal | null,
    refused?: OpenRefused,
    enabled = openRefusal !== "off",
  ) => ({
    guildId: GUILD,
    cases: { cases: [], more: false, enabled, openRefusal },
    action: `/g/${GUILD}/modmail`,
    token: "token",
    caseId: ZERO_CASE,
    ...(refused && { refused }),
  });

  test("a member's list, and what it says while mod mail is off", async () => {
    const document = await inspect(renderMyCases(mineView("off")));
    expect(document.body.textContent).toContain("Mod mail is turned off in this server");
    expect(document.body.textContent).toContain(
      "All of this server's officers can read every case.",
    );
    // Off: the button stays, disabled, with the reason as its description; no form is drawn.
    const button = document.querySelector("button.modmail-opener");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(WEB_OPEN_REFUSALS.off);
    expect(document.querySelector("dialog, form")).toBeNull();
  });

  test("Open a case opens a modal dialog beside its button, with the privacy sentence first", async () => {
    const document = await inspect(renderMyCases(mineView(null)));
    const button = document.querySelector("button.modmail-opener");
    expect(button?.getAttribute("command")).toBe("show-modal");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.className).toContain("anchor-modmail-open");
    const id = button?.getAttribute("commandfor") ?? "";
    expect(button?.getAttribute("popovertarget")).toBe(id);
    // The panel is the button's next sibling, so the dialog gives focus back to it on close.
    const dialog = button?.nextElementSibling;
    expect(dialog?.tagName).toBe("DIALOG");
    expect(dialog?.id).toBe(id);
    expect(dialog?.getAttribute("popover")).toBe("auto");
    expect(dialog?.getAttribute("closedby")).toBe("any");
    expect(dialog?.className).toBe("overlay overlay--anchored anchored-modmail-open");
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("Open a case");
    expect(
      document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(VISIBILITY_NOTICE);
    expect(dialog?.querySelector("[autofocus]")?.textContent).toBe("Open a case");
    const close = dialog?.querySelector("button.overlay__close");
    expect(close?.getAttribute("command")).toBe("close");
    expect(close?.getAttribute("popovertargetaction")).toBe("hide");
    const form = dialog?.querySelector("form");
    expect(form?.getAttribute("action")).toBe(`/g/${GUILD}/modmail`);
    const value = (name: string) =>
      form?.querySelector(`input[name="${name}"]`)?.getAttribute("value");
    expect(value("op")).toBe("open");
    expect(value("case")).toBe(ZERO_CASE);
    // Twice the code-point limits: the browser's UTF-16 count never stops what the server takes.
    expect(form?.querySelector('input[name="topic"]')?.getAttribute("maxlength")).toBe("200");
    expect(form?.querySelector('textarea[name="body"]')?.getAttribute("maxlength")).toBe("8000");
    expect(form?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
    // Nothing on the page is inert on a GET.
    expect(document.querySelector("[inert]")).toBeNull();
  });

  test("each reason the member can't open a case disables the button and says why", async () => {
    for (const reason of ["off", "key", "open_limit", "daily_limit"] as const) {
      const document = await inspect(renderMyCases(mineView(reason)));
      expect(document.querySelector("button.modmail-opener[disabled]")).not.toBeNull();
      expect(document.body.textContent).toContain(WEB_OPEN_REFUSALS[reason]);
      expect(document.querySelector("dialog")).toBeNull();
    }
  });

  test("a refused form comes back drawn open in the centre, the page and its blocks inert", async () => {
    const typed = { topic: "<i>Raid</i> times", body: "Line one\nLine two" };
    const document = await inspect(
      renderMyCases(
        mineView(null, {
          problem: { kind: "invalid", field: "message", error: "long" },
          ...typed,
        }),
      ),
    );
    const panel = document.querySelector(".overlay--open");
    expect(panel?.tagName).toBe("DIV");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    // Centred: no anchor classes, and its own backdrop just before it, last in the content.
    expect(panel?.className).toBe("overlay overlay--open");
    expect(panel?.previousElementSibling?.className).toBe("overlay-backdrop");
    expect(document.querySelector("dialog")).toBeNull();
    // The summary first in the panel, linking to the field, which keeps what was typed.
    const summary = panel?.querySelector(".overlay__body > .error-summary");
    expect(summary?.querySelector("a")?.getAttribute("href")).toBe("#modmail-open-body");
    expect(summary?.textContent).toContain("Keep the message to 4,000 characters.");
    expect(panel?.querySelector('input[name="topic"]')?.getAttribute("value")).toBe(typed.topic);
    // A browser drops the newline written right after <textarea>; linkedom keeps it.
    expect(panel?.querySelector("textarea")?.textContent?.replace(/^\n/u, "")).toBe(typed.body);
    expect(panel?.querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
    // Close reloads the page; the page's own blocks are inert under the panel.
    expect(panel?.querySelector("a.overlay__close")?.getAttribute("href")).toBe(
      `/g/${GUILD}/modmail`,
    );
    for (const block of document.querySelectorAll("body > :not(.overlay--open, .overlay-backdrop)"))
      expect(block.hasAttribute("inert")).toBe(true);
    // A link to the panel's title takes the button's place.
    expect(document.querySelector("a.modmail-opener")?.getAttribute("href")).toBe(
      "#modmail-open-title",
    );
  });

  test("a refusal the page didn't foresee, or a conflict, shows in the panel and blocks a resend", async () => {
    const limit = await inspect(
      renderMyCases(
        mineView("open_limit", {
          problem: { kind: "refused", reason: "open_limit" },
          topic: "t",
          body: "b",
        }),
      ),
    );
    const panel = limit.querySelector(".overlay--open");
    expect(panel?.querySelector(".error-summary a")?.getAttribute("href")).toBe(
      "#modmail-open-error",
    );
    expect(limit.getElementById("modmail-open-error")?.textContent).toContain(
      WEB_OPEN_REFUSALS.open_limit,
    );
    expect(panel?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
    const conflict = await inspect(
      renderMyCases(mineView(null, { problem: { kind: "conflict" }, topic: "t", body: "b" })),
    );
    expect(conflict.getElementById("modmail-open-error")?.textContent).toContain(OPEN_CONFLICT);
    expect(
      conflict.querySelector('.overlay--open button[type="submit"]')?.hasAttribute("disabled"),
    ).toBe(false);
  });

  test("the Open a case markup has no inline style, script or handler, and escapes what was typed", async () => {
    const hostile = `</textarea><script>alert(1)</script><img src=x onerror=alert(1) style="x">"'`;
    for (const refused of [
      undefined,
      { problem: { kind: "conflict" as const }, topic: hostile, body: hostile },
      {
        problem: { kind: "invalid" as const, field: "message" as const, error: "long" as const },
        topic: hostile,
        body: hostile,
      },
      { problem: { kind: "already" as const, number: 4n }, topic: hostile, body: hostile },
    ]) {
      const markup = String(renderMyCases(mineView(null, refused)));
      const document = await inspect(renderMyCases(mineView(null, refused)));
      const all = [...document.querySelectorAll("*")];
      expect(all.filter((element) => element.hasAttribute("style"))).toHaveLength(0);
      expect(document.querySelectorAll("script, style, iframe, object, embed")).toHaveLength(0);
      expect(
        all.flatMap((element) =>
          [...element.attributes]
            .map((attribute) => attribute.name)
            .filter((name) => name.startsWith("on")),
        ),
      ).toHaveLength(0);
      expect(markup).not.toContain("</textarea><script>");
      expect(markup).not.toMatch(/javascript:/iu);
    }
  });

  test("waiting times read in plain words", () => {
    expect(waited(now, now)).toBe("under a minute");
    expect(waited(new Date(now.getTime() - 60_000), now)).toBe("1 minute");
    expect(waited(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3 hours");
    expect(waited(new Date(now.getTime() - 50 * 3_600_000), now)).toBe("2 days");
  });
});

describe("/config validate and the configuration page", () => {
  test("an unset officer notifications channel warns while mod mail is on, and is just off otherwise", () => {
    const row = (modmail: boolean | undefined) =>
      configurationChecks({
        ...configReport({
          guild: { ...configGuild({ id: GUILD }), officer_notifications_channel_id: null },
        }),
        ...(modmail === undefined ? {} : { modmail }),
      }).find((check) => check.text.startsWith("Officer notifications"));
    expect(row(true)).toMatchObject({
      check: "warn",
      text: "Officer notifications: not set, so officer alerts are skipped and officers aren't pinged about mod mail cases",
    });
    for (const off of [false, undefined])
      expect(row(off)).toMatchObject({
        check: "off",
        text: "Officer notifications: not set, so officer alerts are skipped",
      });
  });
});

describe("the web framework's numbered pages and conditional navigation (2.43.0)", () => {
  const base = {
    title: "T",
    access: ["modmail.inbox"] as const,
    requires: [],
    get: () => "" as never,
  };

  test("a path may end in /:number; such a page links with its number and stays out of the navigation", () => {
    const numbered = definePage({ ...base, path: "/g/:guild/things/:number" });
    expect(numbered.numbered).toBe(true);
    expect(numbered.href(GUILD, 12n)).toBe(`/g/${GUILD}/things/12`);
    expect(() => numbered.href(GUILD)).toThrow();
    expect(() => definePage({ ...base, path: "/g/:guild/things/:number", nav: "Things" })).toThrow(
      "can't be in the navigation",
    );
    expect(() => definePage({ ...base, path: "/g/:guild/:number" })).toThrow();
    expect(() => definePage({ ...base, path: "/g/:guild/things/:number/more" })).toThrow();
    expect(() => definePage({ ...base, path: "/g/:guild/things/:id" })).toThrow();
    expect(PAGE_NUMBER.test("1")).toBe(true);
    for (const bad of ["0", "01", "-1", "1.5", "x", "12345678901234567"])
      expect({ bad, ok: PAGE_NUMBER.test(bad) }).toEqual({ bad, ok: false });
  });

  test("a page may raise its own POST body cap, within bounds and only with a post handler", () => {
    const post = async () => ({ redirect: "/" });
    expect(definePage({ ...base, path: "/g/:guild/things" }).bodyLimit).toBe(65536);
    const big = definePage({
      ...base,
      path: "/g/:guild/things",
      post,
      postLimit: 5,
      bodyLimit: 98304,
    });
    expect(big.bodyLimit).toBe(98304);
    for (const bodyLimit of [1000, 65536, 262145, 1.5])
      expect(() =>
        definePage({ ...base, path: "/g/:guild/things", post, postLimit: 5, bodyLimit }),
      ).toThrow("bodyLimit");
    expect(() => definePage({ ...base, path: "/g/:guild/things", bodyLimit: 98304 })).toThrow(
      "needs a post handler",
    );
  });

  test("navWhen needs a navigation label; a numbered page marks the page it sits under as current", () => {
    expect(() => definePage({ ...base, path: "/g/:guild/things", navWhen: () => true })).toThrow(
      "needs a navigation label",
    );
    const list = definePage({ ...base, path: "/g/:guild/things", nav: "Things" });
    const other = definePage({ ...base, path: "/g/:guild/thingsmore", nav: "More" });
    const officer = actor(OFFICER, { officer: true });
    const current = (path: string, hidden?: ReadonlySet<string>) =>
      navLinks([list, other], officer, path, hidden).map((link) => [link.label, link.current]);
    expect(current("/g/:guild/things/:number")).toEqual([
      ["Things", true],
      ["More", false],
    ]);
    // A path that only shares a prefix isn't under it.
    expect(current("/g/:guild/thingsmore")).toEqual([
      ["Things", false],
      ["More", true],
    ]);
    expect(current("/g/:guild/things", new Set(["/g/:guild/things"]))).toEqual([["More", false]]);
  });
});

describe("display names for mod mail's pages", () => {
  const discordError = (code: number, status: number): DiscordAPIError =>
    new DiscordAPIError(
      { code, message: "Raw SDK message" },
      code,
      status,
      "GET",
      `/guilds/${GUILD}/members/1`,
      { body: undefined, files: undefined },
    );

  test("cache first, a bounded number of fetches, and someone gone remembered as gone", async () => {
    const gateway = new DiscordGateway();
    try {
      const fetched: string[] = [];
      const cached = new Map([[MEMBER, { displayName: "Cached Member" }]]);
      const guild = {
        members: {
          cache: cached,
          fetch: async ({ user }: { user: string }) => {
            fetched.push(user);
            if (user === SECOND) throw discordError(10007, 404);
            if (user === "200000000000000099") throw discordError(0, 500);
            return { displayName: `Fetched ${user.slice(-2)}` };
          },
        },
      };
      (gateway.client.guilds.cache as unknown as Map<string, unknown>).set(GUILD, guild);
      const many = Array.from(
        { length: 8 },
        (_, index) => `2000000000000001${String(index).padStart(2, "0")}`,
      );
      const names = await gateway.displayNames(GUILD, [
        MEMBER,
        SECOND,
        "200000000000000099",
        ...many,
      ]);
      expect(names.get(MEMBER)).toBe("Cached Member");
      expect(names.get(SECOND)).toBeNull();
      // Another error tells nothing, so no entry; and at most five fetches per call.
      expect(names.has("200000000000000099")).toBe(false);
      expect(fetched).toHaveLength(5);
      fetched.length = 0;
      expect((await gateway.displayNames(GUILD, [SECOND])).get(SECOND)).toBeNull();
      expect(fetched).toEqual([]);
      // A server TaruBot hasn't cached gives no names at all.
      expect((await gateway.displayNames("100000000000000009", [MEMBER])).size).toBe(0);
    } finally {
      await gateway.client.destroy();
    }
  });
});

describe("retention's own clock and timer", () => {
  /** Just enough of Orm for pruneModMail(): delete().where().returning(). */
  const counting = () => {
    const state = { passes: 0, fail: false };
    const db = {
      delete: () => ({
        where: () => ({
          returning: async () => {
            state.passes += 1;
            if (state.fail) throw new Error("database down");
            return [];
          },
        }),
      }),
    } as never;
    return { state, db };
  };

  test("a wall-clock step back can't pause it: the throttle runs on a monotonic clock", async () => {
    const { state, db } = counting();
    let clock = 1_000;
    const retention = new ModMailRetention(db, () => clock);
    await retention.tick();
    expect(state.passes).toBe(1);
    // Ten monotonic minutes later it runs again, whatever the wall clock did meanwhile.
    clock += RETENTION_INTERVAL_MS - 1;
    await retention.tick();
    expect(state.passes).toBe(1);
    clock += 1;
    await retention.tick();
    expect(state.passes).toBe(2);
    // The default clock is performance.now(), which never steps back.
    const defaults = new ModMailRetention(db);
    await defaults.tick();
    expect(state.passes).toBe(3);
  });

  test("its timer runs only under the writer lease, reports its own failures, and stops", async () => {
    const { state, db } = counting();
    const reported: string[] = [];
    let writer = false;
    const retention = new ModMailRetention(db, () => 0);
    retention.start(() => writer, {
      deleted: () => {},
      report: (_error, operation) => reported.push(operation),
    });
    await Bun.sleep(0);
    expect(state.passes).toBe(0);
    await retention.stop();
    writer = true;
    state.fail = true;
    const failing = new ModMailRetention(db, () => 0);
    failing.start(() => writer, {
      deleted: () => {},
      report: (_error, operation) => reported.push(operation),
    });
    await failing.stop();
    await Bun.sleep(0);
    expect(state.passes).toBe(1);
    expect(reported).toEqual(["modmail retention"]);
  });
});

describe("/modmail stays private, even under DevBot's public-response override", () => {
  test("its pre-form refusal is ephemeral in the public-response guild", async () => {
    const fixture = interactionFixture();
    try {
      fixture.member.guildId = GUILD;
      const service = Object.create(ModMail.prototype) as ModMail;
      service.openGate = async () => "off";
      const router = new InteractionRouter(
        {
          client: fixture.client,
          services: new Services().provide(modmailKey, service),
          report: () => {},
          allowsGuild: () => true,
          isStopping: () => false,
          publicResponseGuildId: GUILD,
          resolveActor: async () => actor(MEMBER, { member: true }),
        },
        new Map([[modmailCommand.name, modmailCommand]]),
        new Map([[modmailComponent.prefix, modmailComponent]]),
      );
      await router.handle(fixture.slash("modmail"));
      const refusal = fixture.requests.at(-1)?.body as {
        data?: { flags?: number; embeds?: unknown };
      };
      expect(refusal.data?.flags).toBe(64);
      expect(JSON.stringify(refusal.data?.embeds)).toContain("Mod mail isn't turned on");
      expect(modmailCommand.alwaysPrivate).toBe(true);
      expect(modmailComponent.alwaysPrivate).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

test("the gateway never mentions @everyone (the server's own ID) in a ping", () => {
  const render = (view: ModMailPingView, guildId: string) =>
    (
      DiscordGateway as unknown as {
        render(message: PostMessage, guildId?: string): Record<string, unknown>;
      }
    ).render({ kind: "modmail", view }, guildId);
  const everyone = render({ number: 7n, event: "opened", url: null, roleId: GUILD }, GUILD);
  expect(everyone.content).toBe("");
  expect(everyone.allowedMentions).toEqual({ parse: [] });
  const officers = render(
    { number: 7n, event: "opened", url: null, roleId: "300000000000000003" },
    GUILD,
  );
  expect(officers.allowedMentions).toEqual({ parse: [], roles: ["300000000000000003"] });
});
