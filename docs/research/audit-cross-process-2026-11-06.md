# Cross-process guard audit (machine-wide resources) — 2026-11-06

Read-only audit. Question: which guards on machine-wide shared state are only *per-process*, so two VibeSquad
processes could both pass the guard at once? Branch `unit-run-audit-xproc`.

**Actors that write shared state in `~/.vibesquad`:** the VS server (single instance — `serve.mjs:433-438`
binds the port and a second launcher exits 0 on `EADDRINUSE`), the runner (single per home — covered below),
the CLI `cli/vs.mjs` (a separate process per invocation), and test runs (fenced off — covered below).

## Findings

| resource | guard (file:line) | per/cross-process | race scenario (A + B + steps) | sev | suggested fix |
|---|---|---|---|---|---|
| `~/.vibesquad/inbox.json` | none — `writeInboxCards` is a plain `writeFileSync`, no lock/rename/revision (`server/inbox.mjs:66-72`); IDs from max-scan (`:394-404`) | cross-process (server + `vs inbox` CLI, `cli/vs.mjs:797,843,851,865`) | A=server `POST /inbox` reads cards; B=`vs inbox add "x"` reads cards; A appends+`writeFileSync`; B appends+`writeFileSync`. Last writer wins, A's card silently lost; both may mint `idea-N` → duplicate ids | H | write tmp+`renameSync` and gate with an O_EXCL lockfile (or route all inbox writes through the server API) |
| `~/.vibesquad/teams.json` (CLI `vs pin` path) | server path is atomic + 409 (`server/vibesquad-api.mjs:460-461,497-498`), but CLI writes tmp+rename with re-read-only, no revision check (`cli/vs.mjs:1531-1532,1606-1607,1641-1643`) | cross-process (server vs `vs pin`) | A=server PUT teams (rename); B=`vs pin new` reads teams.json, appends lane, rename. B's snapshot predates A; A's change dropped | M | CLI sends `revision` and honors 409, or write via the server's `handleTeams` |
| `~/.vibesquad/capped-providers.json` | `setProviderCapped` non-atomic `writeFileSync` (`server/provider-failover.mjs:340`); CLI `writeCappedProviders` non-atomic (`cli/vs.mjs:1922`); only `pruneExpiredCapsFile` is atomic (`:221-233`) | cross-process (server quota failover vs `vs cap`) | A=server caps `claude` (reads caps); B=`vs cap gemini` reads caps; both write, one cap lost — capped provider can pass quota gate | M | tmp+rename + re-read-before-write in `setProviderCapped`/CLI (parity with `pruneExpiredCapsFile`) |
| `docs/lanes/*/TASKS.json` + `SPEC.md` | `upsertLaneTask` read-modify-write + non-atomic `writeFileSync` (`server/lane-spec.mjs:81-118`, write at `:116`); `writeLaneSpec` non-atomic (`:47-54`) | cross-process (server + `vs task set`, `cli/vs.mjs:1893`) | A=`vs task set u1 --status done` reads units; B=server writes u2; A merges u1 over stale list, writes — u2 change lost | M | tmp+`renameSync` (and merge on re-read) |
| `~/.vibesquad/teams/<t>/log.jsonl` + `logs/<t>--<l>.jsonl` | no cross-process lock; three writers `appendFileSync` the same file: server `appendVsLogEntry` (`server/brainstorm.mjs:215,220`), CLI `appendLog` (`cli/vs.mjs:427,431`), runner metric (`server/backend/runner-backend.mjs:289`) | cross-process (server + CLI + runner) | A=`vs log` appends line; B=server appends line concurrently; Windows `appendFileSync` is not guaranteed line-atomic → interleaved/corrupt line | L | single writer (route `vs log` through server), or O_APPEND with a documented line-atomic contract |
| `~/.vibesquad/teams/<t>/cursors.json` | `writeCursors` non-atomic; `setCursor` re-read-before-write (TOCTOU) (`cli/vs.mjs:443-454`) | cross-process (two `vs log`/agent processes) | A and B both `setCursor`; both read same cursors, write; one cursor update lost | L | tmp+`renameSync` (or merge-on-write) |
| `~/.vibesquad/settings.json` | write is atomic (`server/user-settings.mjs:152-170`) but `saveUserSettings` read-modify-write is last-writer-wins on non-merge fields (`:232-255`) — only `dismissedCards` is merged | cross-process (server + mesh/second device) | A sets `userName`; B sets `lanEnabled`; B's snapshot predates A; A's `userName` dropped | L | merge every field the way `dismissedCards` is, or add a revision check |
| `~/.vibesquad/vapid.json` / `push-subs.json` | `getOrCreateVapidKeys` `existsSync`+`writeFileSync` TOCTOU (`server/push.mjs:35-66`); `writePushSubscriptions` non-atomic (`:227-233`) | cross-process (two launchers) | A and B both see no `vapid.json`, both generate keypair, both write — subscribers under A's key stop receiving | L | `flag:"wx"` for key create; tmp+rename for subs |

Severity tally: **1 H, 3 M, 4 L.**

## Covered already (not findings)

- **One runner per home** — `runner/lock.mjs` (`tryCreateLock` O_EXCL, `acquireRunnerLock` pid-alive + `/health`), `runner/server.mjs` (`acquireRunnerLock` + `holderHealthy`, discovery `runner.json`/`token`), and the cross-process start lock in `server/backend/runner-client.mjs:222-256` (`acquireStartLock` on `starting.lock`, stale after `STALE_START_LOCK_MS`).
- **One VS server** — `server/serve.mjs:433-438` (port bind; `EADDRINUSE` + `isListening()` → exit 0).
- **Test isolation / one npm test at a time** — `server/test-guard.mjs` (`underTestRunner` → `isForbiddenRealHome` / `isForbiddenRepoTeams` fail closed to a temp `VIBESQUAD_HOME`).
- **teams.json server write** — `server/vibesquad-api.mjs:460-461` (revision 409) + `:495-498` (tmp+rename).
- **settings.json corruption** — `server/user-settings.mjs:152-170` (`writeSettingsAtomic`: unique tmp + rename + EPERM/EACCES/EBUSY retry).
- **provider-failover prune** — `server/provider-failover.mjs:221-233` (re-read before write + tmp+rename).
- **git / worktree ops** — `server/team-worktrees.mjs` shells out to git, whose own `.git/index.lock` / worktree locks arbitrate across processes.

## Top 3 to fix next

1. **`inbox.json`** (H) — user idea data lost on concurrent add/triage; add O_EXCL lock or tmp+rename+revision, and route `vs inbox` through the server.
2. **`teams.json` CLI `vs pin` path** (M) — bring the CLI up to the server's revision/409 parity so a pin never clobbers a server save.
3. **`capped-providers.json`** (M) — make `setProviderCapped`/CLI write atomic like `pruneExpiredCapsFile`; a dropped cap lets an over-quota provider through.
