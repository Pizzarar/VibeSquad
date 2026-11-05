# Lead brief: <PROJECT / TOPIC> (<date>)

From Brainstorm, approved by the owner. You are the Lead for this area.

> **How to use:** at the end of a brainstorm session, ask: "Write the Lead brief from what we decided,
> using Setup/templates/LEAD_BRIEF.md." Read it, fix it, then start a fresh session and paste it in (or
> point the session at the file). The brief is the only context the Lead has, so what is not here
> does not exist for it.

## Idea

What we are making and why, in a few lines. Who it is for. If there are two jobs, number them.

## Owner's words (verbatim, typos kept)

> Quote the owner's own description of what they want. The Lead goes back to this when a call is close.

## Decided

Everything that is already settled. The Lead must not re-open these.

- **Where it lives:** repo, folder, branch rules, who may push or merge.
- **Constraints:** platform, budget, tools, anything the owner ruled in or out.
- **Style / voice:** if there is output a human reads.

## Owner decisions still open

Anything the Lead may not decide alone. For each: the options, a recommendation, and why.
The Lead brings these to the owner before dispatching work that depends on them.

1. **<Question>.** (a) ... (b) ... (c) ... **Recommendation: (a)**, because ...

## Sources

Files and folders the Lead and its workers should read, marked read-only where that matters.

- `<path>`: what it is and why it matters.

## Plan

Numbered steps. Each says what is produced and who reviews it.

1. **Spec / outline:** the owner approves it before anything is written in full.
2. **Build:** dispatch workers with the right roles; the Lead does not write the content itself.
3. **Review:** cross-family review for accuracy; a separate pass for anything that must not leak.
4. **Verify:** a cold test, where someone (or a fresh agent) follows the result without help.
5. **Owner reads it all.** Then ask before anything outward-facing (creating a remote, pushing, publishing).

## What done looks like

Concrete, checkable bullets. "A fresh agent can go from clone to X with no guessing" beats "it works".

## How to run it

- Normal Lead rules (read `AGENTS.md`, then `LEAD_RULES.md`): dispatch, don't write; cross-family review; raw proof.
- Start planning the handoff at about 100k tokens of context; the successor has taken over by 150k, and never past 200k (`LEAD_HANDOFF.md`).
- When to report to the owner (for example: outline ready, draft ready, results).

## Out of scope / parked

What we are deliberately not doing, so nobody drifts into it.
