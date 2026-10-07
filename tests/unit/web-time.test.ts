/**
 * The web's one time helper (#43): plain UTC data for `<time datetime>`, the same whatever zone
 * the host runs in, at minute precision without rounding up.
 */
import { expect, test } from "bun:test";
import { time } from "../../src/web/time.js";

test("an instant becomes its ISO string and minute-precision UTC text", () => {
  expect(time(new Date("2026-10-04T21:37:00.000Z"))).toEqual({
    iso: "2026-10-04T21:37:00.000Z",
    text: "2026-10-04 21:37 UTC",
  });
  // Single digits are padded in every field.
  expect(time(new Date("2026-01-02T03:04:05.006Z")).text).toBe("2026-01-02 03:04 UTC");
});

test("seconds are cut, never rounded into a minute that hasn't started", () => {
  const result = time(new Date("2026-12-31T23:59:59.999Z"));
  expect(result.iso).toBe("2026-12-31T23:59:59.999Z");
  expect(result.text).toBe("2026-12-31 23:59 UTC");
});

test("the host's time zone never changes the text", () => {
  const instant = new Date("2026-12-31T23:30:00.000Z");
  const previous = process.env.TZ;
  try {
    // UTC+14: the local date is already the next year, so a local accessor would show 2027.
    process.env.TZ = "Pacific/Kiritimati";
    expect(instant.getHours()).not.toBe(instant.getUTCHours());
    expect(time(instant)).toEqual({
      iso: "2026-12-31T23:30:00.000Z",
      text: "2026-12-31 23:30 UTC",
    });
    // UTC-10, the other direction.
    process.env.TZ = "Pacific/Honolulu";
    expect(time(instant).text).toBe("2026-12-31 23:30 UTC");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("an invalid date is a bug, so it throws instead of rendering text", () => {
  expect(() => time(new Date(Number.NaN))).toThrow(RangeError);
});
