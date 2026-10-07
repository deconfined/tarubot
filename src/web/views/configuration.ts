/** Server configuration: typed state in, escaped read-only markup out; no service or gateway I/O. */
import type { ConfigurationReport, EffectsMode, FcHealthRow } from "../../application/results.js";
import {
  configurationChecks,
  type HealthCheck,
  type HealthSection,
} from "../../discord/presenters/configuration.js";
import { fcTagText, lodestone } from "../../discord/presenters/format.js";
import { CHECK, type Check } from "../../discord/presenters/style.js";
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { channelName, mentionText, roleName, type WebNames } from "../mentions.js";
import { time } from "../time.js";

/** A successful resource validation and the actual instant at which it finished. */
export interface CheckedConfiguration {
  readonly report: ConfigurationReport;
  readonly checkedAt: Date;
}

export interface ConfigurationView extends CheckedConfiguration {
  readonly names: WebNames;
}

const EFFECTS: Readonly<Record<EffectsMode, { readonly check: Check; readonly text: string }>> = {
  live: { check: "ok", text: "Live" },
  awaiting_activation: { check: "wait", text: "Paused · pending activation" },
  deployment_disabled: { check: "off", text: "Disabled for this deployment" },
};

const ROLES = [
  ["leader_role_id", "FC Leader role"],
  ["officer_role_id", "Officer role"],
  ["member_role_id", "Member role"],
  ["guest_role_id", "Guest role"],
] as const;

const CHANNELS = [
  ["ledger_channel_id", "Ledger"],
  ["officer_notifications_channel_id", "Officer notifications"],
  ["guest_application_channel_id", "Guest application reviews"],
  ["changelog_channel_id", "Changelog"],
] as const;

const at = (instant: Date): SafeHtml => {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
};

/** A linked ID remains a real Lodestone link even if its cached identity has not arrived yet. */
function company(report: ConfigurationReport, fc: FcHealthRow | undefined): SafeHtml {
  const id = report.configuration.fc_id;
  if (id === null) return html`No Free Company linked`;
  const tag = fc ? fcTagText(fc.tag) : null;
  const name = fc?.name.trim() || `FC ${id}`;
  return html`<a href="${href(lodestone.freeCompany(id))}">${untrusted(name)}${
    tag ? html` ${untrusted(`«${tag}»`)}` : ""
  }</a>${fc?.world ? html` · ${untrusted(fc.world)}` : ""}`;
}

function roster(report: ConfigurationReport, fc: FcHealthRow | undefined): SafeHtml {
  if (report.configuration.fc_id === null) return html`No FC linked`;
  if (!fc?.last_successful_roster_at) return html`No successful roster read yet`;
  return html`<span class="check check-${fc.fresh ? "ok" : "warn"}">${
    CHECK[fc.fresh ? "ok" : "warn"]
  }</span> ${fc.fresh ? "Fresh" : "Stale"} · ${at(fc.last_successful_roster_at)}`;
}

function applications(report: ConfigurationReport): SafeHtml {
  const guild = report.configuration;
  if (!guild.guest_applications_enabled)
    return html`Off · /apply is closed${
      guild.guest_application_channel_id ? " · review channel kept for later" : ""
    }`;
  if (report.guestApplicationsOpen) return html`Open · /apply accepts applications`;
  if (guild.guest_application_channel_id === null) return html`Closed · no review channel`;
  return html`Closed · no Guest role`;
}

function officerAccess(report: ConfigurationReport): SafeHtml {
  const guild = report.configuration;
  if (guild.officer_role_id === null) return html`Server managers only`;
  if (guild.officer_rank_name)
    return html`In-game rank ${untrusted(guild.officer_rank_name)} + manual grants (<code>/officer grant</code>)`;
  return html`Manual grants only (<code>/officer grant</code>)`;
}

function checkItem(row: HealthCheck, names: WebNames): SafeHtml {
  return html`<li><span class="check check-${row.check}">${CHECK[row.check]}</span> ${mentionText(row.text, names)}</li>`;
}

/** Group the shared Discord checklist without hiding any section, unset resource or warning. */
function checklist(checks: readonly HealthCheck[], names: WebNames): SafeHtml[] {
  const sections = new Map<HealthSection, HealthCheck[]>();
  for (const row of checks) {
    const group = sections.get(row.section);
    if (group) group.push(row);
    else sections.set(row.section, [row]);
  }
  return [...sections].map(
    ([section, rows]) => html`<section class="settings-section">
<h3>${section}</h3>
<ul class="items">${rows.map((row) => checkItem(row, names))}</ul>
</section>`,
  );
}

