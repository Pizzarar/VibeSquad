# vibesquad 0.2.8 release record

| Field | Value |
| --- | --- |
| Project | vibesquad (Pizzarar/VibeSquad) |
| Version | 0.2.8 |
| Channel | stable |
| Commit | 542c2855cdc41a72a14a9e7b7e1a335e6b3b5453 |
| Requester | @bugc |
| Approval | _pending_ |
| Release URL | _pending_ |

## Changelog

### VibeSquad runs its own agents now (Paseo removed)
- Every agent runs on VibeSquad's own runner. Paseo is gone from agent prompts, the visible UI (Settings, Setup Checklist) and the relay. The `#offer=` relay pairing is removed. Native LAN/Meshnet pairing stays.
- Native schedules and heartbeats, terminals, workspace scripts, the live event stream, Web Push, and Codex/AGY/OpenCode adapters all run on the runner.
- The VS server and runner start at Windows login with no window (default on, with an off-switch in Settings).

### Runner: steady under load
- Each turn runs in its own process, and agents park a few seconds after a turn. Running turns are capped per provider family (Claude 12). Extra sends wait in a queue. **Your messages jump the queue**, and several queued sends to one agent merge into one turn.
- One runner per machine, owned by the VS server's supervisor. It sweeps orphaned processes at boot. Runner requests time out after 15s, and timed-out spawns recover.
- The runner restarts itself when its code changes, waiting until no turns are running. New: **Settings → Restart runner**.
- **Settings → Unstick VibeSquad** kills only stray processes, through the supervisor, and saves a snapshot log first.
- Gemini/AGY agents resume their session after being parked. Workers archive themselves after their final report and come back if you message them. Logs read incrementally, so big chats load fast.

### Chat
- Chats update live without a reload, including hidden tabs, background browser tabs and split panes. "Sending…" always clears.
- The live stream reconnects by itself (activity watchdog, revives when the tab is visible or back online). A failed first load retries.
- The Stop button stays enabled while the agent runs.

### Buddies, pins and plans
- Spin Up resumes a lost or parked Buddy in place, with the same chat and history. A chat that was archived by mistake opens again, read-only.
- A dormant or closed pin shows the profile picker. The first click on a new pin opens its Buddy. A Buddy can spawn its lane's lead when there's none.
- Plans mark each block "root cause or workaround", and reviewers ask "fix the cause or hide the symptom?". Built-in profile notes upgrade automatically when the shipped defaults change.
- Art lane: spawning the Painter or the Director starts the other half of the duet.

### Hub and UI
- New squad floor tower on the hub page. Squad-wide Needs-you queue. Usage dashboard: limits per provider with burn rate and time-to-cap, role split, and a lane table.
- Monogram team emblems. The pin ⋯ menu no longer gets clipped.

### Files and Terminal, including from a paired PC
- The Files panel works without Paseo and over a paired PC: tree, images, and file links (including links into lane worktrees).
- The owner can open a Terminal from a paired PC. Everyone else is refused.

### Release Desk
- Signing secrets live in Windows Credential Manager, never in argv or source. Staged release script and an automated audit. Windows Authenticode and Android keystore tooling are ready, but not active yet.

### Under the hood
- Tests can't touch your real `~/.vibesquad`. Runtime sync and shim guards. The full test suite is load-safe. Better spawn timing metrics.

Credits: all in-house.

## Audit

| Check | Result | Notes |
| --- | --- | --- |
| Tests | _pending_ | |
| Typecheck | _pending_ | |
| Dependency audit | _pending_ | |
| Secrets scan | _pending_ | |

## Artifacts (SHA-256)

_pending (filled at publish)_

## Signing

Windows: updater-signed (minisign) only, no Authenticode (owner waiver: no Azure cert yet; D5 tooling merged, inactive). Android APK: not built (keystore rotation pending).

## Signature verification

_pending_
