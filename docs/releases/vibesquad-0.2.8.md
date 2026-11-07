# vibesquad 0.2.8 release record

| Field | Value |
| --- | --- |
| Project | vibesquad (Pizzarar/VibeSquad) |
| Version | 0.2.8 |
| Channel | stable |
| Commit | 542c2855cdc41a72a14a9e7b7e1a335e6b3b5453 |
| Built from | 6d39ac1353aaeb1f828bb5bb19f524d58324abae (542c285 + version bump, branch release/vibesquad-0.2.8) |
| Platforms | Windows only. Android deferred to keystore rotation (owner decision 2026-11-07). |
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

Independent auditor (Review - Gemini, did not build). Automated `scripts/release-audit.mjs --from v0.2.7 --commit 6d39ac1 --artifacts dist-desktop --pubkey-config src-tauri/tauri.conf.json`, plus manual items. Gate tests: full `npm test` on 542c285: 2276 total, 0 fail, 7 skip.

| # | Check | Result | Severity | Evidence |
| --- | --- | --- | --- | --- |
| B1 | Secrets in diff + tree | PASS | - | 78 regex hits hand-triaged, all false positives (`-storepass:env`, comments, negative test assertions, `task-`/fixture `sk-` matches). gitleaks SKIP (not installed). |
| B2 | Secrets/personal data in artifacts | REVIEW | Low | Installer extracted (4430 files). The old Android keystore password default is gone from `runtime/`. Low: the build machine's home path appears in `runtime/build-stamp.json` (repo path) and in Rust panic strings in `VibeSquad.exe`. |
| B3 | Telemetry / PII | PASS | - | No new runtime hosts. Push payloads carry ids/titles only. Limits and usage rollups are local files with no outbound calls. |
| B4 | Network exposure | PASS | - | Remote fs list/resolve/read and Terminal/scripts: owner token on every route, path confinement, non-owners refused, 4-terminal cap, stream refused. Unstick and Restart runner are owner-gated POSTs, not remote-proxied. `/__vibesquad/paseo/pair` removed. |
| B5 | Dependencies | PASS | - | `npm audit --omit=dev`: 0 vulnerabilities. node-pty 1.2.0-beta.15: MIT, official npm tarball. It is an optional dependency, not staged into the installer (terminals fall back to piped shell). cargo audit SKIP (not installed). |
| B6 | Permissions/capabilities | PASS | - | No capability, CSP or manifest changes vs v0.2.7 (version string only). |
| B7 | Update + signing integrity | PASS | - | Updater pubkey unchanged vs v0.2.7. `.sig` verified (Ed25519 minisign) against the installer and equals `latest.json`. `latest.json` is windows-x86_64 only, at the HTTPS v0.2.8 URL. |
| B8 | Provenance | PASS | - | Clean tree at 6d39ac1. The installer's `runtime/build-stamp.json` commit is 6d39ac1. Version 0.2.8 everywhere. |
| B9 | Credits | REVIEW | Low | Ported features in range are credited. Release notes credit nothing vibe-only. Flag: the two vibe-only CREDITS.md lines (removal approved) are embedded in the bundled `THIRD-PARTY-LICENSES.txt` (installer + release asset). `@getpaseo/*` is still in package.json, so the Paseo line stays. |
| IP | "Hypnospace Office" cast | REVIEW | Medium | The name is not in any UI string. The in-house H0 role sprites ship in `public/office/cast-{dark,light}.png` (Hub squad floor). Owner call. |

No Critical/High findings.

## Artifacts (SHA-256)

| File | SHA-256 |
| --- | --- |
| VibeSquad-setup.exe | `4ceee5cad802a4028b9104a376163bd53fb5d1dac68ec82d5f8ddc05addb5fe5` |
| VibeSquad-setup.exe.sig | `0e1c74893a7e57d00dda4812298d13cd3a48927013072407d04fc49bd8d6586a` |
| latest.json | `bcaace8e5c0dd887108a65a306fb4e7bfa48a3cc00ec9bc7274ca14af1fa4507` |
| THIRD-PARTY-LICENSES.txt | `04e031d0b24400b02189c76149cf26c142e0cfa1d02533e97aea4721139fe4bf` |

## Signing

Windows: updater-signed (minisign) only, no Authenticode (owner waiver: no Azure cert yet; D5 tooling merged, inactive). Android: deferred to keystore rotation. No APK was built, and `android-aarch64` was removed from `latest.json` so 0.2.7 Android installs are never pointed at a missing APK. At publish, upload this `latest.json` as is: the 542c285 publish stage would re-add the entry (fixed on master in c1f884a).

## Signature verification

Installer `.sig` cryptographically verified against the updater pubkey in `src-tauri/tauri.conf.json` (audit B7). Authenticode: not applicable (waiver).
