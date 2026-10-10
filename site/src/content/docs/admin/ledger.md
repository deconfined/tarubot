---
title: The ledger
description: Set up the FC gil ledger, record the opening balance, withdrawals and corrections, and follow the channel posts.
sidebar:
  order: 9
---

The ledger is an exact, permanent record of the FC chest's gil, kept by people. Members record deposits; officers record everything else. Each Free Company linked to the server has its own ledger account, and each entry is numbered in order.

## Set it up

1. Link the FC: [`/config fc link`](/tarubot/reference/commands/#config-fc-link). Linking creates the FC's ledger account.
2. Choose the channel where entries are posted: [`/config ledger`](/tarubot/reference/commands/#config-ledger) `channel:#fc-ledger`. TaruBot checks that it can post there.
3. Count the chest and record the opening balance once:

   ```text
   /ledger initialize balance:10005000 note:Opening balance from FC chest
   ```

   [`/ledger initialize`](/tarubot/reference/commands/#ledger-initialize) works once per account. Until it runs, the ledger refuses deposits and withdrawals with **Opening balance not set**.

Balances are whole gil, digits only, with no separators: `10005000`, not `10,005,000` or `10M`.

## Record withdrawals

Only officers record withdrawals:

```text
/ledger withdraw amount:2500000 note:Housing materials
```

A withdrawal can't take the recorded balance below zero; the refusal says **Not enough recorded gil**, and nothing is recorded. Deposits come from members themselves with `/ledger deposit`, and officers can record them too.

## Correct a mistake

Entries can't be edited or deleted. [`/ledger adjust`](/tarubot/reference/commands/#ledger-adjust) records a new entry that sets the balance to the right figure:

```text
/ledger adjust balance:10005000 note:Recount after chest audit
/ledger adjust balance:10005000 note:Withdrawal #42 was 2,550,000 gil entry:42
```

- `entry` names the entry being corrected, by its number from `/ledger history` (`42` or `#42`, in the current FC's account) or its ID. A number or ID that isn't in that account is **Entry not found**.
- An adjustment to the balance the ledger already has changes nothing and says **No correction needed**.

## Balance and history

[`/ledger balance`](/tarubot/reference/commands/#ledger-balance) and [`/ledger history`](/tarubot/reference/commands/#ledger-history) show officers more than members: each recent post's delivery state, entry IDs, the account ID, and **Full details (JSON)**. A problem line on the history page counts posts that are blocked, failed, paused or waiting, with the next step.

After an FC is unlinked, its ledger stays. Officers can read it by naming it:

```text
/ledger balance fc_id:9230000000000000001
/ledger history fc_id:9230000000000000001
```

A previous FC's ledger is read-only.

## Posts in the ledger channel

Every entry is posted to the ledger channel as `<Operation> · <amount>`: deposits in green, withdrawals and the opening balance in blue, corrections in orange. A post shows the full note, the new balance (a correction also shows the previous balance and the entry it corrects), who recorded it and the entry number, with the entry ID in the footer.

Posting happens in the background. If TaruBot can't post, for example after the channel was deleted or its permissions changed, the entry is still recorded: the post waits as a blocked job. Fix the channel, then run `/config validate`. TaruBot retries held posts by itself about every 10 minutes; saving a `/config` role or channel (choosing the same ledger channel again works) retries them at once, and `/sync status` shows their progress. A retried post is identical to the first, and each post names the entry it belongs to, so a duplicate message never means a duplicate entry.

If a ledger command ends in an unexpected error, the reply warns that it may have been saved. Check `/ledger history` before recording the same gil again.
