---
title: The FC ledger
description: Record deposits to the FC chest and read the balance and history.
sidebar:
  order: 6
---

TaruBot keeps an exact record of the gil in the Free Company chest. People record what they put in and take out; TaruBot doesn't read the chest itself. Every entry is permanent and numbered, and each one is posted to the server's ledger channel.

The ledger is for **confirmed FC members**: you need a linked character that an accepted roster lists in the FC. Officers can always use it.

## Record a deposit

Run [`/ledger deposit`](/tarubot/reference/commands/#ledger-deposit) with the amount in gil and a note saying what it's for:

```text
/ledger deposit amount:10005000 note:Weekly FC chest deposit
```

- The amount is whole gil, from 1 to 999,999,999.
- The note is required, up to 1,000 characters.
- The receipt shows the entry number (such as `#42`) and the new balance, and the entry is posted to the ledger channel.

If a deposit ends in an error, check `/ledger history` before you record it again: the reply may say the request was saved anyway, and a second command would record the gil twice.

Only officers record withdrawals, the opening balance and corrections. If you took gil out, ask an officer to record it.

## Read the balance

[`/ledger balance`](/tarubot/reference/commands/#ledger-balance) shows the current balance and how many recent entries are still waiting to be posted to the ledger channel. **View history** opens the history.

## Read the history

[`/ledger history`](/tarubot/reference/commands/#ledger-history) lists entries newest first, ten to a page, each with its number, operation, amount, the balance after it, who recorded it, and its note. Use **Older**, **Newer** and **Latest** to page, or start from an entry number:

```text
/ledger history before:34
```

## Mistakes

Entries can't be edited or deleted. If an entry is wrong, tell an officer: they record a correction that sets the balance to the right figure and names the entry it corrects, so the history shows both.

## When the ledger refuses

- **"FC membership needed."** No linked character of yours is confirmed in the FC yet. [Link your character](/tarubot/use/link-a-character/), and wait for the next roster check if you just joined.
- **"Ledger isn't set up."** The officers haven't linked the FC or chosen a ledger channel yet.
- **"Opening balance not set."** An officer has to record the chest's starting balance first.
