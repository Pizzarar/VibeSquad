# Daemon health, Phase 1 findings (2026-11-05, Block 4, read-only)

Daemon 0.14.0, pid 13040 (supervisor) started 2026-11-05T20:54:55Z, launched by Paseo.exe (desktop-managed, parent explorer.exe). Server source read from `app.asar` (extracted copy in %TEMP%, nothing patched).
Note: `~/.paseo/daemon.log` only holds the current run (rotated logs `2026*-daemon.log` hold the earlier ones), so the "3,245" total is across all four files.

## 1. Agent bloat
- 2,082 agent JSON files under `~/.paseo/agents` (275 workspace dirs, 19 MB). Hard-delete path: `paseo delete <id>` (interrupts, then hard-deletes) and `src/paseoAgentOps.ts:10 hardDeleteAgent`. Use these, not `rm`.
- Rules applied: archivedAt set, last activity >7 days, not in `vs who` live list, not pinned, not role=lead/brainstorm.
- Counts: total 2082 / candidates 161 (368,853 bytes) / kept: not-archived 150, recent (<7 days) 1771, live 0, lead/brainstorm 0, pinned 0.
- The project is only ~5 weeks old, so most bloat is <7 days old. Deleting 161 files will not change `ls` speed. A 2-day cutoff would catch far more (not measured).
- `paseo ls` timings: 5.0 s, 3.2 s (baseline 4.4 s).
- List: `docs/research/daemon-prune-dryrun-2026-11-05.txt`.

## 2. `spawn git ENOENT` is NOT a PATH problem
- 35 distinct cwds across all logs; every one no longer exists on disk (deleted `.worktrees/unit-*`, `projects/efi-uilab*`). Node reports a missing cwd as `spawn git ENOENT`. Example (daemon.log): `"path":"git","spawnargs":["-c","core.quotepath=false",...,"rev-parse","--show-toplevel"]},"cwd":"C:\Users\Fugma\projects\efi-uilab","msg":"Git worktree discovery failed; treating directory as non-Git"`.
- Git is on the Machine PATH (`C:\Program Files\Git\cmd`); the User PATH has none. No env change is needed, so there is no env diff.
- Fix: remove the stale workspaces/projects that point at the deleted dirs (`~/.paseo/projects`, workspace list). Reversible only by re-adding them.

## 3. "paseo.json parse failures" are 5 s timeouts, not parse errors
- 655 hits in the current run. Message: `Failed to parse paseo.json; treating workspace as having no scripts` (server/script-status-projection.js:8), with `err.message = "Project config unavailable"`, thrown by `withTimeout(..., 5000, "Project config unavailable")` (utils/paseo-config-file.js:130).
- Top path: `C:\Users\Fugma\projects\VibeSquad\paseo.json` x400. That file does not exist (a missing file returns null, not an error). Others: worktree paths, `AppData\Local\Temp\lean-sbx`, etc.
- So the read queue (pLimit(2) fs slots, paseo-config-file.js:~75) times out while the loop is busy. Event-loop delay in metrics: p99 ~0.9-2.1 s, max 2.4 s.
- No file to fix or remove. The fix is upstream, or less load (fewer stale workspaces).

## 4. gh GraphQL "rate-limit loop" is a malformed-query bug
- 901 failures, all `gh: Expected NAME, actual: (none) ("") at [1, 35]`. `gh api rate_limit` now reports graphql 5000/5000, so it is not a rate limit.
- Column 35 is the end of the first line (`query PaseoBatchPullRequestStatus {`): the multi-line query is cut at the first newline. Cause: `@getpaseo/plugin/dist/server/process.js:16-23` runs a bare command (`gh`, `git`: no extension, no path separator) with `shell: true` on win32, and cmd.exe truncates args at a newline. Builder: services/github-service.js:~650.
- Poller: github-service.js:18-20 (`GITHUB_POLL_FAST_INTERVAL_MS` 20 s, slow 120 s, error backoff cap 300 s). No config switch or env var for it was found (grepped `process.env.PASEO_*` and config schema).
- Proposal: UPSTREAM_ISSUES entry (below). Local mitigation would be to make `gh` resolve to a full path, which needs a daemon change, so none.

## 5. Claude refresh timeout
- 11 occurrences, last 2026-11-05T20:44:53Z (before the 20:54Z restart); 0 in the current daemon.log. Not seen since the restart (about 12 min of uptime at check time).
- Code: providers/claude/agent.js:1171 wraps `resolveClaudeCodeVersion` (agent.js, `execCommand(..., "--version", { timeout: 5000, signal })`). The 5 s exec timeout did not end the call, so the 120 s deadline (agent/provider-refresh-deadline.js:44-49) aborted it. The error shows `abortChildProcess`, so the child was alive.
- Hypothesis (not proven): bare `claude` runs through cmd.exe (same shell:true path as item 4). On timeout only cmd.exe is killed, the grandchild keeps stdout open, and execFile never resolves. Needs `claude --version` to take >5 s under load to trigger.
- Plugin hook: `plugin/index.server.ts:798` `spawnSync("git", ...)` runs up to 4 times (3 s timeout each, ~12 s worst case) inside `before("agent.create")` (call at line 1566). It blocks the daemon loop during spawns. It can delay the 5 s timer but cannot cause a 120 s hang alone. Cheap mitigation: async spawn, or one git call instead of 4.

## Draft UPSTREAM_ISSUES entries (docs/UPSTREAM_ISSUES.md is gitignored; paste there)
- D1. Windows: bare `gh`/`git`/`claude` run with `shell: true`, so multi-line args (GraphQL batch query) are truncated at the first newline. 901 failed polls per few hours. Repro: `gh api graphql -f query=$'query X {\n rateLimit { limit }\n}'` via cmd.exe.
- D2. Missing cwd is reported as `spawn git ENOENT` with no cwd check; 73 warnings from workspaces whose dirs were deleted. Archive or skip workspaces with missing directories.
- D3. `Project config unavailable` is logged as "Failed to parse paseo.json" even when the file is absent or the cause is a queue timeout.
- D4. Possible orphaned `claude --version` child after the 5 s exec timeout on Windows (item 5 hypothesis).
