/**
 * Reply components through the real router, discord.js interactions and a local REST recorder:
 * 'I've added it — verify now' opens a new reply so the /claim token message is never edited;
 * 'Check again' re-renders its own private card in place, throttled by the card's timestamps;
 * 'Full details (JSON)' is refused to members before it runs and re-reads for officers; and the
 * ledger's View history opens a new reply while its pager re-reads each page in place as whoever
 * clicked. Check sync status opens the presser's own sync status as a new reply, the officer sync
 * and guest record details attach their JSON, and the review buttons answer with the decision
 * presenter's short form. Run health check and Re-check re-run /config validate for the officer who
 * clicked and replace their own view with the checklist.
 */
import { afterEach, expect, test } from "bun:test";
import { InteractionResponseType, MessageFlags } from "discord.js";
import type { APIEmbed } from "discord.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import type { Component } from "../../src/bot/component.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import config from "../../src/components/config.component.js";
import details from "../../src/components/details.component.js";
import guestReview from "../../src/components/guest-review.component.js";
import ledger from "../../src/components/ledger.component.js";
import sync from "../../src/components/sync.component.js";
import verify from "../../src/components/verify.component.js";
import { type Actor, can } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { actorOf } from "../fixtures/actors.js";
import { interactionFixture, type RecordedRequest } from "../fixtures/interactions.js";
import { CHARACTER_RESULTS as R } from "../fixtures/replies/characters.js";
import { CONFIG_RESULTS as C } from "../fixtures/replies/configuration.js";
import { APPLICATION_ID, decision, GUEST_RESULTS as G } from "../fixtures/replies/guests.js";
import { LEDGER_FC, LEDGER_RESULTS as L, OLD_FC } from "../fixtures/replies/ledger.js";
import { RUN_ID, SYNC_RESULTS as SR } from "../fixtures/replies/sync-utility.js";
import { at, CHARACTER } from "../fixtures/results.js";

/** Actors the fixture member (user 400 in guild 100) resolves as. */
const MEMBER: Actor = actorOf({ guildId: "100", userId: "400", manageRoles: false });
const OFFICER: Actor = actorOf({ ...MEMBER, officer: true });

/** One recorded service call: the method, the actor's user ID and the remaining arguments. */
type Call = [string, string, ...unknown[]];

/** The fixture's REST recorder of the harness a test built, closed after each test. */
let open: ReturnType<typeof interactionFixture> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/**
 * A router over the real verify and details components and a prototype-backed Service whose
 * verify and characters methods run `verify` and return the officer list, recording each call.
 */
function harness(actor: Actor, verifyResult: () => unknown) {
  const fixture = interactionFixture();
  open = fixture;
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  app.verify = async (caller, characterId) => {
    calls.push(["verify", caller.userId, characterId]);
    return verifyResult() as Awaited<ReturnType<Service["verify"]>>;
  };
  app.characters = async (caller, owner) => {
    calls.push(["characters", caller.userId, owner]);
    return R.officerList;
  };
  const components: readonly Component[] = [verify, details];
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map(),
    new Map(components.map((component) => [component.prefix, component])),
  );
  return { fixture, calls, router };
}

/** The interaction callback type a recorded acknowledgement used (5 reply, 6 update). */
const callbackType = (request: RecordedRequest | undefined): unknown =>
  typeof request?.body === "object" && request.body !== null && "type" in request.body
    ? request.body.type
    : undefined;

