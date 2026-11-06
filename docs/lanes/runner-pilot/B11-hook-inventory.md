# B11 `unit-run-hook-parity` — Paseo plugin hook inventory

Block 11 of `docs/PLAN_RUNNER_PILOT.md` (Phase 2). B10 sends every lane to the VS runner (`rn-*` ids); the Paseo plugin
(`plugin/index.server.ts`) only ever sees Paseo agents. This file lists each plugin behaviour, what is underneath it, and
whether a runner path existed **before** B11 (file:line on `87f0cbe`+master `9b3db3a`). "After B11" is the runner path built here.

## Approach (no forked logic)

The plugin is already a closure over pure `server/` modules plus a small amount of inline glue (spawn layering, retire,
wake queue, digest). Rather than copy that glue, B11 **hosts the same plugin closure for runner agents**:

* `server/backend/runner-hooks.mjs` implements the duck-typed `PluginServerContext` (`before` / `on` / `handle`) and a
  `paseo`-shaped facade (`agents.ref(id).refresh/send/archive/detach/timeline.refetch`, `agents.list`, `agents.create`,
  `schedules.deleteHeartbeat`) backed by `RunnerBackend`, then calls `createPlugin(deps)(host)` from the plugin file unchanged.
* The Paseo daemon keeps loading the plugin exactly as before and only ever gets Paseo events. The runner host only ever
  gets events derived from the runner's own log (`rn-*`), so **nothing fires twice for one agent**.
* Every `server/` function (lead-handoff, identity, whos-here, brief-path, profiles, provider-failover, lean-tools,
  write-guards …) is reached through the plugin exactly as for Paseo — one implementation.

Event source: the runner `/events` SSE log stream already consumed by `RunnerBackend.handleLogEvent`
(`server/backend/runner-backend.mjs`). B11 adds lifecycle events there (`created`, `turn_started`, `turn_ended`), derived from
the log: `created` event → created; `status running` → turn_started; `status idle` after running → turn_ended
(`failed` if an `error` event came during the turn, `cancelled` if a `cancel` event did, else `completed`).
`server/backend/runner-lifecycle.mjs` subscribes once in the VS server process (`server/serve.mjs`) and dispatches to the host.
`before("agent.create")` is applied inside `RunnerBackend.createAgent` itself (any process: UI, MCP, `vs` CLI).

## Inventory

