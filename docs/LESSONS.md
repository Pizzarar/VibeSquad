# VibeSquad Lessons

A durable catalog of recurring engineering & workflow lessons, scraped from Buddy/Brainstorm briefs,
handoff docs, plan docs (`docs/PLAN_*.md`, `docs/HANDOFF_*.md`) and team logs
(`~/.vibesquad/teams/*/log.jsonl`) across VibeSquad and Escape-From-Idle.

Each lesson is written as **Symptom → Root Cause (How We Got Here) → Rule / Fix → Evidence** so a
future lead or worker can recognize the pattern, understand how it happened, and apply the fix.

The machine-readable counterpart of this file is `server/lessons.mjs`
(`appendLesson` / `readLessons` / `renderLessonsDigest`), which stores lessons one-per-line in
`~/.vibesquad/lessons.jsonl` (or `<repo>/docs/LESSONS.jsonl` for repo-scoped use) and can inject a
compact `<!-- vibesquad:lessons:begin -->` digest into prompts.

---

## 1. Paseo Daemon, CLI & RPC (`paseo ls`, `paseo wait`, Spawn Hang, WS Backpressure)

### 1.1 Agents ran `paseo ls -g --json` every turn → 12k-char lookups and CLI deadlocks
- **Symptom:** Every lead/worker turn shelled out to `paseo ls -g --json` to "find the lead", costing
  ~12k chars (~3k tokens) per lookup with 38 agents, growing with every agent, and leaving "skip (old)"
  to model judgment (which is how retired leads kept getting messaged).
- **Root Cause (How We Got Here):** Agent-written instructions taught everyone to resolve identity by
  running the Paseo CLI and eyeballing the JSON. State-file caches were rejected earlier because a
  crashed/replaced agent never writes its final state, so the "live" answer became a cold CLI call.
- **Rule / Fix:** Replace every "find your lead with `paseo ls -g --json`" instruction with
  `vs who lead` (live daemon query, filtered in code by `role=lead`/`role=brainstorm`, never
  `former-*`/`(old)`). No cache file; works without the VS server.
- **Evidence:** `docs/PLAN_VS_WHO.md` ("Why": 12k chars / 3k tokens per lookup); `docs/ROLE_PACKS.md`
  everyone-layer R1–R7; `docs/NAMING.md` v2 resolver.

### 1.2 Synchronous `execFileSync("paseo", …)` inside the daemon/server → 60s+ spawn hangs
- **Symptom:** Cold `node.exe` CLI subprocesses (`paseo status/ls/provider/plugin/usage --json`) spawned
  synchronously from the server froze settings tabs and status reads; `paseo provider diagnostic claude`
  printed nothing within 150s.
- **Root Cause (How We Got Here):** Instead of using the already-open `@getpaseo/client` WebSocket and
  `~/.paseo/local-credential`, VibeSquad shelled out to cold `node.exe` CLI subprocesses and maintained
  its own competing reconnect/poll timers across React, Node, and Rust.
- **Rule / Fix:** Call `daemonClient` WebSocket RPCs (`listAvailableProviders`, `listProviderUsage`,
  `fetchAgents`, `getDaemonStatus`) directly; reserve `runPaseoCli` strictly for process-level verbs
  (`daemon start/stop/restart`, `reload`, `plugin install`, `pair`).
- **Evidence:** `docs/PLAN_SIMPLIFICATION_AUDIT.md` P1 §6 (`server/paseo-control.mjs:235`,
  `src/PaseoSettingsSection.tsx:437-474`); P0 §1–3 for the three-hop WS proxy and competing timers.

### 1.3 The P0 daemon spawn hang: a windows-hide preload broke `util.promisify(execFile)`
- **Symptom:** A VS-started Paseo daemon could not spawn anything — `Timed out refreshing Claude after
  120000ms; pending: version` for Claude/Codex/CodeWhale/Antigravity; `paseo provider ls` showed every
  provider `error`. "Spin Up Brainstorm" hung and produced a ghost "trying to spin up" agent.
- **Root Cause (How We Got Here):** `server/windows-hide-preload.mjs` (`ef05aac`) wrapped
  `childProcess.exec`/`execFile` to suppress console flash but dropped
  `origExec[util.promisify.custom]` / `origExecFile[util.promisify.custom]`. In Node,
  `util.promisify(cp.execFile)` relies on that symbol to return `{ stdout, stderr }` with `.child`;
  without it, every `const { stdout } = await promisify(execFile)(...)` inside `@getpaseo/server`
  (`where.exe claude`, `Get-Command claude`, `claude --version`) got `stdout === undefined`
  (`TypeError: Cannot read properties of undefined (reading 'trim')`) or hung under load.
