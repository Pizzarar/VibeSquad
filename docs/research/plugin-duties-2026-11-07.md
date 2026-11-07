# T2 — Paseo plugin automatic-duty audit (port / covered / drop)

Date: 2026-11-07 · Branch `unit-t2-duty-audit` (off master `127447c`) · Lane `@bug`

Plan: `docs/PLAN_PLUGIN_DUTIES_PORT.md` (block T2). This is the read-only audit that precedes any porting: one
row per automatic plugin behaviour, with a verdict, its root cause / workaround, and whether it is obvious.

## Method

- Read `plugin/index.server.ts` (2797 lines) end-to-end and `plugin/server/remote-proxy.ts`, `plugin/server/remote-proxy-rules.ts`,
  `plugin/index.ts`.
- For every "covered" claim, read the cited `server/` or `runner/` file (not a name match).
- Cross-checked against the existing runner hook inventory `docs/lanes/runner-pilot/B11-hook-inventory.md`.

## Critical framing correction to the plan

The plan states the plugin "runs only inside the Paseo daemon, which is off." That is **no longer true** for runner agents.
The VS server hosts the *same* plugin closure for `rn-*` agents:

- `server/backend/runner-hooks.mjs:9` `loadPlugin = () => import("../../plugin/index.server.ts")`, and `:99` calls
  `plugin.createPlugin({...})(server)` unchanged.
- `server/backend/runner-lifecycle.mjs:20` `startRunnerLifecycle()` forwards the runner's `created` / `turn_started` /
  `turn_ended` events into the plugin's `agent.created` / `agent.turn_started` / `agent.turn_ended` hooks (`HOOK_FOR`, `:8`).
- `server/backend/runner-backend.mjs:402-425` runs the plugin's `before("agent.create")` in `createAgent`, and `:583-591` runs
  its `before("send_agent_prompt")` in `sendAgentPrompt`.

So today every "port" row below is **live for runner agents through the plugin**. When P5 deletes
`plugin/index.server.ts` and `plugin/server/*`, `runner-hooks.mjs:9`'s import breaks, and every behaviour marked
**port** stops firing unless it is re-implemented natively first. P5 must therefore land after (or with) the ports,
exactly as the plan's block table already requires (T1 → T2 → P5).

---

## Table

