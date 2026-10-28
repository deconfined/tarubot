/**
 * The failure catalog: every code has one category and log level, and classifyFailure turns any
 * caught error into a catalog code without exposing raw error text.
 */
import { describe, expect, test } from "bun:test";
import { DiscordAPIError, HTTPError, RateLimitError } from "discord.js";
import { z } from "zod";
import {
  classifyFailure,
  FAILURE_CATEGORY,
  FAILURE_LEVEL,
  type FailureCategory,
  type FailureCode,
  type FailureDetail,
} from "../../src/domain/failures.js";
import { Failure, id } from "../../src/domain/values.js";
import { jobOutcome } from "../../src/jobs/queue.js";

/** Build the SDK's own REST error, as a real rejection would, without any Discord request. */
const discordError = (code: number, status: number): DiscordAPIError =>
  new DiscordAPIError(
    { code, message: "Raw SDK message that must never be shown or logged" },
    code,
    status,
    "PATCH",
    "/guilds/100/members/200",
    { body: undefined, files: undefined },
  );

/**
 * The pinned catalog. The constructor's FailureCode type proves at compile time that every throw
 * site uses a catalogued code; this table catches an accidental re-categorization at runtime.
 */
const EXPECTED: Record<FailureCode, FailureCategory> = {
  input: "input",
  invalid_data: "input",
  forbidden: "forbidden",
  setup: "setup",
  not_found: "not_found",
  ambiguous: "ambiguous",
  ownership_conflict: "conflict",
  fc_linked: "conflict",
  initialized: "conflict",
  uninitialized: "conflict",
  insufficient_funds: "conflict",
  conflict: "stale",
  superseded: "stale",
  stale: "stale",
  expired: "stale",
  pending_proof: "wait",
  cooldown: "wait",
  rate_limited: "wait",
  busy: "wait",
  transient: "wait",
  stopping: "wait",
  eligible: "eligible",
  unavailable: "upstream",
  incomplete: "upstream",
  invalid_response: "upstream",
  private_profile: "upstream",
  blocked: "blocked",
  disabled: "paused",
  idempotency_conflict: "unexpected",
  invalid_job: "unexpected",
  lease_lost: "unexpected",
  ordered: "unexpected",
  dm_blocked: "unexpected",
  backup: "unexpected",
  configuration: "unexpected",
  schema: "unexpected",
  test_plan: "unexpected",
  writer_lease: "unexpected",
  unexpected: "unexpected",
};

describe("catalog", () => {
  test("every code has its pinned category and a report level", () => {
    // Widening to the table's type compares the runtime values, not the literal types.
    const catalog: Record<FailureCode, FailureCategory> = FAILURE_CATEGORY;
    expect(catalog).toEqual(EXPECTED);
    for (const category of Object.values(FAILURE_CATEGORY))
      expect(["info", "warn", "error"]).toContain(FAILURE_LEVEL[category]);
  });

  test("the codes introduced for 2.14.0 replace the ones no site throws any more", () => {
    for (const code of [
      "pending_proof",
      "insufficient_funds",
      "fc_linked",
      "idempotency_conflict",
      "unexpected",
    ])
      expect(Object.hasOwn(FAILURE_CATEGORY, code)).toBe(true);
    // Every throw site was recoded, so the superseded codes left the catalog.
    for (const code of ["funds", "pending"])
      expect(Object.hasOwn(FAILURE_CATEGORY, code)).toBe(false);
  });
});

describe("classifyFailure levels", () => {
  const level = (code: FailureCode) => classifyFailure(new Failure(code, "Fixture.")).level;

  test("routine refusals report at info so the reply's Ref stays findable", () => {
    for (const code of [
      "input",
      "invalid_data",
      "forbidden",
      "setup",
      "not_found",
      "ambiguous",
      // The conflict family.
      "ownership_conflict",
      "fc_linked",
      "initialized",
      "uninitialized",
      "insufficient_funds",
      // The stale family.
      "conflict",
      "superseded",
      "stale",
      "expired",
      // Waits.
      "pending_proof",
      "cooldown",
      "rate_limited",
      "busy",
      "transient",
      "stopping",
      "eligible",
    ] as const)
      expect(level(code)).toBe("info");
  });

  test("dependency and settings trouble reports at warn", () => {
    for (const code of [
      "unavailable",
      "incomplete",
      "invalid_response",
      "blocked",
      "disabled",
    ] as const)
      expect(level(code)).toBe("warn");
  });

  test("failures without an approved explanation report at error", () => {
    expect(level("idempotency_conflict")).toBe("error");
    expect(classifyFailure(new Error("secret token abc")).level).toBe("error");
    const zod = z.object({ id: z.string() }).safeParse({ id: 5 });
    expect(zod.success).toBe(false);
    expect(classifyFailure(zod.error).level).toBe("error");
  });

  test("blocked, paused and terminal job failures agree with jobOutcome's levels", () => {
    // jobOutcome's levels include debug for expected waits, so compare as plain strings.
    for (const error of [
      new Failure("blocked", "Configure a ledger channel."),
      discordError(50013, 403),
      new Failure("disabled", "Effects are disabled."),
      new Failure("invalid_job", "Unknown job kind."),
    ])
      expect<string>(classifyFailure(error).level).toBe(jobOutcome(error, 1).level);
  });
});