- **Rule / Fix:** Patch `childProcess.ChildProcess.prototype.spawn`
  (`options = { ...options, windowsHide: true }`) and **preserve** `[util.promisify.custom]` on
  `exec`/`execFile`. Launch the daemon via `paseo --home <paseoHome> daemon start` without a conflicting
  `detached: true` on the outer wrapper, record the supervisor PID, and poll providers after start to
  surface `"Daemon started but providers failed: <first error>"` instead of silent success.
- **Evidence:** `docs/PLAN_DAEMON_SPAWN_HANG.md` (Root Cause Block 1, `ef05aac`, fix `83afd30`),
  `docs/brainstorm/bug-chaser.md` In-flight (merged at `2e42ddc`).

### 1.4 Ghost "spinning up" agent left behind when `createAgent` throws
- **Symptom:** Paseo shows an agent "trying to spin up" but empty when clicked, after a failed create.
- **Root Cause (How We Got Here):** `@getpaseo/server` persists the new agent record in
  `status: "initializing"` in `~/.paseo/agents/` **before** awaiting `refreshProvider("claude")`, and
  throws on timeout — leaving an empty, unarchived record.
- **Rule / Fix:** When `client.createAgent` throws, query `fetchAgents()` for any newly-created
  unarchived `role=brainstorm` agent in `(teamId, laneId, topic)` created `>= spawnStartTs` with
  `status === "initializing" || "error"` and 0 messages, and archive it automatically; render the
  spin-up error inline rather than `window.alert`.
- **Evidence:** `docs/PLAN_DAEMON_SPAWN_HANG.md` (Block 2, fix `aeb9b23`, `server/brainstorm.mjs:673`).

### 1.5 WebSocket backpressure: three-hop proxy + double JSON parse on every frame
- **Symptom:** 163ms localhost spikes, `Transport closed (code 1006)` disconnects, false password
  prompts.
- **Root Cause (How We Got Here):** `WebView :4189` → Rust proxy → Node `:4180` → Paseo `:6767`; the
  Rust proxy synchronously `serde_json::from_str`'d every text frame (twice), and three uncoordinated
  reconnect/poll timers raced the same `DaemonClient`.
- **Rule / Fix:** Dial `127.0.0.1:6767/ws` directly with `~/.paseo/local-credential`; move frame
  inspection off the hot path onto an async channel without double parse; drive state transitions
  solely from `daemonClient.subscribeConnectionStatus()`.
- **Evidence:** `docs/PLAN_SIMPLIFICATION_AUDIT.md` P0 §1–4; `docs/brainstorm/bug-chaser.md` (Unit 2
  `eafcc80`, Unit 1 `2d470a5`).

### 1.6 `paseoArchiveCascade` killed children when retiring a Buddy
- **Symptom:** Retiring and archiving a Buddy (Brainstorm) also archived its lead, and the lead's
  workers with it (Basic ADE ord1 + 5 workers).
- **Root Cause (How We Got Here):** Paseo archives an agent's children with it: every unarchived agent
  whose `paseo.parent-agent-id` label points at the archived one is cascade-archived. A Buddy spawns its
  lead through MCP `create_agent`, so the lead carries the Buddy as parent.
- **Rule / Fix:** **Detach first, archive second.** Before archiving any agent, detach every live
  (not archived, not closed) child via `client.detachAgent`; if a detach fails, leave the parent
  unarchived rather than risk the cascade. Closed children go with the parent, as before.
- **Evidence:** `server/detach-children.mjs` header; `server/session-janitor.mjs`;
  `docs/PLAN_BUGS_BATCH1.md` block 0; `test/bugs-batch1-cascade.test.mjs`.

### 1.7 Waiting on background agents
- **Symptom:** Leads stalled turns (task-3692, task-3923) by ending a turn to "wait" for a background
  worker.
- **Root Cause (How We Got Here):** No explicit rule forced an in-turn wait with a bound.
- **Rule / Fix:** Never end a turn just to wait on a background task — poll it within the turn with a
  timeout, or use `paseo wait <id> --timeout <s>` (always with a timeout; no sleep/poll loops).
- **Evidence:** `docs/PLAN_ROUTING_POLICY.md` §5 (lead role-pack rule, Aub-approved); `docs/ROLE_PACKS.md`
  guardrail R6.

