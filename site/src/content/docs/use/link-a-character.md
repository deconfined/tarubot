---
title: Link a character
description: Prove a character is yours with a Lodestone token, and remove a link.
sidebar:
  order: 2
---

Linking a character tells TaruBot it's yours. You prove it by putting a one-time token in the character's public Lodestone biography, which only the character's owner can edit. Once the link is made, TaruBot gives you the roles that character earns in this server.

## 1. Claim the character

Run [`/claim`](/tarubot/reference/commands/#claim) with either the character's Lodestone ID or profile URL, or its exact name and world:

```text
/claim character:99000001
/claim forename:Example surname:Character world:Diabolos
```

A name search needs an exact match. If several characters match, the reply lists them; run `/claim` again with the right one's ID.

The reply shows your token (it starts with `tarubot_`), a link to your character's Lodestone page, and a link to the profile editor. The token is valid for 30 minutes unless this server's operator set a different time, and the reply shows when it expires. You can have up to five unfinished claims at a time.

## 2. Put the token in your biography

1. Open **Edit Character Profile** from the reply, or sign in to the Lodestone and edit your character's profile.
2. Paste the whole token anywhere in the **Character Profile** (the biography) and save. The rest of your biography can stay.
3. Make sure the profile is public. TaruBot can't read a private profile.

## 3. Verify

Click **I've added it — verify now** on the claim reply, or run [`/verify`](/tarubot/reference/commands/#verify):

```text
/verify character:99000001
```

TaruBot reads the profile fresh from the Lodestone and looks for your token.

- **Linked.** The reply confirms the link. If this is your first linked character, it becomes your main character and nickname sync turns on. The reply also shows whether the FC's roster lists the character yet; your Member role follows once it does.
- **"Token not on the Lodestone yet."** The Lodestone can take several minutes to publish a saved biography. Your token is still valid: wait a little, then click **Check again**. The button waits 15 seconds between checks.
- **"Lodestone profile is private."** Make the character's profile public on the Lodestone, then try again. Your token is still valid.
- **"Token expired during verification."** Run `/claim` again for a new token and put that one in your biography.

Once you're linked, you can take the token out of your biography. It can't be used again.

## Linked to another member

If the character is already linked to someone else in this server, the claim is refused with **Linked to another member**. A character can belong to only one member per server. If the link is wrong, ask an officer: they can remove it with [`/unassign`](/tarubot/reference/commands/#unassign), then you can claim the character.

## Several characters

You can link as many characters as you own. TaruBot looks at all of them together: any character in the FC makes you a Member, and any character holding the officer rank the server chose gives officer access. Choose which one names you with `/main`; see [Characters and nicknames](/tarubot/use/characters-and-nicknames/).

## Remove a link

Run [`/unclaim`](/tarubot/reference/commands/#unclaim) and pick the character from the suggestions:

```text
/unclaim character:99000001
```

It works even while the Lodestone is down, because it uses what TaruBot has stored. Your roles are rechecked right away. If it was your main character, TaruBot puts back the nickname you had before it changed yours, when it can; choose another main with `/main`.

TaruBot never removes a link by itself, even when a character is deleted. Remove a deleted character's link with `/unclaim`.
