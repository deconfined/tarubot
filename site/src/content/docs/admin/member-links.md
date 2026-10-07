---
title: Managing members' characters
description: Assign and remove character links for members, look up a member's links, and resolve conflicts.
sidebar:
  order: 6
---

Members normally link their own characters with a Lodestone token. Officers can also link a character for a member, remove a wrong link, and look up anyone's links. Every such change needs a reason and is audited.

## Look up a member's characters

```text
/characters member:123456789012345678
```

[`/characters`](/tarubot/reference/commands/#characters) with `member` shows an officer the member's active links, how and when each was made, their main character and nickname setting, and recently ended links. **Full details (JSON)** attaches the complete record. An officer's own `/characters`, without `member`, shows their personal view.

## Assign a character

[`/assign`](/tarubot/reference/commands/#assign) links a character to a member without a Lodestone token, for example when you've confirmed ownership another way:

```text
/assign member:123456789012345678 reason:Confirmed in voice chat character:99000001
/assign member:123456789012345678 reason:Confirmed in voice chat forename:Example surname:Character world:Diabolos
```

- Name the character by its Lodestone ID or profile URL, or by its exact forename, surname and world. If several characters match a name, the reply lists them; run it again with the right ID.
- The member must be in the server, and the reason is required.
- An assigned link is a trusted link, like a verified one: it counts for Member and Guest. If it's the member's first link, it becomes their main and nickname sync turns on; if they had no main, it becomes their main.
- Assigning a character the member already has linked changes nothing and says so.

:::note[Assignments and officer access]
The character's in-game rank counts for officer access only when the assigning officer is a server manager (Manage Server and Manage Roles). An assignment by an officer who holds only the Officer role gives membership, never officer access, so one officer can't appoint another indirectly. The reply says so when an assignment can't grant officer access.
:::

## Remove a link

[`/unassign`](/tarubot/reference/commands/#unassign) ends a member's link:

```text
/unassign member:123456789012345678 character:99000001 reason:Linked by mistake
```

- `character` suggests the chosen member's linked characters.
- It works for members who have left the server: paste their user ID into `member`.
- It works while the Lodestone is down, because it uses stored data.
- The member's roles are rechecked. If it was their main character, TaruBot puts back the nickname they had before it changed theirs, when it can.

The ended link stays in the member's history.

## "Linked to another member"

A character can belong to only one member in a server. When someone claims or is assigned a character that's already linked to another member, the command is refused with **Linked to another member**. Officers see who holds it.

If the existing link is wrong:

1. Remove it with `/unassign`, naming the current owner and the character.
2. The rightful owner claims the character with `/claim` and `/verify`, or you assign it with `/assign`.

## Deleted characters

TaruBot never ends a link by itself. It reads a character's Lodestone profile only to verify ownership, so it doesn't notice when a character is deleted. A deleted character stops counting for Member as soon as it leaves the FC roster, but stays linked until its owner runs `/unclaim` or you remove it with `/unassign`.
