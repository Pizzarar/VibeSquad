# Release record: VibeSquad v0.2.8 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.2.8 |
| Channel | stable |
| Frozen commit | `7a638bf` (master, 2026-11-08) |
| Built / tagged commit | `646d2ae9a33d3c532495e8e9b571e0638623e1c1` (`release: vibesquad 0.2.8 (stable) version bump only, frozen from 7a638bf`) on `release/vibesquad-0.2.8` |
| Requester | owner (Aub), via @bugc |
| Approval | Aub, 2026-11-08: publish once build + audit pass; 848f3d9 lock fix NOT taken (conflicts in `runner/lock.mjs`); ship with the Known Issue below |
| Release URL | https://github.com/Pizzarar/VibeSquad/releases/tag/v0.2.8 |
| Range | `v0.2.7..7a638bf`: 696 commits, 214 merges |

Windows only. No Authenticode (no Azure cert yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. Android deferred. Meshnet A1 (merged after the freeze) is not in this release.

## Tests (at 646d2ae, full `npm test`)
`tests 2361 / pass 2355 / fail 1 / skipped 5` (duration 40.8 s).
The single failure is the known one: `test/inbox-atomic.test.mjs:36` "concurrent adds across processes never lose cards or mint duplicate idea-N ids" (`child exit 1`, the EPERM race below). No other failure. Typecheck (`tsc --noEmit` for both configs) ran clean as part of `npm run build` inside the desktop build.

## Build
`node server/release.mjs build --channel stable --commit 646d2ae --no-authenticode`, then `sign`. Built in this clean linked worktree; build stamp = `646d2ae9a3...`. Updater signing key from `~/.tauri/vibesquad-updater.key`; password resolved from Windows Credential Manager (`vibesquad/updater-key`) via env, never argv.

## Artifacts (SHA-256)
| File | SHA-256 |
| --- | --- |
| VibeSquad-setup.exe | `64a153dbc474a7a3873e15ee258979da820fa7c31a2e36d4a39413aecb44ee90` |
| VibeSquad-setup.exe.sig | `a909e998f30eea543b68a002d1c834089e0dc6f4bd4046a254b25b2a105ba383` |
| THIRD-PARTY-LICENSES.txt | `86dd9fe4f793224cf8152ab48efeef79656097f6ae17a0e68be54fbd7fd1320c` |

## Signature (minisig)
`VibeSquad-setup.exe.sig` (base64 minisign, Ed25519; equals the `windows-x86_64` signature in `latest.json`):
```
dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRbEFxL2szVWhIL1RHenpMUStya2hrNXcrNStQSkRyc2EyZC9zMUpLUkYrNkZpWGxUUGNwaHhRUGd4dEZZZDVVc21xSDdNZ2pwWlh4eFNQMnRmb3FCZlRWVnBIUlVzeXdJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MTYwMzYxCWZpbGU6VmliZVNxdWFkXzAuMi44X3g2NC1zZXR1cC5leGUJdmVyc2lvbjowLjIuOAplMlhmWU1VTE5lVlM4SGpuWmtScVZRbXYxREJGeFdJVW9IL0lxaFpWVUFmWFAyNlJZWTRMdEpVN2swSnluZ21BT1dLNmx3eTRZR1BzWEZHaUU5Ym1EQT09Cg==
```
Verified cryptographically against the pubkey in `src-tauri/tauri.conf.json` (audit B7).

## Audit B1-B9 (`scripts/release-audit.mjs --from v0.2.7 --commit 646d2ae --artifacts dist-desktop --pubkey-config src-tauri/tauri.conf.json`, plus manual triage)
No High/Critical after triage.
| # | Result | Notes |
| --- | --- | --- |
| B1 secrets | PASS (triaged) | Script flagged 71 keyword hits (S5 `sk-` x22, S3 `pass:` x27, S2 storepass x20, S4 x2). Hand-triage: all are names/identifiers (`task-`/`risk-` CSS and prose, `pass:` boolean fields, variable names resolved via `resolveSecret`, `cmdkey` usage text). Value-based sweep of the tracked tree for literal store/key passwords, `AKIA`, `gh*_`, `xox*`, `AIza`, long `sk-` tokens, `BEGIN ... PRIVATE KEY`: only `test/secret-input.test.mjs:39` (a fake test fixture). gitleaks not installed: SKIP. |
| B2 artifacts | PASS (triaged) | 5 keyword hits in `runtime/`: `server/build-android.mjs:128-129` read the keystore password via `resolveSecret` (no literal; the old F2 password string is gone), `providers-catalog.mjs` `pass:` boolean, `secrets.mjs:3` comment. Token-shaped sweep of `runtime/`: only npm's bundled docs. Personal-pattern sweep SKIP (no pattern file); installer interior not swept (7z not installed). Low: `runtime/build-stamp.json` embeds the build checkout path (`C:/Users/<user>/projects/VibeSquad/.git`), carried over from earlier releases. |
| B3 telemetry | PASS (manual) | New hosts are inert: `timestamp.acs.microsoft.com` / `wus2.codesigning.azure.net` (inactive Authenticode tooling, tests), `cli.github.com` (install hint text), `example.googleapis.com` (test). Web Push only fetches the user's own subscription endpoints (SSRF-guarded); `runner/limits.jsonl` and usage rollups are local files. No analytics/telemetry SDK. |
| B4 network | PASS (manual) | `isApi && !isTrusted` -> 401/403; any non-owner is refused every non-GET and every `isGatedRead` path (`vibesquad-api.mjs:1448-1455`). `isGatedRead` covers terminals, `isGitPath`, and `ADE_GATED_READ_PATHS` (files, search, `fs/list`, `fs/read`, `fs/resolve`, `fs/watch`). fs write/create/rename/delete/duplicate are POST (owner-only) and `confineReq` to navRoots; git routes require `resolveCwd` (known team / agent path); `unstick` and `restart-runner` are POST (owner-only). No `/__vibesquad/paseo/pair` or `#offer=` relay route in `server/`. No new 0.0.0.0 binds or route/upgrade handlers in the diff. |
| B5 deps | PASS / SKIP | `npm audit`: 0 critical, 0 high, 0 moderate, 0 low. cargo-audit not installed: SKIP. node-pty 1.2.0-beta.15 is optional (Microsoft, MIT) and already credited. |
| B6 permissions | PASS | No capability, manifest permission or CSP changes in the diff. |
| B7 update integrity | PASS | Pubkey unchanged vs v0.2.7; endpoint https/github.com; `latest.json` sig equals `.sig`; minisign Ed25519 verified. |
| B8 provenance | PASS | HEAD == commit; build stamp `646d2ae9a3` == commit; tree clean; version 0.2.8 in package.json / tauri.conf / latest.json. |
| B9 credits | PASS | Notes credit nothing vibe-only. Tool credits present in `CREDITS.md` (Aseprite, aseprite-mcp, node-pty, xterm.js, Paseo, Mermaid, etc.). CREDITS.md untouched. |

## Known issue: Windows EPERM lock race
Transient `EPERM` at `openSync` in `tryCreateLock` (`runner/lock.mjs:31`) via `withFileLockSync` (`server/file-lock.mjs:45`). Affects cross-process locking of `teams.json` and the inbox. Isolated test failure rates: file-lock 4/16, inbox-atomic 7/16. The 848f3d9 fix conflicts in `runner/lock.mjs` and was NOT taken (owner decision 2026-11-08); it lands in the next point release. `file-lock` and `inbox-atomic` tests are treated as known failures for this release.

## Release notes
Published as the GitHub release body (and `latest.json` notes); source of truth: `docs/releases/vibesquad-0.2.8-prep.md` (Release notes) plus the Known issue and Credits sections.
