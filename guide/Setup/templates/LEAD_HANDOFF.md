# Lead handoff: <PROJECT / AREA> (<date>)

Written by the outgoing Lead, read by the successor. Write it when context passes about 100k tokens;
the successor must have taken over by 150k, and never go past 200k. Be concrete: the successor starts
with only this file and the repo.

> **Why:** every turn re-reads the whole context, so a long session is both slow and expensive.
> A written handoff plus a fresh session is cheaper and sharper than carrying on.

## State of the tree

- Branch / HEAD: `<branch>` @ `<sha>` (paste `git log --oneline -1`)
- Test baseline: `<N>` passing as of `<sha>` (paste the captured output path)
- One-paragraph summary of where the project stands. The tree wins over this paragraph if they disagree.

## In-flight workers

| Worker (name / id) | Task | Branch | Report path | Next step |
|---|---|---|---|---|
| <name or id> | <task> | <branch> | <path to its report file> | <e.g. "needs Review", "waiting on fix round 2"> |

Completion notifications still go to the outgoing Lead, so the successor checks each of these
itself (status plus the report file) instead of waiting.

## Open PRs

| PR | Branch | State | What it still needs |
|---|---|---|---|
| <#> | <branch> | <CI green / red / waiting> | <review, owner merge, ...> |

## The queue (in order)

1. <next task>: why this one, and any dependency.
2. ...

## Unfiled write-backs

Decisions and results the Lead has not yet recorded in the decision log / state doc. Paste the text
so the successor can file it.

- <item>

## Owner decisions pending

- <question, options, recommendation, who asked and when>

## Gotchas and lessons from this session

Things that cost time and would again: tool quirks, flaky tests, files that need care.

## Files worth carrying

Scratch folders, briefs and reports outside the repo that the successor will need (list the paths).

---

## Handoff checklist (outgoing Lead)

- [ ] This file is complete and committed (or saved where the successor can read it).
- [ ] Every in-flight worker is listed with its report path.
- [ ] `## NEXT` in the state doc is current.
- [ ] No uncommitted work in the tree.
- [ ] Successor started from this file (a fresh session: not a continuation of this one).
- [ ] Told the owner the successor is live, and where to talk to it.
- [ ] *(Level 2)* Renamed the successor `★ LEAD · <AREA>` and this one `(old) <area> -> see ★ LEAD`.
      One ★ per area.
- [ ] *(Level 2)* Stopped any scheduled wake-ups/heartbeats this Lead had; the successor sets its own.
- [ ] After handoff this Lead does no work. If woken, it forwards the notification to the successor
      (worker id + report path) and stops: no reads, audits or dispatches.

## Checklist (successor)

- [ ] Read this file and `LEAD_RULES.md`, then ran the first-action commands from `AGENTS.md` and compared
      with the tree.
- [ ] Checked each in-flight worker's status and report.
- [ ] *(Level 2)* Archived the old Lead once none of its workers are still running.