describe("classifyFailure shape", () => {
  test("a Failure keeps its code, detail and instance, with source Failure", () => {
    const detail: FailureDetail = { kind: "resource", resource: "entry", id: "abc" };
    const failure = new Failure("not_found", "Entry not found.", 0, detail);
    expect(classifyFailure(failure)).toEqual({
      code: "not_found",
      category: "not_found",
      level: "info",
      source: "Failure",
      failure,
      detail,
    });
    // A Failure without detail carries none.
    expect(classifyFailure(new Failure("input", "Fixture."))).not.toHaveProperty("detail");
  });

  test("an uncatalogued code smuggled past typecheck still classifies safely", () => {
    const failure = new Failure("retired_code" as FailureCode, "Legacy caller.");
    expect(classifyFailure(failure)).toMatchObject({
      code: "unexpected",
      category: "unexpected",
      level: "error",
      source: "Failure",
      failure,
    });
  });

  test("the constructor keeps retryAfter and the optional detail", () => {
    const until = new Date("2026-09-24T00:00:00Z");
    const failure = new Failure("cooldown", "Try later.", 30, {
      kind: "limit",
      limit: "apply",
      until,
    });
    expect(failure).toMatchObject({ code: "cooldown", retryAfter: 30, name: "Failure" });
    expect(failure.detail).toEqual({ kind: "limit", limit: "apply", until });
  });

  test("a non-Failure error is 'unexpected', named only by its class", () => {
    const plain = classifyFailure(new Error("secret token abc"));
    expect(plain).toEqual({
      code: "unexpected",
      category: "unexpected",
      level: "error",
      source: "Error",
    });
    expect(classifyFailure(new TypeError("boom")).source).toBe("TypeError");
    const zod = z.string().safeParse(5);
    expect(zod.success).toBe(false);
    expect(classifyFailure(zod.error)).toMatchObject({ code: "unexpected", source: "ZodError" });
    // A thrown non-Error has no class to name.
    expect(classifyFailure("secret")).toMatchObject({ code: "unexpected", source: "unknown" });
    // Nothing in the classification repeats the raw message.
    expect(JSON.stringify(plain)).not.toContain("secret");
  });

  test("malformed user IDs classify as input, so the reply asks the user to check it", () => {
    // DevBot 2.12.3: /assign member:<typed name> surfaced as a raw SyntaxError before 2.13.0.
    for (const input of ["Wrenfield", "@Wrenfield", "12 34", "<@123>"]) {
      let caught: unknown;
      try {
        id(input);
      } catch (error) {
        caught = error;
      }
      expect(classifyFailure(caught)).toMatchObject({ category: "input", level: "info" });
    }
  });
});

describe("raw Discord errors in interaction paths", () => {
  test("missing access, missing permissions and deleted channels or roles are blocked", () => {
    for (const code of [50001, 50013, 10003, 10011]) {
      const result = classifyFailure(discordError(code, code === 50013 ? 403 : 404));
      expect(result).toEqual({
        code: "blocked",
        category: "blocked",
        level: "warn",
        source: `DiscordAPIError[${code}]`,
      });
    }
  });

  test("an unknown member or user means the actor is no longer a current member", () => {
    for (const code of [10007, 10013])
      expect(classifyFailure(discordError(code, 404))).toEqual({
        code: "forbidden",
        category: "forbidden",
        level: "info",
        source: `DiscordAPIError[${code}]`,
        detail: { kind: "scope", scope: "current_member" },
      });
  });

  test("rate limits and Discord server errors are upstream trouble, not Lodestone outages", () => {
    const api = { code: "unavailable", category: "upstream", level: "warn" };
    const detail = { kind: "discord", what: "api" };
    expect(classifyFailure(discordError(0, 429))).toMatchObject({ ...api, detail });
    expect(classifyFailure(discordError(0, 502))).toMatchObject({ ...api, detail });
    expect(
      classifyFailure(
        new HTTPError(503, "Service Unavailable", "GET", "/guilds/100", {
          body: undefined,
          files: undefined,
        }),
      ),
    ).toMatchObject({ ...api, detail, source: "HTTPError" });
    const limited = new RateLimitError({
      timeToReset: 1000,
      limit: 5,
      method: "PATCH",
      hash: "hash",
      url: "https://discord.com/api/v10/guilds/100/members/200",
      route: "/guilds/:id/members/:id",
      majorParameter: "100",
      global: false,
      retryAfter: 1000,
      sublimitTimeout: 0,
      scope: "user",
    });
    expect(classifyFailure(limited)).toMatchObject({ ...api, detail });
  });

  test("other Discord rejections stay unexpected, named by their numeric code", () => {
    expect(classifyFailure(discordError(50035, 400))).toEqual({
      code: "unexpected",
      category: "unexpected",
      level: "error",
      source: "DiscordAPIError[50035]",
    });
  });
});