/** The one embed a recorded edit or follow-up carries. */
function embedOf(request: RecordedRequest | undefined): APIEmbed {
  const body = request?.body;
  const embeds = typeof body === "object" && body !== null && "embeds" in body ? body.embeds : [];
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

/** A source message last rendered long enough ago that Check again isn't throttled. */
const SETTLED = { ephemeral: true, editedAt: new Date(Date.now() - 60_000).toISOString() };

test("verify now opens a new reply, so the /claim message and its token are never edited", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  // The /claim message is public in the observed test guild and belongs to another tester.
  await router.handle(fixture.button("verify:claim:12345678", "123456789", { ownerId: "401" }));
  expect(fixture.requests.map(callbackType)).not.toContain(
    InteractionResponseType.DeferredMessageUpdate,
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(fixture.requests[0]?.body).toMatchObject({ data: { flags: MessageFlags.Ephemeral } });
  // The clicking member's own claim is checked, whoever's message the button sat on.
  expect(calls).toEqual([["verify", "400", "12345678"]]);
  expect(embedOf(fixture.requests[1]).title).toBe("Example Character is verified");
});

test("verify now on the presser's own private claim card still opens a new reply", async () => {
  const { fixture, router } = harness(MEMBER, () => R.verified);
  await router.handle(fixture.button("verify:claim:12345678", "123456789", { ephemeral: true }));
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
});

test("Check again updates its private card; a verified result clears the buttons", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  await router.handle(fixture.button("verify:again:12345678", "123456789", SETTLED));
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  expect(calls).toEqual([["verify", "400", "12345678"]]);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    body: {
      content: "",
      components: [],
      attachments: [],
      embeds: [{ title: "Example Character is verified" }],
    },
  });
});

test("a token still missing re-renders the pending card in place with Check again", async () => {
  const { fixture, router } = harness(MEMBER, () => {
    throw new Failure("pending_proof", "Not yet.", 0, {
      kind: "proof",
      character: CHARACTER,
      expiresAt: at(1_200),
    });
  });
  const press = fixture.button("verify:again:12345678", "123456789", SETTLED);
  await router.handle(press);
  expect(fixture.requests.map((request) => request.method)).toEqual(["post", "patch"]);
  expect(fixture.requests[1]?.body).toMatchObject({
    embeds: [
      {
        title: "Token not on the Lodestone yet",
        footer: { text: `Code pending_proof · Ref ${press.id}` },
      },
    ],
    components: [{ components: [{ label: "Check again", custom_id: "verify:again:12345678" }] }],
  });
});

test("Check again within 15 seconds of the last render follows up and skips the service", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  const press = fixture.button("verify:again:12345678", "123456789", {
    ephemeral: true,
    editedAt: new Date().toISOString(),
  });
  await router.handle(press);
  expect(calls).toEqual([]);
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  // The source view stays; the wait arrives as a private follow-up.
  expect(fixture.requests[1]).toMatchObject({
    method: "post",
    route: expect.stringMatching(/^\/webhooks\//u),
    body: { flags: MessageFlags.Ephemeral },
  });
  const embed = embedOf(fixture.requests[1]);
  expect(embed).toMatchObject({
    title: "Please wait a moment",
    footer: { text: `Code cooldown · Ref ${press.id}` },
  });
  expect(embed.fields?.find((field) => field.name === "Try again")).toBeDefined();
});

test("Check again on someone else's public card replies instead of editing it", async () => {
  const { fixture, router } = harness(MEMBER, () => R.verified);
  await router.handle(
    fixture.button("verify:again:12345678", "123456789", {
      ownerId: "401",
      editedAt: SETTLED.editedAt,
    }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
});

test("Check again on someone else's freshly rendered card is not throttled by their check", async () => {
  // The card's timestamps record its owner's last check, not the presser's, and this click
  // replies instead of re-rendering it, so it runs the presser's own check like /verify does.
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  await router.handle(
    fixture.button("verify:again:12345678", "123456789", {
      ownerId: "401",
      editedAt: new Date().toISOString(),
    }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(calls).toEqual([["verify", "400", "12345678"]]);
  expect(embedOf(fixture.requests[1]).title).not.toBe("Please wait a moment");
});

test("a malformed verify control is out of date and never reaches the service", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  for (const customId of ["verify:again:0123", "verify:later:12345678", "verify:claim"]) {
    const press = fixture.button(customId, "123456789", SETTLED);
    const before = fixture.requests.length;
    await router.handle(press);
    const sent = fixture.requests.slice(before);
    // A malformed ID can't choose update mode, so the card is a new reply.
    expect(callbackType(sent[0])).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(embedOf(sent[1])).toMatchObject({
      title: "This control is out of date",
      footer: { text: `Code stale · Ref ${press.id}` },
    });
  }
  expect(calls).toEqual([]);
});

test("a member pressing Full details is refused before the component runs", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  const press = fixture.button("details:characters:123456789012345678", "123456789", {
    ephemeral: true,
  });
  await router.handle(press);
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests[1])).toMatchObject({
    title: "Officers only",
    footer: { text: `Code forbidden · Ref ${press.id}` },
  });
  expect(JSON.stringify(fixture.requests)).not.toContain("tarubot-characters.json");
});

