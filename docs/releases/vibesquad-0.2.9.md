# Release record: VibeSquad v0.2.9 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.2.9 |
| Channel | stable |
| Frozen commit | `e8380d3` (master, 2026-11-10; master tip 3f66803 = TASKS.json only, deliberately left out) |
| Release commits | `4f23507` (`release: vibesquad 0.2.9 (stable) version bump, frozen from e8380d3`) + `8085dd5` (`release: credit @noble/curves as a third-party dependency line`) on `release/vibesquad-0.2.9`; built/tested commit = `8085dd591d2fecd25821b973d4826f20788ad4d2` |
| Requester | Release Desk lead Rele5 (rn-cd9dc6ddfea4) |
| Approval | the owner GO (via Hub6), publish ordered by Rele5 on 2026-11-10 after the Tier A B4 review |
| Tier A review | Review-Gemini rn-a33adefaa531 PASS 0H/0M/4L (relay unwired; build-stamp path + updater key pw tracked) |
| Release URL | https://github.com/Pizzarar/VibeSquad/releases/tag/v0.2.9 (tag `v0.2.9` on `8085dd5`) |
| Range | `7a638bf..e8380d3` (v0.2.8 frozen commit to this freeze): 500 commits, 183 merges |

Windows only. No Authenticode (no Azure Trusted Signing yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. `latest.json` is Windows-only (no `android-aarch64` entry: c1f884a rule, no APK built). Android: no D6 keystore, so no APK was built or attached.

## Tests (at 8085dd5, full `npm test`)
`tests 3058 / suites 177 / pass 3047 / fail 0 / cancelled 0 / skipped 11 / todo 0` (duration 43.8 s). Typecheck (`tsc --noEmit`, both configs) ran clean inside `npm run build` during the desktop build.
Earlier run at 4f23507 (first release commit): `tests 3058 / pass 3046 / fail 1 / skipped 11`; the one failure was `test/credits-attribution.test.mjs:44` (20 accolade bullets, expected 19) caused by the desk's own CREDITS.md line, fixed by rewording it as a dependency credit in 8085dd5 and rebuilding from there. Frozen e8380d3 itself: 3045 pass / 0 fail / 13 skip (lead's run).
The 0.2.8 EPERM lock race is fixed in this release: `848f3d9` is an ancestor of `e8380d3` (`git merge-base --is-ancestor` = true); `test/file-lock` and `test/inbox-atomic` are no longer known failures.

## Build
`node server/release.mjs build --channel stable --commit 8085dd5 --no-authenticode`, then `node server/release.mjs sign --channel stable --commit 8085dd5`. Built in the clean linked worktree `rel-0.2.9-e8380d3` (fresh `npm ci`); build stamp = `8085dd591d2fecd25821b973d4826f20788ad4d2`. Updater signing key `~/.tauri/vibesquad-updater.key`. Secrets path: `resolveSecret` (env, then Windows Credential Manager `vibesquad/updater-key`), never argv. Note: no `vibesquad/updater-key` credential exists in this session's Credential Manager; the key file accepts an empty password (verified by signing a throwaway file), so signing succeeded without one. See audit B7.

## Artifacts (SHA-256)
| File | SHA-256 |
| --- | --- |
| VibeSquad-setup.exe | `2dd0b15f636504e3db9e2d2011e0337b076b102af0495e83f2af107526220cbd` |
| VibeSquad-setup.exe.sig | `68ad2ad45efee33ed4fcbf7c83d65ad31ed9265b61610dd8140978c3aee0a522` |
| latest.json (sign stage, before notes) | `13801587111ccd6502b4646018faa620542e3116d796efbb0db3a8f23fde4023` |
| latest.json (published: same signature, Windows-only, release notes + pub_date added per the 0.2.8 convention) | `d814cf4c0a0383151924543413a52cd34d74617f7870e69add34df8f17b9a1b1` |
| THIRD-PARTY-LICENSES.txt | `c1557df798c8c64e96b83cc804ba32cd0ef75212d9e26b9ea205d69cade4f41e` |
| NO-AUTHENTICODE (marker, not published) | `8c1c3f6a4e24034b9b1a25b512bf8f0cac8bcfe5c26fd5ad5c6e08ba5b02bb40` |

