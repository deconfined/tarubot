---
title: Create a Discord application
description: Create the Discord application and bot user your deployment runs as.
sidebar:
  order: 2
---

Every TaruBot deployment runs as its own Discord application. Create one in the [Discord Developer Portal](https://discord.com/developers/applications), signed in as the account that will own it.

1. **Create the application.** Choose **New Application** and give it a name; members see it as the bot's name. You can set an icon and description on **General Information**.
2. **Copy the application ID.** On **General Information**, copy the **Application ID**. It goes in `.env` as `DISCORD_APPLICATION_ID`.
3. **Get the bot token.** On the **Bot** page, choose **Reset Token** and copy the token. It goes in `.env` as `DISCORD_TOKEN`. Discord shows it once; if you lose it, reset it again, and the old one stops working. Treat it like a password: anyone holding it controls the bot.
4. **Turn on the Server Members Intent.** On the **Bot** page, under **Privileged Gateway Intents**, switch on **Server Members Intent** and save. TaruBot needs it to read the full member list and see members join, leave and change roles or nicknames. The other two privileged intents (Presence and Message Content) stay off.
5. **Turn off Public Bot.** On the **Bot** page, switch **Public Bot** off and save, so only you, the application's owner, can add the bot to a server. Left on, anyone with its authorization link can add it to a server they manage. If Discord refuses because a private application can't have a default authorization link, set **Install Link** to **None** on the **Installation** page first.

TaruBot checks at startup that the token belongs to `DISCORD_APPLICATION_ID`, and the maintenance tools check it before they touch Discord, so a token from another application is refused instead of used.

Next, [install the deployment](/tarubot/deploy/install/), then [add the bot to your server](/tarubot/admin/add-to-server/). Build the authorization URL yourself from your application ID, the `bot` and `applications.commands` scopes and [the permissions TaruBot needs](/tarubot/admin/add-to-server/#permissions).

:::note
Use a separate application, and a separate database, for development and testing. A development application registered to one test server can't reach your members, and a test database can't touch real records.
:::