/** Attention is only FAIL/WARN; WAIT is pending work, and OFF is an intentional disabled setting. */
function healthSummary(checks: readonly HealthCheck[], checkedAt: Date): SafeHtml {
  let attention = 0;
  let waiting = 0;
  let passed = 0;
  for (const row of checks) {
    if (row.check === "fail" || row.check === "warn") attention++;
    else if (row.check === "wait") waiting++;
    else if (row.check === "ok") passed++;
  }
  const title =
    attention > 0
      ? `${attention} ${attention === 1 ? "check needs" : "checks need"} attention.`
      : waiting > 0
        ? "Ready, with work waiting."
        : "All checks passed.";
  return html`<section class="panel featured" aria-labelledby="configuration-health">
<p class="note">Health check · checked ${at(checkedAt)}</p>
<h2 id="configuration-health">${title}</h2>
<p>${passed} ${passed === 1 ? "check" : "checks"} passed. Nothing was changed.</p>
<p><a class="button" href="#configuration-checklist">View health checklist</a></p>
<p class="note">Review the full checklist below. Fix what a check names using <code>/config</code> in Discord.</p>
</section>`;
}

export function renderConfiguration(view: ConfigurationView): SafeHtml {
  const { report, checkedAt, names } = view;
  const guild = report.configuration;
  const fc = report.fc?.find((row) => row.id === guild.fc_id);
  const checks = configurationChecks(report);
  const effects = EFFECTS[report.effectsMode];
  return html`<div class="dashboard-intro">
<div>
<p class="lead">${company(report, fc)}</p>
<p class="note">Discord changes ${effects.text} · Onboarding ${guild.access_policy_enabled ? "On" : "Off"} · Role layout ${guild.role_layout_enabled ? "On" : "Off"}</p>
<p>Read-only view. Change settings with <code>/config</code> in Discord; this dashboard does not change roles, channels or configuration.</p>
</div>
${healthSummary(checks, checkedAt)}
</div>
<section aria-labelledby="configuration-settings">
<h2 id="configuration-settings">Settings</h2>
<div class="settings-grid">
<section class="settings-section">
<h3>Free Company</h3>
<dl class="facts">
<dt>Company</dt><dd>${company(report, fc)}</dd>
<dt>Roster read</dt><dd>${roster(report, fc)}</dd>
<dt>FC ID</dt><dd>${guild.fc_id ? html`<code>${guild.fc_id}</code>` : "Not linked"}</dd>
${fc?.last_attempt_at ? html`<dt>Last roster attempt</dt><dd>${at(fc.last_attempt_at)}</dd>` : ""}
${fc?.last_error ? html`<dt>Last roster error</dt><dd><code>${untrusted(fc.last_error)}</code></dd>` : ""}
</dl>
</section>
<section class="settings-section">
<h3>Access roles</h3>
<dl class="facts">${ROLES.map(
    ([field, label]) => html`<dt>${label}</dt><dd>${roleName(guild[field], names)}</dd>`,
  )}</dl>
</section>
<section class="settings-section">
<h3>Channels</h3>
<dl class="facts">${CHANNELS.map(
    ([field, label]) => html`<dt>${label}</dt><dd>${channelName(guild[field], names)}</dd>`,
  )}
<dt>Guest applications</dt><dd>${applications(report)}</dd>
</dl>
</section>
<section class="settings-section">
<h3>Officers and switches</h3>
<dl class="facts">
<dt>Officer access</dt><dd>${officerAccess(report)}</dd>
<dt>In-game rank</dt><dd>${guild.officer_rank_name ? untrusted(guild.officer_rank_name) : "Not set"}</dd>
<dt>Onboarding</dt><dd>${guild.access_policy_enabled ? "On" : "Off"}</dd>
<dt>Lobby</dt><dd>${channelName(guild.lobby_channel_id, names)}</dd>
<dt>Officer room</dt><dd>${channelName(guild.officer_channel_id, names)}</dd>
<dt>Discord changes</dt><dd><span class="check check-${effects.check}">${CHECK[effects.check]}</span> ${effects.text} · <code>${report.effectsMode}</code></dd>
<dt>Role layout</dt><dd>${guild.role_layout_enabled ? "On · FC Leader > Officer > Member > Guest" : "Off · display and order untouched"}</dd>
${
  guild.guest_grandfather === "pending"
    ? html`<dt>Guest grandfathering</dt><dd>Pending · runs once at activation</dd>`
    : guild.guest_grandfather === "completed"
      ? html`<dt>Guest grandfathering</dt><dd>Completed${guild.guest_grandfathered_at ? html` · ${at(guild.guest_grandfathered_at)}` : ""}</dd>`
      : ""
}
<dt>Configuration revision</dt><dd><code>${String(guild.revision)}</code></dd>
</dl>
</section>
</div>
</section>
<section aria-labelledby="configuration-checklist">
<h2 id="configuration-checklist">Health checklist</h2>
<p class="note">The same resource and visibility checks as <code>/config validate</code>, checked ${at(checkedAt)}. Successful checks are reused for up to 30 seconds.</p>
<div class="settings-grid">${checklist(checks, names)}</div>
</section>`;
}