## Signature (minisig)
`VibeSquad-setup.exe.sig` (base64 minisign, Ed25519; equals the `windows-x86_64` signature in `latest.json`):
```
dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRbEFxL2szVWhIL1pYRGh4RXhIWFlxOVFLTWNpS2xZajU4NjVSRzA0azFFaUk2dFNibSs4Zmlyb0pBOEp0WVFUdThRWm9raFNkSlNwY3FYZjNzcU0yQklmMmdMdjNFaUFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MzM5Nzc5CWZpbGU6VmliZVNxdWFkXzAuMi45X3g2NC1zZXR1cC5leGUJdmVyc2lvbjowLjIuOQpYeDhmb0RHQXlqTjYwSjhNNXhnOGQxWHl0cEkrck5kK041bnpuMWt4eEk1cTk5MXY4Q2VjMDVnMEtuZHFKMDhsTXJkdzVGSEJqdEtMUFBWQjBZNUFCUT09Cg==
```
Verified cryptographically against the pubkey in `src-tauri/tauri.conf.json` (audit B7).

## Audit B1-B9

No High/Critical after triage.
| # | Result | Notes |
| --- | --- | --- |
| B1 secrets | PASS (triaged; script FAIL High on keyword hits) | Script: 45 keyword hits (S5 `sk-`/`-sk` x13, S3 `pass:` x21, S2 storepass x10, S4 x1). Hand triage of every hit: prose and identifiers only (`task-`/`disk-hash-123`/`feel pass:` text, `pass:` boolean fields in `providers-catalog.mjs`, `-storepass:env` keytool argv names in `scripts/rotate-android-keystore.mjs`, `AZURE_CLIENT_SECRET: clientSecret(d)` resolved at run time in `scripts/sign-windows.mjs:135`, regex guards in tests, `test/secret-input.test.mjs:39` fake fixture). Value-shaped sweep of the tracked tree (`AKIA`, `gh*_`, `xox*`, `AIza`, long `sk-`, JWT shape, `BEGIN ... PRIVATE KEY`): 0 hits. gitleaks not installed: SKIP. |
| B2 artifacts | PASS (triaged; script FAIL High on keyword hits) | 6 keyword hits in the staged `runtime/`: `runner/runner.mjs:519` (comment "boot pass:"), `providers-catalog.mjs:437,811` (`pass:` boolean), `secrets.mjs:3` (cmdkey usage comment), `build-android.mjs:168-169` (`storePass = resolveKsSecret(...)`, no literal). Value-shaped sweep of `runtime/` + `dist/`: 0 hits. Personal-pattern sweep SKIP (no pattern file); installer interior not swept (7z not installed), as in 0.2.8. Low (carried from 0.2.8): `runtime/build-stamp.json` embeds the build checkout path `C:/Users/<user>/projects/VibeSquad/.git`. |
| B3 telemetry | PASS (manual) | 14 "new hosts" are inert: `paulmillr.com`, `tauri.app`, `www.apache.org` (license texts in THIRD-PARTY-LICENSES.txt), `192.168.1.20` / `pc-name.example` (pairing examples and test fixtures), `relay.invalid` (URL-parse base in `src/remoteRelayTransport.ts:430`), `relay.example` (doc comment), `tauri.localhost` / `127.0.0.1` / `http://x` (loopback and URL-parse bases), `cloudcode-` (docs). `server/push.mjs` and the `vs log` metrics code are unchanged in the range (`git diff --stat 7a638bf..8085dd5` empty for them). No analytics or telemetry SDK. |
| B4 network | PASS (script + manual) | Script: no new `0.0.0.0` binds or route/upgrade handlers in the diff. Manual notes with file:line below. |
| B5 deps | PASS / SKIP | `npm audit`: 0 critical / 0 high / 0 moderate / 0 low (prod and full). cargo-audit not installed: SKIP. `@noble/curves` exact-pinned, `@tauri-apps/plugin-deep-link` pinned in the release commit (notes below). License allowlist (`generate-licenses.mjs`) clean. |
| B6 permissions | PASS | No capability, manifest permission or CSP change in the diff (`src-tauri/tauri.conf.json` diff vs 646d2ae is the version line). Android-only additions: `vibesquad://pair` deep-link scheme, `VsTrust.kt` CA pin (not in the Windows build). |
| B7 update integrity | PASS | Pubkey unchanged vs 7a638bf; endpoint `https://github.com/Pizzarar/VibeSquad/releases/latest/download/latest.json`; `latest.json` signature equals `.sig`; minisign Ed25519 verified against the pubkey for `VibeSquad-setup.exe`. Observation (Low): the updater private key file accepts an empty password (no `vibesquad/updater-key` credential in this session); the key is protected only by the user-profile ACL. Recommend adding a password and storing it in Credential Manager before the next release. |
| B8 provenance | PASS | HEAD == 8085dd5; build stamp `8085dd591d` == commit; tree clean; version 0.2.9 in package.json / tauri.conf / tauri.android.conf / Cargo.toml / latest.json; `latest.json` is Windows-only (no `android-aarch64`). |
| B9 credits | PASS | Notes credit nothing vibe-only; no plugin-inspired features in this set. `CREDITS.md` gains one third-party dependency line (@noble/curves 2.4.0 by Paul Miller, MIT), written as a dependency credit, not an accolade, so `test/credits-attribution.test.mjs` (19 accolade bullets) still passes. |

