---
id: self-hosted-runners
group: level2
level: 2
method: doc-only
winget_id: n/a
verified: n/a (doc-only, nothing to install)
licence: free
size: small
---

# Self-hosted runners (read-only explainer)

## When you want this
**Nothing to install.** The agent only summarises this page. Read it so you know the option exists, then ignore it
until you have a reason.

## What it is
When you put a project on GitHub, it can run automatic checks ("CI") on every change. By default GitHub runs them on
its own computers (**GitHub-hosted runners**, such as `ubuntu-latest`). A **self-hosted runner** is a computer of
your own that does that job instead.

## Default: use GitHub-hosted
- Zero setup, no security risk to your PC, always clean.
- Public repos get this free; private repos include some free minutes (see GitHub's pricing page for the current
  amount: UNVERIFIED, not fetched here).

## When a self-hosted runner makes sense
- Your checks need software or hardware GitHub's machines don't have.
- You hit the minutes limit and have a spare always-on computer.

## Cautions
- A self-hosted runner executes code from your repo on your computer. Use it only for private repos you trust.
- Keep it on a separate machine or virtual machine, never on the PC where you keep your accounts and files.
- Setup is advanced. Ask the agent to walk you through GitHub's own docs when you get there.

## Gotchas
- If you never need it, that's the right answer.
