# Z1 / idea-515: reap a worker's leaked dev servers (WIP handoff)

## Root cause (seen live 11-21)
The leaked process was node vite :5199, with this parent chain: cmd, then node npx, then bash, then bash, then a dead tool shell. The agent ran `npx vite &`. Its tool shell exited, so the parent chain ends at a dead pid. park and exit kill the CLI's tree with taskkill /T, which follows live parent links only, so that kill never reaches the server.

## Fix
- `runner/reap.mjs`
  - Proof: the listener's env carries this agent's VS_AGENT_ID plus sha256(VS_AGENT_TOKEN). The token is minted per agent for each runner lifetime. The env is read from the process's PEB through Add-Type C# on Windows, and from /proc/<pid>/environ on Linux. Only a hash is printed, never the token.
  - Kill target: the root is the topmost live ancestor that also carries the token. Its descendants are collected through valid links only (a child must be created after its parent). The exact pids are re-dated asynchronously right before the kill, then killed with `taskkill /F /PID ..`. The kill does not use /T, because /T trusts stale parent ids.
  - Fail closed: held or protected pids (the listener itself, an ancestor, or anything in the tree), an unreadable env, a token mismatch, an undated process, a process created after the end, a live CLI, a VS runtime command line, the agent being live again, or the runner shutting down. Each skip is reported with its reason.
- `runner/runner.mjs`
  - `_reapAfterEnd` runs `reapDelayMs` (3 s) after park, the archive stop or exit. It covers role=worker only.
  - Protected pids: every live agent's heldNow/heldWork/work, this entry's own last hold, the runner's pid and its parent's pid.
  - `_tokenAt` records when each token was minted. It is the lower bound, so boot-time services are never read.
- `runner/server.mjs`
  - `reapReporter`: one `{reap:...}` line in runner.log, plus one team-log `metric` for each reaped listener (agent, pid, port, redacted cmd).
  - `VS_RUNNER_REAP=0` turns the reap off. It runs on win32 and linux only.

## Tests
`test/runner-reap-devservers.test.mjs`: 15/15 pass. The real-process done check took about 38 s on Windows. `test/drain-held-truth.test.mjs`: 11/11 pass.

## Open / for review
- Cost: one reap runs about 7 s of PowerShell for the snapshot (Get-NetTCPConnection plus CIM) and about 3 s for the env read, on every worker park. It is async and reaps that land together share one snapshot, but it may need a gate.
- `reapCmdText` redacts a full script path as a single token, so the report reads `node <host-path> --port 5199` and loses the `vite` name. Consider keeping the basename.
- MSYS bash processes don't expose their env in the Windows PEB, so the root climb stops at npx node. The bash parents should exit on their own once their child is dead. This was not live-verified after a reap.
- WOW64 (32-bit) processes are skipped as `env-unreadable:wow64`.
- macOS is not supported, so no reap runs there.
- Not proven: a process that copies another agent's env on purpose. Same-user memory access is the accepted limit (SECURITY.md).
