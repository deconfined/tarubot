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
import { type IconName, icon } from "../icons.js";
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

/**
 * A checklist group with at least this many rows folds into a disclosure, but only when every row
 * passed: a failure, a warning, a pending check or an unset resource ([OFF]) is never behind a
 * click, so the open groups are exactly the ones worth reading.
 */
const FOLD_AT = 4;

/** The health snapshot's mark, by the worst check: failures, then warnings, then pending work. */
const HEALTH_MARK: Readonly<Record<"fail" | "warn" | "wait" | "ok", IconName>> = {
  fail: "circle-x",
  warn: "triangle-alert",
  wait: "clock",
  ok: "circle-check",
};

const at = (instant: Date): SafeHtml => {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
};

/** The badge for a check token; its text is the exact bracketed token Discord shows. */
const token = (check: Check): SafeHtml =>
  html`<span class="check check-${check}">${CHECK[check]}</span>`;

/**
 * One saved value under its label. The dd stays the dt's next sibling, which is how assistive
 * technology (and the tests) pair them; each label appears once on the page.
 */
const fact = (label: string, value: SafeHtml | string): SafeHtml =>
  html`<dt class="orr-label">${label}</dt><dd>${value}</dd>`;

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
  return html`${token(fc.fresh ? "ok" : "warn")} ${fc.fresh ? "Fresh" : "Stale"} · ${at(
    fc.last_successful_roster_at,
  )}`;
}

