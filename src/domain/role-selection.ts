/** Reuse configured or recognizably named guild roles before provisioning new Discord IDs. */
import { Failure, normalized } from "./values.js";

/** A prefix changes presentation, not whether an existing canonical role is eligible for reuse. */
export function existingRoleId(
  roles: readonly { id: string; name: string }[],
  desiredName: string,
  canonicalName: string,
  configured: string | null,
): string | null {
  if (configured && roles.some((role) => role.id === configured)) return configured;
  const names = new Set([normalized(desiredName), normalized(canonicalName)]);
  const matches = roles.filter((role) => names.has(normalized(role.name)));
  // Guessing between same-named roles could hand access to the wrong one, so the officer picks.
  if (matches.length > 1)
    throw new Failure(
      "ambiguous",
      `Several roles are named ${canonicalName}. Choose the one to use with /config roles, then run /setup onboarding again.`,
      0,
      {
        kind: "matches",
        resource: "role",
        name: canonicalName,
        ids: matches.map((role) => role.id),
      },
    );
  return matches[0]?.id ?? null;
}
