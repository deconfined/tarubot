/**
 * Release notes for update posts (issue #30; owner rules of 2026-09-25 and 2026-10-09). Every
 * release from 2.25.0, when update posts launched, is in exactly one of the two maps below, and
 * tests/unit/changelog.test.ts fails until it is:
 *
 * - RELEASE_NOTES: one sentence for each release that anyone using TaruBot can notice (members,
 *   guests or officers; in Discord, on the web dashboard or on the documentation site), in plain
 *   words about what they'll see or can now do. Officer-only, dashboard and documentation-site
 *   changes count. "It should be what's meaningful for users, not the technical side. If people
 *   want the commit list, /version will lead them there."
 * - NO_RELEASE_NOTE: a short reason for each release nobody using TaruBot can notice (deployment
 *   tooling, CI, infrastructure, internal refactors), so a missing note is a recorded decision,
 *   never an oversight.
 *
 * Update posts read only RELEASE_NOTES: an exempt release is never shown, and an update whose
 * releases are all exempt posts nothing (decision 2). A post lists only releases after the version
 * a server last stored, so a note added after its release has run is a record, not an
 * announcement. Keys are the release's package.json version with a CHANGELOG.md heading; the test
 * also keeps each note to one line within the 300-character field limit after escaping, with no
 * mention or link. A release PR adds one line to one map. Data only.
 */
export const RELEASE_NOTES: Readonly<Record<string, string>> = {
  "2.25.0":
    "Officers can now pick a channel where TaruBot shares what's new for members when an update changes something for them.",
  "2.27.0":
    "TaruBot now has a public documentation site, linked from its GitHub page, with guides for members and officers and a reference for every command.",
  "2.28.0":
    "Members and guests can now suggest TaruBot features with /suggest: the idea is posted publicly on GitHub by TaruBot, without your name.",
  "2.29.0":
    "Officers now get a post in the officer notifications channel when people gain or lose the Member, Guest, Officer or FC Leader role, or when a linked character leaves the FC.",
  "2.30.1":
    "The documentation site now has a Thank you page for the people who tested TaruBot, and its roadmap now plans a web app for members, starting with raid and activity scheduling.",
  "2.30.2":
    "TaruBot is ready for Discord hiding channels from bots in November 2026: setup stops at any channel TaruBot can't see and names it, and /channel there shows only the channel's ID.",
  "2.30.4":
    "The documentation site's guide to adding TaruBot to a server no longer has an invite link: it now explains that whoever runs your TaruBot adds it to your server.",
  "2.35.0":
    "TaruBot no longer needs to keep Administrator: server managers can run /setup overrides to give it the channel access it needs, and officers are warned in /config validate and by an alert when a channel still lacks it.",
  "2.36.44":
    "Claiming a character that's in the FC is now quicker, and TaruBot no longer removes a character link by itself when the Lodestone can't find the character; remove a deleted one with /unclaim.",
  "2.37.0":
    "Officers can now sign in with Discord to a view-only web dashboard of their server's settings, health checks and background work, once whoever hosts TaruBot turns it on.",
  "2.38.0":
    "The officer dashboard and the documentation site have a new look and are now always dark; the dashboard is also easier to use on a phone and no longer contacts Google when you open it.",
  "2.38.1":
    "Update posts in this channel now cover every change members, guests or officers can notice, not only new features for members.",
  "2.39.0":
    "Officers can now build a menu of roles people choose for themselves, such as pronouns or games, on the dashboard's new Role menu page. Members and guests will pick from it in an upcoming update.",
  // Conditional, as 2.37.0's is: member sign-in waits for owner steps (the web on, no Administrator
  // for TaruBot, a staging check) that this release may well run before, and its post can't be
  // corrected once it has gone out.
  "2.40.0":
    "Members and guests can pick their own roles, such as pronouns or games, on TaruBot's new My roles page once it's turned on for your server. Roles you already have show up there.",
  "2.41.0":
    "TaruBot's dashboard now has a public status page, linked at the bottom of every page: anyone can see whether TaruBot is up and its uptime over 90 days, no sign-in needed. While it restarts, the dashboard says so.",
};