---

## 2. Identity & Role Resolution

### 2.1 Title-prefix regex matching caused cross-lane collisions
- **Symptom:** `/^★/` and `/^BRAINSTORM/` (and later `(old)`, `ordN`) title matching misrouted roles,
  messaged retired leads, and collided across lanes; "Group Projects by lane label instead of title
  regex" was a real stopgap fix.
- **Root Cause (How We Got Here):** Titles were the only identity signal. A lead's title was
  `★ <Code><ord> · <objective>` and a Buddy's `BRAINSTORM …`, so the plugin inferred role from the
  title string in `before("agent.create")`, which carries no labels.
- **Rule / Fix:** Lane is the single identity fact. Labels `lane`, `role`
  (`lead|brainstorm|worker|former-*`), and `ord` (leads) are the source of truth; titles are generated
  from labels for display only. One resolver (`resolveAgentIdentity`) orders lookups: `labels.lane` →
  `cwd`/worktree `.git` (`lane-autofix`) → 2-week `labels.team` fallback → `paseo.parent-agent-id` chain →
  `orphan=1` (Unassigned tray). A lint flags titles that don't match `formatDisplayTitle`; it never
  rewrites retired/closed/archived agents.
- **Evidence:** `docs/PLAN_IDENTITY_V2.md`; `docs/NAMING.md` v2 (principle + resolution order);
  `~/.vibesquad/teams/vibesquad/log.jsonl` ("Group Projects by lane label instead of title regex").

### 2.2 Spawn-time fallback in `beforeAgentCreate` is required
- **Symptom:** Spawns with no/wrong team or unknown lane landed in the wrong lane; free-text lanes
  drifted from the registry (identity dry-run showed `changed=44, orphans=44`).
- **Root Cause (How We Got Here):** `before("agent.create")` carries `{ config, env }` only, so the
  plugin used `VS_ROLE` env or the title convention to guess role, then `agent.created` back-filled
  `team`/`lane` from the parent or `teams.json` path rules.
- **Rule / Fix:** Keep a spawn-time fallback (`VS_ROLE` env → title convention → worker) in
  `beforeAgentCreate`, then fill missing labels in `agent.created`. Never reject a Paseo-native spawn;
  tag unmatched spawns `orphan=1` and log `orphan` / `lane-autofix` / `misroute-old` metrics.
- **Evidence:** `docs/ROLE_PACKS.md` "How the role is picked"; `docs/PLAN_IDENTITY_V2.md` §4;
  `docs/PLAN_SPAWN_HYGIENE.md` §12 (lane-autofix fills blanks only).

### 2.3 `former-brainstorm` / `former-lead` must never block `quickStart` or match `vs who`
- **Symptom:** Retired leads were still messaged and counted; a restart tried to "reuse" a retired
  Buddy.
- **Root Cause (How We Got Here):** The retired status lived in the title (`(old)`) rather than a
  label, so any title-based lookup matched retired agents.
- **Rule / Fix:** `role=former-lead` / `role=former-brainstorm` are excluded by every live lookup
  (`vs who lead`/`brainstorm`, quick-start reuse checks). `former-*` and `(old)` never match a "find the
  lead/brainstorm" query. Messages to a retired agent redirect to the live successor and log
  `misroute-old` / `relay-old`.