test("an officer's Full details re-reads the member's links and attaches them as JSON", async () => {
  const { fixture, calls, router } = harness(OFFICER, () => R.verified);
  await router.handle(
    fixture.button("details:characters:123456789012345678", "123456789", { ephemeral: true }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(calls).toEqual([["characters", "400", "123456789012345678"]]);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    files: ["tarubot-characters.json"],
    body: { embeds: [{ title: "Full details · characters" }] },
  });
});

test("a details view this release renders no button for is out of date", async () => {
  const { fixture, calls, router } = harness(OFFICER, () => R.verified);
  await router.handle(fixture.button("details:config", "123456789", { ephemeral: true }));
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests[1]).title).toBe("This control is out of date");
});

// ---------------------------------------------------------------------------------------------
// Ledger history buttons

/**
 * A router over the real ledger and details components whose ledgerRead stub records each call
 * and returns `read(history)`. The actor is resolved per click from `actors`, so consecutive
 * clicks can change audience the way a revoked or granted officer role does.
 */
function ledgerHarness(actors: readonly Actor[], read: (history: boolean) => unknown) {
  const fixture = interactionFixture();
  open = fixture;
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  Object.assign(app, {
    ledgerRead: async (caller: Actor, ...args: unknown[]) => {
      // ledger.audit is what the service reads officer detail by (2.44.0).
      calls.push(["ledgerRead", can(caller, "ledger.audit") ? "officer" : "member", ...args]);
      return read(args[2] === true);
    },
  });
  let click = 0;
  const components: readonly Component[] = [ledger, details];
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => {
        const actor = actors[Math.min(click++, actors.length - 1)] ?? MEMBER;
        return { ...actor, guildId, userId };
      },
      report: () => {},
    },
    new Map(),
    new Map(components.map((component) => [component.prefix, component])),
  );
  return { fixture, calls, router };
}

/** The pager and details controls of the page 1 view the fixtures render. */
const FC_ID = LEDGER_FC.id;
/** Everything a recorded request sent, for asserting what never appears. */
const sentText = (requests: readonly RecordedRequest[]) => JSON.stringify(requests);

test("Older re-reads the next page as the presser and updates the private page in place", async () => {
  const { fixture, calls, router } = ledgerHarness([MEMBER], () => L.lastPage);
  await router.handle(
    fixture.button(`ledger:older:c:${FC_ID}:34`, "123456789", { ephemeral: true }),
  );
  expect(calls).toEqual([["ledgerRead", "member", FC_ID, "34", true, "current"]]);
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    body: {
      content: "",
      attachments: [],
      embeds: [{ footer: { text: "Page 5 of 5 · end of history" } }],
    },
  });
});

test("Latest, and Newer without a cursor, open the newest page; historical scope reads any FC", async () => {
  const { fixture, calls, router } = ledgerHarness([OFFICER], () => L.historicalPage);
  for (const customId of [
    `ledger:latest:c:${FC_ID}`,
    `ledger:newer:c:${FC_ID}`,
    `ledger:newer:h:${OLD_FC.id}:19`,
  ])
    await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
  expect(calls).toEqual([
    ["ledgerRead", "officer", FC_ID, null, true, "current"],
    ["ledgerRead", "officer", FC_ID, null, true, "current"],
    ["ledgerRead", "officer", OLD_FC.id, "19", true, "any"],
  ]);
});

