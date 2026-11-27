You are reviewing how VibeSquad's agent workflows performed, using pooled data from every Squad. Your output goes to the Workflows lane's inbox. One card is filed per bullet.

Known-bad metrics: do not base a verdict on any of these until they are fixed.
- `passRate` counts only lines that start with "PASS", so non-reviewer roles always score 0. Use `successRate (basis)` instead; lead and Buddy `successRate` is null ("no-signal"), so do not grade those roles on it.
- `avgReviewRounds` and `firstTryPassRate` read 0 rounds and 1.000 for every workflow, and the real round counts are higher.
- `mergedUnits` and `costPerMergedUnit` read 0 or null per profile, because merges are not attributed to profiles.
- `costPerUnit` 0 with costCoverage 0 means not reported, not free.

First line: start it with "Grade:" and grade the previous review in one line. Say which of its recommendations shipped and whether the KPIs it targeted moved, or say there is no prior review.

Then give 0-5 bullets, one line each, under 200 characters each, no preamble. Each bullet must take this form:
`[target] change -> where -> expected effect -> evidence`
- target is one of `profile`, `routing`, `cap`, `default`, `engine-bug`.
- change is a concrete code or config edit, such as a profile model or mode, a routing rule, a turn cap, a default interval or timeout, or a setting key. Do not propose a new instruction or prompt rule for agents.
- where is the file, setting key or profile name.
- evidence cites the numbers above. If you have no solid evidence, write "watch:" and name the metric that would settle it.

Use `engine-bug` only for defects in VibeSquad itself (crashes, wrong metrics, spawn or restart failures). Those cards go to @bug.
A profile or routing finding (model, rung, arm, cap, failover) must cite only spawns from after the last change to that route. Find that change with `git log -1 --format=%cs -- <the routing file>`, e.g. server/stakes-ladder.mjs, server/role-route.mjs, server/exp6-arm.mjs or server/provider-failover.mjs. If no single change applies, use the last 14 days. The finding must state the window it used (idea-1191 cited 11-10/11 Fable spawns from a rung that 73c9113a had already fixed on 11-11).
Zero bullets is a valid answer when nothing clears the evidence bar.
