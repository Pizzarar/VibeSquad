# Release record: VibeSquad v0.4.0 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.4.0 |
| Channel | stable |
| Frozen commit | `d8881601` + `d6c23109` (test-only win32 fix for `test-tmp-preflight`) + `a1ef3fd8` (build-desktop win32 Path fix) + `d21f8dbf` (Rust path remap + host-path scan) + `d7ea070d` (auto-update test fix) + `62b7f10f` (storybook-marks race fix); re-frozen from `b219e906`, then `405779e6` |
| Release commits | `a95a4f53` (version bump, record, licenses), merge of master `405779e6`, `11a2ea14` (lockfile, credits format, record), then merges of `d8881601` on `release/vibesquad-0.4.0` |
| Requester | Release Desk lead Rele7 (rn-8a7d68a8714e) |
| Approval | the owner; publish is ordered by the desk lead, not by this record |
| Release URL | _pending (P3)_ |
| Range | `v0.3.0..a7124d7f` (release branch at the `62b7f10f` merge, before this record commit): 2231 commits, 774 merges |

Windows only. No Authenticode (no Azure Trusted Signing yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. `latest.json` is Windows-only. No Android APK is built or attached.

Excluded from this freeze: usa-70 (`83c2ed98`) was pushed to master after the route-protection merge and is not in this release.

## Tests
_pending (P2/P3)_

## Build
_pending (P2/P3)_

## Artifacts (SHA-256)
_pending (P2/P3)_

## Audit B1-B9
_pending (P2/P3)_

| Commit | Check | Result | Evidence |
| --- | --- | --- | --- |
| `d21f8dbf` | B2 Rust host-path fix (Tier A security) | PASS 0/0/3 | Review-Gemini rn-16d541524244, `vs verdict` exit 0 |
| `d7ea070d` | auto-update source check accepts remap cargo args (test-only) | PASS 0/0/0 | Review-Sonnet rn-1f0cc1db88a0, `vs verdict` ok |
| `62b7f10f` | storybook-marks race fix, idea-1216 (test-only) | PASS 0/0/1 | Review-Gemini rn-4086d8d7c4bc, `vs verdict` ok; Low: `pollUntil` drops the last thrown error, non-blocking |

## Findings
- `auto-update:96` was a regression from `d21f8dbf`: the release-path test list omitted `test/auto-update.test.mjs`, so the Rust remap change was not caught. Fixed by `d7ea070d` (the source check accepts the remap cargo args). The release-path test list is now kept in `docs/lanes/release-desk/SPEC.md` (on master, not on this branch).
- `storybook-marks:446` (idea-1216) was a test-only race: a fixed 400 ms wait against an auto-commit that takes 1.2-2.7 s on Windows (root cause rn-e906882f1a4a). Fixed by `62b7f10f` (the test polls for the auto-commit). It is no longer listed as a known flake.
- **B2 Medium (fixed):** the Rust binary embedded about 1,001 `C:\Users\<user>\.cargo\registry` paths (build-host username in panic and debug strings). Fixed by `d21f8dbf`: release Rust builds remap host path prefixes and a fail-closed post-build scan refuses any artifact that still contains a host path. The Buddy ruled it a fix, no waiver.
- Past public installers v0.2.0-v0.3.0 carry the same leak. Owner-only finding; no released assets were touched.
- Windows release build regression from `bf4633ad` (Path lost, so `npm.cmd` ENOENT), fixed by `a1ef3fd8`. Review-Gemini PASS 0/0/2 rn-a10ae7fc1087 (Lows: a trailing `;` and the cargo bin dir not deduped in Path, both harmless, queued).
- Licenses file: Windows-generated (`public/THIRD-PARTY-LICENSES.txt`, 101679 bytes, no CRLF, sha256 `2bcb8a72...6471`). Privacy grep clean (only the crate names signal-hook-registry and windows-registry match). Same 596 unique package@version as before (0 dropped, 0 added), 11 duplicate headers collapsed, 158 bare headers now licensed. credits-attribution, public-release and one-stop-installer 37/37 with it (pre-check rn-4be985923903). Determinism follow-up: idea-1234.
- `d6c23109` audit: Review-Sonnet PASS 0/0/0 rn-172769f01a2f. Delta `d8881601..d6c23109` = 1 file, `test/test-tmp-preflight.test.mjs` +6/-2, nothing shipped (Buddy-verified).
_pending_

## Release notes
# VibeSquad v0.4.0

Windows installer, updater-signed (minisign). Not Authenticode-signed yet, so SmartScreen may warn. No Android build in this release.

**Behaviour changes to know about (no flag was removed, but these contracts tightened):**
- `vs restart` requests can be queued for the next fixed restart window (13:00Z / 21:00Z, `VS_RESTART_WINDOWS`) instead of restarting at once; owner Restart Runner no longer cancels busy turns and waits until the runner is idle.
- The merge/push gate now refuses a branch with a FAIL or missing review verdict, and fails closed when a verdict cannot be read. Scripts that pushed or merged without a recorded `vs verdict` will be refused.
- Desktop remote CA pinning fails closed: a remote connection without a verified fingerprint is refused.
- A wrong or stale `server.pid` is no longer trusted (see Desktop).

- `node server/release.mjs` now validates its arguments before doing anything: `--help` prints usage and exits 0, an unknown flag, stray argument or missing value exits 2, and a bare run without `--channel` is refused.
- The verdict gate classifies reviewers by profile and role labels (fail-closed) before falling back to the title.

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
- New Normal-mode "Needs you" concept page and refreshed How-it-works docs (Restart runner busy gate, roles and tier ladder, Crunch mode, 70% soft line, Decision Desk); Crunch-mode and Decision Desk polish; three Normal-mode overlap and contrast fixes.
- Normal mode redesign: new design tokens, calmer chat header, container-aware composer, sleek dashboard with Overview tabs, Cards or Map lane map, living restyle with self-hosted fonts.
- Needs-you attention spine: one count across tab title, favicon and badges, a location line per item, stalled workers shown distinctly, single-click Interrupt.
- Decision Desk cards show option definitions and a source excerpt; a decisions feed and batch answer API for the owner.
- Back/Forward follows the URL; deep links for lanes and roles; Squad badges and a cross-Squad Needs-you list in Psycho mode.
- Owner-facing times are written in US Eastern.

### Routing, roles and usage
- A third Implement arm (Gemini Carbon) joins the Sonnet/Neon alternation for normal-stakes work and shares the Neon cap and soft line; UX Review is its own top-tier role.
- Credit guard refreshes every 30 minutes with a single poller; the card shows the remaining balance, currency threshold and a stale tag.
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

### Windows and tooling
- The route label (`vs.route`) can now only be set by the spawn hook: an agent patching its own metadata gets 403, and a caller-supplied value is dropped before the spawn hook runs.
- `npm test` checks its temp directory first (probe write and 256 MB free) before taking the suite slot; `VS_TEST_TMPDIR` overrides it, and a path inside the VibeSquad home is refused.
- The mesh TLS chain test is Windows-safe (OpenSSL client resolution, Godot `.cmd` shim, loopback probe), and the Normal-mode composer-order browser test waits for settled layout instead of flaking.
- Windows-only test and guard failures fixed for this release: the git guard keeps bash backslashes inside double quotes and maps Git Bash `/c/` and `/cygdrive/c/` paths on Windows.
- Storybook source modules were renamed internally (`*Marks/Guide/Progress.ts` to `*Logic.ts`) so Windows no longer resolves the Storybook components to the wrong file; a guard test blocks new case clashes.
- The runner refuses to start an agent whose worktree was removed ("worktree removed: <path>") and keeps a resumable one parked, with no provider fault or failover.
- The Godot export gate finds the newest `godot-4.*` (template-bearing first) and honours `GODOT_BIN` / `GODOT_PATH`.

### Phone and remote
- The Godot addon pairs with real VibeSquad installs: it loads the name-constrained CA correctly and the mesh HTTPS listener sends the leaf certificate only.
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