| # | duty | hook + plugin file:line | what it does (1 line) | verdict | Root cause / Workaround | obvious? |
|---|---|---|---|---|---|---|
| 1 | Prompt layering (EVERYONE layer → role pack → profile notes → git state) | `before("agent.create")` `:1261`; `injectedPrefix` `:784`; `rolePack` `:615`; `inspectGitSpawnState` `:789`; assembly `:1607-1638` | Builds the fixed-order system prompt prepended to every spawn. | **port** | The rule text (`EVERYONE_LAYER` `:77`, `ROLE_PACKS` `:147`) and `rolePack` live only in the plugin; `runner-backend.mjs:236-244` `injectedPrefix` re-imports the plugin and dies with P5. Move the text + `rolePack` into a `server/` module and call it natively in `RunnerBackend.createAgent`. | yes |
| 2 | Profile match + explicit profile override (provider/model/mode/thinking/features) | `before("agent.create")` `:1503-1566`; `matchStoredProfile` `:229`; `profileFieldDiffs` `:300` | Applies a named profile's provider/model/mode/thinking, clobbering caller picks only for an explicit profile. | **port** | `profiles.mjs:976` `findProfile` + `:1029` `toPaseoSpawnConfig` already resolve/enforce natively but are **not** wired into `RunnerBackend.createAgent`, which depends on the plugin hook. Workaround: call `toPaseoSpawnConfig` in the native spawn path. | yes |
| 3 | Capped-provider / quota failover before spawn | `before("agent.create")` `:1342-1388`; `normalizeCappedProviders` `:1212`; `readCappedProviderMap` `:1243` | Fails a capped/over-quota profile over to its healthy counterpart before the session is created. | **port** | The resolver is already native — `provider-failover.mjs:453` `resolveProfileWithFailover`, `:282` `readCappedProviders`, `:131` `normalizeProviderFamily` — but the spawn-hook wiring and `normalizeCappedProviders:1212` are plugin. Workaround: wire `readCappedProviders`+`resolveProfileWithFailover` into native spawn. | yes |
| 4 | A1 Antigravity `approvalPolicy:"skip"` + `accept-edits` mode guard | `before("agent.create")` `:1570-1582` | Forces a non-hanging permission policy on `antigravity-cli` spawns. | **covered** | Native profiles already default `approvalPolicy:"skip"` for AGY (`profiles.mjs:196,224,345,370,385,400`; counterpart profiles `provider-failover.mjs:54-97`). The plugin's forced `modeId:"accept-edits"` is the residual; confirm whether that default is still wanted natively. | no |
| 5 | Sanitize legacy roster prompt | `before("agent.create")` `:1585`; `sanitizeLegacyRosterPrompt` `:417` | Rewrites a stale `paseo ls -g --json` "find your lead" line in legacy roster prompts. | **drop** | Only legacy Paseo roster prompts carry that line; the runner/VS prompt layers never emit it. Nothing to port. | yes |
| 6 | Identity resolution + team/lane/role/orphan label rewrite | `before("agent.create")` `:1402-1499`; `resolveAgentIdentity` (native `identity.mjs:425`) | Derives and stamps team/lane/role/orphan from cwd/labels/title. | **port** | Resolver is native (`identity.mjs:425`); the label-rewrite glue in `before` is plugin. Workaround: run `resolveAgentIdentity` in the native spawn path. | yes |
| 7 | Env propagation `VS_ROLE`/`VS_TEAM`/`VS_LANE`/`VS_PROFILE` | `before("agent.create")` `:1700-1718` | Sets turn-1 `vs` env so the CLI works before `agent.created` runs. | **port** | `RunnerBackend.createAgent` already maps `FIRST_CLASS` from labels/env (`runner-backend.mjs:429-433`), but the env write is plugin. Workaround: set env in native `createAgent`. | yes |
| 8 | Lean provider options (worker tool deny list) | `before("agent.create")` `:1693-1696`; `leanApplies`/`leanProviderOptions` (native `lean-tools.mjs:36/42`) | Restricts worker/lead tooling (`disallowedTools`) for claude. | **port** | `lean-tools.mjs` is native but the only caller is the plugin (`:1693`). Workaround: call `leanProviderOptions` in native spawn. | no |
| 9 | Lane brief injection (Buddy only) | `before("agent.create")` `:1643-1672`; `laneBriefBlock` `:646` | Prepends `docs/brainstorm/<lane>.md` to a Buddy's system prompt. | **port** | The native Buddy start/restart path already injects the brief (`brainstorm.mjs:286` `buildBrainstormInitialPrompt`, used `:866`); the plugin path is the generic-spawn/legacy-board fallback. Confirm generic Buddy spawns still need it, else drop. | no |
| 10 | Lane-artifact injection (`docs/lanes/<lane>/SPEC.md` + `TASKS.json`) | `before("agent.create")` `:1678-1690`; `laneArtifactBlock` `:674` | Injects the durable lane source-of-truth block into every spawn. | **port** | Native renderer exists (`lane-spec.mjs:122` `renderLaneArtifactBlock`) but is only used by the CLI (`cli/vs.mjs:62,2235,2267`), not the spawn prompt. Workaround: call `renderLaneArtifactBlock` in native spawn. | yes |
| 11 | `agent.created` auto-labelling + lead `ord` | `on("agent.created")` `:1733`; `:1756-1866`; `nextLeadOrd` `:523`; `keptLaneOf` `:476` | Writes final team/lane/role/orphan labels and the lead's `ord` after the session exists. | **port** | Identity resolver native; the label-write + ord glue is plugin. Workaround: native label-write in a `created` handler. | yes |
| 12 | `enforceProfileAfterSpawn` (post-spawn fix / refuse wrong-provider) | `:1120-1206`; called `:1748` | Post-creation: switches model/mode/thinking to the profile, or cancels+archives a wrong-provider agent. | **port** | `profiles.mjs` is native but the post-spawn enforcement glue is plugin. Workaround: native enforcement in the `created` handler (runner meta `vs.spawn-configured=1` already gates it). | yes |
| 13 | Detach new lead from parent | `:1871-1876` | Detaches a chained lead so it outlives the Buddy that spawned it. | **drop** | Runner agents are independent processes; the runner facade's `detach` is a no-op (`runner-hooks.mjs:45`). Nothing to port. | yes |
| 14 | Retire predecessors (former-lead / former-brainstorm) | `retirePredecessors` `:2311`; called `:1887-1891` | Marks the same-(team,lane,role,topic) predecessor `(old)` / former-* when a new holder spawns. | **port** | Brainstorm half is natively covered (`brainstorm.mjs:488` `retireOtherLaneBuddies`; lead-on-handoff retired by `lead-handoff.mjs:689-705/781`), but the `agent.created` "new holder retires old same-lane holder" glue is plugin. Workaround: native retire on `created`. | no |
| 15 | Buddy brief snapshot + archive-after-grace on retire | `snapshotIntoBrief` `:709`; `scheduleBuddyArchive` `:2406` | Appends the retired Buddy's last turn to the brief, then archives it after a grace period with children detached. | **port** | `brainstorm.mjs` has `archiveBuddyKeepingChildren` (used by `retireOtherLaneBuddies:508`) but the brief-snapshot-on-retire + grace archive is plugin. Workaround: fold into native retire. | no |
| 16 | Refresh "Who's here" in the lane brief | `refreshLaneWhosHere` `:2300` | Keeps the brief's `## Who's here` current on spawn/archive/exit/role change. | **covered** | Native `whos-here.mjs:70` `refreshWhosHere`; already called natively by `runner-backend.mjs:502` `refreshLaneWhosHere` (and on archive `:641`, unarchive `:648`, role/lane change `:665`, exit `:990`). | yes |
| 17 | First-prompt redelivery (30 s idle check) | `on("agent.created")` `:1897-1969` | Redelivers the initial prompt once if an agent stays idle at 0 tokens ~30 s. | **port** | Plugin-only timer; the runner sends the prompt synchronously (B11 note 2d) so it rarely fires, and `brainstorm.mjs:341` `recoverTimedOutCreate` already covers the spawn-timeout case. Low priority; confirm still wanted. | no |
| 18 | First-dispatch context metric | `:1971-1984`; `firstDispatchMetricText` `:774` | Logs a lead's context size when its first child is dispatched. | **port** | Plugin-only metric. Workaround: native metric in the `created` handler. | no |
| 19 | Worker digest spawn (Pre-check - Flash) + direct-write fallback | `spawnDigest` `:2079`; called `:2045-2051` | Spawns a digest agent to log PASS/FAIL for a finished worker, with an `UNVERIFIED` fallback. | **port** | Plugin-only; no native digest. Workaround: native digest spawn (uses `RunnerBackend.createAgent`). | yes |
| 20 | `closeFinishedWorker` (auto-archive a worker after its done report) | `:2214`; `noteWorkerDone` `:2239`; called `:2049` | Archives a `role=worker` that filed a done report once its turn ends. | **port** | Plugin-only archive; the revive path is native (`runner-backend.mjs:599-605` reads `vs.auto-archived`). Workaround: native close on the done report. | yes |
| 21 | Lead token check / handoff / confirm-takeover (150k flag → 250k auto → 300k hard) | `checkLeadTokens` `:2164`; `:2052-2058`; `evaluateLead` (native `lead-handoff.mjs:822`) | Flags, nudges, hands off, or retires a lead as its context tokens cross thresholds. | **port (T1)** | Coordinator is native (`lead-handoff.mjs:441`, thresholds `:25-27`, `:60`) and HTTP-wired (`vibesquad-api.mjs:1747-1750`); the per-usage-event watcher that drives `evaluateLead` is the T1 port — new `server/token-watch.mjs` subscribing to runner usage events via `subscribeEvents` (`runner-backend.mjs:716`). | yes |
| 22 | A4 transient-error retry (exponential backoff) | `handleFailure` `:2173`; `TRANSIENT_ERROR` `:68`; `:2027` | Re-sends "continue where you left off" on a transient network failure, up to 2 retries. | **port** | Plugin-only. Workaround: native retry on `turn_ended` `outcome.kind:"failed"`. | yes |
| 23 | `relayFromFormerLead` (relay retired lead's children) | `:2261`; called `:2041` | Re-routes a retired lead's child turn-endings to the current lead (as a wake entry). | **port** | Plugin-only. Workaround: native relay on `turn_ended`. | no |
| 24 | Lead wakeups (log watcher → queue → cooldown → send) | `setInterval` `:2770`; `scanLogs` `:2714`; `queueWake` `:2194`; `dispatchWakes` `:2588`; `flushWake` `:2636`; `findLead` `:2431`; `pendingWake` `:1004` / `lastWakeAt` `:1005` | Wakes an idle lead on new team-log entries (`done/blocker/decision/needs-you/you`), coalesced within a 3 s cooldown. | **port** | Plugin-only; the VS server runs it with `startWatcher:true` via `attachHooks` (`runner-lifecycle.mjs:20`). Workaround: native watcher in the server (team-log tail, or subscribe to runner events). | yes |
| 25 | `turn_started` cooldown stamp / clear `doneReported` / `markTurnSeen` | `on("agent.turn_started")` `:2542`; `:2544-2548` | Records the lead's last-turn time (wake cooldown) and un-marks a re-working worker. | **port** | Plugin-only state; folds into the ported wake + worker-close logic. | yes |
| 26 | Retired-lead misroute redirect (send-time + turn_started envelope) | `handleSendAgentPrompt` `:2452`; `before("send_agent_prompt"/"agent.send")` `:2531`; `on("agent.turn_started")` `:2549-2578`; `parseAgentMessageEnvelope` `:442` | Redirects an agent-to-agent send aimed at a retired lead/Buddy to the live one, with a notice. | **port** | Plugin-only. The `turn_started` envelope parse is dead for the runner (it never writes the `<paseo-system>` envelope — B11 row 6); the live path is the send-time redirect (`runner-backend.mjs:583-591` calls the plugin's `before`). Workaround: native redirect in `RunnerBackend.sendAgentPrompt`. | no |
| 27 | `vs.http` remote RPC (remote-proxy) | `server.handle(vsHttp, …)` `:997`; `plugin/server/remote-proxy.ts` | Exposes the Paseo daemon `vs.http` RPC bridge. | **drop** | Paseo-daemon feature only; the runner host has no `handle` (`runner-hooks.mjs:96`), and the VS server has its own HTTP API. | yes |
| 28 | Team-log metrics (team-mismatch / lane-autofix / orphan / prompt-injection / brief-injected / profile-override / relay-old / misroute-old / brainstorm-retired / hook-timing) | `appendLog` `:560`; `logProfileMetric` `:1104`; `stepTimer` `:581`; scattered | Writes diagnostic `metric` lines to the team log for each duty above. | **port** | Plugin-only metric writes. Native partials exist: `runner-backend.mjs:283` `logRunnerMetric` and `brainstorm.mjs:379` `createSpawnTimer` (spawn-timing). Workaround: emit metrics from the ported handlers. | no |

---

## Summary

- **Rows: 28** — port **21**, covered **4**, drop **3**.
- **`obvious = no` (needs owner call):** rows **4** (A1 `accept-edits` mode default), **8** (lean), **9** (generic Buddy brief injection),
  **14** (retire predecessors), **15** (Buddy brief snapshot/grace-archive), **17** (first-prompt redelivery),
  **18** (first-dispatch metric), **23** (relay former lead), **26** (misroute redirect), **28** (metrics).
- Expected ports confirmed: lead wakes (`flushWake` `:2636` / `pendingWake` `:1004`), A4 retry (`handleFailure` `:2173`),
  capped failover (`normalizeCappedProviders` `:1212`), profile enforcement (`enforceProfileAfterSpawn` `:1120`),
  token watcher (`createLeadHandoffCoordinator` `:1012`, port as **T1**).