Raw script output (`node scripts/release-audit.mjs --from 7a638bf --commit 8085dd5 --artifacts dist-desktop --pubkey-config src-tauri/tauri.conf.json`, exit 1 on the untriaged B1/B2 keyword hits):
| # | Check | Result | Severity | Evidence |
| --- | --- | --- | --- | --- |
| B1 | Secrets in diff + tree | FAIL | High | 45 hit(s): S5×13 [docs/LESSONS.md:100, docs/audits/owner-turn-audit.md:49, src/TeamActions.tsx:391, src/styles.css:5787, test/profiles.test.mjs:681 (+8 more)]; S3×21 [docs/releases/vibesquad-0.2.7.md:30, runner/runner.mjs:519, scripts/rotate-android-keystore.mjs:28, scripts/rotate-android-keystore.mjs:60, scripts/rotate-android-keystore.mjs:61 (+16 more)]; S2×10 [scripts/rotate-android-keystore.mjs:28, scripts/rotate-android-keystore.mjs:44, scripts/rotate-android-keystore.mjs:45, scripts/rotate-android-keystore.mjs:51, scripts/rotate-android-keystore.mjs:60 (+5 more)]; S4×1 [scripts/sign-windows.mjs:135]; skipped: gitleaks not installed (https://github.com/gitleaks/gitleaks#installing) |
| B2 | Secrets/personal data in artifacts | FAIL | High | 6 hit(s): S3×4 [runtime/runner/runner.mjs:519, runtime/server/providers-catalog.mjs:437, runtime/server/providers-catalog.mjs:811, runtime/server/secrets.mjs:3]; S2×2 [runtime/server/build-android.mjs:168, runtime/server/build-android.mjs:169]; skipped: personal sweep skipped: no pattern file (%USERPROFILE%/.vibesquad/audit-personal.txt; one regex per line); VibeSquad-setup.exe contents not swept: 7z not installed (https://www.7-zip.org) |
| B3 | Telemetry / PII | REVIEW | Medium | 14 new outbound host(s): cloudcode- (docs/lanes/ui-bois/V1B_ART_HITS.md:70), paulmillr.com (public/THIRD-PARTY-LICENSES.txt:949, public/THIRD-PARTY-LICENSES.txt:972), tauri.app (public/THIRD-PARTY-LICENSES.txt:998, public/THIRD-PARTY-LICENSES.txt:1020), 192.168.1.20 (src/RemotePairScreen.tsx:320, test/android-pair.test.mjs:38 (+3 more)), relay.invalid (src/remoteRelayTransport.ts:430), pc-name.example (test/android-pair.test.mjs:39) (+8 more); push payload + vs log metrics need manual review |
| B4 | Network exposure | PASS | - | no new 0.0.0.0 binds or route/upgrade handlers in diff |
| B5 | Dependencies | SKIP | - | npm audit: critical 0, high 0, moderate 0, low 0; cargo audit not installed (cargo install cargo-audit); Gradle deps + license allowlist: manual |
| B6 | Permissions/capabilities | PASS | - | no capability, manifest permission or CSP changes in diff |
| B7 | Update + signing integrity | PASS | - | pubkey unchanged vs 7a638bf; 1 endpoint(s) https/github.com; latest.json signature(s) equal .sig; urls https on updater repo; minisign Ed25519 verified against pubkey: VibeSquad-setup.exe |
| B8 | Provenance | PASS | - | HEAD == commit; build-stamp 8085dd591d == commit; tree clean; version 0.2.9 in package.json/tauri.conf/latest.json; SHA-256: latest.json=13801587111ccd6502b4646018faa620542e3116d796efbb0db3a8f23fde4023, NO-AUTHENTICODE=8c1c3f6a4e24034b9b1a25b512bf8f0cac8bcfe5c26fd5ad5c6e08ba5b02bb40, THIRD-PARTY-LICENSES.txt=c1557df798c8c64e96b83cc804ba32cd0ef75212d9e26b9ea205d69cade4f41e, VibeSquad-setup.exe=2dd0b15f636504e3db9e2d2011e0337b076b102af0495e83f2af107526220cbd, VibeSquad-setup.exe.sig=68ad2ad45efee33ed4fcbf7c83d65ad31ed9265b61610dd8140978c3aee0a522 |

### B4 notes (network / pairing / relay / shutdown), with file:line
**Listeners.** The VS server binds loopback only by default: `server/serve.mjs:482` `server.listen(port, "127.0.0.1")`. LAN / Meshnet exposure is opt-in (`--lan`, `VIBESQUAD_LAN=1`, or Settings) and binds only the detected LAN and Meshnet IPs through the TLS/HTTP mux (`server/serve.mjs:497-523`), never `0.0.0.0`. The runner binds loopback on an ephemeral port: `runner/server.mjs:227` `server.listen(Number(arg('port', 0)), '127.0.0.1')`. No new bind sites in the range (`git diff 7a638bf..e8380d3` adds no `.listen(` or `0.0.0.0` outside tests).

**API trust gate.** Every `/__vibesquad/*` and `/api/*` call must be trusted: `server/vibesquad-api.mjs:1524-1527` (`isApi && !isTrusted` -> 403 on loopback, 401 for an unpaired remote); any non-owner is refused every non-GET and every gated read (`:1528-1530`). `isTrusted` = loopback-safe browser (Host/Origin/Sec-Fetch checks, `server/auth.mjs:557-570`) or a paired device cookie whose SHA-256 matches `devices.json` in constant time (`server/auth.mjs:515-538`).

**Host-aware pairing (E4a).** `POST /__vibesquad/pair/start` can only be started from the PC or an already-paired device (`server/auth.mjs:906-908`); it mints a 5-minute one-shot code (`:754-759`, `CODE_TTL_MS` at `:14`) and returns pair URLs for the Meshnet host, Meshnet IP and LAN IP plus the CA fingerprint (`:918-945`). Redeem is `GET /pair?code=` on the LAN/Meshnet HTTPS listener, per-IP throttled (5 attempts/min, exponential lock up to 1 h after 5 failures: `:719-770`), the code is deleted even when expired (`:968-970`), the device token is 32 random bytes and only its SHA-256 is stored (`:975-979`), cookie `HttpOnly; Secure; SameSite=Strict` (`:985`). The host id is a random 16-byte identifier, not a secret, and is intentionally handed to unpaired callers on `/api/auth/status` (`server/host-id.mjs:1-4`, `server/vibesquad-api.mjs:387`); the phone keys its saved host by it and keeps the CA pin per host (`src/remoteSession.ts:264-287`: a different host id behind the same address drops the old pin). `vs pair` posts to `127.0.0.1:<port>/__vibesquad/pair/start` with the local token (`cli/vs.mjs:2028-2043`) and never prints the QR SVGs (`:2052`); `vs devices list|revoke` work on `devices.json` directly through `server/auth.mjs` `listDevices` / `revokeDevice` / `revokeAllDevices` (`cli/vs.mjs:2075-2111`), and a revoke drops the device's live sockets (`server/auth.mjs:383-387, 693-717`). `GET /__vibesquad/devices` (list) is reachable by any paired device (read-only tier); `POST /__vibesquad/devices/revoke` is owner-only via the non-GET gate.

**E2E relay tunnel (E5).** NOT WIRED in 0.2.9: `server/relay-tunnel.mjs:4` says "UNWIRED: nothing imports this yet", and a grep of `server/ cli/ src/ runner/` (non-test) finds no importer of `relay-tunnel.mjs`, `createRelayHost`, `loadOrCreateHostKeypair` or `connectRelay`. `src/main.tsx:8,25` renders `RemotePairScreen` only for the APK build, and that screen uses the LAN/Meshnet HTTPS path (`src/RemotePairScreen.tsx:5-22` imports from `remoteSession`, not the relay transport). Nothing in the shipped Windows build opens a relay connection, and no relay endpoint is configured. Design as shipped, for the next release's wiring review: the host dials OUT over `wss://` (`:402-453`); the client refuses non-`wss:` (`src/remoteRelayTransport.ts:288`) and pins the host's X25519 public key, requiring `hostId == base64url(SHA-256(pub))` (`:292-296`, `:229-232`). Handshake: Noise_NK-style, `DH(e_c,S) || DH(e_c,e_h)` through HKDF-SHA256 with the transcript hash as salt (`server/relay-tunnel.mjs:160-199`), degenerate DH output rejected (`:176-180`), AES-256-GCM records with a strict counter so replay / reorder fail closed (`:116-158`). Inside the channel: redeem (per-session cap 5; 10 host-wide failures burn all codes and raise needs-you, `:422-427, 514-520, 584-607`), token auth throttled host-wide (`:608-628`), revoked devices cut on dispatch (`:629-633`), default-deny path allowlist with canonicalisation and denied prefixes for first-run, local-image, pair/redeem, enter and local-login (`:233-281`), `Set-Cookie` stripped from responses (`:291-300`), 24 h / 2^20-record rekey (`:430-431, 478-484`), unauthenticated-session eviction at 32 (`:677-684`).

**X25519 keys.** Host static key: `~/.vibesquad/host-keypair.json`, created once with `node:crypto` `generateKeyPairSync("x25519")`, written `0600` via an exclusive temp file hard-linked into place (no partial file, never overwrites a concurrent winner), directory `0700` (`server/relay-tunnel.mjs:61-107`; on Windows the user-profile ACL plus `lockDownVibesquadHome` is the boundary). It is stored as a plaintext JWK, loaded into a `KeyObject`, never zeroed (long-lived static key by design) and reused across sessions. Nothing creates it in 0.2.9 (unwired). Ephemeral keys: host side `generateKeyPairSync("x25519")` per handshake (`:192`), held only in a `KeyObject` and dropped with the session (no explicit zeroing; Node has no API for it). Client side: WebCrypto with `extractable: false` when available (`src/remoteRelayTransport.ts:70`), otherwise `@noble/curves` `x25519.utils.randomSecretKey()` kept in a closure (`:84-86`); the noble secret is not `fill(0)`-ed after use (Low, library code only). Channel keys and counters live in memory only (`src/remoteRelayTransport.ts:4-5`). No key material is logged.

**Runner `POST /shutdown` (vs restart).** The runner requires `Authorization: Bearer <token>` on every request, compared in constant time (`runner/server.mjs:64-70, 99`); the token is 32 random bytes written to `<home>/token` mode `0600` (`:197-201, 223`). `POST /shutdown` is served only when a token is configured and an `onShutdown` hook exists, otherwise 403 (`:111-117`); it answers 202 then stops with `keepResumable` (`:225, 232-236`), so agents emit no exit event and resume under the next runner. Only loopback can reach it (`:227`). `scripts/restart-runtime.mjs` reads the token from `<home>/token` (`:168-169`), calls `/shutdown` (`:372`), then force-kills only if the pid still carries a verified runner command line (`:378-381`). `vs restart` is gated fail-closed: a runner agent id with no runner record is refused, and only a live hub lead (Overlord) or the owner (no agent id) passes (`cli/vs.mjs:2294-2309`); launch args reject quotes and control chars before the WMI `Win32_Process.Create` command line (`:2311-2313, 2335`). The server-side `POST /__vibesquad/restart-runner` and `/unstick` are owner-only through the non-GET gate (`server/vibesquad-api.mjs:1579-1584`).

**Android / Tauri.** No capability or CSP change (`src-tauri/tauri.conf.json` diff is the version line only). `tauri.android.conf.json` adds the `vibesquad://pair` deep-link scheme (mobile only, `appLink: false`); `src-tauri/.cargo/config.toml` injects the host-scoped CA pin (`VsTrust.kt`) into wry's Android WebView client. Neither affects the Windows build.

### B5 notes (dependencies)
- `@noble/curves` is exact-pinned: `package.json:28` `"@noble/curves": "2.4.0"`; `package-lock.json:14` (root spec `"2.4.0"`) and `:67-70` (`node_modules/@noble/curves` version 2.4.0, resolved `curves-2.4.0.tgz`, integrity `sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==`). Its only dependency is `@noble/hashes` 2.4.0 (`:82-85`). Both MIT, both now in `THIRD-PARTY-LICENSES.txt` and credited in `CREDITS.md`.
- `@tauri-apps/plugin-deep-link` was `^2.6.3`; the release commit pins it exactly to `2.6.3` (`package.json:29`, `package-lock.json:15`; the lock already resolved 2.6.3 at `:626-629`, so the installed tree is unchanged). Reason for pinning instead of a justification: every other runtime dependency that ships inside the installer is exact-pinned and the Rust half (`tauri-plugin-deep-link` in `Cargo.lock`) is locked, so a floating JS half would have been the only unpinned link in the updater-signed build.
- `npm audit` (prod and full): 0 vulnerabilities. `cargo audit`: not installed, SKIP (as in 0.2.8). License check: `server/generate-licenses.mjs` (allowlist-enforced) ran clean for the release commit and again inside `npm run build` during the desktop build.

## KNOWN-UNVERIFIED
KNOWN-UNVERIFIED: desktop app disconnect fix not yet checked live on the desktop app; hotfix via @bug if the banner reappears.

## Release notes
# VibeSquad v0.2.9

### Desktop app: no more "disconnected" banner (D1-D3)
- The server never blocks on the runner roster: roster reads are async and batched, with one background-refreshed roster shared by navigation roots and live-agent views (23308a3).
- The runner's `GET /agents?full=1` no longer stalls the runner loop: status scans yield between slices. Cold worst-case stall 4101 ms -> 29 ms, and `POST /agents` answers mid-scan (aef75ee).
- Desktop app boot: a healthy port reaps a stale child, `ensure_lock` plus a 60 s boot window never kills a booting server, and a TCP-accept check before spawn means no double spawn (38c42ca).
- Runner boot parses each log once (~2.25 s -> ~1.3 s before listen on a 199 MB agent dir) (c2fcb59).
- KNOWN-UNVERIFIED: desktop app disconnect fix not yet checked live on the desktop app; hotfix via @bug if the banner reappears.

### Android pairing end state: E1-E5 core (e8380d3)
- **E1** strict phone cockpit shell: Overlord / RiffBot / Buddy tabs, host drawer, Restart Runner, bug and pair slots (85c82d2).
- **E3** phone fast bug capture: PhoneBugSheet, an 8 MB `/__vibesquad/inbox/attachment` route (owner-only), media lifecycle on merge/archive (4a0dbf7).
- **E4a** host-aware pairing: a stable per-install host id (`~/.vibesquad/host-id`), a v:3 session store keyed by host id with the CA pin, new `vs pair` and `vs devices list|revoke` verbs, a locked `devices.json` writer, and revoke cuts live sockets (9da81fb).
- **E5** outbound end-to-end encrypted relay core: host side (`server/relay-tunnel.mjs`) and browser client (`src/remoteRelayTransport.ts`), X25519 + AES-256-GCM with a self-certifying host id, default-deny path allowlist, redeem/auth flood limits, and session rekey (fbe014c). In 0.2.9 the tunnel ships as library code and tests only: nothing wires it into the server or the pairing UI yet, and no relay endpoint is configured. Pairing still runs over LAN / Meshnet HTTPS as in 0.2.8.
- **E2** phone cockpit CSS and sheet/scrim fixes (2169519).
- Android app recovery and APK hygiene from the 0.3 A1 audit (Reconnect-to-saved-PC, plain error pages, same-site enter hop, APK sha256 sidecar). No APK ships with 0.2.9 (no keystore yet).

### Spawn routing by stakes (6c18e27)
- `stakes` parameter on `spawn_worker` / `create_agent` and `vs spawn --stakes`; the stakes ladder (`server/stakes-ladder.mjs`) picks model and thinking after failover, an explicit model still wins (4a7025a, 7a1c86b).

### Lead handoff and `vs restart`
- Lead handoff keeps exactly one live lead under failure: a dead pending successor is evicted and re-planned, never re-adopted; `confirmTakeover` refuses an unverifiable successor (383b3f0, 1fb7328).
- `vs restart`: a detached restart script (launched via WMI on Windows so it is outside the runner's process tree) stops the runner through a token-authed `POST /shutdown` that keeps every agent resumable, then restarts runner and server. Owner or Overlord (hub lead) only, fail-closed identity check, quote-safe launch args (7e6cb11).
- Overlord ops: `vs buddy restart --lane` / `restart_buddy` (owner, lane lead or Overlord), handoff floor, unrouted-ops audit bucket, routing of restarts/runtime syncs to Overlord or @bug (fe80aa2, 81bb060, 4bd9fd2, b2441aa).

### UI
- UI gate 11-10 fold (44d7a43): Squads fold, usage hotfix, Bugs quick-chip and Perfection angel in the Usage CRT, sky chat panel header, zoom-aware menus, portaled takeover popovers, floor-tight layout and no placeholder boxes while floor art loads.
- Older inline send-to cards honour the pre-D1 dismissal id (dcf9337).
- Composer queue survives drawer close (8b1eb33); inbox Send delivers to the lane's live Buddy (7f687e2); `/office/` and `/ui/` art served with ETag/304 revalidation (d735c81).
- Boot roster and sweeps: shared ~4k budget for Who's here / In flight, long-done workers auto-archived (26e8e6a, 6bc0e5c, e1eaa93).

### De-flakes and fixes
- runner-roster-async asserts interleaving ticks instead of a wall-clock lag (bcbe09e); stale `starting.lock` test backdates mtime (1c1d0b7); stale harnesses fixed in G1 (e7d228a).
- **0.2.8 known issue closed:** the Windows cross-process file-lock EPERM race is fixed (848f3d9 is in this release). `file-lock` and `inbox-atomic` pass.
- P0 blank boot fixed: the browser bundle no longer pulls in `server/file-lock.mjs` (0f5c53e).

### Dependencies
- New runtime dependency: `@noble/curves` 2.4.0 by Paul Miller (MIT), X25519 fallback for the relay client where WebCrypto lacks it. Exact-pinned. `@tauri-apps/plugin-deep-link` is now exact-pinned at 2.6.3.

### Credits
- New runtime dependency: **@noble/curves 2.4.0** by `Paul Miller` (MIT), X25519 key agreement for the E2E relay tunnel.
- Earlier accolades are listed in `CREDITS.md`. No plugin-inspired features in this release.

Windows only. Updater-signed (minisign); no Authenticode yet. Android is not part of this release.
