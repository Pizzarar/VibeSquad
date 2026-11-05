# Cheapest capable model

Give each job to the cheapest model that can do it well. Keep the strongest model for the hard decisions.

A rough guide:

| Work | Model |
|---|---|
| New design question, or hard work across many parts | Strongest |
| A block of work with a clear scope and a written work order | Mid or cheap |
| Rename, move data, write tests to an existing spec | Cheapest |
| "Where is X used?" or a read-only audit | Cheap. Never the strongest |

Why: every job costs tokens. The strongest model on a simple job wastes budget and gains nothing.

How to check the choice: if a cheap model's result is wrong, move that kind of job up one tier next time. If a strong model is doing mechanical work, move it down.

In Claude Code (other providers have their own switch): pick a model per sub-agent, or start separate sessions with `/model`.

**VibeSquad:** each role has a profile that sets the model, so the Lead picks a role and the model follows.

Used in [Step 2](../Guide/02-lead-and-workers.md). See also [Lead](Lead.md).

> **Aub:** Basically everything moved down. I thought you needed high thinking for most work. You don't. Medium thinking on the strong models is great, even for planning and riffing.
