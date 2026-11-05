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


## Phase 2 (b): stale workspaces (dir missing, not archived)
Backup: ~/.paseo/projects.bak-20261105. Removal via `paseo workspace archive <id>` (supported CLI). 91 workspaces, 0 pinned; 4 hold unarchived agents, all status `closed` (dirs gone). All paths confirmed absent with fs.existsSync.

| workspace id | project id | path | exists | enoent-logged | open agents |
|---|---|---|---|---|---|
| wks_ee0baf949cc1b86e | prj_38915ba4896214c2 | C:\Users\Fugma\projects\efi-uilab | no | true | 4 |
| wks_867c18be54855f9f | prj_68efcd9ae325b68e | C:\Users\Fugma\projects\efi-uilab-h6 | no | true | 0 |
| wks_c011124d29dff3ec | prj_2633cdbc8cef3585 | C:\Users\Fugma\projects\efi-uilab-h7 | no | true | 0 |
| wks_ec2d1664b26727f9 | prj_80e3a5ad89da3c8a | C:\Users\Fugma\projects\efi-gemini-pass | no | false | 0 |
| wks_cfca77e0f6dc285e | prj_4b7b5fecaa772d7f | C:\Users\Fugma\projects\efi-uilab-rx3 | no | true | 1 |
| wks_94f9b20b50fc6a22 | prj_243af2e161a33779 | C:\Users\Fugma\projects\efi-uilab-k1 | no | true | 0 |
| wks_a69e1d43809e4e5f | prj_fec6394ea71a8e15 | C:\Users\Fugma\projects\efi-uilab-rx3-rv | no | false | 0 |
| wks_4950a69e82c4221f | prj_579e1c81852e6c30 | C:\Users\Fugma\projects\efi-uilab-artb1 | no | true | 0 |
| wks_02cdf987a454cbf9 | prj_38915ba4896214c2 | C:\Users\Fugma\projects\efi-uilab | no | true | 1 |
| wks_386a39c283d9ea55 | prj_38915ba4896214c2 | C:\Users\Fugma\projects\efi-uilab | no | true | 1 |
| wks_bf386731d4ac758b | prj_aaf55cf62b9a9e35 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-identity-v2 | no | true | 0 |
| wks_881d826ad6808a96 | prj_aaf55cf62b9a9e35 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-identity-v2 | no | true | 0 |
| wks_4bd890c1be9ed3ae | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_feb9c1f44952fdd9 | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_885dff67fa10f941 | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_99904686bc41e309 | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_f9f7a322feb564ea | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_a0c0e72d2171798f | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_eb541717278e5fdc | prj_0f275fb9a0984c71 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-quickstart-lane | no | true | 0 |
| wks_d662125cf87210eb | prj_5f97b66ca2ff25c5 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-public-ac | no | true | 0 |
| wks_5cf0038be8d3766a | prj_5f97b66ca2ff25c5 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-public-ac | no | true | 0 |
| wks_3e301b9c55087081 | prj_5f97b66ca2ff25c5 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-public-ac | no | true | 0 |
| wks_8893bb757a64167b | prj_5f97b66ca2ff25c5 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-public-ac | no | true | 0 |
| wks_ad9c04541406e654 | prj_44ffe39ae5eb353b | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-grid | no | true | 0 |
| wks_d6c12c54d38a9c85 | prj_a2bbfc2d41a76485 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-resolver | no | true | 0 |
| wks_3e96d26d9a8e5a34 | prj_1cdde32a27ef7b6e | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-pack | no | true | 0 |
| wks_8f8fbada760fba35 | prj_a2bbfc2d41a76485 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-pins-resolver | no | true | 0 |
| wks_de4d1bf421a1e12c | prj_a2bbfc2d41a76485 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-pins-resolver | no | true | 0 |
| wks_194e91ae9216d687 | prj_1cdde32a27ef7b6e | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-pack | no | true | 0 |
| wks_b54b7e90616895fe | prj_44ffe39ae5eb353b | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-grid | no | true | 0 |
| wks_a295a5e581a0919f | prj_a2bbfc2d41a76485 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-resolver | no | true | 0 |
| wks_dfee841da8536a14 | prj_a2bbfc2d41a76485 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-resolver | no | true | 0 |
| wks_33ae364151a15275 | prj_44ffe39ae5eb353b | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-grid | no | true | 0 |
| wks_3507f2877fafd7f4 | prj_44ffe39ae5eb353b | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-grid | no | true | 0 |
| wks_32146be9358fa851 | prj_358312fc082e5f73 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-rail | no | true | 0 |
| wks_3610a08b10abfe27 | prj_c41dc073d8ff2beb | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-done | no | true | 0 |
| wks_620e68bdf386df5d | prj_1cdde32a27ef7b6e | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-pack | no | true | 0 |
| wks_ac5cff874335f4c2 | prj_c41dc073d8ff2beb | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-done | no | true | 0 |
| wks_924b9efb6789dc9f | prj_c41dc073d8ff2beb | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-done | no | true | 0 |
| wks_709c3516d370011d | prj_358312fc082e5f73 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-rail | no | true | 0 |
| wks_fc2066eec8beb5c2 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_4c195d6488e68f99 | prj_2f709ea7f3f17c9e | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-a | no | true | 0 |
| wks_dfc6c9073a7cfe0d | prj_f0be6714cf115a80 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-b | no | true | 0 |
| wks_bf06c25c0b34622d | prj_c41dc073d8ff2beb | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-done | no | true | 0 |
| wks_f076d06f02f62f11 | prj_25e187b6709659a7 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-ideas | no | true | 0 |
| wks_bb741ce788280b65 | prj_850751a504038bd1 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-c | no | true | 0 |
| wks_1a52cb83f323515d | prj_f0be6714cf115a80 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-b | no | true | 0 |
| wks_a74b5d45df384be6 | prj_1be6c1ee58dfb156 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-e | no | true | 0 |
| wks_718c45ccc5f3dc92 | prj_2d27994f81ef7173 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-d | no | true | 0 |
| wks_4bad58de2f33495f | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_ef1099dbe2a426a7 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_8f293662fb940693 | prj_358312fc082e5f73 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-rail | no | true | 0 |
| wks_e89225ac69e5d472 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_f6e1a8258a0b54ab | prj_c41dc073d8ff2beb | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-done | no | true | 0 |
| wks_e4d3442cd5c1f11e | prj_ccdf72ff5062d5e7 | C:\users\fugma\projects\VibeSquad\.worktrees\pins-walk | no | true | 0 |
| wks_81bb1f422fdfd88d | prj_ccdf72ff5062d5e7 | C:\Users\Fugma\projects\VibeSquad\.worktrees\pins-walk | no | true | 0 |
| wks_79c375d7673ce64f | prj_25e187b6709659a7 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-ideas | no | true | 0 |
| wks_bd666a45dd84124f | prj_ccdf72ff5062d5e7 | C:\users\fugma\projects\VibeSquad\.worktrees\pins-walk | no | true | 0 |
| wks_27de3e3f38a0ddc9 | prj_25e187b6709659a7 | C:\users\fugma\projects\VibeSquad\.worktrees\unit-pins-ideas | no | true | 0 |
| wks_daa3dbc149d3a505 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_d8def8273a411f43 | prj_1f216fbd98f05a4a | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-i | no | true | 0 |
| wks_35e29989a963a5cf | prj_bece16e91dde686c | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-f | no | true | 0 |
| wks_10b22407113da9ae | prj_67d8dc98e0726c28 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-g | no | true | 0 |
| wks_5c9871f5a5449a72 | prj_5bb9e842d3a00cd7 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-ade-h | no | true | 0 |
| wks_d54e0b34e7d1b4dc | prj_cfb9a927cd0c5008 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-buddy-retire | no | true | 0 |
| wks_d3b3fac464e9f2e9 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_2eea0ef190253ac0 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_e0df4dbd41887724 | prj_a4d93e6487d58d84 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-art-painter-director | no | true | 0 |
| wks_249f486a2d3149b4 | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_f0204f713293078d | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_8982839050fd0b62 | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_3c798551207c869d | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_1931a7eac8a5216e | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_da244c4a69c4fc98 | prj_0a15e94aabd9f389 | C:\Users\Fugma\projects\VibeSquad-spawn-speed | no | true | 0 |
| wks_0d0edc026c935064 | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_923fe4249cd8fc6c | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_7a5fecaf91746bc7 | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_71c356ef386c1862 | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_e181e12c8efe7783 | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_01948aca40f6f862 | prj_75215015f1461521 | C:\Users\Fugma\projects\zz-timing-sandbox | no | false | 0 |
| wks_7a2b7f472bb73385 | prj_e415f160251cef69 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-parity-b2 | no | true | 0 |
| wks_3fa4c069cf36ca60 | prj_e415f160251cef69 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-parity-b2 | no | true | 0 |
| wks_f164055dc4404e64 | prj_c8a4649481cce019 | C:\Users\Fugma\AppData\Local\Temp\zz-auto-buddy-525Woz | no | false | 0 |
| wks_6b9567c1f1c97790 | prj_be14960aa05e4a9a | C:\Users\Fugma\AppData\Local\Temp\zz-auto-buddy-v0NOlr | no | false | 0 |
| wks_9c016df580b05e53 | prj_66e13f4195e84471 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug-buddy-hub | no | true | 0 |
| wks_5a73174c9f2f749c | prj_66e13f4195e84471 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug-buddy-hub | no | true | 0 |
| wks_4fffeb9c4288218a | prj_07f19aeb7600b0c5 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug5-coord-e2e | no | true | 0 |
| wks_300eed78ad6d8a4f | prj_07f19aeb7600b0c5 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug5-coord-e2e | no | true | 0 |
| wks_8fb37b45e0a636ea | prj_70cf333d6c26dc89 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug6-token-meter | no | true | 0 |
| wks_645867fdc2c8f66b | prj_70cf333d6c26dc89 | C:\Users\Fugma\projects\VibeSquad\.worktrees\unit-bug6-token-meter | no | true | 0 |
| wks_d8f63d90bc20ec32 | prj_734dccda8cd0a9d3 | C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-uip-u16b-reconcile | no | true | 0 |

## Phase 2 result
- Archived all 91 stale workspaces with `paseo workspace archive` (88 on the first pass; 3 timed out: wks_ee0baf949cc1b86e, wks_867c18be54855f9f, wks_c011124d29dff3ec; the session was cut by the 21:34:42Z daemon restart and re-check at 21:48Z showed 0 un-archived workspaces with a missing directory). Backup: `~/.paseo/projects.bak-20261105`.
- `spawn git ENOENT`: 29 in the 10 min before the change (daemon.log, ~21:2x Z). After the change and restart: 0 between 21:35Z and 21:48Z (last one logged 21:33:37Z).
- Agent prune (a): NOT done, per Buddy; dry-run list kept.
- Upstream entries D1-D4 are in the main checkout `docs/UPSTREAM_ISSUES.md` (gitignored).
