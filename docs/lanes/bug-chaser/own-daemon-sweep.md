# Own Daemon sweep (idea-800, 2026-11-25)

`docs/lanes/own-daemon/` is **untracked** in the main checkout (not in git), so SPEC.md and TASKS.json were not edited. This file is the result. Lane closed by owner 11-24: the VS runner is the daemon.

All 7 TASKS.json units still read `todo` (file last touched 2026-11-05), but the code shows most shipped.

| Unit | Verdict | Where |
|---|---|---|
| own-1-seam (AgentBackend seam) | adopted (shipped) | server/backend/index.mjs, runner-backend.mjs |
| own-2-runner (runner spike) | adopted (shipped) | runner/runner.mjs, runner/adapters/claude.mjs, acp.mjs |
| own-3-runnerbackend | adopted (shipped) | server/backend/runner-backend.mjs, runner-client.mjs, runner-lifecycle.mjs |
| own-4-mcp (VS MCP + Paseo aliases) | adopted (shipped) | server/mcp/server.mjs, server/mcp/tools.mjs:1113 (alias map, hits logged as metrics) |
| own-5-catchfix (alias removal at 0 hits) | dropped as a separate item | aliases still exist at server/mcp/tools.mjs:1113-1129. Removal is routine cleanup; needs its own card only if wanted. |
| own-6-adapters (Codex/AGY/OpenCode) | adopted (partly) | runner/adapters/acp.mjs covers ACP providers; no per-provider native adapters, by design ("native only if ACP fails") |
| own-7-cutover (retire Paseo) | adopted | `plugin/` and `plugin-screens/` no longer exist in the repo; cutover commits e.g. 7df59613. Owner's 11-24 close confirms. |

SPEC done-checks 1-7 are superseded by the closure. Remaining Paseo leftovers (alias map, Paseo-shaped inputs) fall under own-5 and are dropped unless a card is opened.
