---
title: TaruBot
description: A Discord bot for Final Fantasy XIV Free Companies. Documentation for members, server officers, self-hosters and contributors.
template: splash
hero:
  title: '<em class="orr-holo-text">TaruBot</em>'
  image:
    html: >-
      <div class="orr-orbit" aria-hidden="true">
      <div class="orr-orbit__ring"><span class="orr-orbit__planet orr-orbit__planet--violet"></span></div>
      <div class="orr-orbit__ring orr-orbit__ring--dashed orr-orbit__ring--middle"></div>
      <div class="orr-orbit__ring orr-orbit__ring--inner"><span class="orr-orbit__planet"></span></div>
      <div class="orr-orbit__sun"></div>
      </div>
  tagline: A Discord bot for Final Fantasy XIV Free Companies. It verifies who owns which character through the Lodestone, keeps Discord roles in step with your FC's roster, handles guest access and nicknames, and keeps an exact gil ledger.
  actions:
    - text: Use TaruBot
      link: /tarubot/use/getting-started/
      icon: right-arrow
    - text: Run a server
      link: /tarubot/admin/add-to-server/
      variant: secondary
    - text: Deploy and operate
      link: /tarubot/deploy/requirements/
      variant: secondary
    - text: Architecture
      link: /tarubot/architecture/overview/
      variant: minimal
---

## Who these pages are for

- **[Use TaruBot](/tarubot/use/getting-started/)** is for members and visitors of a server that runs TaruBot: linking your characters, nicknames, guest access, the FC ledger, what to do when something goes wrong, and suggesting features.
- **[Run a server](/tarubot/admin/add-to-server/)** is for officers and server managers: adding the bot, who can do what, setting a server up, roles, the self-service role menu, officers, guest applications, the ledger, officer notices, member status posts and update posts, health checks, and feature suggestions.
- **[Deploy and operate](/tarubot/deploy/requirements/)** is for people who run their own TaruBot: requirements, the Discord application, installation, configuration, updates and backups, monitoring and the maintenance tools.
- **[Architecture and design](/tarubot/architecture/overview/)** is for contributors and the curious: how the bot is built, how it decides access, what it stores, and why.
- **[Reference](/tarubot/reference/commands/)** lists every command and option, and every reply code.

## What TaruBot does

- **Proves character ownership.** Members put a one-time token in their character's public Lodestone biography; TaruBot reads it and links the character.
- **Keeps roles in step with the FC.** It reads the Free Company's roster from the Lodestone and gives Member, Guest, Officer and FC Leader roles to match, across all of a member's characters. Departures are confirmed twice before anyone loses a role.
- **Handles guests.** Registered visitors get Guest automatically; others can apply, and officers approve or deny in a staff channel.
- **Manages nicknames.** Members can have their nickname follow their main character's name.
- **Keeps the gil ledger.** Deposits, withdrawals and corrections are exact, numbered, permanent and posted to a channel.
- **Builds a role menu.** On the web dashboard, officers list roles such as pronouns or games that members and guests will pick for themselves, replacing reaction roles.
- **Can gate channels.** Optional lobby onboarding shows newcomers only a lobby until they link a character or are approved.
- **Tells officers what changed.** A short post in the officers' channel lists members who gained or lost access, Officer or FC Leader, with the reason, and characters that left the FC.
- **Shares what's new.** After an update that changes something you can notice, in Discord, on the dashboard or on this site, it can post a short note in a channel the officers choose.

Every change is saved and audited before TaruBot touches Discord, and the Discord work it owes survives restarts and outages.

## About these pages

These pages describe the latest release on the `main` branch. What changed in each release is in the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md).

TaruBot is free software under the [GNU Affero General Public License v3.0](https://github.com/deconfined/tarubot/blob/main/LICENSE). The source is on [GitHub](https://github.com/deconfined/tarubot); report security issues privately as the [security policy](https://github.com/deconfined/tarubot/security/policy) describes.
