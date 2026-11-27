# Release record: VibeSquad v0.4.0 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.4.0 |
| Channel | stable |
| Frozen commit | `b219e906` (master) |
| Release commits | one `release: vibesquad 0.4.0 (stable) ...` commit on `release/vibesquad-0.4.0` (version bump, this record, licenses) |
| Requester | Release Desk lead Rele7 (rn-8a7d68a8714e) |
| Approval | the owner; publish is ordered by the desk lead, not by this record |
| Release URL | _pending (P3)_ |
| Range | `v0.3.0..b219e906`: 2135 commits, 738 merges |

Windows only. No Authenticode (no Azure Trusted Signing yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. `latest.json` is Windows-only. No Android APK is built or attached.

## Tests
_pending (P2/P3)_

## Build
_pending (P2/P3)_

## Artifacts (SHA-256)
_pending (P2/P3)_

## Audit B1-B9
_pending (P2/P3)_

## Findings
_pending_

## Release notes
# VibeSquad v0.4.0

Windows installer, updater-signed (minisign). Not Authenticode-signed yet, so SmartScreen may warn. No Android build in this release.

**Behaviour changes to know about (no flag was removed, but these contracts tightened):**
- `vs restart` requests can be queued for the next fixed restart window (13:00Z / 21:00Z, `VS_RESTART_WINDOWS`) instead of restarting at once; owner Restart Runner no longer cancels busy turns and waits until the runner is idle.
- The merge/push gate now refuses a branch with a FAIL or missing review verdict, and fails closed when a verdict cannot be read. Scripts that pushed or merged without a recorded `vs verdict` will be refused.
- Desktop remote CA pinning fails closed: a remote connection without a verified fingerprint is refused.
- A wrong or stale `server.pid` is no longer trusted (see Desktop).

### Desktop
- The desktop app checks that `server.pid` points at a live node process before trusting it; a stale file is removed (idea-373), in both the JS and Tauri sides.
- Remote CA pin fails closed without a verified fingerprint; duplicate constant-time compare removed from the desktop build (idea-525).
- Meshnet CA stays put across LAN-IP changes; pairing prefers the Meshnet IP.
- Android and PWA launcher icons now match the Windows VS mark.

### Linux and forge hosts
- VibeSquad can now run on a Linux host (forge): systemd user unit and bootstrap script, runtime directory helper, POSIX process groups and tree kill, POSIX listener-pid lookup, login-shell PATH repair, Linux-aware browser opening, and `vs restart` through `systemctl --user`.
- Forge transport runs over NordVPN Meshnet (Tailscale accepted as transport only); off-loopback servers are TLS-only with per-client CA trust steps in the runbook.
- Windows stays the default and first-class install.

### Storybook
- New Storybook for game text review: project snapshot API and `vs` commands, per-entity sheets, Review search and speaker filter, unlock/play-order arcs, Glossary tab and cohesion checks, what-changed view, placeholder-to-final progress bars, and a phone-shell entry.
- Marks (OK / Redo / Edit) write to a review worktree branch, never main; notes never touch the shared template.
- In-app how-to guide (8 steps) with jumps to real tabs; sign-off, unreviewed and problem counts follow the live marks.

### Playtest overlay (VSPlaytest)
- Godot addon: dock chat and F9 click-to-point capture that posts a report and thread to VibeSquad.
- Owner-playtest device role with a route allowlist, a Playtest-only pair view and pair UI, and tester streams capped per device.
- Release export gate strips the addon from shipping builds; runtime debug bridge uses godot-mcp-runtime.

### Normal mode and Decision Desk
- Normal mode redesign: new design tokens, calmer chat header, container-aware composer, sleek dashboard with Overview tabs, Cards or Map lane map, living restyle with self-hosted fonts.
- Needs-you attention spine: one count across tab title, favicon and badges, a location line per item, stalled workers shown distinctly, single-click Interrupt.
- Decision Desk cards show option definitions and a source excerpt; a decisions feed and batch answer API for the owner.
- Back/Forward follows the URL; deep links for lanes and roles; Squad badges and a cross-Squad Needs-you list in Psycho mode.
- Owner-facing times are written in US Eastern.

### Routing, roles and usage
- Roles-only routing: pick a role and stakes, the ladder picks the model; role and ladder editors, provider-grouped override, spawn results and chips show role, model and reason.
- Per-family soft quota line (70%): above it only interruptible work runs; mechanical work routes to cheap models first.
- Usage dashboard: burst cohort table, per-model quality table (first-try pass, fix rounds, cost per unit), limit cards show when they were last sampled, DeepSeek credit poll, cap handling that never lapses without a reset time.
- Gemini model ids move to the current top model from one source of truth.

### Agents, runner and CLI
- Runner reaps an ended worker's leftover processes; drains refuse and track detached background work.
- `vs who` roster no longer re-folds while booting; `vs watch` reads the final report of an archived worker; `vs profiles` lists roles with their ladder rungs.
- Provider-neutral worker git shim first on PATH; `vs task`/`spec` write the caller's linked worktree.
- Compact-first handling at each context threshold for leads and Buddies; long-turn tracking per lane and role.
- Child ledger writes are single-writer and monotonic; digest no longer writes duplicate done entries.

### Phone and remote
- Phone Cockpit gains a Bugs tab and a Storybook entry; From GitHub allowed for paired remote devices.
- Relayed worker reports keep every line and only replace host-path tokens.

### Quality
- Many suites made hermetic (no real home, temp dirs cleaned up), ~20 Linux browser cases now run instead of skipping, and flaky timing tests use load-scaled waits.

### Credits
- Implemented Normal Mode UX redesign (desk D1-D2: tokens, measure, NEEDS YOU attention spine) — Thanks to Antigravity by Google DeepMind
- Implemented runtime debug bridge — Thanks to godot-mcp-runtime by Erodenn
- Implemented Normal-mode self-hosted typography — Thanks to Plus Jakarta Sans by Tokotype and IBM Plex Mono by IBM
- godot-mcp-runtime by Erodenn (Owen Sterling), MIT: external dev tool for Godot playtest debugging, not vendored in this repo.
- Runner-era orchestration: originally built on Paseo by getpaseo.