test("each click renders for its presser: officer detail, then the member layout", async () => {
  const { fixture, router } = ledgerHarness([OFFICER, MEMBER], () =>
    // The service filters nothing by audience here; the presenter chooses the layout.
    ({ ...L.history, before: 44n }),
  );
  await router.handle(
    fixture.button(`ledger:older:c:${FC_ID}:44`, "123456789", { ephemeral: true }),
  );
  const officer = embedOf(fixture.requests[1]);
  expect(officer.footer?.text).toContain("Account ");
  expect(sentText(fixture.requests)).toContain(`details:history:c:${FC_ID}:44`);
  const before = fixture.requests.length;
  await router.handle(
    fixture.button(`ledger:older:c:${FC_ID}:44`, "123456789", { ephemeral: true }),
  );
  const member = fixture.requests.slice(before);
  expect(embedOf(member[1]).footer?.text).toBe("Page 1 of 5");
  const text = sentText(member);
  expect(text).not.toContain("details:");
  expect(text).not.toContain(L.history.account.id);
  expect(text).not.toContain(L.history.entries[0]?.id ?? "missing");
});

test("View history opens page 1 as a new reply and leaves the balance message alone", async () => {
  const { fixture, calls, router } = ledgerHarness([MEMBER], () => L.history);
  // Even on the presser's own private balance, the balance stays visible.
  await router.handle(fixture.button(`ledger:open:c:${FC_ID}`, "123456789", { ephemeral: true }));
  expect(calls).toEqual([["ledgerRead", "member", FC_ID, null, true, "current"]]);
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(fixture.requests.map(callbackType)).not.toContain(
    InteractionResponseType.DeferredMessageUpdate,
  );
  // A deferred reply (type 5) created a new message, so completing it can't touch the balance.
  expect(fixture.requests[1]?.method).toBe("patch");
  expect(embedOf(fixture.requests[1]).title).toBe("Ledger history · Example Free Company");
});

