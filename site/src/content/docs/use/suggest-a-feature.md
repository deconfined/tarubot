---
title: Suggest a feature
description: Send an idea for TaruBot with /suggest, what goes public on GitHub and what never does, and the limits.
sidebar:
  order: 8
---

Have an idea for TaruBot? [`/suggest`](/tarubot/reference/commands/#suggest) posts it as a public issue in [TaruBot's GitHub repository](https://github.com/deconfined/tarubot/issues), where the maintainers keep feature requests. It goes up at once, and the reply links to it.

## Where and who

- **In the FC's own server only.** `/suggest` works in the one Free Company server the TaruBot project's own deployment serves. Other servers, including servers that run their own copy of TaruBot, answer "Not available here" (a development copy's test server only previews suggestions privately, for testing). From anywhere else, open an issue on [GitHub](https://github.com/deconfined/tarubot/issues) yourself.
- **With the Member or Guest role.** [Linking a character](/tarubot/use/link-a-character/) gives you one of them, and an officer can also give you [guest access](/tarubot/use/guest-access/). Without either role the reply is "FC membership needed", with the steps to get one. Officers qualify through their Member role; officer access alone doesn't count.

## Send a suggestion

```text
/suggest idea:Let officers schedule FC events and remind members an hour before.
```

- Describe the idea in 10 to 1,000 characters: what you'd like TaruBot to do, and why it would help.
- The reply, "Suggestion posted", links to the new issue and says what was posted. Follow the issue on GitHub to see what the maintainers say.
- `/suggest` is for ideas. When something doesn't work, use [`/issue`](/tarubot/use/progress-and-problems/#report-a-problem) instead: it goes privately to the people who run this deployment, not to a public page.

## What goes public

Everything in the issue is public, and it stays public: GitHub's notification emails, event feed and archives can keep a copy even after the issue is closed or deleted.

**What's posted:**

- The title: the start of your idea, cut at a word within 80 characters.
- The body: a fixed first line saying the idea came from Discord, your idea in a code block, and "Sent by TaruBot" with the running version.
- The labels `enhancement` and `from-discord`. The author is TaruBot's own GitHub account, never yours.

**What's removed from your text first:**

- links, with or without `https://` and in any script, and IP addresses. They become `[link removed]`. A bare domain with nothing after it, such as `example.com`, stays.
- Discord mentions: a person, role or channel becomes `[member]`, `[role]` or `[channel]`, and custom emoji keep only their name.
- email addresses (`[email removed]`), and text shaped like a password, token or key;
- ID numbers of 17 or more digits (`[ID removed]`);
- invisible characters.

Every `@` becomes `＠`, so nobody is mentioned on GitHub, and a `#` in the title becomes `＃`, so it can't link another issue.

**What's never posted:** your Discord name or ID, the server and its channels and roles, your characters and your FC, and anything else TaruBot stores.

Cleaning can't catch everything typed on purpose, such as a name written out or an ID split up with spaces. Leave names, personal details and security problems out of a suggestion. Report a security problem privately, as the [security policy](https://github.com/deconfined/tarubot/security/policy) explains.

## Limits

- Each member can send one suggestion an hour, and three in any 24 hours.
- TaruBot posts at most ten suggestions in any 24 hours, from everyone together.

When a limit is reached, the reply is "You can suggest again later", with when. GitHub's own limit on new issues reads the same way.

## When it doesn't go through

- **"GitHub didn't confirm your suggestion."** TaruBot got no clear answer from GitHub, so the suggestion may or may not have been posted. Check [TaruBot's issues](https://github.com/deconfined/tarubot/issues) before you send it again. The try counts toward your limits either way.
- **"Not available here"**, saying suggestions are switched off: the people who run TaruBot have paused suggestions for now.
- **"Please wait a moment"**, saying TaruBot is restarting: nothing was sent. Try again in a minute.
- **"Something went wrong":** nothing was posted, and the maintainers were told. You can try again later.

## What happens next

The maintainers read suggestions on GitHub. They may answer, label, close (for example as not planned) or lock an issue. Suggestions go up without review, so anything abusive is removed afterwards, and a member who misuses `/suggest` can lose access to it.
