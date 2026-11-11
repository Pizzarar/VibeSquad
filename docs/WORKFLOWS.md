# Workflows index (one line each)
Before proposing a workflow, check here; if covered, say "already covered by X". Update when a workflow ships.
`docs/PLAN_*.md` is gitignored: those cites resolve in the main checkout. `cli/vs.mjs:NNN` = usage line in the `vs --help` text.

| name | trigger (what the owner says) | where it lives | lane |
|---|---|---|---|
| Spin up a Buddy / hub Buddy | "spin up a buddy for X", "new pin" | `cli/vs.mjs:508` (`vs pin new`); docs/PLAN_HUB_BUDDY.md:15 | @hub |
| Buddy restart | "restart the buddy", "fresh buddy" | `cli/vs.mjs:518` (`vs buddy restart`); `server/mcp/tools.mjs:896` (`restart_buddy`) | @bug |
| Lead handoff / successor | "hand off the lead", lead at 150k+ | `cli/vs.mjs:516` (`vs lead handoff`); `server/mcp/tools.mjs:891` (`handoff_lead`); docs/PLAN_LEAD_HANDOFF.md:1; docs/PLAN_LEAD_SUCCESSOR_VERB.md:1 | @bug |
| Spawn a worker by profile | "spawn a worker/implementer for X" | `cli/vs.mjs:515` (`vs spawn`); `server/mcp/tools.mjs:874` (`spawn_worker`) | @bug |
| Stakes routing | "top model for crypto/auth", "tierA" | docs/PLAN_ROUTING_BY_STAKES.md:13; `server/stakes-ladder.mjs:8,11`; `--stakes` on `vs spawn` (`cli/vs.mjs:515`) | @per |
| Release handoff to Release Desk | "release beta", "release stable" | R10 `server/profiles.mjs:41`; docs/PLAN_RELEASE_DESK.md:1 | @rele |
| Worktree create | "work in a worktree for unit X" | `vs worktree create` (`cli/vs.mjs:2474`); `server/team-worktrees.mjs:125`; STANDING_RULES `server/lessons.mjs:159` | @bug |
| Worktree sweep | "clean up merged worktrees" | `vs worktree sweep` (`cli/vs.mjs:2486`); `server/team-worktrees.mjs:169` | @bug |
| Inbox add | "queue that", "put it in the inbox" | `cli/vs.mjs:505` (`vs inbox add`); R11 `server/profiles.mjs:42` | @bug |
| Inbox triage (merge/bounce/park) | "merge those cards", "bounce to @ui" | `cli/vs.mjs:507` (`vs inbox triage`); docs/PLAN_INBOX_SWEEP_1108.md:1 | @bug |
| Inbox send (card to lane) | "send it" on a card | docs/PLAN_INBOX_SEND_1109.md:1; docs/PLAN_STANDING_TEAMS.md:6 (auto-wake send-to) | @bug |
| Just send it (act, report after) | "send it", "do it", "go for b" | docs/PLAN_JUST_SEND_IT.md:12; R9/R13 `server/profiles.mjs:40,44` | @per |
| Bug Runner | "queue the bug", "bug chip" | docs/PLAN_BUG_RUNNER.md:6; R11 `server/profiles.mjs:42` | @bug |
| Workaround gate | "is that a workaround?" | docs/PLAN_WORKAROUND_GATE.md:8 | @bug |
| Find the lead | "who's the lead" | `cli/vs.mjs:500` (`vs who`); STANDING_RULES `server/lessons.mjs:158`; docs/PLAN_VS_WHO.md:3 | @bug |
| Team log write | "log that", "record the decision" | `cli/vs.mjs:502` (`vs log`); MCP `report` `server/mcp/tools.mjs:886` | @bug |
| Catch up on Squad state | "catch me up" | `cli/vs.mjs:503` (`vs log --since-me`) | @bug |
| Handoff packet | "write a handoff" | `cli/vs.mjs:504` (`vs handoff`) | @bug |
| Lane spec / tasks | "update the spec", "show tasks" | `cli/vs.mjs:510,511,512` (`vs spec`, `vs task list`) | @bug |
| Merge pins / lanes | "fold perfection-2 into perfection" | `cli/vs.mjs:509` (`vs pin merge`) | @hub |
| Bugs chip (standing Bug lane) | "bugs chip" | docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md:5-11 (Workflows chip dropped 11-09) | @ui |
| Overlord spin-up | "spin up overlord" | docs/PLAN_OVERLORD_ROLE.md:26; docs/PLAN_HUB_SPINUP_1108.md:1 | @hub |
| Wait on agents (end turn, one ping) | "wait for them" | `cli/vs.mjs:527,528` (`vs wait`, `vs watch add`); MCP `wait` `server/mcp/tools.mjs:880`, `watch` `:901`; STANDING_RULES `server/lessons.mjs:161` | @bug |
| Message / inspect / stop an agent | "tell the lead X", "stop it" | `cli/vs.mjs:519` (`vs send`); MCP `send` `server/mcp/tools.mjs:879`, `status` `:885`, `list` `:906`, `cancel` `:907` | @bug |
| Archive sweep | "archive the done workers" | `cli/vs.mjs:526` (`vs archive --sweep`); docs/PLAN_PROVIDER_CONTINUITY.md:16 | @bug |
| Provider cap / failover | "claude is capped" | `cli/vs.mjs:514` (`vs cap`); STANDING_RULES `server/lessons.mjs:162` | @per |
| Compact in place | "compact first" | docs/PLAN_COMPACT_IN_PLACE_1108.md:8 | @bug |
| Runtime restart | "restart the runner/server" | `cli/vs.mjs:517` (`vs restart`, owner/Overlord only); merge trailer `server/lessons.mjs:165` | @bug |
| Merge trailer (Live-Needs) | every master merge | `server/lessons.mjs:165`; `server/sync-runtime.mjs:172` | @bug |
| Usage dashboard / review | "how much did X cost" | docs/PLAN_USAGE_DASHBOARD.md:28; docs/lanes/perfection/USAGE_REVIEW_PROMPT.md:1 | @usa |
| Pair a device | "pair my phone" | `cli/vs.mjs:533` (`vs pair`) | @and |
| Lane artifact as truth | "check the spec, not the chat" | STANDING_RULES `server/lessons.mjs:164` | @per |
| Owner interrupts / queued units | "/btw", "also", "on another note" | R9 `server/profiles.mjs:40` | @hub |
| Cross-lane principles | "cross-lane principle" | R12 `server/profiles.mjs:43` | @hub |