test("a page whose FC was replaced follows up privately and leaves the page", async () => {
  const { fixture, router } = ledgerHarness([MEMBER], () => {
    throw new Failure(
      "stale",
      "The linked Free Company changed since this ledger view was shown. Run /ledger history again.",
      0,
      { kind: "stale", what: "control" },
    );
  });
  const press = fixture.button(`ledger:older:c:${FC_ID}:34`, "123456789", { ephemeral: true });
  await router.handle(press);
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  expect(fixture.requests.map((request) => request.method)).toEqual(["post", "post"]);
  expect(fixture.requests[1]).toMatchObject({
    route: expect.stringMatching(/^\/webhooks\//u),
    body: { flags: MessageFlags.Ephemeral },
  });
  expect(embedOf(fixture.requests[1])).toMatchObject({
    title: "This control is out of date",
    footer: { text: `Code stale · Ref ${press.id}` },
  });
});

test("the pager on someone else's public page replies instead of editing it", async () => {
  const { fixture, router } = ledgerHarness([MEMBER], () => L.history);
  await router.handle(
    fixture.button(`ledger:older:c:${FC_ID}:34`, "123456789", { ownerId: "401" }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
});

test("a malformed ledger control is out of date and never reaches the service", async () => {
  const { fixture, calls, router } = ledgerHarness([MEMBER], () => L.history);
  for (const customId of [
    `ledger:older:x:${FC_ID}:34`,
    `ledger:older:c:${FC_ID}:034`,
    "ledger:open:c",
    `ledger:history:c:${FC_ID}`,
  ]) {
    const before = fixture.requests.length;
    await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
    expect(embedOf(fixture.requests.slice(before)[1]).title).toBe("This control is out of date");
  }
  expect(calls).toEqual([]);
});

test("details:history and details:balance pass the scope, FC and cursor through", async () => {
  const { fixture, calls, router } = ledgerHarness([OFFICER], (history) =>
    history ? L.history : L.balance,
  );
  await router.handle(
    fixture.button(`details:history:c:${FC_ID}:34`, "123456789", { ephemeral: true }),
  );
  await router.handle(
    fixture.button(`details:balance:h:${OLD_FC.id}`, "123456789", { ephemeral: true }),
  );
  expect(calls).toEqual([
    ["ledgerRead", "officer", FC_ID, "34", true, "current"],
    ["ledgerRead", "officer", OLD_FC.id, null, false, "any"],
  ]);
  const files = fixture.requests.flatMap((request) => request.files ?? []);
  expect(files).toEqual(["tarubot-ledger-history.json", "tarubot-ledger-balance.json"]);
});

test("a member pressing a ledger Full details is refused before it reads", async () => {
  const { fixture, calls, router } = ledgerHarness([MEMBER], () => L.balance);
  await router.handle(
    fixture.button(`details:balance:c:${FC_ID}`, "123456789", { ephemeral: true }),
  );
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests[1]).title).toBe("Officers only");
});

// ---------------------------------------------------------------------------------------------
// Check sync status, sync and guest details, and the guest review buttons

/**
 * A router over the real sync, details and guest-review components and a prototype-backed Service
 * whose syncStatus, guestStatus and decide record each call and return catalog results.
 */
function guestSyncHarness(actor: Actor) {
  const fixture = interactionFixture();
  open = fixture;
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  Object.assign(app, {
    syncStatus: async (caller: Actor, run: string | null) => {
      calls.push(["syncStatus", caller.userId, run]);
      // sync.view_all widens the listing to everyone's work, as the service does.
      return can(caller, "sync.view_all") ? SR.officer : run ? SR.run : SR.memberAttention;
    },
    guestStatus: async (caller: Actor, owner: string) => {
      calls.push(["guestStatus", caller.userId, owner]);
      return G.record;
    },
    decide: async (caller: Actor, ...args: unknown[]) => {
      calls.push(["decide", caller.userId, ...args]);
      return decision();
    },
  });
  const components: readonly Component[] = [sync, details, guestReview];
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map(),
    new Map(components.map((component) => [component.prefix, component])),
  );
  return { fixture, calls, router };
}

test("Check sync status opens the presser's own status as a new reply, with or without a run", async () => {
  const { fixture, calls, router } = guestSyncHarness(MEMBER);
  // The /setup summary it sits on is private to the presser, and still isn't edited.
  await router.handle(fixture.button("sync:status", "123456789", { ephemeral: true }));
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(embedOf(fixture.requests[1]).title).toBe("Your sync status");
  await router.handle(fixture.button(`sync:status:${RUN_ID}`, "123456789", { ephemeral: true }));
  expect(embedOf(fixture.requests.at(-1)).title).toBe("Sync run · completed");
  expect(calls).toEqual([
    ["syncStatus", "400", null],
    ["syncStatus", "400", RUN_ID],
  ]);
});

test("a malformed sync control is out of date and never reaches the service", async () => {
  const { fixture, calls, router } = guestSyncHarness(MEMBER);
  for (const customId of [
    `sync:status:${RUN_ID.toUpperCase()}`,
    "sync:status:9d8c7b6a",
    `sync:later:${RUN_ID}`,
    `sync:status:${RUN_ID}:x`,
  ]) {
    const before = fixture.requests.length;
    await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
    expect(embedOf(fixture.requests.slice(before)[1]).title).toBe("This control is out of date");
  }
  expect(calls).toEqual([]);
});

test("sync and guest Full details re-read for officers and attach their JSON", async () => {
  const { fixture, calls, router } = guestSyncHarness(OFFICER);
  await router.handle(fixture.button("details:sync", "123456789", { ephemeral: true }));
  await router.handle(fixture.button(`details:sync:${RUN_ID}`, "123456789", { ephemeral: true }));
  await router.handle(
    fixture.button("details:guest:234567890123456789", "123456789", { ephemeral: true }),
  );
  expect(calls).toEqual([
    ["syncStatus", "400", null],
    ["syncStatus", "400", RUN_ID],
    ["guestStatus", "400", "234567890123456789"],
  ]);
  const files = fixture.requests.flatMap((request) => request.files ?? []);
  expect(files).toEqual(["tarubot-sync.json", "tarubot-sync.json", "tarubot-guest.json"]);
  expect(embedOf(fixture.requests.at(-1)).title).toBe("Full details · guest");
});

