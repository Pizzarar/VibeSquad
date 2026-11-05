# Feel baseline, 2026-11-05 (Block 1: instrument + baseline, no fixes)

Plan: `docs/PLAN_FEEL_PASS.md`. Timers: commit `52cc861` (cherry-picked to master as `ea0c34e`, plugin reloaded 16:26:39Z).
Machine: main PC, one daemon (paseo 0.14.0), same network. Probes: Claude Haiku 5.5, prompt "Reply with the single word ok.", label `job=feel-probe`, all 6 archived afterwards.

**Headline: the time is in the daemon and in two synchronous/CLI-spawn steps inside the plugin hooks, not in the UI.** Native Paseo (CLI against the same daemon) is slow in the same places, so most of the gap Aub feels is the daemon + what the plugin adds on top of it.

## 1. Baseline table (3 runs each, median)

| Action | VS (runs) | VS median | Native Paseo (runs) | Native median | Notes |
|---|---|---|---|---|---|
| Spawn a lead (spawn to agent idle after first reply) | lead 1: 153 s; lead 2: 8 s (+ MCP `create_agent` "did not start within 60s" both times) | n=2 only (see data note) | native probes 1/3: 150 s, 112 s (probe 2: 120 s, **possibly tainted**: it was initializing at the 16:26:39Z plugin reload) | 120 s | `paseo agent run` CLI itself never returned until killed at 125 s in 4/4 runs, though the agent was created and answered. A third lead probe was not run (stop rule: two >60 s timeouts in a row). |
| Send to first token (Haiku "ok") | 8.2 s, 4.8 s, 13.5 s | **8.2 s** | not measurable with the CLI (`paseo send --no-wait` returns after the RPC) | n/a | Split below. |
| `sendAgentMessage` RPC resolved | 6.2 s, 3.9 s, 12.5 s | **6.2 s** | `paseo send --no-wait` wall: 2.3 s, 5.0 s, 6.1 s (includes ~0.5 s CLI start) | **5.0 s** | Same order of magnitude: daemon-side. `send_agent_message_request` in the daemon log: median 1.9 s, max 6.2 s (n=17 slow). |
| Send RPC resolved to first timeline event | 1.8 s, 1.6 s, 8.4 s (clock from click) | | n/a | | |
| Open agent (click to transcript painted) | 1.9 s, 4.3 s, 10.6 s | **4.3 s** | `paseo agent logs` 2.5 s (1 run) | 2.5 s | Daemon `fetch_agent_timeline_request`: median 29.7 s, max 260 s (n=14 slow). |
| Switch team | 55 ms, 62 ms, 87 ms (n=8, median 62 ms) | **62 ms** | n/a (desktop app not driven) | n/a | Not a problem. |
| Cold load (navigation to roster usable) | 3.99 s, 2.22 s, 3.83 s | **3.83 s** | n/a | n/a | Measured on the Vite **dev** server (unbundled), so inflated; roster fetch is 0.3 to 1.0 s of it. |

Data notes:
- VS UI numbers: Playwright headless, `?perf=1` overlay, dev server from the worktree on :5180, live daemon. n=3 each (switch-team n=8).
- Native desktop app was not driven (no automation); CLI against the same daemon was used instead.
- Probe 2 flagged per lead as possibly tainted (reload). Lead probe 2's 8 s shows the variance: same path, 153 s vs 8 s.
- Send-path data point: one MCP `send_agent_prompt` to the lead hit `ECONNRESET` once (~16:2xZ), reported by the lead.

## 2. create_agent "did not start within 60s"

