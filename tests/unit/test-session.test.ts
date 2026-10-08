/** Session announcements retain complete responsibility-separated checklists and bounded output. */
import { expect, test } from "bun:test";
import { testSessionMessage, testSessionSchema } from "../../src/application/test-session.js";

test("deployed session announcements prohibit automatic mentions", async () => {
  const plan = testSessionSchema.parse(
    await Bun.file(new URL("../../test-plans/current.json", import.meta.url)).json(),
  );
  const result = testSessionMessage(plan, "DevBot", new Date("2026-09-22T00:00:00Z"), true);
  expect(result.allowedMentions).toEqual({ parse: [] });
});
test("oversized or missing action sections fail validation instead of being truncated", () => {
  expect(() =>
    testSessionSchema.parse({
      title: "Test",
      objective: "Test",
      user: [],
      assistant: ["Check"],
      bot: ["Run"],
    }),
  ).toThrow();
  expect(() =>
    testSessionSchema.parse({
      title: "Test",
      objective: "Test",
      user: Array.from({ length: 4 }, () => "x".repeat(400)),
      assistant: ["Check"],
      bot: ["Run"],
    }),
  ).toThrow();
});
