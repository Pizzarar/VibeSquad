# Release record: VibeSquad v0.2.7 (stable)

- **Commit:** `66d01b5435ac3d9333b91ae25e2078f5eca734c8` (`chore(release): v0.2.7`, version bump on top of tested `5ce29b2`)
- **Channel:** stable
- **Requester:** owner (approved in `docs/PLAN_RELEASE_027_GREEN.md`: "a"; 2026-11-05: "send it")
- **Desk:** Release Desk · Lead (2fecc057). Last release on the old one-shot flow (`server/release.mjs`); D7 is the first full desk release.

## Tests on the frozen commit
`npm run typecheck` clean. `node --test "test/**/*.test.mjs"` on `5ce29b2`: 1698 pass / 2 fail. Both fails are load flakes that pass alone (163/163):
`identity-v2` migrate (spawnSync timeout under load) and `remote-proxy` PUT /api/teams (10 s timeout).

## Build
Clean detached worktree at `66d01b5` (`%LOCALAPPDATA%\VibeSquad\worktrees\VibeSquad\rd-v027-cut`), runtime build stamp `66d01b5`.
A first build from the main checkout was discarded: `0555420` (rail check-in, untested, fails repo hygiene) was merged mid-build and got into it.
Android `gen/` was missing tauri's generated `TauriActivity.kt` in the fresh worktree; copied from the main checkout (the other generated files are identical, same Cargo.lock).

## Artifacts (SHA-256)
| File | SHA-256 |
|---|---|
| VibeSquad-setup.exe (ProductVersion 0.2.7) | `030dbdfec659ac8db38cf4260298e7941b6007ac04893c725dcbc6b544faf83f` |
| VibeSquad.apk | `d8e9480d7f42827b78b4b30e7a84657f0d4d3981569451308564c091be07044e` |

Updater `.sig` matches the signature in `latest.json` (windows-x86_64 + android-aarch64, version 0.2.7).
Installer signature verified cryptographically against the updater pubkey (minisign Ed25519, `scripts/release-audit.mjs` B7). Not checked: `apksigner verify --print-certs` (apksigner isn't on the SDK path here); Authenticode (not set up until D5).

## Audit (first run of `scripts/release-audit.mjs`, read-only, after the build)
v0.2.7 goes out on the old flow (owner decision), so this is informational and not a gate.
| # | Result | Notes |
|---|---|---|
| B1/B2 | FAIL (High) | F2: the old hardcoded Android keystore password in `server/build-android.mjs` also ships in the installer's `runtime/`. v0.2.6 shipped it too, and it's already in git history. Fixed on master (b0bc825); the keystore rotation (D6) retires it. The rest are likely false positives (`sk-`/`pass:` text matches) for triage. |
| B3/B4/B6 | PASS | No new hosts, binds, routes, capabilities or permissions. |
| B5 | SKIP | `npm audit --omit=dev`: 0 vulnerabilities. cargo audit not installed. |
| B7 | REVIEW | Pubkey unchanged vs v0.2.6; Windows signature equals `.sig`. `android-aarch64` in `latest.json` has no signature (same as v0.2.6). |
| B8 | PASS | build stamp = `66d01b5`, tree clean, version 0.2.7 everywhere. |

## Changes since v0.2.6
- Lane display names for Brainstorm titles, free-form rename (identity)
- GitHub wiki mirrors `guide/` on release
- U14–U17 UI polish: compact top bar, config sub-menu, right-rail spin-off / send-to / looks-done buttons, mark-read toggle, menu overflow fixes
- Pins: Mark complete / Remove team fixes, PinMenu in sidebar and rail
- Timeline: booting indicator, spin-up spinner, pending/failed bubble styles
- Spawn: unwrap capped providers, turn-1 profile reload guard, longer proxy spawn timeout
- 64 px hand-drawn cast art

## Approval
The owner approved shipping once green. Publishing from an agent was blocked by the permission classifier; the owner ran the publish at 2026-11-06 04:23 UTC.

## Publish (owner)
From the pinned worktree, so the right artifacts upload and the tag lands on the frozen commit (the old script creates the tag at the remote branch tip, which has moved):

```
cd %LOCALAPPDATA%\VibeSquad\worktrees\VibeSquad\rd-v027-cut
gh release create v0.2.7 --repo Pizzarar/VibeSquad --target 66d01b5435ac3d9333b91ae25e2078f5eca734c8 --title "VibeSquad v0.2.7" --notes "VibeSquad v0.2.7"
node server\release.mjs --channel stable --skip-build
```

The second command finds the release, sets its notes, uploads the 5 assets and syncs the rolling beta release.

## Release URL
https://github.com/Pizzarar/VibeSquad/releases/tag/v0.2.7 (tag `v0.2.7` -> `66d01b5`; 5 assets, published installer and APK SHA-256s match the table above; published `latest.json` is version 0.2.7. Rolling beta synced to 0.2.7.)
