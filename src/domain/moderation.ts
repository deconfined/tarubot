/**
 * Per-person moderation, pure parts (2.45.0, owner decision 3): how long a pause lasts and the
 * features it can name, in the words people see them in. What a pause does (deny-only, on the
 * permission catalog) is src/domain/policy.ts; who may set one is src/application/moderation.ts.
 */
import { BLOCKABLE, type PermissionId } from "./rbac.js";

/** How long a pause lasts: fixed choices, so a slash command can offer them and a form can too. */
export const PAUSE_DURATIONS = {
  "1h": { seconds: 3_600, label: "1 hour" },
  "1d": { seconds: 86_400, label: "1 day" },
  "1w": { seconds: 604_800, label: "1 week" },
  "30d": { seconds: 2_592_000, label: "30 days" },
  forever: { seconds: null, label: "Until lifted" },
} as const;

export type PauseDuration = keyof typeof PAUSE_DURATIONS;

/** A week: long enough to matter, short enough that forgetting one is harmless. */
export const DEFAULT_PAUSE_DURATION: PauseDuration = "1w";

/** Whether an untrusted string names a duration. */
export const isPauseDuration = (value: unknown): value is PauseDuration =>
  typeof value === "string" && Object.hasOwn(PAUSE_DURATIONS, value);

/**
 * What a pause can name, in catalog order: the permission, the feature in plain words (what a
 * paused person's card and an officer's chip say) and the command or page that feature is. Exactly
 * BLOCKABLE; tests/unit/moderation.test.ts keeps the two in step.
 */
export const PAUSE_FEATURES: readonly {
  readonly permission: PermissionId;
  readonly label: string;
}[] = [
  { permission: "characters.claim", label: "Linking characters (/claim and /verify)" },
  { permission: "roster.refresh", label: "Roster checks (/refresh)" },
  { permission: "guests.apply", label: "Guest applications (/apply)" },
  { permission: "ledger.view", label: "Reading the ledger" },
  { permission: "ledger.deposit", label: "Recording ledger deposits" },
  { permission: "modmail.open", label: "Opening mod mail cases" },
  { permission: "selfroles.use", label: "Picking roles on My roles" },
  { permission: "suggest.use", label: "Suggesting features (/suggest)" },
  { permission: "issue.use", label: "Reporting problems (/issue)" },
];

/** The feature's plain-words name, or the permission id for one this release doesn't list. */
export const featureLabel = (id: PermissionId): string =>
  PAUSE_FEATURES.find((feature) => feature.permission === id)?.label ?? id;

/** The pause features, as ids, for a check against the catalog. */
export const PAUSE_FEATURE_IDS: readonly PermissionId[] = PAUSE_FEATURES.map(
  (feature) => feature.permission,
);

/** Whether the listed features are exactly what BLOCKABLE allows (a test asserts it). */
export const featuresMatchCatalog = (): boolean =>
  PAUSE_FEATURE_IDS.length === BLOCKABLE.length &&
  BLOCKABLE.every((id) => PAUSE_FEATURE_IDS.includes(id));