- **Evidence:** `docs/PLAN_VS_WHO.md` ("Filter in code … Never `former-*`, never titles starting
  `(old)`"); `docs/NAMING.md` retired-lead/retired-brainstorm rows; `docs/brainstorm/bug-chaser.md`
  Option C §4.

---

## 3. Worktree Sprawl & `projects/` Folder Hygiene

### 3.1 `git worktree add ../<repo>-<unit>` spammed `projects/` with 44+ sibling folders
- **Symptom:** `C:\Users\Fugma\projects` filled with 44+ sibling directories (`VibeSquad-*`,
  `efi-uilab-*`) plus 50+ `VibeSquad\.worktrees\` folders; the Workspaces page showed ~200–317 "active"
  workspace records.
- **Root Cause (How We Got Here):** Early spawns created unit worktrees as siblings of the main
  checkout (`../<repo>-<unit>` and `.worktrees/unit-*`), and `src/WorkspacesView.tsx` matched agents to a
  workspace **by folder** (`a.cwd` under `workspaceDirectory`) rather than by workspace id, so every
  agent in `projects/VibeSquad` claimed all 19 live + 142 archived agents as "in use".
- **Rule / Fix:** All unit worktrees belong in
  `%LOCALAPPDATA%\VibeSquad\worktrees\<repo>\<unit>` (the "worktree sanctuary"), with automatic merge
  sweeps. Match workspace membership by `workspaceId` (fall back to cwd only when the protocol omits it),
  and treat "in use" as a live, non-archived agent active within `STALE_DAYS`.
- **Evidence:** `docs/PLAN_WORKSPACES_CLEANUP.md` (Cause, Decided);
  `~/.vibesquad/teams/vibesquad/log.jsonl` (`lane-autofix … cwd=C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-…`);
  this work order's own isolated worktree path.

### 3.2 Archive-vs-delete confusion in the Workspaces UI
- **Symptom:** "Archive N safe" armed as "Delete N folders?" even for `local_checkout` records, where
  archive only drops Paseo's record.
- **Root Cause (How We Got Here):** One label conflated "archive Paseo's record" with "delete the folder
  on disk".
- **Rule / Fix:** Two distinct actions: "Clear records" (archives Paseo records only, no files touched)
  vs "Delete folder" (only when the action really deletes one, and only for linked git worktrees, never a
  main checkout). `git worktree remove` refuses dirty worktrees and `git branch -d` refuses unmerged
  branches — surface git's reason, don't force.
- **Evidence:** `docs/PLAN_WORKSPACES_CLEANUP.md`; `server/team-worktrees.mjs`.

---

## 4. Provider Quota Caps & Profile Explosion

### 4.1 Coupling 20+ profiles to one provider froze lanes at the Claude cap
- **Symptom:** When Claude hit its usage cap (~1%), every Claude-bound profile stalled and lanes froze;
  only Gemini (`antigravity-cli`) profiles kept working.
- **Root Cause (How We Got Here):** Profiles (`Lead - Claude`, `Brainstorm - Claude`, etc.) were pinned
  to a single provider, and a hand-copied `PROFILES` list in the UI had drifted from Paseo (missing 6 of
  19 profiles, dropped `featureValues`, dropped DSP thinking).
- **Rule / Fix:** Route by **Role + Tier** with automatic failover (`Claude → Gemini → DeepSeek`) and a
  compact top-bar provider switch. Auto-fallback `*-Claude ↔ *-Gemini` when a provider's usage is
  `>= 95%` (or `unavailable`/`error`/`exhausted`). Keep one owner-editable routing policy
  (`~/.vibesquad/routing.md`) and strip routing lines out of profile notes.
- **Evidence:** `docs/PLAN_PROVIDER_CONTINUITY.md` (C1 failover); `docs/PLAN_PROFILES.md` (drifted
  `PROFILES` list); `docs/PLAN_ROUTING_POLICY.md` (seed policy); `server/provider-failover.mjs`
  (`QUOTA_FAILOVER_THRESHOLD = 95`, `COUNTERPART_PROFILES`).
- **Attribution (Community Accolades):** Provider failover & 1-click switch — Thanks to **Continuity** by
  Chechulin Serhii, **Switch provider** by anh-chu, **Usage Auto Resume** by babo-jeonguk, **Zerosub** by
  Kapybara, and **Claude Code entrypoint** by getpaseo (recorded in `docs/PLAN_PROVIDER_CONTINUITY.md`
  Block C1).

### 4.2 Lead successor inherited the old lead's provider, so rebalances never stuck
- **Symptom:** Rebalancing routing required multi-repo edits (Escape-From-Idle carried its own
  `AGENTS.md` copy), and the lead provider never changed after handoff.
- **Root Cause (How We Got Here):** `lead-handoff.mjs` kept the old lead's provider for the successor
  (`isAgy`), and routing lines were copied into every profile's notes and every repo's rules.
- **Rule / Fix:** Lead successor provider comes from the routing policy, not the old lead's provider
  (explicit handoff-UI override still wins). One policy + `vs broadcast leads "<text>"` to rebalance in
  one edit.
- **Evidence:** `docs/PLAN_ROUTING_POLICY.md` ("Today" and §3).

### 4.3 The top-bar model dropdown showed only one model
- **Symptom:** The agent top-bar model list showed only `claude-opus-5-5`.
- **Root Cause (How We Got Here):** `<input list="drawer-model-list">` filters `<datalist>` options by
  the current value, a static global `<datalist>` id was shared across panes, and
  `PROVIDER_MODEL_HINTS` was missing several providers and didn't merge live
  `listProviderModels(agent.provider)`.
- **Rule / Fix:** Use a per-agent `<select>` (with a "Custom…" free-text fallback) merging
  `currentModel`, live `listProviderModels(agent.provider)`, and an expanded provider-model hint table.
- **Evidence:** `docs/PLAN_DAEMON_SPAWN_HANG.md` (Block 4, fix `aea1ff6`).

---

## 5. Handoffs & Context Survival Across Restarts

### 5.1 Chat-history scraping wipes state across restarts/provider switches
- **Symptom:** A fresh Buddy started with the blank brief template; brief edits written by the server
  never reached the repo; brainstorms restarted with 42k context or lost their decisions.
- **Root Cause (How We Got Here):** `REPO_ROOT` resolved to the server's own folder — in the installed
  app that is `%LOCALAPPDATA%\VibeSquad\runtime` — so `readBrainstormSummary` read/wrote
  `<runtime>/docs/brainstorm/<lane>.md`, which only holds `quickstart.md`. The real brief lives in the
  repo, and chat history isn't a durable store across provider switches.
- **Rule / Fix:** Durable per-lane artifacts are the source of truth:
  `docs/lanes/<lane>/SPEC.md` + `TASKS.json` and `docs/brainstorm/<lane>.md`. One shared brief resolver
  (`laneWorkingDir(team, lane)`, falling back to `REPO_ROOT` only in dev) for read/write/snapshot/inbox/
  pin-ideas. Never inject the blank template when a real brief exists; say "no brief yet" in one line.
- **Evidence:** `docs/PLAN_BRIEF_PATH.md`; `docs/PLAN_SPAWN_HYGIENE.md` §6 (brief durability +
  `~/.vibesquad/brief-history`); `docs/PLAN_BRAINSTORM_FLOW.md` (referenced).

### 5.2 Lead auto-handoff ladder (150k / 250k / 300k)
- **Symptom:** Leads ran out of context mid-dispatch, or handed off too late.
- **Root Cause (How We Got Here):** The old rule was a blunt "100k stop / 130k handoff"; no soft flag,
  no auto path, no hard ceiling.
- **Rule / Fix:** At ~150k stop dispatching and write a handoff at the next good stopping point; VS
  auto-hands off at 250k (spawn `ordN+1` successor with the handoff doc, lane summary and latest plan,
  retire the old lead only after the successor confirms); hard cap 300k (VS writes the handoff from
  `vs log` if none exists). Re-point in-flight workers to the successor.
- **Evidence:** `docs/PLAN_LEAD_HANDOFF.md`; `docs/ROLE_PACKS.md` lead pack.

### 5.3 Roster plugin / config drift corrupted the brief and bloated spawns
- **Symptom:** `docs/brainstorm/vibesquad.md` was wiped to 134 bytes; some brainstorms started at
  40–55k context.
- **Root Cause (How We Got Here):** A removed Roster plugin had been the one writing the brief, and
  duplicate R1–R7 rules were injected from two places (plugin prefix + profile notes). The reuse check
  in `server/brainstorm.mjs` failed open when `fetchAgents` returned empty (daemon restart), spawning a
  second Buddy.
- **Rule / Fix:** Keep exactly one prompt source per rule. Fail closed when the agent list can't be read
  (return an error, don't spawn). Restore briefs from `~/.vibesquad/local-backup`; snapshot before
  overwriting; refuse to replace a >1k brief with a <300-byte write unless it's a new lane. Strip tools
  per role (deny Workflow/PowerShell/Agent/ScheduleWakeup/ReportFindings) instead of loading a 40k
  provider file.
- **Evidence:** `docs/PLAN_SPAWN_HYGIENE.md` (Decided §1–7, Block 7 decision).

---

## 6. Windows / PowerShell Traps

### 6.1 PowerShell `Set-Content` / `Out-File` writes UTF-8 BOMs that break JSON parsers
- **Symptom:** `teams.json`, `package.json`, `profiles.json`, and `~/.paseo/config.json` failed to parse
  after a PowerShell rewrite.
- **Root Cause (How We Got Here):** `Set-Content` / `Out-File` default to UTF-8 **with** BOM (ef bb bf /
  `\uFEFF`), which `JSON.parse` rejects.
- **Rule / Fix:** Always write JSON with node `fs.writeFileSync(path, text, "utf8")` (no BOM), and read
  with `readJsonFileWithBom` (`server/user-settings.mjs`) so an existing BOM is stripped (and best-effort
  scrubbed on the way out). Back up `~/.paseo/config.json` before any rewrite.
- **Evidence:** `docs/profiles/DEFAULT_PACK.md` line 28; `server/user-settings.mjs`
  (`stripBom`/`parseJsonWithBom`/`readJsonFileWithBom`); `server/paseo-control.mjs` header ("no UTF-8
  BOM").

### 6.2 `child_process.spawn` on Windows: `EFTYPE` on `.mjs` and console flash
- **Symptom:** `spawn`/`exec` of `.mjs` files fails with `EFTYPE`, and every child process flashes a
  console window.
- **Root Cause (How We Got Here):** Windows can't directly execute `.mjs` (no registered association),
  and without `windowsHide: true` each spawned `node.exe`/CLI opens a console.
- **Rule / Fix:** Always pass `windowsHide: true` (and for the CLI wrapper avoid a conflicting
  `detached: true`). Prefer `paseo --home <home> daemon start` (the CLI Paseo itself uses) over
  hand-rolled `spawn` of `.mjs` entry points. See also lesson 1.3 — hide windows by patching
  `ChildProcess.prototype.spawn`, **preserving** `[util.promisify.custom]`.
- **Evidence:** `docs/PLAN_DAEMON_SPAWN_HANG.md` (fix `83afd30`, `ef05aac` preload);
  `server/team-worktrees.mjs` (`windowsHide: true`); `server/windows-hide-preload.mjs`.

---

## 7. Additional Buddy/Handoff Lessons Scraped from Briefs & Team Logs

### 7.1 Daemon password set by hand broke every browser tab (Reconnecting loop)
- **Symptom:** After a daemon password was set, `createDaemonClient()` failed with `password_required`
  and every browser tab stuck "Reconnecting".
- **Root Cause (How We Got Here):** The browser `DaemonClient` sent no password; the server held no
  copy; `DaemonStatusBanner` retried every 3s with no escape hatch.
- **Rule / Fix:** On localhost, authenticate via `~/.paseo/local-credential`; store a relay password as
  `~/.vibesquad/daemon-password` (`0600`, `PASEO_DAEMON_PASSWORD` env, never in settings/bundle) and hand
  it to the browser client before `connect()`; pause retry on `authFailureReason` and show an unlock +
  `SETUP/DAEMON` escape hatch.
- **Evidence:** `docs/brainstorm/paseo-parity.md` (P0-A `68169a6`, P0-B `4345599`);
  `~/.vibesquad/teams/paseo-parity/log.jsonl` (`needs-you: daemon password breaks VS`).

### 7.2 Remote-spawn endpoints must be closed or provenance-fenced
- **Symptom:** Relay security review found `inbox/open-topic` and `brainstorm-restart` remote endpoints
  too permissive.
- **Root Cause (How We Got Here):** Relay work opened server write endpoints before a body policy and
  registry check existed.
- **Rule / Fix:** Remote write bodies enforce a `REMOTE_BODY_POLICY` (type/size caps); `profile` is
  forbidden remotely — send a registry-checked `profileName` (`str(120)`) and validate it server-side
  against `role === "brainstorm"` profiles. Reopen closed spawn routes only with non-auto mode or
  untrusted-provenance fencing.
- **Evidence:** `docs/brainstorm/paseo-parity.md` R2-5 (`bf0a69a`, 172/172 tests);
  `docs/PLAN_DAEMON_SPAWN_HANG.md` Block 3.

### 7.3 "In use" and "duplicate Buddy" both came from matching on the wrong key
- **Symptom:** 317 "active" workspaces; two live Buddies in one lane after a daemon restart.
- **Root Cause (How We Got Here):** Workspace matching used folder string, not workspace id; the Buddy
  reuse check failed open when `fetchAgents` returned empty after the daemon restarted (pid
  14892→30508), spawning a duplicate.
- **Rule / Fix:** Match by stable id (workspace id, agent id); fail closed when the roster can't be
  read; treat "one live lead and one live main Brainstorm per `(team, lane)`" as the invariant, with a
  `DUPLICATE LIVE LEAD/BRAINSTORM · RETIRE ONE` two-tap control.
- **Evidence:** `docs/PLAN_WORKSPACES_CLEANUP.md`; `docs/PLAN_SPAWN_HYGIENE.md` §3; `docs/NAMING.md`
  lane integrity.

### 7.4 Splitting vs. spinning off: the hub Buddy sorts, the owner confirms
- **Symptom:** The owner kept dumping everything in one lane, and the Buddy kept waiting for "spin up a
  Buddy" triggers; `vs pin new` refused "Bug Chaser" because the name matched "VibeSquad".
- **Root Cause (How We Got Here):** The Buddy pack only reacted to explicit triggers; there was no
  parallel-by-default rule and no editable spin-off confirmation.
- **Rule / Fix:** Hub Buddy sorts every new idea (stays / existing Team / new Team) and never spins off
  without confirmation; confirmation is a fenced `vs:spin-off` block the owner edits by talking ("energy
  and food in one lane called Needs"). Plans carry a parallel table ("Touches | Clashes with"); leads run
  non-clashing blocks in parallel by default and say why when they don't.
- **Evidence:** `docs/PLAN_SPINOFFS_PARALLEL.md`; `docs/brainstorm/efi.md` (hub: "keep every live thread
  in exactly one Team").

### 7.5 Privacy / security leaks from docs and commit history
- **Symptom:** Quickstart review flagged a private repo link, a leaked handle, and commit history
  carrying private details.
- **Root Cause (How We Got Here):** Public-flip happened before a pre-flip check; docs referenced
  private/scratch paths.
- **Rule / Fix:** Run a pre-public check (secrets, private links, "write as if VibeSquad is public");
  separate a pre-flip checklist; keep scratch in `scratch/` (gitignored); a repo pointer tells agents to
  follow the VibeSquad routing policy rather than repo-local rules.
- **Evidence:** `~/.vibesquad/teams/quickstart/log.jsonl` (`QS2-G2-SEC`, "reported privacy details in
  git history"); `docs/PLAN_ROUTING_POLICY.md` §6.

### 7.6 Antigravity (`antigravity-cli`) providers ignore `systemPrompt` and mis-report tokens
- **Symptom:** Gemini/antigravity leads logged `n/a` or wrong token counts; prompt injection was dropped
  or stalled (`agy` override stalls silently).
- **Root Cause (How We Got Here):** `antigravity-cli*` ignores `systemPrompt`, so the role pack had to be
  steered in as a first message; its provider computed `contextInputTokens` without
  `cache_read_tokens`, under-reporting context.
- **Rule / Fix:** For Antigravity, steer the role pack in as a first message after creation; when
  spawning via `create_agent`, pass `provider`/`model`/`mode` + `profile` and omit `features` (the plugin
  adds required provider defaults + `modeId: accept-edits`, overriding inherited `agy`). Fix token
  reporting to `input_tokens + (cache_read_tokens ?? 0)`.
- **Evidence:** `docs/ROLE_PACKS.md` "Antigravity (Gemini)"; `docs/brainstorm/bug-chaser.md`
  (`docs/PLAN_AGY_TOKEN_USAGE.md`, Bug6).

---

## 8. Owner ↔ Agent Communication & Interrupt Patterns

Derived from an audit of 176 extracted owner turns (`owner-turns-extracted.json`) plus verbatim
owner quotes in `docs/PLAN_*.md`. See `docs/audits/owner-turn-audit.md` for the full breakdown.
Aub (the owner) talks fast, tersely, with typos, and often while an agent is already mid-turn.

### 8.1 Plain Enter steered mid-turn follow-ups instead of queueing them
- **Symptom:** ~15% of owner turns arrive within 60s of the previous one; "oh and by the way"
  side-thoughts ("proceed, also, crate a prompt…", "sweet on a nother note…") collided with active
  turns and displaced them. 3 Gemini turns carry `interruptedMidTurn=true`, 10 Claude turns have
  `prevEntryType=assistant`, and 10 are `[Request interrupted by user]` markers.
- **Root Cause (How We Got Here):** `src/paseo.ts` `sendMessage` defaults
  `activeTurnBehavior: "steer"`, so every plain-Enter send rewrites the running turn instead of
  queueing behind it. Aub flagged it himself: "i know i intterupt mid turn alot… more 'oh and by the
  way'. I think you have a /btw command?" / "i like suupporting commands and queuing by default with a
  little 'send this now' promt… if you want to steer insteaad."
- **Rule / Fix:** Default to **queue**; only an explicit "Send this now" (or `Go:`) steers. Treat
  `also` / `on a nother note` / `btw` / `I also need` as a **separate unit of work**, not a modifier
  on the current turn. Never end a turn to "wait" for a queued item.
- **Evidence:** `owner-turns-extracted.json` 2026-11-04T03:45:08Z / 03:48:42Z; `src/paseo.ts:164`;
  `docs/audits/owner-turn-audit.md` §4(a).

### 8.2 Keyboard-adjacent / phonetic shorthand must be decoded silently
- **Symptom:** Agents stalled or misread owner typos that are one key off or phonetically garbled.
- **Root Cause (How We Got Here):** Aub types fast and never corrects, so shorthand abounds:
  "gold for a second" → *hold*, "paseo la" → *paseo ls*, "emini" → *gemini*, "dameon" → *daemon*,
  "sotpped" → *stopped*, "ahvent" → *haven't*, "fo 2. do your lean btw A + B" → *for … between*.
- **Rule / Fix:** Infer from context and act; only confirm (in one clause, while continuing) when
  genuinely ambiguous. A misspelling is never a new concept.
- **Evidence:** `owner-turns-extracted.json` 03:00:01Z, 03:18:04Z, 02:56:31Z, 01:49:13Z, 02:12:14Z,
  17:04:23Z; `docs/audits/owner-turn-audit.md` §4(b).

### 8.3 Mechanism-suggestions must become architectural primitives, not literal commands
- **Symptom:** Aub names a means ("run paseo ls", "make a worktree", "we have like 20 profiles",
  "run as many lanes as you can") and agents obeyed literally instead of building the primitive.
- **Root Cause (How We Got Here):** The owner describes the outcome in mechanism terms he can see;
  there was no rule forcing the agent to translate mechanism → outcome. He asked for it outright:
  "is there any way to audit … where I'm suggesting an idea that works but there are commands or ways
  to do it better?".
- **Rule / Fix:** Propose the cleaner primitive and record the translation in the plan's **Decided**
  section (`paseo ls` → `vs who`; projects-folder cleanup → worktree sanctuary; 20 profiles →
  Role+Tier failover routing; "run as many lanes" → parallel-by-default lanes).
- **Evidence:** `docs/PLAN_BETTER_WAY_AUDIT.md`, `docs/PLAN_VS_WHO.md`, `docs/PLAN_WORKSPACES_CLEANUP.md`,
  `docs/PLAN_PROVIDER_CONTINUITY.md`; `owner-turns-extracted.json` 03:08:15Z, 03:10:54Z, 01:15:17Z.

### 8.4 Multi-item dumps need automatic parallel split + `@lane` routing
- **Symptom:** 3–4 distinct requests arrive in one message and got collapsed into one serial turn.
- **Root Cause (How We Got Here):** Aub dumps numbered lists ("1. … 2. … 3. …", "fo 2. do your lean
  btw A + B and 3. Go A", "Send all 3 to whatever relevant lanes already exist") and there was no
  split-and-route rule.
- **Rule / Fix:** Split multi-item messages into parallel units automatically and route each to its
  `@lane` handle; a short approval ("send it", "go for b", "a + a", "do it") is a terminal go-signal,
  not a request to re-summarize.
- **Evidence:** `owner-turns-extracted.json` 17:04:23Z, 16:52:52Z, 01:53:28.729Z, 19:09:09.200Z,
  03:48:42Z; `docs/audits/owner-turn-audit.md` §4(d), §5.

---

## Standing rules (quick reference)

1. Find the lead with `vs who lead` (labels `role`/`lane`/`ord`), never `paseo ls -g --json` or
   title-prefix regex.
2. Run unit work in `%LOCALAPPDATA%\VibeSquad\worktrees\<repo>\<unit>`; never
   `git worktree add ../<repo>-<unit>` into `projects/`.
3. Write JSON with node `fs.writeFileSync(..., 'utf8')`, never PowerShell `Set-Content`/`Out-File`
   (UTF-8 BOM breaks parsers).
4. Never end a turn just to wait on a background task: poll with a timeout or
   `paseo wait <id> --timeout <s>`.
5. Route by Role + Tier with automatic provider failover (Claude → Gemini → DeepSeek); never pin every
   profile to one provider.
6. Detach live children before archiving any agent (Paseo cascades archives to the parent's children).
7. Treat durable lane artifacts (`docs/lanes/<lane>/SPEC.md` + `docs/brainstorm/<lane>.md`) as the source
   of truth, not chat history.
8. Queue by default (never steer mid-turn): decode the owner's shorthand (`dameon`→daemon, `paseo la`→`paseo
   ls`, `btw`→between) silently, translate mechanisms into architectural primitives, and split multi-item
   dumps into parallel units routed to `@lane` handles — a short "send it"/"go for b" is a go-signal, not
   a request to re-summarize.