/**
 * Releases since 2.25.0 that nobody using TaruBot can notice, each with a one-line reason of at most
 * 80 characters (CHANGELOG.md holds the detail). Update posts never read this map.
 */
export const NO_RELEASE_NOTE: Readonly<Record<string, string>> = {
  "2.29.1": "CI only: automatic reviews of the agent's pull requests.",
  "2.29.2": "Deployment tooling and operator documentation only.",
  "2.30.0": "Deployment tooling only: approved production deploys over SSH.",
  "2.30.3": "Deployment tooling only: hardened container settings, same behavior.",
  "2.32.0": "Deployment tooling only: staging host setup and signed images.",
  "2.32.1": "Deployment tooling only: host tool version pins.",
  "2.33.0": "Deployment tooling only: staging deploys, host secrets and backups.",
  "2.34.0": "Deployment tooling only: hosts apply their own configuration.",
  "2.36.0": "Deployment tooling only: the staging deployment pipeline.",
  "2.36.1": "Internal documentation only: the contributor guide.",
  "2.36.2": "Internal documentation only: the pipeline specification.",
  "2.36.3": "Deployment tooling only: infrastructure plan safety checks.",
  "2.36.4": "Internal documentation only: the pipeline specification update.",
  "2.36.5": "Deployment tooling only: infrastructure control records.",
  "2.36.6": "Deployment tooling only: release scanning and staging checks.",
  "2.36.7": "Deployment tooling only: database adoption guards.",
  "2.36.8": "Deployment tooling only: SSH host trust records.",
  "2.36.9": "Deployment tooling only: SSH, DNS and recovery checks.",
  "2.36.10": "Deployment tooling only: provider and storage adapters.",
  "2.36.11": "Deployment tooling only: deployment handoff and storage reads.",
  "2.36.12": "Deployment tooling only: deployment authority checks.",
  "2.36.13": "Deployment tooling only: deployment record storage.",
  "2.36.14": "Deployment tooling only: signed deployment receipts.",
  "2.36.15": "Deployment tooling only: deployment control settings.",
  "2.36.16": "Deployment tooling only: SSH transport.",
  "2.36.17": "Deployment tooling only: vulnerability scan exceptions.",
  "2.36.18": "Deployment tooling only: deployment journal safeguards.",
  "2.36.19": "Deployment tooling only: host bridge framing.",
  "2.36.20": "Deployment tooling only: infrastructure baseline evidence.",
  "2.36.21": "Internal checks only: Ansible test fixtures.",
  "2.36.22": "Deployment tooling only: deployment issuance evidence.",
  "2.36.23": "Deployment tooling only: per-target deployment transport.",
  "2.36.24": "Deployment tooling only: infrastructure journal internals.",
  "2.36.25": "CI only: review workflows removed; code comments reworded.",
  "2.36.26": "Deployment tooling only: deployment issuance adapters.",
  "2.36.27": "Deployment tooling only: deployment journal read limits.",
  "2.36.28": "Deployment tooling only: host enrollment evidence.",
  "2.36.29": "CI only: code-scanning workflow cleanup.",
  "2.36.30": "Deployment tooling only: deployment journal owner checks.",
  "2.36.31": "Deployment tooling only: SSH preparation fixes.",
  "2.36.32": "Deployment tooling only: DNS preparation timing.",
  "2.36.33": "Deployment tooling only: deployment journal read scope.",
  "2.36.34": "Deployment tooling only: staging host checks.",
  "2.36.35": "Deployment tooling only: deployment journal deadline fixes.",
  "2.36.36": "Deployment tooling only: deployment transport deadline fixes.",
  "2.36.37": "Deployment tooling only: host exchange deadlines.",
  "2.36.38": "Deployment tooling only: host controller image recipe.",
  "2.36.39": "Deployment tooling only: workflow denial controller.",
  "2.36.40": "Deployment tooling only: deployment record history.",
  "2.36.41": "Internal and operator documentation only.",
  "2.36.42": "Container image update only; the bot behaves the same.",
  "2.36.43": "Deployment tooling and operator documentation only.",
  "2.37.1": "Deployment tooling only: a proxy configuration fix.",
};
