/**
 * The job kinds this release's dispatcher (src/jobs/dispatch.ts) can run. A worker claims only
 * these. A release that is restored after a newer one ran (a failed delivery rolled back, or an
 * owner restarting the recorded release) would otherwise claim the newer release's job kinds,
 * fail them as `invalid_job` and so lose work the newer release will want back. A job of a kind
 * nobody here knows simply stays queued until a release that knows it runs again.
 *
 * Adding a kind to the dispatcher means adding it here: tests/unit/job-kinds.test.ts fails when the
 * dispatcher handles a kind this list lacks, and when a call site enqueues one it lacks.
 */
import { MODMAIL_DM_KIND, MODMAIL_PING_KIND } from "../domain/modmail.js";
import { ROLE_CHOICE_KIND } from "../domain/self-roles.js";

export const JOB_KINDS = [
  "roster",
  "roster.confirm",
  "issue.report",
  "channels.access",
  "reconcile.guild",
  "reconcile.user",
  // Retired (#86): kept so an older refresh still queued before an upgrade completes as skipped.
  "profile",
  "roles.layout",
  "changelog.post",
  "ledger.notify",
  "guest.review",
  "guest.dm",
  "officer.notify",
  "officer.status",
  ROLE_CHOICE_KIND,
  MODMAIL_PING_KIND,
  MODMAIL_DM_KIND,
] as const;

export type JobKind = (typeof JOB_KINDS)[number];
