/**
 * Per-person moderation, the pure parts (2.45.0, src/domain/moderation.ts): how long a pause lasts,
 * and the features it can name in plain words. What a pause does to a decision is policy.test.ts;
 * who may set one, and the stored history, are tests/integration/moderation.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAUSE_DURATION,
  featureLabel,
  featuresMatchCatalog,
  isPauseDuration,
  PAUSE_DURATIONS,
  PAUSE_FEATURE_IDS,
  PAUSE_FEATURES,
  type PauseDuration,
} from "../../src/domain/moderation.js";
import { BLOCKABLE, PERMISSION_IDS, type PermissionId } from "../../src/domain/rbac.js";

describe("how long a pause lasts", () => {
  test("the choices, their seconds and their labels are pinned, shortest first", () => {
    expect(PAUSE_DURATIONS).toEqual({
      "1h": { seconds: 3_600, label: "1 hour" },
      "1d": { seconds: 86_400, label: "1 day" },
      "1w": { seconds: 604_800, label: "1 week" },
      "30d": { seconds: 2_592_000, label: "30 days" },
      forever: { seconds: null, label: "Until lifted" },
    });
    // The order is what a slash command's choices and a form's menu show.
    expect(Object.keys(PAUSE_DURATIONS)).toEqual(["1h", "1d", "1w", "30d", "forever"]);
  });

  test("each finite choice is longer than the one before, and only forever has no end", () => {
    const finite = Object.values(PAUSE_DURATIONS).flatMap(({ seconds }) =>
      seconds === null ? [] : [seconds],
    );
    expect(finite).toEqual([...finite].sort((a, b) => a - b));
    expect(new Set(finite).size).toBe(finite.length);
    expect(finite).toHaveLength(Object.keys(PAUSE_DURATIONS).length - 1);
    expect(PAUSE_DURATIONS.forever.seconds).toBeNull();
    for (const { seconds } of Object.values(PAUSE_DURATIONS))
      expect(seconds === null || Number.isInteger(seconds)).toBe(true);
  });

  test("every label is plain words and no two are alike", () => {
    const labels = Object.values(PAUSE_DURATIONS).map(({ label }) => label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim()).toBe(label);
  });

  test("a week is the default, and it is one of the choices", () => {
    expect(DEFAULT_PAUSE_DURATION).toBe("1w");
    expect(isPauseDuration(DEFAULT_PAUSE_DURATION)).toBe(true);
    expect(PAUSE_DURATIONS[DEFAULT_PAUSE_DURATION].seconds as number | null).toBe(7 * 86_400);
  });

  test("isPauseDuration accepts exactly the listed keys, as typed", () => {
    for (const key of Object.keys(PAUSE_DURATIONS)) expect(isPauseDuration(key)).toBe(true);
    for (const value of [
      "",
      "1W",
      "1H",
      "FOREVER",
      " 1w",
      "1w ",
      "2w",
      "1 week",
      "week",
      "toString",
      "constructor",
      "hasOwnProperty",
      "__proto__",
      "valueOf",
      1,
      0,
      null,
      undefined,
      true,
      ["1w"],
      { toString: () => "1w" },
    ])
      expect(isPauseDuration(value)).toBe(false);
  });

  test("isPauseDuration narrows to the type that indexes the table", () => {
    const chosen: unknown = "30d";
    const label = isPauseDuration(chosen) ? PAUSE_DURATIONS[chosen].label : null;
    expect(label).toBe("30 days");
    const all: PauseDuration[] = ["1h", "1d", "1w", "30d", "forever"];
    expect(all.map((key) => PAUSE_DURATIONS[key].label)).toHaveLength(5);
  });
});

describe("the features a pause can name", () => {
  test("they are exactly the blockable permissions, in catalog order, each once", () => {
    expect([...PAUSE_FEATURE_IDS]).toEqual([...BLOCKABLE]);
    expect(PAUSE_FEATURES.map((feature) => feature.permission)).toEqual([...PAUSE_FEATURE_IDS]);
    expect(new Set(PAUSE_FEATURE_IDS).size).toBe(PAUSE_FEATURE_IDS.length);
    expect(featuresMatchCatalog()).toBe(true);
    // Catalog order is the order the page lists them in.
    expect([...PAUSE_FEATURE_IDS]).toEqual(PERMISSION_IDS.filter((id) => BLOCKABLE.includes(id)));
  });

  test("each has a label of its own, and none is just the permission id", () => {
    const labels = PAUSE_FEATURES.map((feature) => feature.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const { permission, label } of PAUSE_FEATURES) {
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(permission);
      expect(label).not.toContain(".");
    }
  });

  test("a label names the command or page it stops, in the words people use", () => {
    const named: Readonly<Partial<Record<PermissionId, string>>> = {
      "characters.claim": "/claim",
      "roster.refresh": "/refresh",
      "guests.apply": "/apply",
      "suggest.use": "/suggest",
      "issue.use": "/issue",
      "selfroles.use": "My roles",
      "modmail.open": "mod mail",
      "ledger.view": "ledger",
      "ledger.deposit": "ledger",
    };
    for (const [id, word] of Object.entries(named))
      expect(featureLabel(id as PermissionId).toLowerCase()).toContain(word.toLowerCase());
    // The two ledger chips are told apart, since an officer picks one of them.
    expect(featureLabel("ledger.view")).not.toBe(featureLabel("ledger.deposit"));
  });

  test("featureLabel gives the plain label for a blockable id and the id for anything else", () => {
    for (const { permission, label } of PAUSE_FEATURES)
      expect(featureLabel(permission)).toBe(label);
    // A staff or fixed permission isn't listed this release; the id is shown, never a blank.
    expect(featureLabel("config.view")).toBe("config.view");
    expect(featureLabel("admin.fc")).toBe("admin.fc");
    expect(featureLabel("moderation.block")).toBe("moderation.block");
    // A stored row naming an id from a later release still reads as something.
    expect(featureLabel("future.feature" as PermissionId)).toBe("future.feature");
  });

  test("featuresMatchCatalog notices a feature the catalog doesn't allow, or one it left out", () => {
    const ids = PAUSE_FEATURE_IDS as PermissionId[];
    const saved = [...ids];
    try {
      ids.push("config.view");
      expect(featuresMatchCatalog()).toBe(false);
      ids.splice(0, ids.length, ...saved.slice(1), "config.view");
      expect(featuresMatchCatalog()).toBe(false);
      ids.splice(0, ids.length, ...saved.slice(1));
      expect(featuresMatchCatalog()).toBe(false);
    } finally {
      ids.splice(0, ids.length, ...saved);
    }
    expect(featuresMatchCatalog()).toBe(true);
    expect([...PAUSE_FEATURE_IDS]).toEqual(saved);
  });
});
