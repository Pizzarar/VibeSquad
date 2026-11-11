# Lead

A Lead is the agent that runs the work once you have a [plain plan](Plain-Plan.md). The [Buddy](Buddy.md) already broke the idea down with you. The Lead turns the plan into small jobs. It does not write the product itself. It gives each job to a worker, using the cheapest model that can do it, and checks that each worker shows proof (raw output, not a summary).

A Lead's context fills up over a long job. When it gets heavy, it writes a handoff note and a fresh Lead takes over.

**VibeSquad:** the Lead is a second chat. You start it with **+ NEW AGENT** (click **FULL** on the Squad page first; the default page hides it) (pick a Lead profile in **PROFILE**, then **Spawn agent**), or your Buddy starts it through VibeSquad. Handing a plan on does not start a Lead by itself: the Buddy's **⇄ Handoff** button starts a fresh Buddy from its summary, and once a plan has been handed to a Lead the Buddy offers **↻ Restart from summary**. **✓ Hand off plan & close topic** hands one topic's plan on and closes that chat. The Lead shows as "RUNS THE WORK" in **FULL** view, and shows its workers under it. If it needs a decision from you, it sets the `needs-you` flag and its card moves up.

When a Lead merges work, it also notes what the merge needs to go live (a `Live-Needs:` line in the merge commit: `none`, `build`, `frontend-reload`, `runner-restart` or `server-restart`). See [LEAD_RULES.md](../Setup/templates/LEAD_RULES.md). After merging it can tidy finished worktrees with `vs worktree sweep`.

In any other agent, start a new chat, paste your plan, and say "act as the Lead: split this into small jobs and give them to workers". The kit's `Setup/templates/LEAD_RULES.md` has rules you can drop into your project.

> **Aub:** Art. I assumed AI art meant generating assets and dropping them into a game, which is basically stealing, and I get why people hate that. Working with the Piskel tools isn't that. You give it a rough sketch, it takes a pass, you say what you don't like and how you'd change it, and you go back and forth. To me, that's close to how artists already take inspiration from each other.

Next: [Step 2](../Guide/02-lead-and-workers.md). Part of [ROLO](../ROLO.md): Organize.
