# Release record: VibeSquad v0.4.0 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.4.0 |
| Channel | stable |
| Frozen commit | `d8881601` + `d6c23109` (test-only win32 fix for `test-tmp-preflight`) + `a1ef3fd8` (build-desktop win32 Path fix) + `d21f8dbf` (Rust path remap + host-path scan) + `d7ea070d` (auto-update test fix) + `62b7f10f` (storybook-marks race fix); built and tested commit = `fa4fa8cf`, this record is docs-only on top; re-frozen from `b219e906`, then `405779e6` |
| Release commits | `a95a4f53` (version bump, record, licenses), merge of master `405779e6`, `11a2ea14` (lockfile, credits format, record), then merges of `d8881601` on `release/vibesquad-0.4.0` |
| Requester | Release Desk lead Rele7 (rn-8a7d68a8714e) |
| Approval | pending owner (stable) |
| Release URL | _pending (P3)_ |
| Range | `v0.3.0..fa4fa8cf`: 2232 commits, 774 merges (this record commit is docs-only on top) |

Windows only. No Authenticode (no Azure Trusted Signing yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. `latest.json` is Windows-only. No Android APK is built or attached.

Excluded from this freeze: usa-70 (`83c2ed98`) was pushed to master after the route-protection merge and is not in this release.

## Tests
Windows full suite at `fa4fa8cf`, run on the dev pp with the installed exe present (5:47 to 5:53 PM ET, `suite_exit=0`, builder rn-ad29bb77eaf5):
```
ℹ tests 6963
ℹ pass 6920
ℹ fail 0
ℹ skipped 43
```
Gate tests (raw):
```
853:  ✔ buildSigningEnv defaults an empty password, preserves explicit ones, and ghReleaseArgs appends --repo (3.1311ms)
856:  ✔ stable ignores beta builds, rejects unsigned/tampered payloads, and beta auto-installs when agent turn finishes (1369.0611ms)
2691: ✔ fresh launch shows mode choice before spawning anything, remote mode greys out buttons until paired, and pairing auto-pins CA (862.7992ms)
```
The first line is the `auto-update:96` test that failed at `deae730c`; the other two are the exe-gated auto-update and lan-pair-choice tests. `storybook-marks` alone (`storybook_alone_exit=0`):
```
✔ m2: one lock per repo however spelled; auto-commit after midnight commits the branch the marks were written on (2610.9166ms)
ℹ tests 22 / ℹ pass 20 / ℹ fail 0 / ℹ skipped 2
```
Linux (forge) release-path list (`auto-update`, `rust-path-remap`, `build-desktop-env`, `secrets`, `release-args`, `release-audit`, `release-stages`, `release-tag-guard`, `public-release`, `sign-windows`): `ℹ tests 139 / ℹ pass 138 / ℹ fail 0 / ℹ skipped 1`; `npx tsc --noEmit -p tsconfig.server.json` exit 0.

**Skip census (43 skips, from `suite-fa4fa8cf.log`, auditor rn-31b210f0dd49).** Watchlist: 0 skips in release.mjs, release-audit, push-guard, relay, auto-update, lan-pair-choice.

| Test file:line | Count | Reason | Class |
| --- | --- | --- | --- |
| `test/git-shim.test.mjs` 51, 80, 97, 110, 124, 144, 158, 204, 223, 245, 272, 287, 302, 323, 370, 387, 399, 420 | 18 | `!posix` (win32) | [SEC] POSIX by-design |
| `test/runner-limits.test.mjs:306` | 1 | win32 (POSIX 0700/0600 mode check) | [SEC] POSIX by-design |
| `test/test-tmp-preflight.test.mjs:78` | 1 | win32 | SEC-borderline: the Windows junction equivalent is queued as idea-1225 |
| `test/test-tmp-preflight.test.mjs` 31, 64, 90 | 3 | root or win32 | env/POSIX |
| `test/git-spawn.test.mjs:130` | 1 | SIGTERM can't be ignored on win32 | env/POSIX |
| `test/proc-groups.test.mjs` 418, 431, 442 | 3 | POSIX process groups | env/POSIX |
| `test/run-tests-lock.test.mjs:482`, `test/watch-sets.test.mjs:512` | 2 | POSIX owner/mode | env/POSIX |
| `test/runner-reap-tree.test.mjs` 446, 484 | 2 | linux only | env/POSIX |
| `test/runner-adapters.test.mjs:195` (opencode, antigravity-cli, codex) | 3 | `VS_SMOKE=1` live provider smokes | opt-in |
| `test/ui-overlap.test.mjs` 28, 34, 40, 47, 54, 61 | 6 | `UI_OVERLAP=1` | opt-in |
| `test/storybook-marks.test.mjs` 16, 379 | 2 | python3 missing on the dev pp | env |
| `test/storybook-review.test.mjs:400` | 1 | needs `/tmp/sbv3_snap.json` | env |

## Build
Built and signed on the dev pp over SSH (5:38 to 5:47 PM ET, builder rn-ad29bb77eaf5): `node server/release.mjs build --channel stable --version 0.4.0 --commit fa4fa8cf0a975415fae3dc0c24fcbd237f98e531 --no-authenticode`, then `sign`. Built and tested commit = `fa4fa8cf`; this record commit is docs-only on top of it. Build stamp: `{"commit":"fa4fa8cf0a975415fae3dc0c24fcbd237f98e531","builtAt":"2026-11-27T22:38:58.400Z"}`.
```
P3I build_exit=0
P3I sign_exit=0
[build:desktop] stamped runtime with commit fa4fa8c
[build:desktop] remapping 8 host path prefixes (home, repo, rustup, cargo) via --config build.rustflags
[build:desktop] host-path scan of the app binary: 0 hits
HOSTSCAN VibeSquad.exe bytes=18300416 home_bs=0/0 home_fs=0/0 home_bs_lc=0/0 users_user=0/0 users_user_fs=0/0 (utf8/utf16le)
```
Authenticode waived by the owner (`NO-AUTHENTICODE` marker present); updater-signed with minisign only. minisign verify of setup.exe: `{"ok":true}`; negative control (1 bit flipped): `{"ok":false,"reason":"signature invalid"}`. `latest.json`: version `0.4.0`, platform `windows-x86_64` only, signature equals the `.sig`.

## Artifacts (SHA-256)
| File | SHA-256 | Bytes |
| --- | --- | --- |
| VibeSquad-setup.exe | `d192a7c3401ede027b73f05eec3f3c3355fe8ee42de112c04f010692ab7ca804` | 35458312 |
| VibeSquad-setup.exe.sig | `acb610aa37eeb435cf74d57807c518ed3d8937349b40c6aca18c91213d0c2000` | 440 |
| latest.json | `ccea3d57c679966870cc2d933b8f28743dfb1c7a2a7b18dd5e6a3552066c2955` | 2240 |
| THIRD-PARTY-LICENSES.txt | `2bcb8a72db3beb48a11677ffab4ca56ea8cbeb6d3392ace0fd46f92210526471` | 101679 |
| NO-AUTHENTICODE (marker, not published) | `8c1c3f6a4e24034b9b1a25b512bf8f0cac8bcfe5c26fd5ad5c6e08ba5b02bb40` | 87 |

The superseded artifact sets built at `a8622b77` and `deae730c` were never published.

## Audit B1-B9
Final independent re-audit at `fa4fa8cf` (rn-31b210f0dd49): all 5 artifact hashes re-hashed and matching; delta `a8622b77..fa4fa8cf` = 6 files.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| B1 | secrets in diff + tree | PASS (triaged) | Same 684 false-positive keyword hits as at `a8622b77` (`release-audit.mjs` exit 1; 0 new hits in the delta). gitleaks not installed (Low). |
| B2 | secrets/personal data in artifacts | PASS | Whole-payload scan below: `<user>` 0, 0 real host paths, 0 `\.cargo\registry` / `\.rustup` hits in `VibeSquad.exe` (down from 1,001 at `a8622b77`). |
| B3 | telemetry / PII | PASS (triaged) | Same 58 hosts as `a8622b77`; only `api.deepseek.com` and `deb.nodesource.com` in shipping dirs; 0 new hosts in the delta. |
| B4 | network exposure | PASS | No new `0.0.0.0` binds or route/upgrade handlers. |
| B5 | dependencies | PASS (partial) | `npm audit --omit=dev`: 0 critical / 0 high / 0 moderate / 0 low. cargo-audit not installed (Low). |
| B6 | permissions/capabilities | PASS | No capability, manifest permission or CSP changes. |
| B7 | update + signing integrity | PASS | Pubkey unchanged vs `v0.3.0`. Independent minisign verify: `keyIdMatch=true`, `sigOk=true`, `globalOk=true` (trusted comment `timestamp:1795819624 file:VibeSquad_0.4.0_x64-setup.exe version:0.4.0`); 1-bit flip gives `sigOk=false`, tampered trusted comment gives `globalOk=false`. `latest.json` version 0.4.0, `windows-x86_64` only, signature equals `.sig`. PE Security Directory RVA 0, size 0 (no Authenticode, matches the waiver). |
| B8 | provenance | PASS | HEAD == `fa4fa8cf`, tree clean, version 0.4.0 in `package.json` / `tauri.conf.json` / `latest.json`. Stamps from the NSIS payload: `{"commit":"fa4fa8cf0a975415fae3dc0c24fcbd237f98e531","dirty":false,"ui":"","builtAt":"2026-11-27T22:38:49.707Z"}` and the build stamp above (no local path). |
| B9 | credits and licenses | PASS | 32/32 `CREDITS.md` bullet lines appear verbatim in `THIRD-PARTY-LICENSES.txt` (0 missing). |

**Whole-payload privacy scan.** 100% of `VibeSquad-setup.exe` parsed: NSIS stub (52,740 B) plus the decompressed LZMA stream (151,075,734 B, 3,403 entries, 0 unparsed tail bytes), case-insensitive, UTF-8 and UTF-16LE. `<user>`: 0/0 across the stub and all entries. `VibeSquad.exe` (18,300,416 B): `<user>` 0/0, `\.cargo\registry` / `\.rustup` hits 0. `C:\Users\` / `C:/Users/`: 8 hits (UTF-8), 0 (UTF-16LE), 0 real host paths. All 8 are placeholders:
1. `server/brief-path.mjs:46`: `C:\Users\you\projects)`
2. `server/redact-host-paths.mjs:58`: `C:\Users\<first  last>\…`
3. bundled npm docs markdown (`package.json` section 5): `C:\Users\{Username}\AppData\Roaming\npm\myapp.cmd` ...
4. bundled npm docs HTML (`package.json`): `C:\Users\{Username}\AppData\Roaming\npm\myapp.cmd`
5. `runner/git-guard.mjs:70`: `C:\Users\x (bash cd goes there, and MSYS`
6. `runner/git-guard.mjs:166`: `C:\Users\x\repo`
7. `runner/git-guard.mjs:167`: `C:\Users\x\repo, not C:Usersxrepo (that misread let a Windows main-checkout reset through).`
8. `server/rust-path-remap.mjs:5`: a comment with the literal `<user>` placeholder (`C:\Users\<user>\`); the file was added by the remap fix itself.

**Verdicts.**

| Review | Scope | Result | Commit |
| --- | --- | --- | --- |
| rn-45f18e64c284 | P2 | PASS 0/0/1 | `b219e906` |
| rn-19079f9d68f9 | P2b | PASS 0/0/0 | `405779e6` |
| rn-62e197d60712 | | PASS 0/0/1 | `405779e6` |
| rn-5f6412b794aa | P2c | PASS 0/0/1 | `d8881601` |
| rn-172769f01a2f | | PASS 0/0/0 | `d6c23109` |
| rn-a10ae7fc1087 | | PASS 0/0/2 | `a1ef3fd8` |
| rn-31b210f0dd49 | artifact audit | PASS 0/1/1 at `a8622b77` (Medium fixed), then FAIL 0/1/1 at `a8622b77` baseline, then final PASS 0/0/2 | `fa4fa8cf` |
| rn-16d541524244 | | PASS 0/0/3 (Tier A) | `d21f8dbf` |
| rn-1f0cc1db88a0 | | PASS 0/0/0 | `d7ea070d` |
| rn-4086d8d7c4bc | | PASS 0/0/1 | `62b7f10f` |

## Findings
- Critical: none. High: none.
- `auto-update:96` was a regression from `d21f8dbf`: the release-path test list omitted `test/auto-update.test.mjs`, so the Rust remap change was not caught. Fixed by `d7ea070d` (the source check accepts the remap cargo args). The release-path test list is now part of the release desk's lane spec (managed via `vs spec --lane release-desk`; `docs/lanes/release-desk/SPEC.md` is not on master).
- `storybook-marks:446` (idea-1216) was a test-only race: a fixed 400 ms wait against an auto-commit that takes 1.2-2.7 s on Windows (root cause rn-e906882f1a4a). Fixed by `62b7f10f` (the test polls for the auto-commit). It is no longer listed as a known flake.
- **B2 Medium (fixed):** the Rust binary embedded about 1,001 `C:\Users\<user>\.cargo\registry` paths (build-host username in panic and debug strings). Fixed by `d21f8dbf`: release Rust builds remap host path prefixes and a fail-closed post-build scan refuses any artifact that still contains a host path. The Buddy ruled it a fix, no waiver.
- Past public installers v0.2.0-v0.3.0 carry the same leak. Owner-only finding; no released assets were touched.
- Windows release build regression from `bf4633ad` (Path lost, so `npm.cmd` ENOENT), fixed by `a1ef3fd8`. Review-Gemini PASS 0/0/2 rn-a10ae7fc1087 (Lows: a trailing `;` and the cargo bin dir not deduped in Path, both harmless, queued).
- Licenses file: Windows-generated (`public/THIRD-PARTY-LICENSES.txt`, 101679 bytes, no CRLF, sha256 `2bcb8a72...6471`). Privacy grep clean (only the crate names signal-hook-registry and windows-registry match). Same 596 unique package@version as before (0 dropped, 0 added), 11 duplicate headers collapsed, 158 bare headers now licensed. credits-attribution, public-release and one-stop-installer 37/37 with it (pre-check rn-4be985923903). Determinism follow-up: idea-1234.
- `d6c23109` audit: Review-Sonnet PASS 0/0/0 rn-172769f01a2f. Delta `d8881601..d6c23109` = 1 file, `test/test-tmp-preflight.test.mjs` +6/-2, nothing shipped (Buddy-verified).
- Open Lows: gitleaks and cargo-audit are not installed on the audit host; remap minors idea-1240; idea-1210, 1211, 1215, 1221, 1225, 1234, 1236.

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