function applications(report: ConfigurationReport): SafeHtml {
  const guild = report.configuration;
  if (!guild.guest_applications_enabled)
    return html`Off · <code>/apply</code> is closed${
      guild.guest_application_channel_id ? " · review channel kept for later" : ""
    }`;
  if (report.guestApplicationsOpen) return html`Open · <code>/apply</code> accepts applications`;
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

/** The Guest grandfathering fact, only once that one-time run is pending or has completed. */
function grandfathering(report: ConfigurationReport): SafeHtml | string {
  const guild = report.configuration;
  if (guild.guest_grandfather === "pending")
    return fact("Guest grandfathering", "Pending · runs once at activation");
  if (guild.guest_grandfather === "completed")
    return fact(
      "Guest grandfathering",
      html`Completed${guild.guest_grandfathered_at ? html` · ${at(guild.guest_grandfathered_at)}` : ""}`,
    );
  return "";
}

/**
 * The page's one featured card (the design's single holographic card per view): what needs
 * attention as its heading, the passed, waiting and off counts as readouts, when the checks ran,
 * and a link down to the checklist. Attention is only FAIL/WARN; WAIT is pending work, and OFF is
 * an intentional disabled setting.
 */
function healthSnapshot(checks: readonly HealthCheck[], checkedAt: Date): SafeHtml {
  const count: Record<Check, number> = { ok: 0, warn: 0, fail: 0, off: 0, wait: 0 };
  for (const row of checks) count[row.check]++;
  const attention = count.fail + count.warn;
  const title =
    attention > 0
      ? `${attention} ${attention === 1 ? "check needs" : "checks need"} attention.`
      : count.wait > 0
        ? "Ready, with work waiting."
        : "All checks passed.";
  const worst = count.fail > 0 ? "fail" : count.warn > 0 ? "warn" : count.wait > 0 ? "wait" : "ok";
  const readout = (tone: Check, label: string, value: number) =>
    html`<div class="orr-stat health-count health-count--${tone}"><dt class="orr-stat__label orr-label">${label}</dt><dd class="orr-stat__value">${value}</dd></div>`;
  return html`<section class="orr-card orr-card--holo orr-holo-edge featured health-card" aria-labelledby="configuration-health">
<div class="orr-card__head">
<span class="health-card__mark health-card__mark--${worst}">${icon(HEALTH_MARK[worst])}</span>
<div class="orr-card__titles">
<p class="orr-label">Health snapshot</p>
<h2 id="configuration-health" class="health-card__title">${title}</h2>
</div>
</div>
<div class="orr-card__body">
<dl class="health-card__counts">${readout("ok", "Passed", count.ok)}${readout("wait", "Waiting", count.wait)}${readout("off", "Off", count.off)}</dl>
</div>
<div class="orr-scale health-card__scale" aria-hidden="true"></div>
<div class="orr-card__foot health-card__foot">
<p class="note">Checked ${at(checkedAt)}</p>
<a class="orr-btn orr-btn--secondary orr-btn--sm" href="#configuration-checklist">View health checklist${icon("chevron-right")}</a>
</div>
</section>`;
}

/**
 * The switches an officer reads first, as the design's stat readouts. A list rather than dt/dd
 * pairs: the Settings cards below hold the facts with these labels, and a label is defined once.
 */
function stateRow(report: ConfigurationReport): SafeHtml {
  const guild = report.configuration;
  const effects = EFFECTS[report.effectsMode];
  const readout = (glyph: IconName, label: string, value: SafeHtml | string) =>
    html`<li class="orr-card orr-card--pad-sm"><div class="orr-card__body orr-stat state-readout"><p class="orr-stat__label">${icon(glyph)}<span class="orr-label">${label}</span></p><p class="orr-stat__value">${value}</p></div></li>`;
  return html`<ul class="state-row" aria-label="Current configuration state">
${readout("refresh-cw", "Discord changes", html`${token(effects.check)}<span>${effects.text}</span>`)}
${readout("compass", "Onboarding", guild.access_policy_enabled ? "On" : "Off")}
${readout("list", "Role layout", guild.role_layout_enabled ? "On" : "Off")}
</ul>`;
}

/** One Settings card: a titled glass card over its saved values, each label over its value. */
function settingsCard(title: string, description: string, facts: SafeHtml): SafeHtml {
  return html`<section class="orr-card">
<div class="orr-card__head"><div class="orr-card__titles"><h3 class="orr-card__title">${title}</h3><p class="orr-card__desc">${description}</p></div></div>
<div class="orr-card__body"><dl class="settings-facts">${facts}</dl></div>
</section>`;
}

function checkItem(row: HealthCheck, names: WebNames): SafeHtml {
  return html`<li class="check-row">${token(row.check)}<span class="check-copy">${mentionText(row.text, names)}</span></li>`;
}

/** Group the shared Discord checklist without hiding any section, unset resource or warning. */
function checklist(checks: readonly HealthCheck[], names: WebNames): SafeHtml[] {
  const sections = new Map<HealthSection, HealthCheck[]>();
  for (const row of checks) {
    const group = sections.get(row.section);
    if (group) group.push(row);
    else sections.set(row.section, [row]);
  }
  return [...sections].map(([section, rows]) => {
    const items = html`<ul class="checklist">${rows.map((row) => checkItem(row, names))}</ul>`;
    const folded = rows.length >= FOLD_AT && rows.every((row) => row.check === "ok");
    return html`<section class="check-group">
<h3 class="check-group__title">${section}</h3>
${folded ? html`<details class="check-group__fold"><summary>${icon("circle-check")}All ${rows.length} checks passed</summary>${items}</details>` : items}
</section>`;
  });
}

/** The six Settings cards: every saved value, including resources kept while a feature is off. */
function settings(
  report: ConfigurationReport,
  fc: FcHealthRow | undefined,
  names: WebNames,
): SafeHtml[] {
  const guild = report.configuration;
  const effects = EFFECTS[report.effectsMode];
  const diagnostic = fc?.last_error
    ? html`<details class="roster-diagnostic"><summary>View roster diagnostic</summary><pre><code>${untrusted(fc.last_error)}</code></pre></details>`
    : null;
  return [
    settingsCard(
      "Free Company",
      "Linked identity and the latest roster read.",
      html`${fact("Company", company(report, fc))}
${fact("Roster read", roster(report, fc))}
${fact("FC ID", guild.fc_id ? html`<code>${guild.fc_id}</code>` : "Not linked")}
${fc?.last_attempt_at ? fact("Last roster attempt", at(fc.last_attempt_at)) : ""}
${diagnostic ? fact("Last roster error", diagnostic) : ""}`,
    ),
    settingsCard(
      "Access roles",
      "Saved roles used for company access.",
      html`${ROLES.map(([field, label]) => fact(label, roleName(guild[field], names)))}`,
    ),
    settingsCard(
      "Channels",
      "Destinations for logs, alerts and applications.",
      html`${CHANNELS.map(([field, label]) => fact(label, channelName(guild[field], names)))}
${fact("Guest applications", applications(report))}`,
    ),
    settingsCard(
      "Officers",
      "How officer access is granted.",
      html`${fact("Officer access", officerAccess(report))}
${fact("In-game rank", guild.officer_rank_name ? untrusted(guild.officer_rank_name) : "Not set")}`,
    ),
    settingsCard(
      "Onboarding",
      "Access rooms remain listed when onboarding is off.",
      html`${fact("Onboarding", guild.access_policy_enabled ? "On" : "Off")}
${fact("Lobby", channelName(guild.lobby_channel_id, names))}
${fact("Officer room", channelName(guild.officer_channel_id, names))}`,
    ),
    settingsCard(
      "Discord automation",
      "Activation, role ordering and the saved revision.",
      html`${fact("Discord changes", html`${token(effects.check)} ${effects.text} · <code>${report.effectsMode}</code>`)}
${fact("Role layout", guild.role_layout_enabled ? "On · FC Leader > Officer > Member > Guest" : "Off · display and order untouched")}
${grandfathering(report)}
${fact("Configuration revision", html`<code>${String(guild.revision)}</code>`)}`,
    ),
  ];
}

export function renderConfiguration(view: ConfigurationView): SafeHtml {
  const { report, checkedAt, names } = view;
  const fc = report.fc?.find((row) => row.id === report.configuration.fc_id);
  const checks = configurationChecks(report);
  return html`<p class="lead">${company(report, fc)}</p>
<div class="config-summary">
${healthSnapshot(checks, checkedAt)}
${stateRow(report)}
</div>
<section aria-labelledby="configuration-settings">
<div class="section-heading">
<h2 id="configuration-settings">Settings</h2>
<p class="section-description">Saved configuration, including resources kept while a feature is off.</p>
</div>
<p class="notice settings-notice">${icon("info")}<span>Read-only. Update settings with <code>/config</code> in Discord.</span></p>
<div class="settings-grid">
${settings(report, fc, names)}
</div>
</section>
<section aria-labelledby="configuration-checklist">
<div class="section-heading">
<h2 id="configuration-checklist">Health checklist</h2>
<p class="section-description">Every resource and visibility check from <code>/config validate</code>.</p>
</div>
<p class="note checklist-note">Checked ${at(checkedAt)}. Successful checks are reused for up to 30 seconds.</p>
<div class="orr-card checklist-card"><div class="orr-card__body">${checklist(checks, names)}</div></div>
</section>`;
}
