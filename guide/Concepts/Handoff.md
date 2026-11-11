# Handoff

Every turn, an agent re-reads the whole chat. A long chat is slow, costs more, and gets fuzzier. So a Lead should not run forever. When its context gets heavy, it writes a handoff note and a fresh Lead takes over.

## The steps

1. At about 100k tokens of context, the Lead starts planning the handoff and stops giving out new jobs. The new Lead should have taken over by 150k at the latest, and never past 200k.
2. Workers already running finish.
3. The Lead writes a handoff file: the state of the project, every worker still running, open pull requests, the queue, and decisions not yet filed.
4. A fresh Lead starts from that file and the repo. It checks each running worker itself.
5. The old Lead does no more work.

**VibeSquad:** messages follow the handoff. If someone runs `vs send` to a Lead or Buddy that has been replaced, the message goes to the live successor and the sender is told it was redirected (`redirectedTo`). If there is no live successor, the send fails instead of vanishing. This only applies to Leads and Buddies: a message to a worker is never rerouted to its Lead.

The template is [LEAD_HANDOFF.md](../Setup/templates/LEAD_HANDOFF.md). The matching rule is in [LEAD_RULES.md](../Setup/templates/LEAD_RULES.md).

**VibeSquad:** it shows a context bar on each Lead. Its built-in ladder is later than this kit's rule: it flags the Lead at 150k, hands off by itself at 250k, and stops at a hard cap of 300k. The 100k and 150k numbers above are earlier on purpose, because heavy Leads cost money. Use them as your own rule and hand off before VibeSquad has to.

In Claude Code you can also run `/context` to see how full a chat is (Claude Code only). When it is heavy, ask the Lead to write the handoff file, then open a new chat and paste it in.

Used in [Step 2](../Guide/02-lead-and-workers.md). Buddies get the same treatment: a heavy Buddy chat is restarted from a short summary.

> **Aub:** The work stayed great. Context windows and models are good enough now that quality wasn't the problem. Cost was. Heavy Leads were expensive as hell, and I kept hitting usage limits. So I asked how to be more efficient. That led to team roles and instructions, which led to the roster, which led to VibeSquad.
>
> This is why the handoff is at 100k-150k. You hand off to save money, not because the work gets worse.