| # | Behaviour | Plugin function (`plugin/index.server.ts`) | `server/` function underneath | Runner path before B11 | After B11 |
|---|---|---|---|---|---|
| 1 | `before("agent.create")`: fixed-order prompt layering (EVERYONE layer → role pack → profile notes → git state → lane brief → lane artifacts), A1 spawn guard (AGY approval policy), profile enforce/failover, VS_ROLE/TEAM/LANE env | `beforeAgentCreate` (l.1255–1686), `injectedPrefix` (l.783), `rolePack` (l.614), `laneBriefBlock` (l.646), `laneArtifactBlock` (l.673) | `identity.mjs` `resolveAgentIdentity`, `profiles.mjs`, `provider-failover.mjs`, `brief-path.mjs`, `write-guards.mjs`, `lean-tools.mjs`, `user-settings.mjs` | **Partial**: `RunnerBackend.createAgent` (runner-backend.mjs:224–250) called `injectedPrefix` only (EVERYONE + role pack). No profile enforcement/failover, git state, brief/artifact blocks, env propagation, metrics. | `createAgent` runs the plugin's `before` handler first (`RunnerBackend.createAgent`, `runner-hooks.mjs`); `buildPrefix` remains only as the fallback when no host (tests / hooks disabled) |
| 2a | `agent.created`: team/lane/role/orphan auto-labelling, lead `ord`, parent, retire predecessor lead/Buddy, Who's here refresh | `server.on("agent.created")` (l.1691–1957), `retirePredecessors` (l.2188), `refreshLaneWhosHere` (l.2177) | `identity.mjs`, `whos-here.mjs` `refreshWhosHere` | **Missing** labelling/ord/retire. Who's here: `RunnerBackend.refreshLaneWhosHere` (runner-backend.mjs:253) on create/archive/exit/role change — native, verified. `toAgent` had no parent. | `created` lifecycle event → host `agent.created`. Parent = `vs.parent` label (set by the MCP spawn tool), surfaced as `parentAgentId` by `toAgent` |
| 2b | `agent.created`: antigravity everyone-layer | covered by 1 (layer is injected before create) | — | — | n/a: the runner has no post-create prompt path; layer is in the system prompt at create |
| 2c | `agent.created`: first-dispatch context metric | `firstDispatchMetricText` (l.773) via `agent.created` (l.1923–1936) | `appendLog` (team log) | **Missing** | via host (parent `lastUsage` comes from `toAgent`, runner-backend.mjs:29–39) |
| 2d | `agent.created`: initial-prompt redelivery check | `agent.created` l.1849–1921 | — | n/a | `Runner.create` sends the prompt synchronously and logs `input` (runner/runner.mjs:74); the plugin check (idle, 0 tokens, empty timeline after 30 s) therefore only has a prompt to redeliver when the create went through the host's `before` in the same process; kept as-is, not relied on |
| 3 | `agent.turn_ended` (completed): worker digest via Pre-check - Flash, direct-write fallback | `spawnDigest` (l.2027), `lastAssistantText` (l.2014) | `profiles.mjs` (`resolveStoredProfile`), `identity.mjs` `isDigestAgent`; team log | **Missing** | `turn_ended` → host; `paseo.agents.create` facade → `RunnerBackend.createAgent`; `autoArchive` honoured by the facade; backstop via facade `waitForFinish` |
| 4 | `log.jsonl` watcher → event-driven lead wakeups (`done/blocker/decision/needs-you/you`) | `scanLogs` (l.2582), `dispatchWakes` (l.2456), `flushWake` (l.2504), `findLead` (l.2302) | `identity.mjs` role/lane resolution; `~/.vibesquad/teams/*/log.jsonl` | **Missing** for `rn-*` leads (the Paseo plugin's `findLead` lists Paseo agents only) | host started with `startWatcher:true` in the server process; its `findLead` lists runner agents; wake `send` goes through `RunnerBackend.sendAgentPrompt` (the runner) |
| 5a | `turn_ended`: lead handoff prompt (stage `prompt-250`; flag at `flag-150`) | `checkLeadTokens` (l.2090) | `lead-handoff.mjs` `evaluateLead` (l.820; thresholds l.25–27: 150k flag / 250k auto / 300k hard — the older 100k/130k wording in the plan is stale) | **Missing** for runner leads (needs the call; `lastUsage` already native via `toAgent`/`usageFields`) | `turn_ended` → host → `evaluateLead`; sends via facade, labels via `RunnerBackend.updateAgent` |
| 5b | `turn_ended`: handoff-ready label / auto handoff / hard cap | same, `handoffCoordinator.confirmTakeover` (l.2001) | `lead-handoff.mjs` `confirmTakeover` (l.738) | **Missing** | same |
| 5c | `turn_ended` failed: A4 transient-error retry | `handleFailure` (l.2099) | — | **Missing** | `turn_ended` with `outcome.kind:"failed"` + error text from the runner `error` event |
| 6 | `agent.turn_started`: lead wake cooldown stamp, retired-agent forwarding | `server.on("agent.turn_started")` (l.2411–2454), `handleSendAgentPrompt` (l.2323) | `identity.mjs` `isRetiredRole` | **Missing**. Note the plugin forwards by parsing Paseo's `<paseo-system kind="agent-message">` envelope, which the runner never writes | `turn_started` → host (cooldown stamp). Retired-lead redirect is done **at send time**: `RunnerBackend.sendAgentPrompt` with `opts.senderId` runs the plugin's `send_agent_prompt` before-handler (the same `handleSendAgentPrompt`); the VS MCP `send` tool passes its caller id |
| 7 | Who's here refresh (B6) | — | `whos-here.mjs` | **Native** (runner-backend.mjs:253, called from create/archive/updateAgent/exit) | verified, untouched |
| 8 | `tokenUsage` / `lastUsage` on runner agents (B6) | — | — | **Native** (`usageFields`, runner-backend.mjs:29–39; runner `usage` events, runner.mjs:124) | verified, untouched |

## Not ported / differences

* Events are live-only (the runner SSE has no replay): a turn that ends while the VS server is down fires no hook (the
  Paseo plugin has the same property while the daemon is down). The wake watcher baselines to end-of-log on start.
* `applyAgentSettings` (post-spawn model/mode switch) has no runner equivalent; the `before` hook already applies an explicit
  profile, so post-spawn fixes are not needed. A provider mismatch is still refused (cancel + archive).
* A lane split across Paseo and runner (a Paseo-pinned lane) is woken by the Paseo plugin; the runner host only sees `rn-*`.

## Review r1 fixes (Gemini)

* **Digest**: runner workers are inspected with `vs status <id>` (not `paseo inspect`). After the digest agent goes idle, the
  plugin checks the team log for a `done` entry naming the worker; none = direct-write fallback (`UNVERIFIED (digest logged nothing)`).
* **Profile identity**: `spawn_worker`/`vs spawn` label the profile by *name*; `matchStoredProfile` also accepts a profile id.
* **First `turn_started`**: turn state is driven by the event stream (a prompt `input` event marks a live turn); `created` no
  longer seeds from a status fetch. An error/exit before the adapter's first `running` (ACP init failure) now ends the turn as failed.
* **Cross-process spawn state**: `before(agent.create)` runs in the caller's process, `agent.created` in the VS server, so the
  plugin's in-memory maps are not shared. The runner create persists `thinkingOptionId`, `featureValues` and a
  `vs.spawn-configured=1` label, which `enforceProfileAfterSpawn` honours. `agy`/`antigravity` are canonicalised to `antigravity-cli` before the hook.
* **Handoff**: `spawnSuccessor` re-points runner workers with `vs.parent`; `vs` caller usage reads `lastUsage` for `rn-` ids.
* **Installed runtime**: the plugin is a `.ts` file loaded by Node's built-in type stripping (no flags; Node >= 22.18 / 23.6). The desktop
  build copies the building `node.exe` (`server/build-desktop.mjs:77`), which is v24 here. The `vs` shim closure now includes `plugin/`.
  If the import still fails, `RunnerBackend.hookHost` logs to stderr and writes a `runner hooks unavailable` metric to the `_unassigned` team log (never silent).
* **No replay (accepted)**: the runner event stream does not replay; a turn that ends while the VS server is down fires no hook
  and the wake watcher baselines at end-of-log on start.

## Review r2 fixes

* **Cold-start race**: `RunnerBackend.enableCatchUp()` (called by `startRunnerLifecycle`) records each agent's last log seq at startup
  (in memory; history is never replayed, so a server restart fires nothing old). Every event-stream (re)connect then replays, per agent,
  the events after that high-water mark (`seedRoster` -> `catchUp`), and `handleLogEvent` handles each seq once (live or replayed).
  Updated "no replay" note: events appended while the stream is down are now replayed *within a server process*; events while the VS server itself is down are still not.
* **Shim closure** follows `@vibesquad/server/*` specifiers to `server/*`.
* **Duplicate metrics**: `agent.created` skips the mismatch / autofix / fallback / orphan / profile-override metric lines when `vs.spawn-configured=1`.

## Review r3 fixes

* **Turn state is event-only** (`reduceTurn`, pure): `enableCatchUp` scans each agent's log once for its high-water mark *and* turn state;
  `seedRoster` no longer overwrites it and `catchUp` no longer deletes it, so a turn spanning a disconnect, a failure before `running`, or
  `meta` before `running` replay correctly. Turn state advances before the roster fetch, so a failed fetch loses nothing.
* **Ordering**: `startRunnerLifecycle` baselines and subscribes synchronously and is called before `startPushWatcher` in `serve.mjs`;
  events seen while the plugin loads are buffered and drained in order.
* **Serialized emits**: hooks run one at a time through a single queue; `catchUp` walks agents in `createdAt` order. The plugin's
  `retirePredecessors` only retires agents created *before* the new one, so a replayed `created` cannot retire a later sibling.