test("members pressing sync or guest Full details are refused before any read", async () => {
  const { fixture, calls, router } = guestSyncHarness(MEMBER);
  for (const customId of ["details:sync", "details:guest:234567890123456789"]) {
    const before = fixture.requests.length;
    await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
    expect(embedOf(fixture.requests.slice(before)[1]).title).toBe("Officers only");
  }
  expect(calls).toEqual([]);
  expect(sentText(fixture.requests)).not.toContain("tarubot-guest.json");
});

test("a review button records the decision on its message and answers briefly", async () => {
  const { fixture, calls, router } = guestSyncHarness(OFFICER);
  await router.handle(fixture.button(`guest:approve:${APPLICATION_ID}`, "987654321"));
  // The review message is a channel post, so the answer is a new private reply.
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(calls).toEqual([["decide", "400", APPLICATION_ID, true, null, "987654321"]]);
  expect(embedOf(fixture.requests[1])).toMatchObject({
    title: "Application approved",
    description: "Recorded. The review message updates shortly.",
    footer: { text: "Audited" },
  });
});

test("a malformed review control is out of date and never reaches the service", async () => {
  const { fixture, calls, router } = guestSyncHarness(OFFICER);
  for (const customId of [
    `guest:approve:${APPLICATION_ID.toUpperCase()}`,
    "guest:approve:fixture",
    `guest:ban:${APPLICATION_ID}`,
  ]) {
    const before = fixture.requests.length;
    await router.handle(fixture.button(customId));
    expect(embedOf(fixture.requests.slice(before)[1]).title).toBe("This control is out of date");
  }
  expect(calls).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Run health check and Re-check

/**
 * A router over the real config component and a prototype-backed Service whose validate records
 * each call and returns the approved problems report.
 */
function configHarness(actor: Actor) {
  const fixture = interactionFixture();
  open = fixture;
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  Object.assign(app, {
    validate: async (caller: Actor) => {
      calls.push(["validate", caller.userId]);
      return C.troubled;
    },
  });
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map(),
    new Map([[config.prefix, config]]),
  );
  return { fixture, calls, router };
}

test("Run health check replaces the officer's private /config show with the checklist", async () => {
  const { fixture, calls, router } = configHarness(OFFICER);
  await router.handle(fixture.button("config:validate", "123456789", { ephemeral: true }));
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  expect(calls).toEqual([["validate", "400"]]);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    body: {
      content: "",
      embeds: [{ title: "Configuration health · 2 problems, 2 warnings" }],
      components: [{ components: [{ label: "Re-check", custom_id: "config:validate" }] }],
    },
  });
});

test("Re-check on someone else's public view replies instead of editing it", async () => {
  const { fixture, calls, router } = configHarness(OFFICER);
  await router.handle(fixture.button("config:validate", "123456789", { ownerId: "401" }));
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(calls).toEqual([["validate", "400"]]);
  expect(embedOf(fixture.requests[1]).title).toBe("Configuration health · 2 problems, 2 warnings");
});

test("members pressing Re-check are refused before validation runs", async () => {
  const { fixture, calls, router } = configHarness(MEMBER);
  await router.handle(fixture.button("config:validate", "123456789", { ephemeral: true }));
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests.at(-1)).title).toBe("Officers only");
});

test("a malformed config control is out of date and never validates", async () => {
  const { fixture, calls, router } = configHarness(OFFICER);
  for (const customId of ["config:validate:x", "config:show", "config"]) {
    const before = fixture.requests.length;
    await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
    expect(embedOf(fixture.requests.slice(before).at(-1)).title).toBe(
      "This control is out of date",
    );
  }
  expect(calls).toEqual([]);
});
