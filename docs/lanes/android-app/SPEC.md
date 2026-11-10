# PLAN · Android App (`@and` / `android-app`)

Older Tauri plan: `docs/PLAN_ANDROID_APP.md` (A1-A6, all done). Current 0.3 plan: `docs/PLAN_ANDROID_MESHNET.md` (Meshnet A1-A3, A2b, A2d, A2e, A1b, A1c — **ALL DONE & CLOSED 2026-11-10** at `7fb55ab` / APK `aac22b2d…`; Aub passed the full `docs/lanes/android-app/RETEST_A1.md` on-device checklist including edge cases). Post-0.3 end-state plan: `docs/PLAN_ANDROID_END_STATE.md` (locked 2026-11-10: primary host = unattended spare PC at home, with phone-minted pairing [Tier A, gated on 0.3 X1 security walk: two-step confirm on minting device + `mintedByDeviceId` cascade revoke + CLI `vs devices revoke` for lost/stolen phone] + CLI `vs pair` + remote restart/health; E5 Outbound E2EE Relay [Tier A] required for Project PC; E4 host-aware `hostId` model + Scale section [Stage 3 `squad-collaborator`/`bug-tester` principals marked Tier A, gated on 0.3 X1]; E1 strict Phone Cockpit; E2 Decision Cards + Buddy jump; E3 fast Bug Capture to `@bug`; held during 0.3 stabilization freeze).
Lead: And2 rn-390e18a09191 (took over from And1 rn-4cc22ce7f145, 2026-11-09). Keystore/signing stay with Aub + Release Desk. Never publish; hand to Release Desk.

## Units (older Tauri plan, done)
- `unit-and-a1` (`6e19c17`), `unit-and-a2` (`749c12a`), `unit-and-a3` (`6364ecb`), `unit-and-a4` (`42f4d67`), `unit-and-a5` (`684f1f6`), `unit-and-a6` (`3e5f581`)

## Units (Meshnet / 0.3 A1 plan, all done)
- `unit-and-a1-pair` (done, merge `86d8b85`, built by @rel Rele3): APK pairs over VS-native LAN/Meshnet /pair
- `unit-and-mesh-a2` (done, `b306836`): CA trust (pin VS CA fingerprint per paired host), camera/pair on device, chat list/live/send/Stop/Needs-you over remote proxy
- `unit-and-mesh-a3` (done, `8647863`): APK debug/unsigned build works end to end, GitHub updater finds APK on stable. No signing changes.
- `unit-and-mesh-a2b` (done, `1ddac72`): Same-site `/__vibesquad/enter` hop for `serverUrl()`.
- `unit-and-mesh-a2d` (done, `d3105e4`, `106c5d3`, `d6eb8a7`): Restore Android APK download card/link in `PairDeviceModal.tsx`, route `handlePairRedeem` 302 through `/__vibesquad/enter`, fix empty `meshnetHost` default QR, and stage a compact (~13 MB) debug-signed release APK at `dist-desktop/VibeSquad.apk`.
- `unit-and-03-a1` (done, `705b5f6`, `0fe90ce`, `7fb55ab`, on-device `RETEST_A1.md` passed by Aub 2026-11-10, edge cases included): same-site `/` enter hop, case-insensitive `/VibeSquad.apk` + sha256 sidecar/runtime sync, Reconnect + plain cert/offline errors + pin/cookie clear.