- Logged by the Buddy/lead in the team log before this block: 2 (★ ADE5 ~16:00Z, ADE5 worker 538ba27c 16:08Z). Both: agent created, idle, 0 activity, initial prompt undelivered.
- **During this block: 2 more** (16:5xZ, `★ feel-probe lead 1` and `lead 2`, MCP `create_agent`, claude/claude-haiku-5-5). Both agents existed afterwards and answered "ok" (lead 1 after 153 s, lead 2 after 8 s). Total today: **4**. The Gemini reviewer spawn (ca772989) returned in under 60 s (lead's note).
- Own worker prompt (this task's initial prompt) was lost to the same timeout: it arrived as a later message.
- Historic `spawn-timing` (33 rows in `~/.vibesquad/logs`): `createAgent` median **121.6 s**, max 267.8 s (11-05 15:44Z new-buddy). 11-02/03: 155 to 204 s; 11-04: 2 to 76 s; 11-05: 6.4 s, 13.8 s, 14.8 s, 15.7 s, then 267.8 s at 15:44Z. Everything else in those rows (connect, fetchAgents, prep, repoint, retire) is under 2 s.
- Daemon log (10:33Z to ~11:30Z run): `agent.create.request` slow: n=13, median 37.6 s, max 124.7 s. Probe CLI run: one `agent.create.request` = 177.9 s (16:28:15Z).

## 3. Plugin hook timers (live since 16:26:39Z, `hook-timing` metric in the team log)

Sample: 262 `before.agent.create` and 96 `agent.created` calls from 16:26:40Z to ~17:00Z. **Caveat:** several bursts (16:39:41, 16:41:08, 16:59:54) are other workers' test runs writing to the real home, which inflates the big tail via CPU contention; the real-spawn rows (16:27:25, 16:28:05 etc.) show the same shape.

| Hook | n | median | p90 | max | Dominant step |
|---|---|---|---|---|---|
| `before("agent.create")` (**synchronous, on the daemon event loop**) | 262 | 6 ms | 767 ms | 4,285 ms | `git-spawn-state` = `inspectGitSpawnState`: median 3 ms, 48 calls >500 ms, max 4,277 ms, sum 80 s. Every other step (match-profile, resolve-identity-labels, layer-prompt, lane-brief, lane-artifacts) is 0 to 5 ms (match-profile spiked to 107 to 171 ms 3 times under load). |
| `agent.created` | 96 | 4 ms | 848 ms | 11,383 ms | `set-labels` (n=9 where labels were needed): median 3,958 ms, max 9,082 ms, sum 37 s. `retire-predecessors`: n=25, max 3,995 ms, sum 11.5 s. `parent-snap` max 2,661 ms, `labels-for` max 782 ms, `refresh-whos-here` max 1,083 ms. |

Real spawn examples: 16:28:05 before=721 ms (git 718); 16:27:17 created=4,701 ms (set-labels 4,012, parent-snap 527); 16:55:10 created=10,465 ms (set-labels 6,203, parent-snap 2,661, whos-here 1,083); 16:33:29 created=11,383 ms (set-labels 9,082, retire 2,018).

Conclusion on the prime suspect: **the prompt-layering part of `before("agent.create")` is not slow** (layering, A1 guard, brief and artifact reads: 0 to 5 ms). What is slow in the hook is the sync `git` subprocesses, and they block the whole daemon while they run.

## 4. Daemon-side measurements (measured only, not fixed)

From `~/.paseo/20261105-1033-01-daemon.log` (`ws_slow_request` = requests over the daemon's slow threshold), grouped by request type:

| Request | n | median | max | Sum |
|---|---|---|---|---|
| `wait_for_finish_request` | 19 | 60 s | 600 s | 2,448 s (agents waiting on agents; expected) |
| `fetch_agent_timeline_request` | 14 | 29.7 s | 260 s | 959 s |
| `agent.create.request` | 13 | 37.6 s | 124.7 s | 674 s |
| `plugin.rpc.invoke.request` (the VS remote/relay path) | 119 | 1.4 s | 10.4 s | 206 s |
| `provider.usage.list.request` | 49 | 2.4 s | 8.0 s | 149 s |
| `workspace.create.request` | 4 | 38.4 s | 49.9 s | 130 s |
| `send_agent_message_request` | 17 | 1.9 s | 6.2 s | 45 s |
| `fetch_workspaces_request` | 5 | 5.5 s | 6.4 s | 28 s |
| `archive_agent_request` | 2 | 6.1 s | 9.4 s | 12 s (observed: `paseo agent archive` took 10 to 18 s each when archiving the 6 probes) |

Other daemon-log facts: 3,245 "Failed to parse paseo.json; treating workspace as having no config", 2,744 "Plugin output" lines, 594 "Git worktree discovery failed; treating directory as non-Git" (`spawn git ENOENT`: the daemon process cannot find `git` on its PATH, bursts of ~15 in one second), 188 forge PR status self-heal failures (GitHub rate limit), 4 "Agent MCP transport error: Unsupported protocol version: 2026-07-28" per 2 minutes. `paseo agent ls` takes 4.4 s wall, `agent ls -a` 4.5 s.

- **Checkout-diff:** no `ws_slow_request` of a checkout/diff type appears in the daemon logs scanned; Parity2 holds the >12 s data. Not measured here.
- **Agent counts:** 2,023 agent JSON files on disk (266 distinct cwds, 12.9 MB), `paseo agent ls -a` lists 2,021. The VS roster fetch (`includeArchived:false`) returns **119 to 123 agents, 592 to 646 KB (about 5.3 KB per agent), 0.3 to 1.0 s**, then diff+set 5 to 20 ms. `roster-flush` (store apply and listeners) 0 to 30 ms. Long tasks on cold load: 7 to 9, median 81 to 173 ms, max 373 ms. So the UI is **not** pulling the 2,000 archived agents on a roster update.
- **`allowedAttachRoots`** (`server/vibesquad-api.mjs:745`, `paseoAgentCwds` at :729): reads all 2,023 agent files every call: **113 to 227 ms** scan + 12 ms realpath of 266 unique cwds, 140 ms typical total (5 runs, warm). The remembered 3 to 9 s was not reproduced (likely cold cache or AV scan under load). Callers: :766, :788, :1532 (uncached); the nav path caches 30 s (:752).

## 5. Top 5 time sinks, ranked by estimated seconds lost per day

Per-day estimates use today's observed counts (spawns ~13 slow creates in the 10:33Z log window, sends ~17 slow, opens ~14 slow) and are lower bounds, because the log only records slow requests.

| # | Sink | Evidence | Est. lost/day | Suspected cause (file:line) |
|---|---|---|---|---|
| 1 | `agent.create` / run start inside the daemon | 13 slow creates, median 37.6 s, max 125 s; spawn-timing createAgent median 121 s; native CLI probes 112 to 150 s; 4 MCP "did not start within 60s" today | **~670 s** (674 s in one 10:33Z log window) | Daemon, same for native Paseo (`agent.create.request`, "Creating agent" to "Created agent"). VS adds up to 4.3 s sync on top (sink 2). Event loop contention from sinks 2 to 5 is the leading hypothesis; the daemon starts the claude run only after the create RPC and its before-hooks return. |
| 2 | **Sync `git` subprocesses in `before("agent.create")`** | `git-spawn-state` sum 80 s over 207 spawns, 48 calls >500 ms, max 4.3 s; hook is sync, so the **whole daemon is blocked** for that time (hurts every other request: timeline fetch, sends) | **~80 s direct, plus the stall it imposes on everything else** | `plugin/index.server.ts:786-830` `inspectGitSpawnState`: up to 4 `spawnSync("git", ...)` (`rev-parse`, 2 to 3 `rev-list`, `status --porcelain`), 3 s timeout each, called from the hook at `:1566` (`const gitState = inspectGitSpawnState(cwd)`). Blocks the event loop; slow on a big repo or while other git runs. |
| 3 | `agent.created`: `set-labels` via a spawned `paseo` CLI, plus `retire-predecessors` and `parent-snap` | set-labels median 4.0 s, max 9.1 s (n=9, sum 37 s); retire max 4.0 s; parent-snap max 2.7 s; whole hook max 11.4 s | **~50 s direct** (labels/lane routing, retire and first-dispatch metric all wait on it) | `plugin/index.server.ts:915-930` `cliSetLabels` spawns `paseo agent update` (a whole new CLI process, shell on win32, reconnects to the daemon over WS) instead of the in-process `paseo` API; called at `:1811` (`await deps.setLabels`). Same pattern for archive (`cliArchive` :937). |
| 4 | Send and open agent hit the daemon's slow paths | send RPC 3.9 to 12.5 s in VS vs 2.3 to 6.1 s native (CLI); first event 1.6 to 8.4 s; first token 4.8 to 13.5 s; open agent 1.9 to 10.6 s; timeline fetch median 29.7 s, max 260 s (n=14) | **~100 to 250 s** (17 slow sends x ~3 s + 14 slow timeline fetches, many on agent open) | Mostly daemon (`send_agent_message_request`, `fetch_agent_timeline_request`), shared with native. VS-side extras to check next block: `src/Timeline.tsx:970` every live timeline event schedules a full 60-entry `timeline.refetch` 600 ms later (`soon()`), so each streamed token burst triggers extra daemon timeline requests; `src/paseo.ts:166-176` sends have no optimistic render. |
| 5 | Daemon plugin RPC + usage polling + noisy failures | `plugin.rpc.invoke.request` 119 x median 1.4 s (sum 206 s); `provider.usage.list.request` 49 x 2.4 s (149 s); 3,245 paseo.json parse failures; 594 `spawn git ENOENT`; 188 gh GraphQL failures; 2,744 plugin-output log lines | **~350 s of request time** (mostly background, but it shares the event loop with user actions) | `refetchProviderUsage` at `src/paseo.ts` (every connect and reconnect, `listProviderUsage`), `vs.http` relay RPC (`server/vibesquad-api.mjs`), daemon missing `git` on PATH (daemon-side: report to Parity2). |

Not time sinks (measured): switch team 62 ms; roster flush 0 to 30 ms; roster fetch 0.3 to 1.0 s; `allowedAttachRoots` ~0.14 s; plugin prompt layering 0 to 5 ms.

## 6. Recommended Block 2 (for the lead; numbers must agree)

1. Make `inspectGitSpawnState` async or move it out of the sync hook (cache per cwd for ~30 s; or run it in `agent.created` and append to the prompt only if cheap). Target: before-hook p90 under 10 ms. Touches the `bug13` hook path (merge overlap).
2. Replace `cliSetLabels` with the in-process API (`paseo.agents.ref(id).update/labels`) or at minimum run it off the critical path. Target: `agent.created` p90 under 300 ms.
3. VS send path: optimistic user message; stop `soon()` refetch on every live event while a turn is streaming (`src/Timeline.tsx:970`). Re-measure send to first token.
4. Report to Parity2 (daemon, measure-only): `spawn git ENOENT` (daemon PATH), `paseo.json` parse spam, `agent.create` and `fetch_agent_timeline` latency, `agent ls` 4.4 s with ~2,000 agents, MCP protocol-version error loop, gh rate-limit self-heal loop. Tell bug-chaser `allowedAttachRoots` is ~0.14 s now and not worth a cache yet.

## 7. How to re-measure

- Plugin: `grep hook-timing ~/.vibesquad/teams/*/log.jsonl` (total first, 0 ms steps dropped, line capped at 240 chars).
- UI: open `http://localhost:<port>/?perf=1` (overlay bottom-right, "copy" puts all marks on the clipboard). Marks: `cold-load`, `roster-fetch` (agents + payload KB), `roster-flush`, `open-agent`, `switch-team`, `send→first-token` (rpc / first-event / token rendered), `longtask`. With `?perf=1` the send run also posts a `send-timing` metric to the agent's team log.
- Harness gotchas for Playwright: the page needs the `vs_local` cookie (sha256 of `vs_local-cookie:<token>`), and the app's `beforeunload` dialog must be suppressed with an init script, or navigation stalls.

## 8. Re-measure 2026-11-05 (after Block 2 + Block 4)

Window: daemon restarted clean 21:34:42Z, plugin reloaded 21:25Z; numbers are post-21:35Z (to ~21:54Z). Master `cf646cb`.

**Scope gap (stated plainly):** the VS UI rows (send-to-first-token, open agent, switch team, cold load) were **not re-run**. They need the `vs_local` cookie, derived from `~/.vibesquad/local-token`, and the sandbox denied reading that file. The dev server from this worktree is up on :5180 but unused. The UI rows below keep their §1 baseline and are marked "not re-measured". The fix-C optimistic bubble therefore has no new number here. Native/CLI rows and plugin/daemon numbers are fresh.

### Before/after

| Action | Baseline (§1/§3) | Re-measure | Verdict |
|---|---|---|---|
| Spawn (native CLI `agent run --no-wait`, Haiku, n=3) | 112 to 150 s to idle | create request 44.6 s, 13.4 s, 10.2 s (median 13.4 s); all 3 answered "ok", CLI returned immediately, no >60 s timeout | Improved ~9×. Remaining time is daemon `agent.create.request`. Plugin hooks are no longer the main part (see hooks). The 44.6 s first probe ran while another worker's create took 66.2 s (21:50:40Z), so the daemon was busy. VS-side spawn (MCP `create_agent`) not re-run; it goes through the same daemon request and the same hooks. |
| Send RPC resolved (`paseo send --no-wait`, n=3) | 2.3, 5.0, 6.1 s (median 5.0 s) | 1.8, 3.3, 2.4 s (median 2.4 s); daemon `send_agent_message_request` n=5 slow, median 1.0 s, max 3.5 s (baseline median 1.9 s, max 6.2 s) | Better; native and VS share this RPC, so the remainder is daemon-side. |
| Open agent (native `agent logs`, n=3) | 2.5 s | 2.6, 1.2, 0.75 s (median 1.2 s) | Native improved. VS open-agent not re-measured (baseline 4.3 s). Daemon `fetch_agent_timeline_request` still slow: n=9, median 31.4 s, max 51.6 s (baseline median 29.7 s, max 260 s), so any VS gap is daemon-side. |
| Send to first token (VS) | 8.2 s | not re-measured | Unknown. |
| Switch team | 62 ms | not re-measured | Was not a problem. |
| Cold load | 3.83 s (dev server) | not re-measured | Unknown. |

### Hook timers (n is small: 6 real spawns since 21:35Z)

| Hook | Baseline | Now (n=6 each) |
|---|---|---|
| `before("agent.create")` | p50 6 ms, p90 767 ms, max 4,285 ms | p50 ~590 ms, p90 1,028 ms, max 1,028 ms (139, 545, 550, 595, 620, 1028) |
| `agent.created` | p50 4 ms, p90 848 ms, max 11,383 ms | p50 ~120 ms, p90 2,006 ms, max 2,006 ms (53, 65, 93, 147, 519, 2006) |
| `set-labels` | median 3,958 ms, max 9,082 ms | median ~40 ms, max 1,055 ms (n=4: 8, 24, 53, 1055) |

Reading: the max tails are gone (before-hook 4.3 s to 1.0 s, created 11.4 s to 2.0 s, set-labels 9.1 s to 1.1 s). The before-hook p50 looks higher than baseline, but the baseline median was dominated by 262 no-op calls from test bursts that skipped git. Real spawns before were 721 ms (16:28:05), so ~550 ms of `git-spawn-state` per real spawn is unchanged. It is now async, so it no longer blocks the daemon event loop (that was the fix). The sample is too small for a p90 claim.

### Daemon log, 21:35:30Z to 21:53:15Z

| Pattern | Count |
|---|---|
| `spawn git ENOENT` | 0 |
| "Project config unavailable" | 0 |
| gh `Expected NAME` | 127 (not fixed, still spamming) |
| "Timed out refreshing" | 0 |

Block 4 worked (ENOENT and config spam at zero). The gh `Expected NAME` loop is still active. Still slow daemon-side: `agent.create.request` n=5, median 22.7 s, max 66.2 s; `fetch_agent_timeline_request` median 31.4 s; `list_commands`/`provider_subagents`/`list_provider_models` ~40 s each (probably ~2,000 un-pruned agents; agent prune was not done).

### Open items
- Re-run the four VS UI rows once the local token is readable for the harness, or have the owner run `?perf=1` and copy the marks.
- `Expected NAME` gh error.
- Agent prune (daemon `agent.create` and timeline fetch remain the dominant cost).
